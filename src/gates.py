"""Ejecutor de Quality Gates G0..G8 con EVIDENCIA.

Cada criterio se CALCULA (consulta a PostgreSQL, ejecucion de pruebas, lectura de evidencias): ninguno se
declara "PASS" porque "parece funcionar". Un gate es PASS solo si TODOS sus criterios pasan; si algun
criterio no se pudo ejecutar (--sin-pruebas) el gate queda INCOMPLETO, nunca PASS.

    python src/gates.py                 # todo, incluidas las suites de pruebas (varios minutos)
    python src/gates.py --sin-pruebas   # solo criterios estaticos / de base de datos (rapido)
    python src/gates.py --solo G2 G5    # gates concretos

Escribe evidencia/gates.json y docs/GATES.md. Termina con codigo 1 si algun gate no es PASS.
"""
import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
from datetime import datetime

import psycopg2

from config import DSN, RAIZ, conectar
from consultas import leer_consultas

PASS, FAIL, OMITIDO = "PASS", "FAIL", "OMITIDO"
SEMILLA = 20260909
ESQUEMAS = ("nucleo", "auditoria", "seguridad")
CON_PRUEBAS = True


class Gate:
    def __init__(self, id_, nombre, descripcion):
        self.id, self.nombre, self.descripcion, self.criterios = id_, nombre, descripcion, []

    def ok(self, nombre, cond, evidencia=""):
        self.criterios.append({"criterio": nombre, "estado": PASS if cond else FAIL, "evidencia": str(evidencia)})
        return cond

    def omitido(self, nombre, motivo):
        self.criterios.append({"criterio": nombre, "estado": OMITIDO, "evidencia": motivo})

    @property
    def estado(self):
        estados = {c["estado"] for c in self.criterios}
        if FAIL in estados or not self.criterios:
            return FAIL
        return "INCOMPLETO" if OMITIDO in estados else PASS


def ejecutar(cmd, cwd=None, timeout=1800):
    """Ejecuta un comando y devuelve (codigo, salida)."""
    r = subprocess.run(cmd, cwd=cwd or RAIZ, capture_output=True, text=True, encoding="utf-8", errors="replace",
                       timeout=timeout, env={**os.environ, "NODE_ENV": "test", "PYTHONUTF8": "1"})
    return r.returncode, (r.stdout or "") + (r.stderr or "")


def npm():
    return shutil.which("npm") or "npm"


def vitest(carpeta):
    codigo, salida = ejecutar([npm(), "--prefix", carpeta, "test"])
    m = re.search(r"Tests\s+(?:(\d+) failed \| )?(\d+) passed \((\d+)\)", salida)
    return codigo == 0, (f"{m.group(2)} de {m.group(3)} pruebas pasan" if m else salida[-300:])


def q(cur, sql, params=None):
    cur.execute(sql, params)      # params=None: sin formateo (los '%' de un LIKE quedan literales)
    return cur.fetchall()


def q1(cur, sql, params=None):
    return q(cur, sql, params)[0][0]


# ------------------------------------------------------------------------------------------ G0
def g0(cur):
    g = Gate("G0", "Entorno", "El entorno es el exigido y reproducible: versiones, conexiones, secretos fuera del repositorio.")
    ver = q1(cur, "SHOW server_version")
    g.ok("PostgreSQL 16 o superior", int(q1(cur, "SHOW server_version_num")) >= 160000, f"PostgreSQL {ver}")
    g.ok("Python 3.9 o superior", sys.version_info >= (3, 9), sys.version.split()[0])
    codigo, v = ejecutar(["node", "-v"])
    g.ok("Node.js 20 o superior", codigo == 0 and int(v.strip().lstrip("v").split(".")[0]) >= 20, v.strip())
    codigo, v = ejecutar([npm(), "-v"])
    g.ok("npm disponible", codigo == 0, v.strip())

    api = psycopg2.connect(**{**DSN, "user": "lab_api", "password": os.environ.get("LAB_API_PASSWORD", "")})
    ca = api.cursor()
    sup, crol, cdb = q(ca, "SELECT rolsuper, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname = current_user")[0]
    g.ok("El backend se conecta con un rol SIN superusuario / crear roles / crear BD", not (sup or crol or cdb), f"lab_api super={sup} createrole={crol} createdb={cdb}")
    miembro = q1(cur, "SELECT pg_has_role('lab_api', 'rol_lab_app', 'member')")
    g.ok("lab_api hereda unicamente rol_lab_app", miembro, "lab_api es miembro de rol_lab_app")
    try:
        ca.execute("SELECT 1 FROM nucleo.cuenta LIMIT 1")
        acceso = True
    except psycopg2.errors.InsufficientPrivilege:
        acceso = False
    g.ok("lab_api NO puede leer las tablas del nucleo (minimo privilegio)", not acceso, "SELECT sobre nucleo.cuenta -> permiso denegado")
    api.close()

    env = {}
    ruta = RAIZ / ".env"
    if ruta.exists():
        for linea in ruta.read_text(encoding="utf-8").splitlines():
            if "=" in linea and not linea.startswith("#"):
                k, v = linea.split("=", 1)
                env[k.strip()] = v.strip()
    requeridas = ["LAB_DB_PASSWORD", "LAB_API_PASSWORD", "JWT_SECRET", "CARD_PEPPER", "SEED_PASSWORD", "SEED_PIN"]
    g.ok("Variables obligatorias definidas en .env (valores no se muestran)", all(env.get(k) for k in requeridas), ", ".join(f"{k}={'definida' if env.get(k) else 'VACIA'}" for k in requeridas))
    g.ok("JWT_SECRET >= 32 caracteres y CARD_PEPPER >= 16", len(env.get("JWT_SECRET", "")) >= 32 and len(env.get("CARD_PEPPER", "")) >= 16, f"{len(env.get('JWT_SECRET', ''))} / {len(env.get('CARD_PEPPER', ''))} caracteres")
    ejemplo = (RAIZ / ".env.example").read_text(encoding="utf-8")
    con_valor = [l.split("=")[0] for l in ejemplo.splitlines() if "=" in l and not l.startswith("#") and l.split("=", 1)[1].strip()
                 and l.split("=")[0] not in ("LAB_DB_HOST", "LAB_DB_PORT", "LAB_DB_NAME", "LAB_DB_USER", "PORT", "FRONTEND_ORIGIN")]
    g.ok(".env.example no trae credenciales", not con_valor, "claves con valor: " + (", ".join(con_valor) or "ninguna"))
    gi = (RAIZ / ".gitignore").read_text(encoding="utf-8")
    g.ok(".env, node_modules y datos generados estan en .gitignore", all(x in gi for x in (".env", "node_modules/", "datos/", "dist/")), "ver .gitignore")
    g.ok("Semilla reproducible SEED=20260909", "20260909" in (RAIZ / "src" / "masivo.py").read_text(encoding="utf-8")
         and json.loads((RAIZ / "evidencia" / "masivo_hashes.json").read_text())["semilla"] == SEMILLA, "masivo.py y masivo_hashes.json")
    g.ok("Dependencias instaladas (backend y frontend)", (RAIZ / "backend" / "node_modules").exists() and (RAIZ / "frontend" / "node_modules").exists(), "node_modules presentes")
    return g


# ------------------------------------------------------------------------------------------ G1
def g1(cur):
    g = Gate("G1", "Dominio", "El modelo cubre el dominio bancario exigido por el laboratorio.")
    tablas = {r[0] for r in q(cur, "SELECT table_schema || '.' || table_name FROM information_schema.tables WHERE table_schema IN %s AND table_type = 'BASE TABLE'", (ESQUEMAS,))}
    exigidas = ["nucleo.cliente", "nucleo.cuenta", "nucleo.cuenta_titular", "nucleo.producto", "nucleo.oficina", "nucleo.transaccion",
                "nucleo.movimiento", "nucleo.evento_cuenta", "nucleo.tarjeta", "nucleo.llave_brebe", "nucleo.brebe_operacion",
                "nucleo.cierre_diario", "auditoria.evento", "seguridad.usuario", "seguridad.rol", "seguridad.permiso",
                "seguridad.usuario_rol", "seguridad.rol_permiso", "seguridad.sesion"]
    faltan = [t for t in exigidas if t not in tablas]
    g.ok("Entidades del dominio presentes", not faltan, f"{len(tablas)} tablas; faltan: {faltan or 'ninguna'}")

    checks = {}
    for tabla, defn in q(cur, "SELECT conrelid::regclass::text, pg_get_constraintdef(oid) FROM pg_constraint WHERE contype = 'c' AND connamespace::regnamespace::text IN %s", (ESQUEMAS,)):
        checks[tabla] = checks.get(tabla, "") + " " + defn
    def valores(tabla, *vals):
        txt = checks.get(tabla, "")
        return [v for v in vals if f"'{v}'" not in txt]
    for nombre, tabla, vals in [
        ("Productos: ahorro, corriente, nomina y adicional", "nucleo.producto", ("ahorro", "corriente", "nomina", "adicional")),
        ("Tipos de transaccion: consignacion, retiro, transferencia, debito, credito, ajuste y reverso", "nucleo.transaccion", ("deposito", "retiro", "transferencia", "debito", "credito", "ajuste", "reverso")),
        ("Eventos de cuenta: creacion, activacion, bloqueo, desbloqueo, cambio de limites y cierre", "nucleo.evento_cuenta", ("creacion", "activacion", "bloqueo", "desbloqueo", "cambio_limites", "cierre")),
        ("Titularidad: individual, conjunta y empresarial", "nucleo.cuenta", ("individual", "conjunta", "empresarial")),
        ("Estados de cuenta: pendiente, activa, bloqueada y cerrada", "nucleo.cuenta", ("pendiente", "activa", "bloqueada", "cerrada")),
        ("Clientes: persona natural y juridica", "nucleo.cliente", ("natural", "juridica")),
        ("Canales: web, cajero, atm, brebe y sistema", "nucleo.transaccion", ("web", "cajero", "atm", "brebe", "sistema")),
    ]:
        f = valores(tabla, *vals)
        g.ok(nombre, not f, f"{tabla}: " + ("completo" if not f else f"faltan {f}"))
    roles = {r[0] for r in q(cur, "SELECT codigo FROM seguridad.rol")}
    g.ok("Roles ADMIN, CAJERO, AUDITOR y CLIENTE", {"ADMIN", "CAJERO", "AUDITOR", "CLIENTE"} <= roles, sorted(roles))
    g.ok("Transacciones POSTED inmutables (el estado solo admite POSTED)", "'POSTED'" in checks.get("nucleo.transaccion", ""), "CHECK estado = 'POSTED'")
    g.ok("Documento de dominio presente", (RAIZ / "docs" / "DOMINIO.md").exists(), "docs/DOMINIO.md")
    return g


# ------------------------------------------------------------------------------------------ G2
def g2(cur):
    g = Gate("G2", "Modelo", "Modelo relacional correcto: llaves, restricciones, tipos exactos para dinero y fechas.")
    sin_pk = [r[0] for r in q(cur, """SELECT n.nspname || '.' || c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind = 'r' AND n.nspname IN %s AND NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conrelid = c.oid AND k.contype = 'p')""", (ESQUEMAS,))]
    g.ok("Toda tabla tiene PRIMARY KEY", not sin_pk, f"sin PK: {sin_pk or 'ninguna'}")
    cont = dict(q(cur, "SELECT contype, count(*) FROM pg_constraint WHERE connamespace::regnamespace::text IN %s GROUP BY 1", (ESQUEMAS,)))
    for tipo, nombre in (("p", "PRIMARY KEY"), ("f", "FOREIGN KEY"), ("u", "UNIQUE"), ("c", "CHECK")):
        g.ok(f"Restricciones {nombre} definidas", cont.get(tipo, 0) > 0, f"{cont.get(tipo, 0)} restricciones")
    notnull = q1(cur, "SELECT count(*) FROM information_schema.columns WHERE table_schema IN %s AND is_nullable = 'NO'", (ESQUEMAS,))
    g.ok("Columnas NOT NULL", notnull > 0, f"{notnull} columnas")
    defaults = q1(cur, "SELECT count(*) FROM information_schema.columns WHERE table_schema IN %s AND column_default IS NOT NULL", (ESQUEMAS,))
    g.ok("Columnas con DEFAULT", defaults > 0, f"{defaults} columnas")
    malos = [r for r in q(cur, "SELECT table_name || '.' || column_name || ' ' || data_type FROM information_schema.columns WHERE table_schema IN %s AND data_type IN ('real', 'double precision')", (ESQUEMAS,))]
    g.ok("NINGUNA columna FLOAT/REAL (dinero exacto)", not malos, f"columnas float: {malos or 'ninguna'}")
    dinero = q(cur, r"""SELECT table_name || '.' || column_name, data_type FROM information_schema.columns
        WHERE table_schema IN %s AND column_name ~ '^(monto|saldo|saldo_.*|limite_.*|sobregiro.*|total_.*)$'""", (ESQUEMAS,))
    no_num = [c for c, t in dinero if t != "numeric"]
    g.ok("Todo campo monetario es NUMERIC", dinero and not no_num, f"{len(dinero)} columnas monetarias; no numericas: {no_num or 'ninguna'}")
    sin_tz = [r[0] for r in q(cur, "SELECT table_name || '.' || column_name FROM information_schema.columns WHERE table_schema IN %s AND data_type = 'timestamp without time zone'", (ESQUEMAS,))]
    g.ok("Todo instante es TIMESTAMPTZ", not sin_tz, f"timestamp sin zona: {sin_tz or 'ninguno'}")
    idx = q1(cur, "SELECT count(*) FROM pg_indexes WHERE schemaname IN %s AND indexname LIKE 'idx_%%'", (ESQUEMAS,))
    g.ok("Indices secundarios definidos", idx > 0, f"{idx} indices (cada uno justificado en docs/RENDIMIENTO.md)")
    dup = q(cur, """SELECT array_agg(i.indexrelid::regclass::text) FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname IN %s
        GROUP BY i.indrelid, i.indkey, i.indpred::text, i.indexprs::text HAVING count(*) > 1""", (ESQUEMAS,))
    g.ok("Sin indices duplicados", not dup, f"duplicados: {dup or 'ninguno'}")
    g.ok("Modelo documentado", (RAIZ / "docs" / "ARQUITECTURA.md").exists(), "docs/ARQUITECTURA.md")
    return g


# ------------------------------------------------------------------------------------------ G3
def g3(cur):
    g = Gate("G3", "PostgreSQL", "El motor protege la integridad: funciones, procedimientos, triggers, roles y permisos.")
    n_fn = q1(cur, "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname IN ('api','nucleo','auditoria','seguridad') AND p.prokind = 'f'")
    n_pr = q1(cur, "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname IN ('api','nucleo','auditoria','seguridad') AND p.prokind = 'p'")
    n_tg = q1(cur, "SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE NOT t.tgisinternal AND n.nspname IN %s", (ESQUEMAS,))
    n_vw = q1(cur, "SELECT count(*) FROM pg_views WHERE schemaname = 'api'")
    g.ok("Funciones PL/pgSQL", n_fn >= 20, f"{n_fn} funciones")
    g.ok("Procedimientos almacenados (CALL)", n_pr >= 1, f"{n_pr} procedimiento(s): api.cerrar_dia")
    g.ok("Triggers", n_tg >= 15, f"{n_tg} triggers")
    g.ok("Vistas de la capa api", n_vw >= 10, f"{n_vw} vistas")
    dif = q1(cur, "SELECT count(*) FROM pg_trigger WHERE tgname = 'tg_movimiento_balance' AND tgdeferrable AND tginitdeferred")
    g.ok("Partida doble verificada por un constraint trigger DIFERIDO (al COMMIT)", dif == 1, "tg_movimiento_balance DEFERRABLE INITIALLY DEFERRED")
    inmut = {t: q1(cur, "SELECT count(*) FROM pg_trigger WHERE tgrelid = %s::regclass AND tgname LIKE %s", (t, "%inmutable%")) for t in
             ("nucleo.movimiento", "nucleo.transaccion", "auditoria.evento", "nucleo.evento_cuenta", "nucleo.cierre_diario")}
    g.ok("Historial inmutable: UPDATE/DELETE bloqueados por trigger", all(v >= 1 for v in inmut.values()), inmut)
    sin_path = [r[0] for r in q(cur, """SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'api' AND p.prosecdef AND NOT EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=%%')""")]
    g.ok("Toda funcion SECURITY DEFINER fija search_path (anti-secuestro)", not sin_path, f"sin search_path: {sin_path or 'ninguna'}")
    expuestas = [r[0] for r in q(cur, """SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'api' AND has_function_privilege('public', p.oid, 'EXECUTE')""")]
    g.ok("Ninguna funcion de api es ejecutable por PUBLIC", not expuestas, f"expuestas: {expuestas or 'ninguna'}")
    abiertos = [s for s in ("nucleo", "auditoria", "seguridad", "api") if q1(cur, "SELECT has_schema_privilege('public', %s, 'USAGE')", (s,))]
    g.ok("PUBLIC no tiene acceso a ningun esquema", not abiertos, f"abiertos: {abiertos or 'ninguno'}")
    roles = {r[0]: (r[1]) for r in q(cur, "SELECT rolname, rolcanlogin FROM pg_roles WHERE rolname LIKE 'rol_lab_%'")}
    g.ok("Roles de aplicacion sin login (NOLOGIN)", len(roles) == 3 and not any(roles.values()), roles)
    g.ok("La aplicacion no puede tocar tablas del nucleo ni de seguridad",
         not q1(cur, "SELECT has_table_privilege('rol_lab_app', 'nucleo.cuenta', 'SELECT') OR has_table_privilege('rol_lab_app', 'seguridad.usuario', 'SELECT')"),
         "rol_lab_app sin SELECT en nucleo.cuenta ni seguridad.usuario")
    if CON_PRUEBAS:
        codigo, salida = ejecutar([sys.executable, "-X", "utf8", "tests/ejecutar_pruebas.py"])
        informe = json.loads((RAIZ / "evidencia" / "informe_pruebas.json").read_text(encoding="utf-8"))
        g.ok("Suite SQL/Python (integridad, dinero, concurrencia, seguridad, dominio, cierre, consultas) en verde",
             codigo == 0 and informe["exitoso"], f"{informe['ejecutadas']} pruebas, {informe['fallos']} fallos, {informe['errores']} errores ({informe['duracion_s']} s)")
    else:
        g.omitido("Suite SQL/Python en verde", "no se ejecutaron las pruebas (--sin-pruebas)")
    return g


# ------------------------------------------------------------------------------------------ G4
def g4(cur):
    g = Gate("G4", "Datos", "Datos sinteticos a escala, reproducibles y con distribuciones realistas (no uniformes).")
    n_cli = q1(cur, "SELECT count(*) FROM nucleo.cliente WHERE correo LIKE '%%@correo-sintetico.test'")
    n_cta = q1(cur, "SELECT count(*) FROM nucleo.cuenta c JOIN nucleo.cliente cl ON cl.id = c.cliente_id WHERE cl.correo LIKE '%%@correo-sintetico.test'")
    n_tx = q1(cur, "SELECT count(*) FROM nucleo.transaccion WHERE clave_idempotencia LIKE 'hist-%%'")
    g.ok("10.000 clientes de la carga masiva", n_cli == 10_000, f"{n_cli}")
    g.ok("50.000 cuentas de la carga masiva", n_cta == 50_000, f"{n_cta}")
    g.ok("1.000.000 de transacciones de la carga masiva", n_tx == 1_000_000, f"{n_tx}")
    ev = q(cur, "SELECT despues FROM auditoria.evento WHERE operacion = 'CARGA_MASIVA' ORDER BY id DESC LIMIT 1")
    h = json.loads((RAIZ / "evidencia" / "masivo_hashes.json").read_text(encoding="utf-8"))
    g.ok("La carga quedo registrada en la bitacora con la semilla y los SHA-256", bool(ev) and ev[0][0]["semilla"] == SEMILLA and ev[0][0]["sha256"] == h["sha256"],
         f"semilla {ev[0][0]['semilla']}" if ev else "sin evento CARGA_MASIVA")
    dir_ = RAIZ / "datos" / "masivo"
    if dir_.exists() and all((dir_ / f).exists() for f in h["sha256"]):
        distintos = [f for f, hs in h["sha256"].items() if hashlib.sha256((dir_ / f).read_bytes()).hexdigest() != hs]
        g.ok("Los archivos generados coinciden byte a byte con los SHA-256 registrados (reproducible)", not distintos, f"{len(h['sha256'])} archivos; distintos: {distintos or 'ninguno'}")
    else:
        g.omitido("Archivos generados coinciden con sus SHA-256", "datos/masivo no esta en disco (se regenera con python src/masivo.py --solo-generar)")

    # Distribuciones: se recalcula con estadisticas.py
    (RAIZ / "evidencia" / "distribuciones.json").unlink(missing_ok=True)   # nunca se acepta evidencia de una corrida anterior
    codigo, salida = ejecutar([sys.executable, "-X", "utf8", "src/estadisticas.py"])
    g.ok("estadisticas.py se ejecuta sin errores (evidencia recien generada)", codigo == 0 and (RAIZ / "evidencia" / "distribuciones.json").exists(), f"codigo {codigo}")
    if codigo != 0 or not (RAIZ / "evidencia" / "distribuciones.json").exists():
        return g
    d = json.loads((RAIZ / "evidencia" / "distribuciones.json").read_text(encoding="utf-8"))
    g.ok("Departamentos: distribucion NO uniforme (chi-cuadrado)", d["clientes_por_departamento"]["uniformidad"]["rechaza_uniformidad"] and d["clientes_por_departamento"]["razon_max_min"] > 20,
         f"chi2={d['clientes_por_departamento']['uniformidad']['chi2']}, razon max/min={d['clientes_por_departamento']['razon_max_min']}")
    g.ok("Cuentas por cliente: cola pesada", d["cuentas_por_cliente"]["max"] >= 10 * d["cuentas_por_cliente"]["mediana"] / 2 and d["cuentas_por_cliente"]["gini"] > 0.3,
         f"mediana={d['cuentas_por_cliente']['mediana']} p99={d['cuentas_por_cliente']['p99']} max={d['cuentas_por_cliente']['max']} gini={d['cuentas_por_cliente']['gini']}")
    g.ok("Actividad por cuenta concentrada (Gini alto)", d["actividad_por_cuenta"]["gini"] > 0.5, f"gini={d['actividad_por_cuenta']['gini']}; el 10% mas activo concentra {d['actividad_por_cuenta']['participacion_del_10pct_mas_activo']:.0%}")
    for clave, nombre in (("horario", "Horario"), ("dia_de_semana", "Dia de la semana"), ("mes", "Mes"), ("dia_del_mes", "Dia del mes")):
        g.ok(f"{nombre}: distribucion NO uniforme", d[clave]["uniformidad"]["rechaza_uniformidad"], f"chi2={d[clave]['uniformidad']['chi2']} (critico {d[clave]['uniformidad']['critico_0.001']})")
    montos = d["montos_cop_por_tipo"]
    razones = {k: round(v["p99"] / v["p50"], 1) for k, v in montos.items()}
    # Los creditos (nomina) estan concentrados por naturaleza; basta con que TODOS los tipos tengan dispersion real
    # (no montos constantes) y que la mayoria tenga cola larga.
    g.ok("Montos log-normales: todos dispersos (p99 > 2x mediana) y la mayoria con cola larga (p99 > 4x)",
         all(r > 2 for r in razones.values()) and sum(r > 4 for r in razones.values()) >= len(razones) - 2, f"p99/p50 por tipo: {razones}")
    g.ok("Estados variados (cuentas y clientes)", len(d["estados_cuenta"]) == 4 and len(d["estados_cliente"]) == 3, f"cuentas {d['estados_cuenta']}; clientes {d['estados_cliente']}")
    g.ok("Persona natural y juridica; tres titularidades", len(d["tipo_persona"]) == 2 and len(d["tipo_titularidad"]) == 3, f"{d['tipo_persona']} / {d['tipo_titularidad']}")
    reales = q1(cur, "SELECT count(*) FROM nucleo.cliente WHERE tipo_documento <> 'SIS' AND correo !~ '\\.test$'")
    g.ok("Sin PII real: todos los correos usan el TLD reservado .test", reales == 0, f"correos fuera de .test: {reales}")
    return g


# ------------------------------------------------------------------------------------------ G5
def g5(cur):
    g = Gate("G5", "Consultas", "30 consultas SQL (10 basicas, 10 intermedias, 10 avanzadas), correctas y ejecutables.")
    todas = leer_consultas()
    por_nivel = {n: len(leer_consultas(n)) for n in ("basica", "intermedia", "avanzada")}
    g.ok("30 consultas: 10 basicas, 10 intermedias y 10 avanzadas", len(todas) == 30 and set(por_nivel.values()) == {10}, por_nivel)
    cur.execute("SET statement_timeout = 0")
    lentas, vacias, tiempos = [], [], {}
    for c in todas:
        t0 = time.perf_counter()
        cur.execute(c["sql"])
        filas = cur.fetchall()
        dt = time.perf_counter() - t0
        tiempos[c["nombre"]] = round(dt * 1000)
        if not filas:
            vacias.append(c["nombre"])
        if dt > 10:
            lentas.append(c["nombre"])
    g.ok("Las 30 se ejecutan y devuelven filas", not vacias, f"sin filas: {vacias or 'ninguna'}")
    g.ok("Ninguna tarda mas de 10 s sobre 1.000.000 de transacciones", not lentas, f"mas lenta: {max(tiempos, key=tiempos.get)} = {max(tiempos.values())} ms")
    texto = "\n".join(c["sql"].lower() for c in leer_consultas("avanzada"))
    for nombre, patron in {"funciones de ventana": r"\bover\s*\(", "ranking (RANK / DENSE_RANK / NTILE)": r"\b(rank|dense_rank|ntile)\s*\(",
                           "percentiles (percentile_cont)": r"percentile_cont", "acumulados (SUM OVER ORDER BY)": r"sum\([^)]*\)\s+over\s*\(\s*order by",
                           "cohortes": r"cohorte", "deteccion de anomalias (desviacion estandar / z-score)": r"stddev"}.items():
        g.ok(f"Avanzadas usan: {nombre}", bool(re.search(patron, texto)), "presente en el catalogo")
    if CON_PRUEBAS:
        codigo, salida = ejecutar([sys.executable, "-X", "utf8", "-m", "unittest", "pruebas_consultas"], cwd=RAIZ / "tests")
        m = re.search(r"Ran (\d+) tests", salida)
        g.ok("Correctitud contrastada con calculos independientes (Python / otra via SQL)", codigo == 0 and "skipped" not in salida,
             f"{m.group(1) if m else '?'} pruebas de consultas" + (" (HAY PRUEBAS OMITIDAS)" if "skipped" in salida else ""))
    else:
        g.omitido("Correctitud de las consultas", "no se ejecutaron las pruebas (--sin-pruebas)")
    (RAIZ / "evidencia" / "consultas_tiempos.json").write_text(json.dumps(tiempos, indent=2), encoding="utf-8")
    return g


# ------------------------------------------------------------------------------------------ G6
def g6(cur):
    from compuertas import CONTROLES
    g = Gate("G6", "Data Quality", "0 duplicados criticos, 0 huerfanos, 0 transacciones imposibles, ledger 100% balanceado, 0 diferencias de saldo.")
    cur.execute("SET statement_timeout = 0")
    resultados = {}
    for categoria, nombre, sql in CONTROLES:
        cur.execute(sql)
        resultados[(categoria, nombre)] = cur.fetchone()[0]
    por_cat = {}
    for (cat, nom), n in resultados.items():
        por_cat.setdefault(cat, []).append(n)
    exigidas = {"integridad_referencial": "Integridad referencial (0 huerfanos)", "unicidad": "Unicidad (0 duplicados criticos)",
                "financiera": "Consistencia financiera (partida doble, conciliacion, limites, reversos)", "temporal": "Consistencia temporal",
                "geografica": "Consistencia geografica", "validez": "Validez de reglas de negocio", "auditoria": "Auditoria"}
    for cat, nombre in exigidas.items():
        vals = por_cat.get(cat, [])
        g.ok(nombre, bool(vals) and sum(vals) == 0, f"{len(vals)} controles, {sum(vals)} filas problematicas")
    g.ok("Ledger 100% balanceado", resultados[("financiera", "doble partida: transaccion con debitos <> creditos")] == 0, "0 transacciones con debitos <> creditos")
    g.ok("0 diferencias de saldo sin explicar", resultados[("financiera", "conciliacion: saldo <> suma de movimientos")] == 0
         and resultados[("financiera", "invariante global: la suma de TODOS los saldos de cada moneda debe ser cero")] == 0, "conciliacion por cuenta + suma global = 0")
    g.ok(f"Los {len(CONTROLES)} controles dan 0", sum(resultados.values()) == 0, f"{len(CONTROLES)} controles ejecutados")
    if CON_PRUEBAS:
        codigo, salida = ejecutar([sys.executable, "-X", "utf8", "-m", "unittest", "tests.pruebas_calidad"])
        m = re.search(r"Ran (\d+) tests", salida)
        g.ok("Los controles probados DETECTAN corrupcion (pruebas de mutacion; no cubren todos los controles)", codigo == 0 and "skipped" not in salida,
             f"{m.group(1) if m else '?'} mutaciones detectadas" + (" (HAY PRUEBAS OMITIDAS)" if "skipped" in salida else ""))
    else:
        g.omitido("Pruebas de mutacion de los controles", "no se ejecutaron las pruebas (--sin-pruebas)")
    (RAIZ / "evidencia").mkdir(exist_ok=True)
    (RAIZ / "evidencia" / "data_quality.json").write_text(json.dumps(
        {"controles": len(CONTROLES), "fallos": sum(1 for v in resultados.values() if v),
         "resultados": [{"categoria": c, "control": n, "problemas": int(v)} for (c, n), v in resultados.items()]}, indent=2, ensure_ascii=False), encoding="utf-8")
    return g


# ------------------------------------------------------------------------------------------ G7
def g7(cur):
    g = Gate("G7", "Performance + Seguridad", "Rendimiento medido con EXPLAIN antes/despues e indices justificados; seguridad verificada.")
    ruta = RAIZ / "evidencia" / "rendimiento.json"
    rend = json.loads(ruta.read_text(encoding="utf-8")) if ruta.exists() else {"experimentos": []}
    exp = rend["experimentos"]
    g.ok("Al menos 5 consultas criticas con EXPLAIN (ANALYZE, BUFFERS) antes y despues", len(exp) >= 5 and all((RAIZ / "evidencia" / "explain" / f"{e['id']}_{x}.txt").exists() for e in exp for x in ("antes", "despues")),
         f"{len(exp)} experimentos con plan antes y despues en evidencia/explain/")
    adopt = [e for e in exp if e["veredicto"].startswith(("CONSERVAR", "ADOPTAR"))]
    umbral = rend.get("umbral", {})
    # Indices: reduccion de paginas >= 3x y ahorro >= 256 (determinista). Parametros/reescrituras: mejora de tiempo >= 3x.
    def supera(e):
        if e["indice"].startswith("idx_"):
            return e["antes"]["paginas"] >= 3 * max(e["despues"]["paginas"], 1) and e["antes"]["paginas"] - e["despues"]["paginas"] >= umbral.get("paginas", 256)
        return e["mejora_x"] >= 3
    g.ok("Las mejoras adoptadas superan el umbral (indices: >= 3x y >= 256 paginas; reescrituras/parametros: >= 3x)",
         bool(adopt) and all(supera(e) for e in adopt if "estructural" not in e["veredicto"]),
         f"{len(adopt)} adoptadas; mejora en tiempo de x{min(e['mejora_x'] for e in adopt):g} a x{max(e['mejora_x'] for e in adopt):g}")
    vivos = {r[0].split(".")[1] for r in q(cur, "SELECT schemaname || '.' || indexname FROM pg_indexes WHERE schemaname IN %s AND indexname LIKE 'idx_%%'", (ESQUEMAS,))}
    justificados = set()
    for e in adopt:
        justificados |= set(re.findall(r"idx_\w+", e["indice"] + " " + e["ddl"]))
    sin_justificar = sorted(vivos - justificados)
    g.ok("TODO indice secundario existente tiene un experimento que lo justifica (sin indices indiscriminados)", not sin_justificar, f"{len(vivos)} indices; sin justificar: {sin_justificar or 'ninguno'}")
    descartados = [e for e in exp if e["veredicto"].startswith("DESCARTAR")]
    reaparecen = sorted({i for e in descartados for i in re.findall(r"idx_\w+", e["indice"])} & vivos)
    g.ok("Los indices descartados por la medicion no existen", not reaparecen, f"descartados: {[e['indice'] for e in descartados]}; presentes: {reaparecen or 'ninguno'}")
    lat = RAIZ / "evidencia" / "latencia_api.json"
    if lat.exists():
        d = json.loads(lat.read_text(encoding="utf-8"))
        peor = max(d["lecturas"].items(), key=lambda kv: kv[1]["mediana_ms"])
        g.ok("Latencia de lectura de la API: mediana < 100 ms en todos los endpoints (1 M de transacciones)", all(v["mediana_ms"] < 100 and v["status"] == 200 for v in d["lecturas"].values()),
             f"{len(d['lecturas'])} endpoints; el mas lento: {peor[0]} = {peor[1]['mediana_ms']} ms")
        g.ok("Concurrencia: 0 errores con 8 trabajadores simultaneos", all(v["errores"] == 0 for v in d["concurrencia"].values()), d["concurrencia"])
    else:
        g.ok("Latencia de la API medida", False, "falta evidencia/latencia_api.json (npm --prefix backend run latencia)")

    # --- Seguridad
    malos = q1(cur, "SELECT count(*) FROM seguridad.usuario WHERE password_hash !~ '^\\$2[aby]\\$[0-9]{2}\\$.{53}$'")
    g.ok("Contrasenas almacenadas solo como hash bcrypt", malos == 0, f"usuarios con hash invalido: {malos}")
    malos = q1(cur, "SELECT count(*) FROM nucleo.tarjeta WHERE pin_hash !~ '^\\$2[aby]\\$[0-9]{2}\\$.{53}$' OR numero_hash !~ '^[0-9a-f]{64}$'")
    g.ok("PIN solo como hash bcrypt y numero de tarjeta solo como HMAC", malos == 0, f"tarjetas incorrectas: {malos}")
    fugas = q1(cur, "SELECT count(*) FROM auditoria.evento WHERE despues::text ~ 'password_hash|pin_hash|numero_hash' OR antes::text ~ 'password_hash|pin_hash|numero_hash'")
    g.ok("Los hashes nunca se copian a la bitacora de auditoria", fugas == 0, f"eventos con hashes: {fugas}")

    env = {}
    for linea in (RAIZ / ".env").read_text(encoding="utf-8").splitlines():
        if "=" in linea and not linea.startswith("#"):
            k, v = linea.split("=", 1)
            env[k.strip()] = v.strip()
    secretos = [env[k] for k in ("LAB_DB_PASSWORD", "LAB_API_PASSWORD", "JWT_SECRET", "CARD_PEPPER", "SEED_PASSWORD") if len(env.get(k, "")) >= 8]
    excluir = {"node_modules", "datos", "evidencia", "dist", ".git", "lab_banco", "__pycache__", ".claude"}
    revisados, hallazgos = 0, []
    for raiz, dirs, archivos in os.walk(RAIZ):
        dirs[:] = [d for d in dirs if d not in excluir]
        for f in archivos:
            if f in (".env", "package-lock.json") or f.endswith((".zip", ".pyc", ".png", ".ico")):
                continue
            ruta_f = os.path.join(raiz, f)
            try:
                txt = open(ruta_f, encoding="utf-8").read()
            except (UnicodeDecodeError, OSError):
                continue
            revisados += 1
            if any(s in txt for s in secretos):
                hallazgos.append(os.path.relpath(ruta_f, RAIZ))
    g.ok("Ningun secreto del .env aparece en el codigo, scripts ni documentos", not hallazgos, f"{revisados} archivos revisados; con secretos: {hallazgos or 'ninguno'}")

    if CON_PRUEBAS:
        for carpeta, nombre in (("backend", "backend"), ("frontend", "frontend")):
            codigo, salida = ejecutar([npm(), "--prefix", carpeta, "audit", "--omit=dev"])
            g.ok(f"Dependencias del {nombre} sin vulnerabilidades conocidas (npm audit)", codigo == 0, "found 0 vulnerabilities" if codigo == 0 else salida[-200:])
        ok, ev = vitest("backend")
        g.ok("Pruebas del backend: autenticacion, RBAC permitido/denegado, SQL injection, errores controlados, dinero, idempotencia y concurrencia", ok, ev)
        ok, ev = vitest("frontend")
        g.ok("Pruebas del frontend: cliente HTTP, proteccion de rutas y login (errores comprensibles)", ok, ev)
        for carpeta in ("backend", "frontend"):
            codigo, salida = ejecutar([npm(), "--prefix", carpeta, "run", "typecheck"])
            g.ok(f"TypeScript del {carpeta} compila sin errores", codigo == 0, "tsc sin errores" if codigo == 0 else salida[-200:])
    else:
        g.omitido("Pruebas del backend, npm audit y compilacion TypeScript", "no se ejecutaron las pruebas (--sin-pruebas)")
    return g


# ------------------------------------------------------------------------------------------ G8
def g8(cur):
    g = Gate("G8", "Defensa", "El proyecto puede explicarse y defenderse: documentacion completa y revision externa (ECC) realizada.")
    readme = (RAIZ / "README.md").read_text(encoding="utf-8").lower() if (RAIZ / "README.md").exists() else ""
    secciones = ["requisitos", "instalaci", "configuraci", "base de datos", "backend", "frontend", "usuarios de prueba", "roles", "endpoints",
                 "pruebas", "quality gates", "ecc", "arquitectura"]
    faltan = [s for s in secciones if s not in readme]
    g.ok("README con las 13 secciones exigidas", not faltan, f"faltan: {faltan or 'ninguna'}")
    for doc in ("ARQUITECTURA.md", "SEGURIDAD.md", "DOMINIO.md", "RENDIMIENTO.md", "GATES.md", "DEFENSA.md", "API.md"):
        g.ok(f"docs/{doc}", (RAIZ / "docs" / doc).exists(), "presente" if (RAIZ / "docs" / doc).exists() else "FALTA")
    ecc = RAIZ / "evidencia" / "ecc"
    informes = sorted(p.name for p in ecc.glob("*.md")) if ecc.exists() else []
    def informe_ok(prefijo):   # nombre exacto pasadaN_*.md, con contenido real
        return any(re.fullmatch(rf"{prefijo}_.+\.md", p.name) and len(p.read_text(encoding="utf-8").strip()) > 200 for p in ecc.glob("*.md")) if ecc.exists() else False
    g.ok("Revision ECC realizada (informe pasada1_*.md con contenido)", informe_ok("pasada1"), informes or "sin informes en evidencia/ecc/")
    g.ok("Segunda revision ECC ejecutada (informe pasada2_*.md con contenido)", informe_ok("pasada2"), informes or "sin informes en evidencia/ecc/")
    return g


GATES = [("G0", g0), ("G1", g1), ("G2", g2), ("G3", g3), ("G4", g4), ("G5", g5), ("G6", g6), ("G7", g7), ("G8", g8)]


def documento(resultado, fecha):
    L = ["# Quality Gates", "",
         "> Documento **generado** por `python src/gates.py`. Cada criterio se calcula (consulta a PostgreSQL, ejecucion de pruebas o lectura de "
         "evidencias); ninguno se declara por apariencia. Un gate es **PASS** solo si todos sus criterios pasan; si alguno no se pudo ejecutar queda "
         "**INCOMPLETO**, nunca PASS.", "", f"Ultima ejecucion: {fecha}", "", "## Resumen", "", "| Gate | Nombre | Criterios | Estado |", "|---|---|---:|---|"]
    for r in resultado:
        ok = sum(1 for c in r["criterios"] if c["estado"] == PASS)
        L.append(f"| {r['id']} | {r['nombre']} | {ok}/{len(r['criterios'])} | **{r['estado']}** |")
    L += ["", "Como ejecutarlo: `python src/gates.py` (completo, con las suites) o `python src/gates.py --sin-pruebas` (solo criterios de base de datos y evidencias).", ""]
    for r in resultado:
        L += [f"## {r['id']} — {r['nombre']}: {r['estado']}", "", f"_{r['descripcion']}_", "", "| Criterio | Estado | Evidencia |", "|---|---|---|"]
        for c in r["criterios"]:
            ev = str(c["evidencia"]).replace("|", "\\|").replace("\n", " ")
            L.append(f"| {c['criterio']} | {'✅ PASS' if c['estado'] == PASS else '❌ FAIL' if c['estado'] == FAIL else '⏭ OMITIDO'} | {ev[:240]} |")
        L.append("")
    return "\n".join(L)


def main():
    global CON_PRUEBAS
    ap = argparse.ArgumentParser()
    ap.add_argument("--sin-pruebas", action="store_true")
    ap.add_argument("--solo", nargs="*", help="ids de gates, p. ej. G2 G5")
    args = ap.parse_args()
    CON_PRUEBAS = not args.sin_pruebas
    if CON_PRUEBAS:   # el cierre diario es un proceso operativo idempotente: se pone al dia antes de verificar
        ejecutar([sys.executable, "-X", "utf8", "src/cerrar_historico.py"])
    conn = conectar(autocommit=True)
    cur = conn.cursor()
    resultado = []

    def escribir():
        fecha = datetime.now().strftime("%Y-%m-%d %H:%M")
        (RAIZ / "evidencia").mkdir(exist_ok=True)
        (RAIZ / "evidencia" / "gates.json").write_text(json.dumps({"fecha": fecha, "gates": resultado}, indent=2, ensure_ascii=False), encoding="utf-8")
        if not args.solo:
            (RAIZ / "docs").mkdir(exist_ok=True)
            (RAIZ / "docs" / "GATES.md").write_text(documento(resultado, fecha), encoding="utf-8")

    if args.solo:
        desconocidos = [s for s in args.solo if s not in dict(GATES)]
        if desconocidos:
            sys.exit(f"Gates desconocidos: {desconocidos}")
    for id_, fn in GATES:
        if args.solo and id_ not in args.solo:
            continue
        if id_ == "G8":
            escribir()      # G8 comprueba que docs/GATES.md exista: se escribe con G0..G7 antes de evaluarlo
        t0 = time.perf_counter()
        try:
            g = fn(cur)
        except Exception as e:  # noqa: BLE001 - un error al ejecutar el gate es un FAIL, nunca se oculta
            g = Gate(id_, id_, "Error al ejecutar el gate")
            g.ok("El gate se ejecuta sin errores", False, f"{type(e).__name__}: {e}")
        d = {"id": g.id, "nombre": g.nombre, "descripcion": g.descripcion, "estado": g.estado, "criterios": g.criterios,
             "segundos": round(time.perf_counter() - t0, 1)}
        resultado.append(d)
        ok = sum(1 for c in g.criterios if c["estado"] == PASS)
        print(f"{g.id} {g.nombre:24s} {g.estado:10s} {ok}/{len(g.criterios)} criterios  ({d['segundos']} s)")
        for c in g.criterios:
            if c["estado"] != PASS:
                print(f"    [{c['estado']}] {c['criterio']} -> {str(c['evidencia'])[:200]}")
    conn.close()
    escribir()
    sys.exit(0 if all(r["estado"] == PASS for r in resultado) else 1)


if __name__ == "__main__":
    main()
