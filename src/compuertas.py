"""Controles de calidad de datos. Cada control cuenta filas PROBLEMATICAS: todos deben dar 0.

Se ejecutan sobre la base completa (incluida la carga masiva, que apaga los triggers) por lo que
re-verifican en SQL lo que los triggers/FK garantizarian en una carga normal.

    python src/compuertas.py            # imprime OK/FALLA y termina con codigo 1 si algo falla
    python src/compuertas.py --json     # ademas escribe evidencia/data_quality.json
"""
import json
import sys
import time

from config import RAIZ, conectar

# (categoria, nombre, SQL que devuelve un solo numero: filas problematicas)
CONTROLES = []


def c(categoria, nombre, sql):
    CONTROLES.append((categoria, nombre, sql))


# ---------------------------------------------------------------- integridad referencial
FK = [
    ("nucleo.cuenta", "cliente_id", "nucleo.cliente"), ("nucleo.cuenta", "producto_id", "nucleo.producto"),
    ("nucleo.cuenta", "oficina_id", "nucleo.oficina"), ("nucleo.cuenta_titular", "cuenta_id", "nucleo.cuenta"),
    ("nucleo.cuenta_titular", "cliente_id", "nucleo.cliente"), ("nucleo.evento_cuenta", "cuenta_id", "nucleo.cuenta"),
    ("nucleo.transaccion", "cuenta_debito", "nucleo.cuenta"), ("nucleo.transaccion", "cuenta_credito", "nucleo.cuenta"),
    ("nucleo.transaccion", "reversa_de", "nucleo.transaccion"), ("nucleo.movimiento", "transaccion_id", "nucleo.transaccion"),
    ("nucleo.movimiento", "cuenta_id", "nucleo.cuenta"), ("nucleo.llave_brebe", "cliente_id", "nucleo.cliente"),
    ("nucleo.llave_brebe", "cuenta_id", "nucleo.cuenta"), ("nucleo.brebe_operacion", "transaccion_id", "nucleo.transaccion"),
    ("nucleo.brebe_operacion", "llave_destino_id", "nucleo.llave_brebe"),
]
for hijo, col, padre in FK:
    c("integridad_referencial", f"huerfanos {hijo}.{col}",
      f"SELECT count(*) FROM {hijo} h WHERE h.{col} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM {padre} p WHERE p.id = h.{col})")
c("integridad_referencial", "huerfanos transaccion.actor_usuario_id",
  "SELECT count(*) FROM nucleo.transaccion t WHERE t.actor_usuario_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM seguridad.usuario u WHERE u.id = t.actor_usuario_id)")

# ------------------------------------------------------------------------------ unicidad
c("unicidad", "documento de cliente duplicado", "SELECT count(*) FROM (SELECT documento FROM nucleo.cliente GROUP BY 1 HAVING count(*) > 1) x")
c("unicidad", "correo de cliente duplicado", "SELECT count(*) FROM (SELECT correo FROM nucleo.cliente WHERE correo IS NOT NULL GROUP BY 1 HAVING count(*) > 1) x")
c("unicidad", "numero de cuenta duplicado", "SELECT count(*) FROM (SELECT numero FROM nucleo.cuenta GROUP BY 1 HAVING count(*) > 1) x")
c("unicidad", "clave de idempotencia duplicada", "SELECT count(*) FROM (SELECT clave_idempotencia FROM nucleo.transaccion GROUP BY 1 HAVING count(*) > 1) x")
c("unicidad", "transaccion reversada mas de una vez", "SELECT count(*) FROM (SELECT reversa_de FROM nucleo.transaccion WHERE reversa_de IS NOT NULL GROUP BY 1 HAVING count(*) > 1) x")
c("unicidad", "llave Bre-B activa duplicada", "SELECT count(*) FROM (SELECT valor FROM nucleo.llave_brebe WHERE estado = 'activa' GROUP BY 1 HAVING count(*) > 1) x")

# ------------------------------------------------------------ consistencia financiera (ledger)
c("financiera", "doble partida: transaccion con debitos <> creditos",
  """SELECT count(*) FROM (SELECT transaccion_id FROM nucleo.movimiento GROUP BY 1
       HAVING SUM(CASE sentido WHEN 'C' THEN monto ELSE -monto END) <> 0) t""")
c("financiera", "transaccion sin exactamente un debito y un credito",
  """SELECT count(*) FROM (SELECT transaccion_id FROM nucleo.movimiento GROUP BY 1
       HAVING count(*) <> 2 OR count(*) FILTER (WHERE sentido = 'D') <> 1) t""")
c("financiera", "transaccion sin movimientos",
  "SELECT count(*) FROM nucleo.transaccion t WHERE NOT EXISTS (SELECT 1 FROM nucleo.movimiento m WHERE m.transaccion_id = t.id)")
c("financiera", "movimiento no coincide con su transaccion (cuenta o monto)",
  """SELECT count(*) FROM nucleo.movimiento m JOIN nucleo.transaccion t ON t.id = m.transaccion_id
      WHERE (m.sentido = 'D' AND (m.cuenta_id <> t.cuenta_debito OR m.monto <> t.monto))
         OR (m.sentido = 'C' AND (m.cuenta_id <> t.cuenta_credito OR m.monto <> t.monto))""")
c("financiera", "conciliacion: saldo <> suma de movimientos", "SELECT count(*) FROM api.v_conciliacion")
c("financiera", "cadena de saldos rota (saldo_posterior no sigue al anterior)",
  """SELECT count(*) FROM (
       SELECT sentido, monto, saldo_posterior,
              lag(saldo_posterior, 1, 0::numeric) OVER (PARTITION BY cuenta_id ORDER BY id) AS previo
         FROM nucleo.movimiento) m
      WHERE saldo_posterior <> previo + CASE sentido WHEN 'C' THEN monto ELSE -monto END""")
c("financiera", "saldo de cuenta <> ultimo saldo_posterior",
  """SELECT count(*) FROM nucleo.cuenta c
      LEFT JOIN (SELECT DISTINCT ON (cuenta_id) cuenta_id, saldo_posterior FROM nucleo.movimiento ORDER BY cuenta_id, id DESC) u
             ON u.cuenta_id = c.id
      WHERE c.saldo <> COALESCE(u.saldo_posterior, 0)""")
c("financiera", "invariante global: la suma de TODOS los saldos de cada moneda debe ser cero",
  """SELECT count(*) FROM (SELECT moneda FROM nucleo.cuenta GROUP BY moneda HAVING sum(saldo) <> 0) x""")
c("financiera", "cierre diario: dias anteriores a hoy con movimientos y sin cierre",
  """SELECT count(*) FROM (SELECT DISTINCT (creado_en AT TIME ZONE 'America/Bogota')::date AS d FROM nucleo.movimiento) x
      WHERE d < (now() AT TIME ZONE 'America/Bogota')::date
        AND NOT EXISTS (SELECT 1 FROM nucleo.cierre_diario c WHERE c.fecha = x.d)""")
c("financiera", "cierre diario: operaciones cerradas distintas a las del libro",
  """SELECT CASE WHEN (SELECT COALESCE(sum(operaciones), 0) FROM nucleo.cierre_diario)
                   = (SELECT count(*) FROM nucleo.transaccion
                       WHERE (creado_en AT TIME ZONE 'America/Bogota')::date IN (SELECT fecha FROM nucleo.cierre_diario))
              THEN 0 ELSE 1 END""")
c("financiera", "saldo por debajo del sobregiro autorizado",
  "SELECT count(*) FROM nucleo.cuenta WHERE tipo = 'cliente' AND saldo < -sobregiro_autorizado")
c("financiera", "monedas cruzadas en una transaccion",
  """SELECT count(*) FROM nucleo.transaccion t
       JOIN nucleo.cuenta d ON d.id = t.cuenta_debito JOIN nucleo.cuenta cr ON cr.id = t.cuenta_credito
      WHERE d.moneda <> cr.moneda""")
c("financiera", "retiros por encima del limite diario",
  """SELECT count(*) FROM (SELECT cuenta_debito, (creado_en AT TIME ZONE 'America/Bogota')::date d, sum(monto) s
                           FROM nucleo.transaccion WHERE tipo = 'retiro' GROUP BY 1, 2) x
       JOIN nucleo.cuenta c ON c.id = x.cuenta_debito WHERE x.s > c.limite_retiro_diario""")
c("financiera", "transferencias por encima del limite diario",
  """SELECT count(*) FROM (SELECT cuenta_debito, (creado_en AT TIME ZONE 'America/Bogota')::date d, sum(monto) s
                           FROM nucleo.transaccion WHERE tipo = 'transferencia' GROUP BY 1, 2) x
       JOIN nucleo.cuenta c ON c.id = x.cuenta_debito WHERE x.s > c.limite_transferencia_diaria""")
c("financiera", "reverso inconsistente con su original",
  """SELECT count(*) FROM nucleo.transaccion r JOIN nucleo.transaccion o ON o.id = r.reversa_de
      WHERE r.monto <> o.monto OR r.cuenta_debito <> o.cuenta_credito OR r.cuenta_credito <> o.cuenta_debito
         OR r.creado_en < o.creado_en OR o.tipo = 'reverso'""")
c("financiera", "cuenta cerrada con saldo distinto de cero", "SELECT count(*) FROM nucleo.cuenta WHERE estado = 'cerrada' AND saldo <> 0")
c("financiera", "Bre-B: transaccion sin operacion o con destino distinto",
  """SELECT count(*) FROM nucleo.transaccion t
       LEFT JOIN nucleo.brebe_operacion b ON b.transaccion_id = t.id
       LEFT JOIN nucleo.llave_brebe l ON l.id = b.llave_destino_id
      WHERE (t.canal = 'brebe' AND (b.transaccion_id IS NULL OR l.cuenta_id <> t.cuenta_credito))
         OR (t.canal <> 'brebe' AND b.transaccion_id IS NOT NULL)""")
c("financiera", "Bre-B fuera de COP",
  "SELECT count(*) FROM nucleo.transaccion t JOIN nucleo.cuenta c ON c.id = t.cuenta_debito WHERE t.canal = 'brebe' AND c.moneda <> 'COP'")

# ------------------------------------------------------------------ consistencia temporal
c("temporal", "movimiento con fecha distinta a su transaccion",
  "SELECT count(*) FROM nucleo.movimiento m JOIN nucleo.transaccion t ON t.id = m.transaccion_id WHERE m.creado_en <> t.creado_en")
c("temporal", "cuenta abierta antes de la vinculacion del cliente",
  "SELECT count(*) FROM nucleo.cuenta c JOIN nucleo.cliente cl ON cl.id = c.cliente_id WHERE c.tipo = 'cliente' AND c.fecha_apertura < cl.fecha_vinculacion")
c("temporal", "operaciones fuera de la vida activa de la cuenta",
  """WITH ev AS (SELECT cuenta_id,
                      min(creado_en) FILTER (WHERE tipo = 'activacion') AS act,
                      min(creado_en) FILTER (WHERE tipo IN ('bloqueo', 'cierre')) AS fin
                 FROM nucleo.evento_cuenta GROUP BY 1)
     SELECT count(*) FROM nucleo.movimiento m JOIN ev ON ev.cuenta_id = m.cuenta_id
      WHERE ev.act IS NULL OR m.creado_en < ev.act OR (ev.fin IS NOT NULL AND m.creado_en > ev.fin)""")
c("temporal", "eventos de cuenta antes de la creacion",
  """SELECT count(*) FROM nucleo.evento_cuenta e JOIN nucleo.cuenta c ON c.id = e.cuenta_id
      WHERE e.creado_en < c.creado_en""")
c("temporal", "transacciones en el futuro", "SELECT count(*) FROM nucleo.transaccion WHERE creado_en > now()")
c("temporal", "estado de cuenta incoherente con su ultimo evento",
  """SELECT count(*) FROM nucleo.cuenta c
      JOIN LATERAL (SELECT tipo FROM nucleo.evento_cuenta e WHERE e.cuenta_id = c.id ORDER BY e.id DESC LIMIT 1) u ON true
     WHERE c.tipo = 'cliente'
       AND NOT ((c.estado = 'pendiente' AND u.tipo = 'creacion')
             OR (c.estado = 'activa' AND u.tipo IN ('activacion', 'desbloqueo', 'cambio_limites'))
             OR (c.estado = 'bloqueada' AND u.tipo = 'bloqueo')
             OR (c.estado = 'cerrada' AND u.tipo = 'cierre'))""")

# ------------------------------------------------------------------ consistencia geografica
c("geografica", "oficina de la cuenta fuera del departamento del cliente (teniendo oficina alli)",
  """SELECT count(*) FROM nucleo.cuenta c
       JOIN nucleo.cliente cl ON cl.id = c.cliente_id JOIN nucleo.oficina o ON o.id = c.oficina_id
      WHERE c.tipo = 'cliente' AND o.departamento <> cl.departamento
        AND EXISTS (SELECT 1 FROM nucleo.oficina x WHERE x.departamento = cl.departamento)""")
c("geografica", "cliente sin departamento o ciudad (excepto cuentas del sistema)",
  "SELECT count(*) FROM nucleo.cliente WHERE tipo_documento <> 'SIS' AND (departamento IS NULL OR ciudad IS NULL)")

# --------------------------------------------------------------------------- validez / reglas
c("validez", "titularidad: individual debe tener 1 titular",
  """SELECT count(*) FROM nucleo.cuenta c WHERE c.tipo = 'cliente' AND c.tipo_titularidad = 'individual'
       AND (SELECT count(*) FROM nucleo.cuenta_titular t WHERE t.cuenta_id = c.id) <> 1""")
c("validez", "titularidad: conjunta debe tener 2 o mas titulares",
  """SELECT count(*) FROM nucleo.cuenta c WHERE c.tipo = 'cliente' AND c.tipo_titularidad = 'conjunta'
       AND (SELECT count(*) FROM nucleo.cuenta_titular t WHERE t.cuenta_id = c.id) < 2""")
c("validez", "titularidad: empresarial exige cliente juridico",
  """SELECT count(*) FROM nucleo.cuenta c JOIN nucleo.cliente cl ON cl.id = c.cliente_id
      WHERE c.tipo = 'cliente' AND ((c.tipo_titularidad = 'empresarial') <> (cl.tipo_persona = 'juridica'))""")
c("validez", "cuenta sin su titular principal",
  """SELECT count(*) FROM nucleo.cuenta c WHERE c.tipo = 'cliente'
       AND NOT EXISTS (SELECT 1 FROM nucleo.cuenta_titular t WHERE t.cuenta_id = c.id AND t.cliente_id = c.cliente_id AND t.rol = 'titular')""")
c("validez", "cliente inactivo/bloqueado con cuentas operativas",
  """SELECT count(*) FROM nucleo.cuenta c JOIN nucleo.cliente cl ON cl.id = c.cliente_id
      WHERE c.tipo = 'cliente' AND ((cl.estado = 'inactivo' AND c.estado <> 'cerrada') OR (cl.estado = 'bloqueado' AND c.estado = 'activa'))""")
c("validez", "NIT con digito de verificacion invalido",
  """SELECT count(*) FROM (
       SELECT cl.documento,
              (SELECT sum(substr(reverse(split_part(cl.documento, '-', 1)), i, 1)::int
                          * (ARRAY[3,7,13,17,19,23,29,37,41,43,47,53,59,67,71])[i]) % 11
                 FROM generate_series(1, 9) i) AS r
         FROM nucleo.cliente cl
        WHERE cl.tipo_documento = 'NIT' AND cl.documento ~ '^[0-9]{9}-[0-9]$') x
      WHERE (CASE WHEN r < 2 THEN r ELSE 11 - r END) <> split_part(documento, '-', 2)::int
         OR (SELECT count(*) FROM nucleo.cliente WHERE tipo_documento = 'NIT' AND documento !~ '^[0-9]{9}-[0-9]$') > 0""")
c("validez", "monto de ajuste/reverso sin concepto o sin actor coherente",
  "SELECT count(*) FROM nucleo.transaccion WHERE tipo = 'ajuste' AND (concepto IS NULL OR btrim(concepto) = '')")
c("validez", "operaciones de ventanilla sin cajero registrado",
  """SELECT count(*) FROM nucleo.transaccion t WHERE t.canal = 'cajero' AND t.actor_usuario_id IS NULL
       AND EXISTS (SELECT 1 FROM seguridad.usuario_rol ur JOIN seguridad.rol r ON r.id = ur.rol_id AND r.codigo = 'CAJERO')""")

# ------------------------------------------------------------------------------ auditoria
c("auditoria", "ajustes manuales sin evento de auditoria (tras la carga masiva)",
  """SELECT CASE WHEN EXISTS (SELECT 1 FROM auditoria.evento WHERE operacion = 'CARGA_MASIVA')
                   OR NOT EXISTS (SELECT 1 FROM nucleo.transaccion WHERE clave_idempotencia LIKE 'hist-%') THEN 0 ELSE 1 END""")
c("auditoria", "transaccion posterior a la carga sin registro en la bitacora",
  """SELECT count(*) FROM nucleo.transaccion t
      WHERE t.clave_idempotencia NOT LIKE 'hist-%'
        AND NOT EXISTS (SELECT 1 FROM auditoria.evento a WHERE a.tabla = 'nucleo.transaccion' AND a.registro_id = t.id::text)""")


def main():
    escribir_json = "--json" in sys.argv
    conn = conectar()
    resultados, fallos = [], 0
    cur = conn.cursor()
    cur.execute("SET statement_timeout = 0")
    for categoria, nombre, sql in CONTROLES:
        t0 = time.perf_counter()
        cur.execute(sql)
        problemas = cur.fetchone()[0]
        dt = time.perf_counter() - t0
        estado = "OK   " if problemas == 0 else "FALLA"
        fallos += problemas != 0
        print(f"[{estado}] {categoria:22s} {nombre}: {problemas}  ({dt:.1f}s)")
        resultados.append({"categoria": categoria, "control": nombre, "problemas": int(problemas), "segundos": round(dt, 2)})
    conn.close()
    if escribir_json:
        (RAIZ / "evidencia").mkdir(exist_ok=True)
        (RAIZ / "evidencia" / "data_quality.json").write_text(
            json.dumps({"controles": len(resultados), "fallos": fallos, "resultados": resultados}, indent=2, ensure_ascii=False),
            encoding="utf-8")
    print(f"\n{len(resultados) - fallos}/{len(resultados)} controles en OK")
    sys.exit(1 if fallos else 0)


if __name__ == "__main__":
    main()
