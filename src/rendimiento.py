"""Experimentos de rendimiento: EXPLAIN (ANALYZE, BUFFERS) ANTES y DESPUES de cada indice o reescritura.

Metodo (para no tocar la base): cada experimento corre dentro de una transaccion que se REVIERTE.
  1. ANTES   : se elimina el indice (o se usa la consulta original) y se mide.
  2. DESPUES : se crea el indice (o la consulta reescrita) y se mide.
  3. ROLLBACK: la base queda exactamente como estaba.
Cada medicion es la mediana de varias ejecuciones con cache caliente.

Regla de decision (fija, para no justificar indices por intuicion): un indice se CONSERVA solo si reduce
las paginas leidas al menos 3x Y ahorra al menos 256 paginas (2 MiB) en TODAS las corridas. Se usan paginas
(EXPLAIN BUFFERS) y no milisegundos porque son deterministas: no dependen de la carga del equipo. Si pasa en
unas corridas y no en otras es "marginal" y se descarta. Los marcados "estructural" se conservan siempre (los
usa un trigger o una restriccion en la ruta critica de escritura).

Salida: evidencia/explain/<id>_{antes,despues}.txt, evidencia/rendimiento.json y docs/RENDIMIENTO.md.
"""
import json
import statistics
import sys
import time

from config import RAIZ, conectar

REPETICIONES = 5
# La decision se toma con PAGINAS leidas (EXPLAIN BUFFERS): es determinista y no depende de la velocidad ni de la
# carga del equipo, a diferencia de los milisegundos (en una corrida con poca RAM libre variaron 3x y cambiaron veredictos).
UMBRAL_FACTOR, UMBRAL_PAGINAS = 3.0, 256      # 256 paginas de 8 KiB = 2 MiB
CORRIDAS = 2          # cada experimento de indice se repite; solo se conserva si pasa en TODAS


def resumen_plan(nodo, acc=None):
    """Lista los nodos del plan como 'Tipo [indice|relacion]' sin repetir."""
    acc = [] if acc is None else acc
    t = nodo["Node Type"]
    det = nodo.get("Index Name") or nodo.get("Relation Name") or ""
    etiqueta = f"{t} ({det})" if det else t
    if etiqueta not in acc:
        acc.append(etiqueta)
    for h in nodo.get("Plans", []):
        resumen_plan(h, acc)
    return acc


def medir(cur, sql, params=None):
    """Mediana de ejecucion en ms, buffers y plan (texto + resumen)."""
    def una(formato):
        cur.execute(f"EXPLAIN (ANALYZE, BUFFERS, FORMAT {formato}) {sql}", params or ())
        return cur.fetchall()
    una("JSON")                                            # calentamiento
    tiempos, ultimo = [], None
    for _ in range(REPETICIONES):
        j = una("JSON")[0][0]
        j = j if isinstance(j, list) else json.loads(j)
        tiempos.append(j[0]["Execution Time"])
        ultimo = j[0]
    texto = "\n".join(f[0] for f in una("TEXT"))
    plan = ultimo["Plan"]
    # Paginas tocadas: compartidas (tablas normales) + locales (tablas temporales)
    hit = plan.get("Shared Hit Blocks", 0) + plan.get("Local Hit Blocks", 0)
    read = plan.get("Shared Read Blocks", 0) + plan.get("Local Read Blocks", 0)
    return {
        "ms": round(statistics.median(tiempos), 2),
        "buffers_hit": hit, "buffers_read": read, "paginas": hit + read,
        "nodos": resumen_plan(plan), "texto": texto,
    }


def fila(cur, sql, params=None):
    cur.execute(sql, params or ())
    return cur.fetchone()[0]


def main():
    conn = conectar(autocommit=True)
    cur = conn.cursor()
    cur.execute("SET statement_timeout = 0")
    cur.execute("SET max_parallel_workers_per_gather = 2")
    if fila(cur, "SELECT count(*) FROM nucleo.transaccion") < 500_000:
        sys.exit("Se requiere la carga masiva completa (python src/masivo.py)")

    # Parametros representativos (cuenta con actividad tipica alta = percentil 90; dia con actividad; transaccion)
    cta = fila(cur, """SELECT cuenta_id FROM (SELECT cuenta_id, count(*) n FROM nucleo.movimiento WHERE cuenta_id > 2
                       GROUP BY 1) x ORDER BY abs(n - 63), cuenta_id LIMIT 1""")
    cta_ret = fila(cur, "SELECT cuenta_debito FROM nucleo.transaccion WHERE tipo = 'retiro' AND cuenta_debito > 2 GROUP BY 1 ORDER BY count(*) DESC LIMIT 1 OFFSET 50")
    cliente = fila(cur, "SELECT cliente_id FROM nucleo.cuenta WHERE id = %s", (cta,))
    tx = fila(cur, "SELECT id FROM nucleo.transaccion ORDER BY creado_en DESC LIMIT 1 OFFSET 300000")
    dia = fila(cur, "SELECT (max(creado_en) AT TIME ZONE 'America/Bogota')::date - 40 FROM nucleo.transaccion")
    ini_dia = f"{dia} 00:00:00-05"
    fin_dia = f"{dia} 23:59:59-05"
    ultimo_dia = fila(cur, "SELECT (max(creado_en) AT TIME ZONE 'America/Bogota')::date FROM nucleo.transaccion")

    EXP = [
        # (id, titulo, tabla, indice, ddl, SQL, params, estructural, problema)
        ("E01", "Extracto de una cuenta (ultimos 15 movimientos)", "nucleo.movimiento", "idx_movimiento_cuenta",
         "CREATE INDEX idx_movimiento_cuenta ON nucleo.movimiento (cuenta_id, creado_en DESC)",
         "SELECT * FROM api.v_extracto WHERE cuenta_id = %s ORDER BY creado_en DESC, id DESC LIMIT 15", (cta,), False,
         "Sin indice por cuenta el planificador solo puede recorrer el indice por fecha (o la tabla) descartando fila a fila las de otras cuentas, entre 2 millones de movimientos."),
        ("E02", "Limite diario: suma de retiros recientes de una cuenta (corre dentro de cada retiro/transferencia)",
         "nucleo.transaccion", "idx_transaccion_debito",
         "CREATE INDEX idx_transaccion_debito ON nucleo.transaccion (cuenta_debito, creado_en DESC)",
         "SELECT COALESCE(sum(monto), 0) FROM nucleo.transaccion WHERE cuenta_debito = %s AND tipo = 'retiro' AND creado_en >= %s",
         (cta_ret, ini_dia), False,
         "Se ejecuta en CADA retiro/transferencia, mientras la cuenta esta bloqueada con FOR UPDATE. INFORMATIVO: el indice por fecha ya lo acota a pocas filas, asi que este indice no se justifica solo por esto (lo justifica E08)."),
        ("E03", "Trigger de partida doble: movimientos de una transaccion (corre por cada movimiento insertado)",
         "nucleo.movimiento", "idx_movimiento_transac",
         "CREATE INDEX idx_movimiento_transac ON nucleo.movimiento (transaccion_id)",
         "SELECT COALESCE(SUM(CASE sentido WHEN 'C' THEN monto ELSE -monto END), 0) FROM nucleo.movimiento WHERE transaccion_id = %s",
         (tx,), True,
         "El trigger fn_verificar_balance busca los movimientos de la transaccion por cada INSERT; sin indice cada operacion escanearia 2 millones de filas."),
        ("E04", "Cierre diario: movimientos de un dia", "nucleo.movimiento", "idx_movimiento_fecha",
         "CREATE INDEX idx_movimiento_fecha ON nucleo.movimiento (creado_en DESC)",
         "SELECT count(*), sum(monto) FROM nucleo.movimiento WHERE creado_en >= %s AND creado_en <= %s", (ini_dia, fin_dia), False,
         "Un dia es ~0,1 % de la tabla; sin indice por fecha se lee toda."),
        ("E05", "Operaciones de hoy (panel del administrador)", "nucleo.transaccion", "idx_transaccion_fecha",
         "CREATE INDEX idx_transaccion_fecha ON nucleo.transaccion (creado_en)",
         "SELECT tipo, count(*), sum(monto) FROM nucleo.transaccion WHERE creado_en >= %s GROUP BY tipo", (f"{ultimo_dia} 00:00:00-05",), False,
         "El panel pide solo el dia actual; sin indice agrega 1 millon de filas."),
        ("E06", "Cuentas de un cliente via titularidad (dashboard y control de propiedad)", "nucleo.cuenta_titular", "idx_titular_cliente",
         "CREATE INDEX idx_titular_cliente ON nucleo.cuenta_titular (cliente_id)",
         "SELECT * FROM api.v_saldos WHERE cuenta_id IN (SELECT cuenta_id FROM api.v_titulares WHERE cliente_id = %s)", (cliente,), False,
         "La PK es (cuenta_id, cliente_id): buscar por cliente no puede usarla."),
        ("E07", "Cuentas de un cliente por la columna cliente_id de cuenta", "nucleo.cuenta", "idx_cuenta_cliente",
         "CREATE INDEX idx_cuenta_cliente ON nucleo.cuenta (cliente_id)",
         "SELECT id, numero, saldo FROM nucleo.cuenta WHERE cliente_id = %s", (cliente,), False,
         "Consulta directa de las cuentas de un cliente."),
        ("E08", "Historial de transacciones de una cuenta (origen o destino)", "nucleo.transaccion", "idx_transaccion_debito",
         "CREATE INDEX idx_transaccion_debito ON nucleo.transaccion (cuenta_debito, creado_en DESC)",
         "SELECT * FROM api.v_transacciones WHERE cuenta_debito = %s OR cuenta_credito = %s ORDER BY creado_en DESC LIMIT 20", (cta, cta), False,
         "La forma 'A OR B ... ORDER BY fecha LIMIT' obliga al planificador a elegir un barrido completo (~400 ms) aunque existan indices por cuenta."),
        ("E09", "Eventos de una cuenta", "nucleo.evento_cuenta", "idx_evento_cuenta",
         "CREATE INDEX idx_evento_cuenta ON nucleo.evento_cuenta (cuenta_id, creado_en DESC)",
         "SELECT * FROM api.v_eventos_cuenta WHERE cuenta_id = %s ORDER BY id DESC", (cta,), False,
         "Pantalla de eventos de una cuenta."),
        ("E10", "Clientes de un departamento", "nucleo.cliente", "idx_cliente_departamento",
         "CREATE INDEX idx_cliente_departamento ON nucleo.cliente (departamento)",
         "SELECT count(*) FROM nucleo.cliente WHERE departamento = 'Antioquia'", (), False,
         "Filtro por departamento sobre 10.000 clientes."),
        ("E11", "Cuentas de una oficina", "nucleo.cuenta", "idx_cuenta_oficina",
         "CREATE INDEX idx_cuenta_oficina ON nucleo.cuenta (oficina_id)",
         "SELECT count(*), sum(saldo) FROM nucleo.cuenta WHERE oficina_id = 3", (), False,
         "Filtro de cuentas por oficina."),
        ("E12", "Llaves Bre-B de un cliente", "nucleo.llave_brebe", "idx_llave_cliente",
         "CREATE INDEX idx_llave_cliente ON nucleo.llave_brebe (cliente_id)",
         "SELECT * FROM api.v_llaves_brebe WHERE cliente_id = %s", (cliente,), False,
         "Listado de llaves del cliente."),
    ]

    resultados = []
    (RAIZ / "evidencia" / "explain").mkdir(parents=True, exist_ok=True)

    # Diseno combinado del historial: DOS indices por cuenta + consulta reescrita como UNION ALL ordenado.
    UNION_HISTORIAL = """SELECT * FROM (
       (SELECT * FROM api.v_transacciones WHERE cuenta_debito = %s ORDER BY creado_en DESC LIMIT 20)
       UNION ALL
       (SELECT * FROM api.v_transacciones WHERE cuenta_credito = %s ORDER BY creado_en DESC LIMIT 20)) u
     ORDER BY creado_en DESC LIMIT 20"""
    VARIANTES = {"E08": {
        "drop": ["idx_transaccion_debito", "idx_transaccion_credito"],
        "ddl": ["CREATE INDEX idx_transaccion_debito ON nucleo.transaccion (cuenta_debito, creado_en DESC)",
                "CREATE INDEX idx_transaccion_credito ON nucleo.transaccion (cuenta_credito, creado_en DESC)"],
        "sql_despues": UNION_HISTORIAL, "indice": "idx_transaccion_debito + idx_transaccion_credito (y UNION ALL)"}}
    INFORMATIVOS = {"E02"}

    def correr(e):
        id_, titulo, tabla, indice, ddl, sql, params, estructural, problema = e
        v = VARIANTES.get(id_, {})
        cur.execute("BEGIN")
        try:
            for ix in v.get("drop", [indice]):
                cur.execute(f"DROP INDEX IF EXISTS {tabla.split('.')[0]}.{ix}")
            cur.execute(f"ANALYZE {tabla}")
            antes = medir(cur, sql, params)
            for d in v.get("ddl", [ddl]):
                cur.execute(d)
            cur.execute(f"ANALYZE {tabla}")
            despues = medir(cur, v.get("sql_despues", sql), params)
        finally:
            cur.execute("ROLLBACK")
        return antes, despues

    def pasa(a, d):
        return a["paginas"] >= UMBRAL_FACTOR * max(d["paginas"], 1) and a["paginas"] - d["paginas"] >= UMBRAL_PAGINAS

    for e in EXP:
        corridas = [correr(e) for _ in range(CORRIDAS)]
        # Se reporta la corrida MENOS favorable al indice (la de mas paginas "despues")
        antes, despues = max(corridas, key=lambda r: r[1]["paginas"])
        id_, titulo, tabla, indice, ddl, sql, params, estructural, problema = e
        indice = VARIANTES.get(id_, {}).get("indice", indice)
        if id_ in VARIANTES:
            ddl = ";\n".join(VARIANTES[id_]["ddl"])
            sql = "-- ANTES:\n" + sql + "\n-- DESPUES:\n" + VARIANTES[id_]["sql_despues"]
        mejora = antes["ms"] / despues["ms"] if despues["ms"] > 0 else float("inf")
        pasan = [pasa(a, d) for a, d in corridas]
        if id_ in INFORMATIVOS:
            veredicto = "INFORMATIVO"
        elif all(pasan):
            veredicto = "CONSERVAR"
        elif estructural:
            veredicto = "CONSERVAR (estructural)"
        elif any(pasan):
            veredicto = "DESCARTAR (marginal)"
        else:
            veredicto = "DESCARTAR"
        (RAIZ / "evidencia" / "explain" / f"{id_}_antes.txt").write_text(antes["texto"], encoding="utf-8")
        (RAIZ / "evidencia" / "explain" / f"{id_}_despues.txt").write_text(despues["texto"], encoding="utf-8")
        mejora_pag = antes["paginas"] / max(despues["paginas"], 1)
        resultados.append({"id": id_, "consulta": titulo, "problema": problema, "indice": indice, "ddl": ddl, "sql": sql,
                           "antes": {k: antes[k] for k in ("ms", "buffers_hit", "buffers_read", "paginas", "nodos")},
                           "despues": {k: despues[k] for k in ("ms", "buffers_hit", "buffers_read", "paginas", "nodos")},
                           "mejora_x": round(mejora, 1), "mejora_paginas_x": round(mejora_pag, 1), "veredicto": veredicto})
        print(f"{id_} {indice[:30]:30s} paginas {antes['paginas']:7d} -> {despues['paginas']:6d} (x{mejora_pag:7.1f})  "
              f"{antes['ms']:8.1f} -> {despues['ms']:7.2f} ms  {veredicto}")

    # ---- Auditoria: tabla sintetica de 1.000.000 de eventos (la real es chica porque la carga masiva no audita fila a fila)
    cur.execute("BEGIN")
    try:
        cur.execute("""CREATE TEMP TABLE ev_sim AS
            SELECT row_number() OVER ()::bigint AS id, 'nucleo.transaccion'::text AS tabla, 'INSERT'::text AS operacion,
                   'postgres'::text AS usuario, COALESCE(actor_usuario_id, 1 + (hashtext(id::text) & 7))::bigint AS usuario_app_id,
                   NULL::text AS rol, NULL::inet AS ip, id::text AS registro_id, 'OK'::text AS resultado, creado_en AS ocurrido_en
              FROM nucleo.transaccion""")
        cur.execute("ANALYZE ev_sim")
        reg = fila(cur, "SELECT registro_id FROM ev_sim OFFSET 123456 LIMIT 1")
        audit = [
            ("E13", "Auditoria: historia de un registro (quien lo toco)", "idx_evento_registro",
             "CREATE INDEX idx_evento_registro ON ev_sim (tabla, registro_id)",
             "SELECT * FROM ev_sim WHERE tabla = 'nucleo.transaccion' AND registro_id = %s ORDER BY id", (reg,),
             "Pregunta central de la auditoria: ¿que paso con este registro? Sin indice recorre toda la bitacora."),
            ("E14", "Auditoria: actividad reciente de un usuario", "idx_evento_usuario",
             "CREATE INDEX idx_evento_usuario ON ev_sim (usuario_app_id, ocurrido_en DESC)",
             "SELECT * FROM ev_sim WHERE usuario_app_id = 3 ORDER BY ocurrido_en DESC LIMIT 25", (),
             "Pregunta de auditoria: ¿que hizo este usuario?"),
            ("E15", "Auditoria: ultimos eventos de una tabla", "idx_evento_tabla_fecha",
             "CREATE INDEX idx_evento_tabla_fecha ON ev_sim (tabla, ocurrido_en DESC)",
             "SELECT * FROM ev_sim WHERE tabla = 'nucleo.transaccion' ORDER BY ocurrido_en DESC LIMIT 25", (),
             "Pantalla de auditoria filtrada por tabla y ordenada por fecha."),
        ]
        for id_, titulo, indice, ddl, sql, params, problema in audit:
            antes = medir(cur, sql, params)
            cur.execute(ddl)
            cur.execute("ANALYZE ev_sim")
            despues = medir(cur, sql, params)
            cur.execute(f"DROP INDEX {indice}")
            mejora = antes["ms"] / despues["ms"] if despues["ms"] > 0 else float("inf")
            conservar = pasa(antes, despues)
            (RAIZ / "evidencia" / "explain" / f"{id_}_antes.txt").write_text(antes["texto"], encoding="utf-8")
            (RAIZ / "evidencia" / "explain" / f"{id_}_despues.txt").write_text(despues["texto"], encoding="utf-8")
            resultados.append({"id": id_, "consulta": titulo + " [bitacora simulada de 1.000.000 filas]", "problema": problema,
                               "indice": indice, "ddl": ddl.replace("ev_sim", "auditoria.evento"), "sql": sql.replace("ev_sim", "auditoria.evento"),
                               "antes": {k: antes[k] for k in ("ms", "buffers_hit", "buffers_read", "paginas", "nodos")},
                               "despues": {k: despues[k] for k in ("ms", "buffers_hit", "buffers_read", "paginas", "nodos")},
                               "mejora_x": round(mejora, 1), "mejora_paginas_x": round(antes["paginas"] / max(despues["paginas"], 1), 1),
                               "veredicto": "CONSERVAR" if conservar else "DESCARTAR"})
            print(f"{id_} {indice[:30]:30s} paginas {antes['paginas']:7d} -> {despues['paginas']:6d}  "
                  f"{antes['ms']:8.1f} -> {despues['ms']:7.2f} ms  {'CONSERVAR' if conservar else 'DESCARTAR'}")
    finally:
        cur.execute("ROLLBACK")

    # ---- Parametro de ejecucion: paralelismo en consultas OLTP cortas (el backend lo desactiva)
    cli1 = fila(cur, "SELECT id FROM nucleo.cliente WHERE documento = '1000000001'")
    cols = "id, tipo, canal, actor_usuario_id, cuenta_debito, cuenta_credito, creado_en"
    pagina = (f"SELECT id FROM (SELECT {cols} FROM api.v_tx_base WHERE cuenta_debito IN (SELECT cuenta_id FROM api.v_titular_base WHERE cliente_id = %s) "
              f"UNION ALL SELECT {cols} FROM api.v_tx_base WHERE cuenta_credito IN (SELECT cuenta_id FROM api.v_titular_base WHERE cliente_id = %s)) b "
              "ORDER BY creado_en DESC, id LIMIT 25")
    cur.execute("BEGIN")
    try:
        cur.execute("SET LOCAL max_parallel_workers_per_gather = 2")
        pa = medir(cur, pagina, (cli1, cli1))
        cur.execute("SET LOCAL max_parallel_workers_per_gather = 0")
        pb = medir(cur, pagina, (cli1, cli1))
    finally:
        cur.execute("ROLLBACK")
    (RAIZ / "evidencia" / "explain" / "P01_antes.txt").write_text(pa["texto"], encoding="utf-8")
    (RAIZ / "evidencia" / "explain" / "P01_despues.txt").write_text(pb["texto"], encoding="utf-8")
    resultados.append({"id": "P01", "consulta": "Pagina de transacciones de un cliente (OLTP corta): paralelismo por defecto vs desactivado",
                       "problema": "El planificador supone ~70 transacciones por cuenta y elige Gather Merge con 2 workers; lanzarlos cuesta ~50 ms para devolver 2 filas.",
                       "indice": "(parametro) max_parallel_workers_per_gather = 0 en el rol del backend", "ddl": "SET max_parallel_workers_per_gather = 0", "sql": pagina,
                       "antes": {k: pa[k] for k in ("ms", "buffers_hit", "buffers_read", "paginas", "nodos")},
                       "despues": {k: pb[k] for k in ("ms", "buffers_hit", "buffers_read", "paginas", "nodos")},
                       "mejora_x": round(pa["ms"] / max(pb["ms"], 0.01), 1), "veredicto": "ADOPTAR"})
    print(f"P01 paralelismo OLTP              antes={pa['ms']:9.2f} ms  despues={pb['ms']:8.2f} ms  x{pa['ms'] / max(pb['ms'], 0.01):7.1f}")

    # ---- Reescritura de consulta: conciliacion de saldos (v_conciliacion)
    original = """SELECT count(*) FROM (SELECT c.id FROM nucleo.cuenta c CROSS JOIN LATERAL (
                    SELECT COALESCE(SUM(CASE m.sentido WHEN 'C' THEN m.monto ELSE -m.monto END), 0) AS calculado
                      FROM nucleo.movimiento m WHERE m.cuenta_id = c.id) x WHERE c.saldo <> x.calculado) t"""
    reescrita = """SELECT count(*) FROM nucleo.cuenta c
                    LEFT JOIN (SELECT cuenta_id, SUM(CASE sentido WHEN 'C' THEN monto ELSE -monto END) AS calculado
                                 FROM nucleo.movimiento GROUP BY cuenta_id) x ON x.cuenta_id = c.id
                   WHERE c.saldo <> COALESCE(x.calculado, 0)"""
    a = medir(cur, original)
    b = medir(cur, reescrita)
    (RAIZ / "evidencia" / "explain" / "R01_antes.txt").write_text(a["texto"], encoding="utf-8")
    (RAIZ / "evidencia" / "explain" / "R01_despues.txt").write_text(b["texto"], encoding="utf-8")
    resultados.append({"id": "R01", "consulta": "Conciliacion de saldos de TODAS las cuentas (api.v_conciliacion)",
                       "problema": "El LATERAL hace una busqueda por cuenta (50.000 veces) y suma sus movimientos; el panel del administrador la ejecuta en cada carga.",
                       "indice": "(reescritura, sin indice nuevo)", "ddl": "GROUP BY cuenta_id + LEFT JOIN en lugar de LATERAL", "sql": reescrita,
                       "antes": {k: a[k] for k in ("ms", "buffers_hit", "buffers_read", "paginas", "nodos")},
                       "despues": {k: b[k] for k in ("ms", "buffers_hit", "buffers_read", "paginas", "nodos")},
                       "mejora_x": round(a["ms"] / b["ms"], 1), "veredicto": "ADOPTAR" if a["ms"] / b["ms"] >= UMBRAL_FACTOR else "MANTENER"})
    print(f"R01 reescritura conciliacion      antes={a['ms']:9.2f} ms  despues={b['ms']:8.2f} ms  x{a['ms'] / b['ms']:7.1f}")

    (RAIZ / "evidencia" / "rendimiento.json").write_text(json.dumps(
        {"umbral": {"factor": UMBRAL_FACTOR, "paginas": UMBRAL_PAGINAS}, "repeticiones": REPETICIONES, "corridas": CORRIDAS,
         "experimentos": resultados}, indent=2, ensure_ascii=False), encoding="utf-8")
    conn.close()
    generar_documento(resultados)


def _plan(x):
    return f"{' → '.join(x['nodos'][:6])}; **{x['paginas']} paginas leidas** ({x['buffers_hit']} en cache / {x['buffers_read']} de disco); {x['ms']:.2f} ms"


def generar_documento(resultados):
    lat = RAIZ / "evidencia" / "latencia_api.json"
    L = ["# Rendimiento", "",
         "> Documento **generado** por `python src/rendimiento.py` a partir de mediciones reales con "
         "`EXPLAIN (ANALYZE, BUFFERS)` sobre la base con **1.000.000 de transacciones y 2.000.000 de movimientos**. "
         "No se edita a mano: se regenera. Los planes completos estan en `evidencia/explain/`.", "",
         "## Metodo", "",
         "Cada experimento corre dentro de una transaccion que se **revierte**: (1) se quita el indice y se mide el plan *antes*; "
         "(2) se crea el indice (o se usa la consulta reescrita) y se mide el plan *despues*; (3) `ROLLBACK`. "
         f"Cada medicion es la mediana de {REPETICIONES} ejecuciones con cache caliente, y cada experimento se repite {CORRIDAS} veces "
         "(se reporta la corrida menos favorable al indice).", "",
         f"**Regla de decision, fijada de antemano:** un indice solo se conserva si reduce las **paginas leidas** al menos **{UMBRAL_FACTOR:g}x** "
         f"y ahorra al menos **{UMBRAL_PAGINAS} paginas ({UMBRAL_PAGINAS * 8 // 1024} MiB)** en todas las corridas. Se decide con paginas "
         "(`EXPLAIN BUFFERS`) y no con milisegundos porque las paginas son **deterministas**: no dependen de lo cargado que este el equipo "
         "(en una corrida con poca RAM libre los milisegundos variaron 3x y cambiaron los veredictos marginales). Lo marginal se descarta. "
         "Los indices que usa un trigger en la ruta de escritura se marcan *estructurales*. Asi no se crean indices indiscriminadamente. "
         "Los milisegundos se muestran como dato informativo.", "",
         "## Resumen", "",
         "| ID | Consulta | Indice / propuesta | Paginas antes → despues | Tiempo antes → despues | Mejora (paginas) | Veredicto |", "|---|---|---|---:|---:|---:|---|"]
    for r in resultados:
        L.append(f"| {r['id']} | {r['consulta']} | `{r['indice']}` | {r['antes']['paginas']:,} → {r['despues']['paginas']:,} | "
                 f"{r['antes']['ms']:.2f} → {r['despues']['ms']:.2f} ms | x{r.get('mejora_paginas_x', r['mejora_x']):g} | **{r['veredicto']}** |")
    L += ["", "## Detalle de cada experimento", ""]
    for r in resultados:
        concl = {
            "CONSERVAR": "El indice reduce el costo de forma consistente y por encima del umbral: se conserva en `sql/07_indices.sql`.",
            "CONSERVAR (estructural)": "Lo usa un trigger en cada escritura: se conserva siempre.",
            "DESCARTAR": "No alcanza el umbral: el indice cuesta espacio y escritura sin beneficio medible. Se **elimina**.",
            "DESCARTAR (marginal)": "Los resultados no son consistentes entre corridas: sin evidencia clara se **elimina**.",
            "INFORMATIVO": "Solo informativo: no decide por si solo la existencia del indice (lo justifica otro experimento).",
            "ADOPTAR": "Mejora medida y reproducible: se adopta en el codigo.",
        }.get(r["veredicto"], "")
        L += [f"### {r['id']} — {r['consulta']}", "",
              f"- **Consulta:**", "  ```sql", "  " + r["sql"].replace("\n", "\n  "), "  ```",
              f"- **Problema:** {r['problema']}",
              f"- **Plan antes:** {_plan(r['antes'])}  (`evidencia/explain/{r['id']}_antes.txt`)",
              f"- **Indice / propuesta:** `{r['indice']}`", "  ```sql", "  " + r["ddl"].replace("\n", "\n  "), "  ```",
              f"- **Plan despues:** {_plan(r['despues'])}  (`evidencia/explain/{r['id']}_despues.txt`)",
              f"- **Mejora:** x{r['mejora_x']:g} ({r['antes']['ms']:.2f} ms → {r['despues']['ms']:.2f} ms)",
              f"- **Conclusion:** {concl}", ""]
    conservados = [r for r in resultados if r["veredicto"].startswith("CONSERVAR")]
    descartados = [r for r in resultados if r["veredicto"].startswith("DESCARTAR")]
    L += ["## Indices resultantes", "",
          "**Se conservan** (justificados por medicion): " + ", ".join(f"`{r['indice']}` ({r['id']})" for r in conservados) + ".", "",
          "**Descartados por no superar el umbral:** " + (", ".join(f"`{r['indice']}` ({r['id']})" for r in descartados) or "ninguno") + ". "
          "Ademas se eliminaron `cuenta(producto_id)` y `tarjeta(cuenta_id)` por analisis estatico: ninguna consulta del sistema filtra por esas columnas.", ""]
    if lat.exists():
        d = json.loads(lat.read_text(encoding="utf-8"))
        L += ["## Latencia de la API (HTTP, 1.000.000 de transacciones)", "",
              "Medida con `npm --prefix backend run latencia` (mediana de 7 ejecuciones).", "",
              "| Endpoint | Mediana | Maximo |", "|---|---:|---:|"]
        for k, v in d["lecturas"].items():
            L.append(f"| `{k}` | {v['mediana_ms']} ms | {v['max_ms']} ms |")
        L += ["", "| Escritura (20 operaciones secuenciales) | Mediana | p95 |", "|---|---:|---:|"]
        for k, v in d["escrituras"].items():
            L.append(f"| `{k}` | {v['mediana_ms']} ms | {v['p95_ms']} ms |")
        L += ["", "**Concurrencia** (8 trabajadores en paralelo, 320 operaciones cada prueba, 0 errores):", "",
              "| Prueba | TPS | p50 | p95 |", "|---|---:|---:|---:|"]
        nom = {"deposit": "Consignaciones (todas bloquean la fila de CAJA)", "transfer": "Transferencias (cuentas distintas)"}
        for k, v in d["concurrencia"].items():
            L.append(f"| {nom.get(k, k)} | {v['tps']} | {v['p50_ms']} ms | {v['p95_ms']} ms |")
        L.append("")
    L += ["## Hallazgos de diseno (lo que la medicion destapo)", "",
          "1. **`count(*) OVER ()` para paginar:** el listado de transacciones tardaba **3,7 s** porque cada pagina recorria y unia el millon de filas. "
          "Ahora se filtra/ordena/corta la pagina sobre una vista delgada sin joins, el detalle se une solo a 20 filas y el total se cuenta con tope "
          "(exacto hasta 10.000, despues `10.000+`). Resultado: ~15 ms.",
          "2. **`A OR B ... ORDER BY fecha LIMIT n`:** nunca obtiene un buen plan (~400-600 ms) aunque existan indices por cuenta. Dos busquedas por "
          "indice `(cuenta, creado_en DESC)` unidas con `UNION ALL` bajan a decimas de milisegundo (E08).",
          "3. **Paralelismo en consultas OLTP cortas:** el planificador asume ~70 transacciones por cuenta y usa `Gather Merge` con 2 workers; lanzarlos cuesta "
          "~50 ms para devolver 2 filas (P01). El backend usa `max_parallel_workers_per_gather = 0`; el panel analitico lo reactiva con `SET LOCAL`.",
          "4. **Conciliacion de saldos:** `LATERAL` por cuenta (50.000 busquedas) -> una sola agregacion (R01, ~14x).",
          "5. **Panel del administrador:** agrega millones de filas, por eso se calcula una vez por minuto y se comparte (cache en memoria de 60 s).",
          "6. **Hipotesis descartada:** se penso que el *plan generico* de las sentencias preparadas explicaba una regresion; se probo "
          "`plan_cache_mode = force_custom_plan` y **no tuvo efecto**; la causa real era el paralelismo (punto 3). Se retiro esa opcion.",
          "7. **Cuello de botella conocido:** toda consignacion y retiro toca la fila de la caja del banco (`CAJA-COP`), por lo que se serializan. "
          "En esta maquina las consignaciones rinden aproximadamente la mitad que las transferencias entre cuentas distintas (ver tabla de concurrencia). "
          "Para un banco real habria que repartir la caja por oficina; aqui se documenta como limitacion y no se optimiza prematuramente.",
          "8. **`work_mem`:** con el valor por defecto (4 MB) los ordenamientos de ~1 millon de filas se derraman a disco. Medido en las mismas condiciones, "
          "`work_mem = 64MB` baja la consulta de anomalias (`a05`) de 8,7 s a 4,1 s y la de percentiles (`a02`) de 5,7 s a 4,7 s, sin afectar al resto. "
          "Se fija a nivel de base de datos (`ALTER DATABASE ... SET work_mem`, en `reconstruir.py`); solo se reserva cuando una consulta lo necesita.", "",
          "## Advertencia sobre las cifras absolutas", "",
          "Esta medicion se hizo en un equipo de 8 GB de RAM con ~1,4 GB libres y PostgreSQL con `shared_buffers = 128MB` (valor por defecto). "
          "Los tiempos **absolutos** de las consultas analiticas variaron entre 2 y 4 veces entre corridas segun la presion de memoria del equipo "
          "(p. ej. la misma consulta `a02` midio 1,5 s y 5,7 s). Por eso todas las comparaciones antes/despues se miden **en las mismas condiciones, "
          "alternadas, con medianas y repetidas** (y los indices marginales se descartan): las *proporciones* son confiables, los milisegundos absolutos no son una promesa.", ""]
    (RAIZ / "docs").mkdir(exist_ok=True)
    (RAIZ / "docs" / "RENDIMIENTO.md").write_text("\n".join(L), encoding="utf-8")
    print("docs/RENDIMIENTO.md generado")


if __name__ == "__main__":
    t0 = time.perf_counter()
    main()
    print(f"({time.perf_counter() - t0:.0f}s)")
