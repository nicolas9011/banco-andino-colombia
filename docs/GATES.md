# Quality Gates

> Documento **generado** por `python src/gates.py`. Cada criterio se calcula (consulta a PostgreSQL, ejecucion de pruebas o lectura de evidencias); ninguno se declara por apariencia. Un gate es **PASS** solo si todos sus criterios pasan; si alguno no se pudo ejecutar queda **INCOMPLETO**, nunca PASS.

Ultima ejecucion: 2026-10-07 23:23

## Resumen

| Gate | Nombre | Criterios | Estado |
|---|---|---:|---|
| G0 | Entorno | 13/13 | **PASS** |
| G1 | Dominio | 11/11 | **PASS** |
| G2 | Modelo | 13/13 | **PASS** |
| G3 | PostgreSQL | 12/12 | **PASS** |
| G4 | Datos | 17/17 | **PASS** |
| G5 | Consultas | 10/10 | **PASS** |
| G6 | Data Quality | 11/11 | **PASS** |
| G7 | Performance + Seguridad | 16/16 | **PASS** |
| G8 | Defensa | 10/10 | **PASS** |

Como ejecutarlo: `python src/gates.py` (completo, con las suites) o `python src/gates.py --sin-pruebas` (solo criterios de base de datos y evidencias).

## G0 — Entorno: PASS

_El entorno es el exigido y reproducible: versiones, conexiones, secretos fuera del repositorio._

| Criterio | Estado | Evidencia |
|---|---|---|
| PostgreSQL 16 o superior | ✅ PASS | PostgreSQL 18.6 |
| Python 3.9 o superior | ✅ PASS | 3.12.10 |
| Node.js 20 o superior | ✅ PASS | v24.19.0 |
| npm disponible | ✅ PASS | 11.17.0 |
| El backend se conecta con un rol SIN superusuario / crear roles / crear BD | ✅ PASS | lab_api super=False createrole=False createdb=False |
| lab_api hereda unicamente rol_lab_app | ✅ PASS | lab_api es miembro de rol_lab_app |
| lab_api NO puede leer las tablas del nucleo (minimo privilegio) | ✅ PASS | SELECT sobre nucleo.cuenta -> permiso denegado |
| Variables obligatorias definidas en .env (valores no se muestran) | ✅ PASS | LAB_DB_PASSWORD=definida, LAB_API_PASSWORD=definida, JWT_SECRET=definida, CARD_PEPPER=definida, SEED_PASSWORD=definida, SEED_PIN=definida |
| JWT_SECRET >= 32 caracteres y CARD_PEPPER >= 16 | ✅ PASS | 62 / 48 caracteres |
| .env.example no trae credenciales | ✅ PASS | claves con valor: ninguna |
| .env, node_modules y datos generados estan en .gitignore | ✅ PASS | ver .gitignore |
| Semilla reproducible SEED=20260909 | ✅ PASS | masivo.py y masivo_hashes.json |
| Dependencias instaladas (backend y frontend) | ✅ PASS | node_modules presentes |

## G1 — Dominio: PASS

_El modelo cubre el dominio bancario exigido por el laboratorio._

| Criterio | Estado | Evidencia |
|---|---|---|
| Entidades del dominio presentes | ✅ PASS | 19 tablas; faltan: ninguna |
| Productos: ahorro, corriente, nomina y adicional | ✅ PASS | nucleo.producto: completo |
| Tipos de transaccion: consignacion, retiro, transferencia, debito, credito, ajuste y reverso | ✅ PASS | nucleo.transaccion: completo |
| Eventos de cuenta: creacion, activacion, bloqueo, desbloqueo, cambio de limites y cierre | ✅ PASS | nucleo.evento_cuenta: completo |
| Titularidad: individual, conjunta y empresarial | ✅ PASS | nucleo.cuenta: completo |
| Estados de cuenta: pendiente, activa, bloqueada y cerrada | ✅ PASS | nucleo.cuenta: completo |
| Clientes: persona natural y juridica | ✅ PASS | nucleo.cliente: completo |
| Canales: web, cajero, atm, brebe y sistema | ✅ PASS | nucleo.transaccion: completo |
| Roles ADMIN, CAJERO, AUDITOR y CLIENTE | ✅ PASS | ['ADMIN', 'AUDITOR', 'CAJERO', 'CLIENTE'] |
| Transacciones POSTED inmutables (el estado solo admite POSTED) | ✅ PASS | CHECK estado = 'POSTED' |
| Documento de dominio presente | ✅ PASS | docs/DOMINIO.md |

## G2 — Modelo: PASS

_Modelo relacional correcto: llaves, restricciones, tipos exactos para dinero y fechas._

| Criterio | Estado | Evidencia |
|---|---|---|
| Toda tabla tiene PRIMARY KEY | ✅ PASS | sin PK: ninguna |
| Restricciones PRIMARY KEY definidas | ✅ PASS | 19 restricciones |
| Restricciones FOREIGN KEY definidas | ✅ PASS | 27 restricciones |
| Restricciones UNIQUE definidas | ✅ PASS | 10 restricciones |
| Restricciones CHECK definidas | ✅ PASS | 57 restricciones |
| Columnas NOT NULL | ✅ PASS | 114 columnas |
| Columnas con DEFAULT | ✅ PASS | 50 columnas |
| NINGUNA columna FLOAT/REAL (dinero exacto) | ✅ PASS | columnas float: ninguna |
| Todo campo monetario es NUMERIC | ✅ PASS | 13 columnas monetarias; no numericas: ninguna |
| Todo instante es TIMESTAMPTZ | ✅ PASS | timestamp sin zona: ninguno |
| Indices secundarios definidos | ✅ PASS | 12 indices (cada uno justificado en docs/RENDIMIENTO.md) |
| Sin indices duplicados | ✅ PASS | duplicados: ninguno |
| Modelo documentado | ✅ PASS | docs/ARQUITECTURA.md |

## G3 — PostgreSQL: PASS

_El motor protege la integridad: funciones, procedimientos, triggers, roles y permisos._

| Criterio | Estado | Evidencia |
|---|---|---|
| Funciones PL/pgSQL | ✅ PASS | 39 funciones |
| Procedimientos almacenados (CALL) | ✅ PASS | 1 procedimiento(s): api.cerrar_dia |
| Triggers | ✅ PASS | 29 triggers |
| Vistas de la capa api | ✅ PASS | 18 vistas |
| Partida doble verificada por un constraint trigger DIFERIDO (al COMMIT) | ✅ PASS | tg_movimiento_balance DEFERRABLE INITIALLY DEFERRED |
| Historial inmutable: UPDATE/DELETE bloqueados por trigger | ✅ PASS | {'nucleo.movimiento': 1, 'nucleo.transaccion': 1, 'auditoria.evento': 1, 'nucleo.evento_cuenta': 1, 'nucleo.cierre_diario': 1} |
| Toda funcion SECURITY DEFINER fija search_path (anti-secuestro) | ✅ PASS | sin search_path: ninguna |
| Ninguna funcion de api es ejecutable por PUBLIC | ✅ PASS | expuestas: ninguna |
| PUBLIC no tiene acceso a ningun esquema | ✅ PASS | abiertos: ninguno |
| Roles de aplicacion sin login (NOLOGIN) | ✅ PASS | {'rol_lab_app': False, 'rol_lab_lectura': False, 'rol_lab_auditor': False} |
| La aplicacion no puede tocar tablas del nucleo ni de seguridad | ✅ PASS | rol_lab_app sin SELECT en nucleo.cuenta ni seguridad.usuario |
| Suite SQL/Python (integridad, dinero, concurrencia, seguridad, dominio, cierre, consultas) en verde | ✅ PASS | 117 pruebas, 0 fallos, 0 errores (83.231 s) |

## G4 — Datos: PASS

_Datos sinteticos a escala, reproducibles y con distribuciones realistas (no uniformes)._

| Criterio | Estado | Evidencia |
|---|---|---|
| 10.000 clientes de la carga masiva | ✅ PASS | 10000 |
| 50.000 cuentas de la carga masiva | ✅ PASS | 50000 |
| 1.000.000 de transacciones de la carga masiva | ✅ PASS | 1000000 |
| La carga quedo registrada en la bitacora con la semilla y los SHA-256 | ✅ PASS | semilla 20260909 |
| Los archivos generados coinciden byte a byte con los SHA-256 registrados (reproducible) | ✅ PASS | 8 archivos; distintos: ninguno |
| estadisticas.py se ejecuta sin errores (evidencia recien generada) | ✅ PASS | codigo 0 |
| Departamentos: distribucion NO uniforme (chi-cuadrado) | ✅ PASS | chi2=17611.8, razon max/min=211.2 |
| Cuentas por cliente: cola pesada | ✅ PASS | mediana=3 p99=35 max=90 gini=0.4943 |
| Actividad por cuenta concentrada (Gini alto) | ✅ PASS | gini=0.701; el 10% mas activo concentra 56% |
| Horario: distribucion NO uniforme | ✅ PASS | chi2=339318.2 (critico 49.8) |
| Dia de la semana: distribucion NO uniforme | ✅ PASS | chi2=99228.4 (critico 22.7) |
| Mes: distribucion NO uniforme | ✅ PASS | chi2=39358.6 (critico 31.4) |
| Dia del mes: distribucion NO uniforme | ✅ PASS | chi2=64404.5 (critico 59.8) |
| Montos log-normales: todos dispersos (p99 > 2x mediana) y la mayoria con cola larga (p99 > 4x) | ✅ PASS | p99/p50 por tipo: {'ajuste': 6.3, 'credito': 2.8, 'debito': 36.7, 'deposito': 21.0, 'retiro': 5.1, 'reverso': 12.4, 'transferencia': 11.9} |
| Estados variados (cuentas y clientes) | ✅ PASS | cuentas {'activa': 45596, 'cerrada': 2607, 'pendiente': 1253, 'bloqueada': 1117}; clientes {'activo': 10207, 'inactivo': 300, 'bloqueado': 100} |
| Persona natural y juridica; tres titularidades | ✅ PASS | {'natural': 9407, 'juridica': 1200} / {'empresarial': 18496, 'individual': 30655, 'conjunta': 1422} |
| Sin PII real: todos los correos usan el TLD reservado .test | ✅ PASS | correos fuera de .test: 0 |

## G5 — Consultas: PASS

_30 consultas SQL (10 basicas, 10 intermedias, 10 avanzadas), correctas y ejecutables._

| Criterio | Estado | Evidencia |
|---|---|---|
| 30 consultas: 10 basicas, 10 intermedias y 10 avanzadas | ✅ PASS | {'basica': 10, 'intermedia': 10, 'avanzada': 10} |
| Las 30 se ejecutan y devuelven filas | ✅ PASS | sin filas: ninguna |
| Ninguna tarda mas de 10 s sobre 1.000.000 de transacciones | ✅ PASS | mas lenta: i03_operaciones_por_mes = 1277 ms |
| Avanzadas usan: funciones de ventana | ✅ PASS | presente en el catalogo |
| Avanzadas usan: ranking (RANK / DENSE_RANK / NTILE) | ✅ PASS | presente en el catalogo |
| Avanzadas usan: percentiles (percentile_cont) | ✅ PASS | presente en el catalogo |
| Avanzadas usan: acumulados (SUM OVER ORDER BY) | ✅ PASS | presente en el catalogo |
| Avanzadas usan: cohortes | ✅ PASS | presente en el catalogo |
| Avanzadas usan: deteccion de anomalias (desviacion estandar / z-score) | ✅ PASS | presente en el catalogo |
| Correctitud contrastada con calculos independientes (Python / otra via SQL) | ✅ PASS | 24 pruebas de consultas |

## G6 — Data Quality: PASS

_0 duplicados criticos, 0 huerfanos, 0 transacciones imposibles, ledger 100% balanceado, 0 diferencias de saldo._

| Criterio | Estado | Evidencia |
|---|---|---|
| Integridad referencial (0 huerfanos) | ✅ PASS | 16 controles, 0 filas problematicas |
| Unicidad (0 duplicados criticos) | ✅ PASS | 6 controles, 0 filas problematicas |
| Consistencia financiera (partida doble, conciliacion, limites, reversos) | ✅ PASS | 18 controles, 0 filas problematicas |
| Consistencia temporal | ✅ PASS | 6 controles, 0 filas problematicas |
| Consistencia geografica | ✅ PASS | 2 controles, 0 filas problematicas |
| Validez de reglas de negocio | ✅ PASS | 8 controles, 0 filas problematicas |
| Auditoria | ✅ PASS | 2 controles, 0 filas problematicas |
| Ledger 100% balanceado | ✅ PASS | 0 transacciones con debitos <> creditos |
| 0 diferencias de saldo sin explicar | ✅ PASS | conciliacion por cuenta + suma global = 0 |
| Los 58 controles dan 0 | ✅ PASS | 58 controles ejecutados |
| Los controles probados DETECTAN corrupcion (pruebas de mutacion; no cubren todos los controles) | ✅ PASS | 13 mutaciones detectadas |

## G7 — Performance + Seguridad: PASS

_Rendimiento medido con EXPLAIN antes/despues e indices justificados; seguridad verificada._

| Criterio | Estado | Evidencia |
|---|---|---|
| Al menos 5 consultas criticas con EXPLAIN (ANALYZE, BUFFERS) antes y despues | ✅ PASS | 17 experimentos con plan antes y despues en evidencia/explain/ |
| Las mejoras adoptadas superan el umbral (indices: >= 3x y >= 256 paginas; reescrituras/parametros: >= 3x) | ✅ PASS | 13 adoptadas; mejora en tiempo de x20.1 a x11926 |
| TODO indice secundario existente tiene un experimento que lo justifica (sin indices indiscriminados) | ✅ PASS | 12 indices; sin justificar: ninguno |
| Los indices descartados por la medicion no existen | ✅ PASS | descartados: ['idx_cliente_departamento', 'idx_cuenta_oficina', 'idx_llave_cliente']; presentes: ninguno |
| Latencia de lectura de la API: mediana < 100 ms en todos los endpoints (1 M de transacciones) | ✅ PASS | 13 endpoints; el mas lento: GET /transactions?cuentaId=:id (historial de cuenta) = 27.1 ms |
| Concurrencia: 0 errores con 8 trabajadores simultaneos | ✅ PASS | {'deposit': {'ok': 320, 'errores': 0, 'tps': 414.2, 'p50_ms': 16.1, 'p95_ms': 30.9}, 'transfer': {'ok': 320, 'errores': 0, 'tps': 606.3, 'p50_ms': 12.4, 'p95_ms': 18.3}} |
| Contrasenas almacenadas solo como hash bcrypt | ✅ PASS | usuarios con hash invalido: 0 |
| PIN solo como hash bcrypt y numero de tarjeta solo como HMAC | ✅ PASS | tarjetas incorrectas: 0 |
| Los hashes nunca se copian a la bitacora de auditoria | ✅ PASS | eventos con hashes: 0 |
| Ningun secreto del .env aparece en el codigo, scripts ni documentos | ✅ PASS | 115 archivos revisados; con secretos: ninguno |
| Dependencias del backend sin vulnerabilidades conocidas (npm audit) | ✅ PASS | found 0 vulnerabilities |
| Dependencias del frontend sin vulnerabilidades conocidas (npm audit) | ✅ PASS | found 0 vulnerabilities |
| Pruebas del backend: autenticacion, RBAC permitido/denegado, SQL injection, errores controlados, dinero, idempotencia y concurrencia | ✅ PASS | 60 de 60 pruebas pasan |
| Pruebas del frontend: cliente HTTP, proteccion de rutas y login (errores comprensibles) | ✅ PASS | 14 de 14 pruebas pasan |
| TypeScript del backend compila sin errores | ✅ PASS | tsc sin errores |
| TypeScript del frontend compila sin errores | ✅ PASS | tsc sin errores |

## G8 — Defensa: PASS

_El proyecto puede explicarse y defenderse: documentacion completa y revision externa (ECC) realizada._

| Criterio | Estado | Evidencia |
|---|---|---|
| README con las 13 secciones exigidas | ✅ PASS | faltan: ninguna |
| docs/ARQUITECTURA.md | ✅ PASS | presente |
| docs/SEGURIDAD.md | ✅ PASS | presente |
| docs/DOMINIO.md | ✅ PASS | presente |
| docs/RENDIMIENTO.md | ✅ PASS | presente |
| docs/GATES.md | ✅ PASS | presente |
| docs/DEFENSA.md | ✅ PASS | presente |
| docs/API.md | ✅ PASS | presente |
| Revision ECC realizada (informe pasada1_*.md con contenido) | ✅ PASS | ['pasada1_resumen.md', 'pasada2_resumen.md'] |
| Segunda revision ECC ejecutada (informe pasada2_*.md con contenido) | ✅ PASS | ['pasada1_resumen.md', 'pasada2_resumen.md'] |
