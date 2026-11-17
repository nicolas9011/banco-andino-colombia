# Informe final — Banco Andino Colombia

> Plataforma bancaria **académica**. Datos 100 % sintéticos (semilla 20260909). Bre-B y ATM son simulaciones y así se rotulan en la interfaz. Cada afirmación remite a evidencia en `evidencia/` o `docs/`; lo que no se pudo verificar figura en el punto 23.

## 1. Arquitectura implementada
`React (Vite) → API Express/TypeScript → PostgreSQL`. La base es la fuente de verdad: el backend entra con el rol `lab_api` (sin superusuario, sin acceso directo a las tablas) y solo ejecuta funciones y lee vistas del esquema `api` (`SECURITY DEFINER`, `search_path` fijo). Cuatro esquemas: `nucleo`, `auditoria`, `seguridad`, `api`. Detalle en `docs/ARQUITECTURA.md`.

## 2. Tecnologías utilizadas
PostgreSQL 18.6 · Node 24, Express 5, TypeScript estricto, zod, pg, bcryptjs, jsonwebtoken, helmet, cors, express-rate-limit · React 19, Vite, Tailwind v4, react-router 7 · Python (carga masiva, controles, gates, pruebas SQL) · vitest, supertest, testing-library, unittest.

## 3. Cambios realizados al proyecto original
El original era un laboratorio SQL con un servidor web mínimo en Python (`src/web/servidor.py`). Se añadió: backend Express y frontend React; esquemas `seguridad` y `api`; RBAC; ATM; Bre-B simulado; cierre diario; carga masiva de 1 M de transacciones; 30 consultas; 58 controles de calidad; Quality Gates calculados; pruebas de API/interfaz; y endurecimiento del ledger (CHECK anti-`NaN`, tarjeta única, triggers de inmutabilidad incluido TRUNCATE). Quedan en la raíz copias antiguas (`lab_banco/lab_banco/`, `lab_banco.zip`) sin tocar.

## 4. Modelo de base de datos
`nucleo`: cliente, cuenta, cuenta_titular, transaccion, movimiento, evento_cuenta, tarjeta, llave_brebe, brebe_operacion, cierre_diario, oficina, producto. `auditoria.evento` (JSONB antes/después). `seguridad`: usuario, rol, permiso, rol_permiso, usuario_rol, sesion. Dinero en `NUMERIC`, fechas en `TIMESTAMPTZ`, zona `America/Bogota`. Diagrama textual y reglas en `docs/DOMINIO.md`.

## 5. Roles
ADMIN, CAJERO, AUDITOR, CLIENTE; 24 permisos; matriz editable por ADMIN y validada en el backend en cada petición.

## 6. Funciones del cliente
Panel con sus cuentas, extracto, transferencias propias (con búsqueda de cuenta destino y titular enmascarado), historial, llaves y envíos Bre-B. Un cliente nunca ve cuentas ni operaciones ajenas (404).

## 7. Funciones del cajero
Alta de clientes y cuentas (en la oficina del departamento del cliente), depósitos, retiros, transferencias, reversos con motivo, bloqueo/cierre de cuentas, emisión de tarjeta, límites, "mis operaciones".

## 8. Funciones del administrador
Usuarios y roles, matriz de permisos, bitácora de auditoría, estadísticas, consulta y ejecución del cierre diario. El último administrador activo no puede quedar sin rol (advisory lock).

## 9. Funciones del ATM
Pantalla independiente `/atm` con token propio: login por tarjeta+PIN (bloqueo al 3.er fallo), saldo, movimientos, retiro (múltiplos de $10.000, máx. $1.500.000, idempotente), transferencia, cambio de PIN, cierre por inactividad. No controla hardware.

## 10. Transferencias
`api.registrar_transaccion` valida estado, moneda, saldo/sobregiro y límite diario (día de Bogotá). Cuentas bloqueadas en orden de id antes de insertar → sin deadlock en transferencias cruzadas.

## 11. Bre-B
**Simulado**; no se conecta a ninguna red. Llaves (documento, celular, correo, alfanumérica) con formato validado y, desde la pasada 2 de ECC, con prueba de pertenencia a los datos del cliente. Envío por llave con el mismo motor contable e idempotencia.

## 12. Ledger
Doble partida: cada transacción = 1 débito + 1 crédito, verificado por `constraint trigger` diferido. `transaccion` y `movimiento` inmutables (UPDATE/DELETE/TRUNCATE bloqueados). Corrección solo por reverso (único por original). Conciliación: 0 diferencias y suma global de saldos = 0 (controles de `compuertas.py`).

## 13. Auditoría
Trigger por tabla con antes/después, usuario, rol e IP tomados de variables de sesión; hashes omitidos; bitácora inmutable. Intentos de login y ATM (incluidos los denegados) quedan registrados.

## 14. Seguridad
JWT HS256 con `jti` revocable en base de datos; bcrypt; hash ficticio de igual coste contra enumeración; rate limiting; helmet/CORS; consultas parametrizadas; RBAC + comprobación de propiedad (sin IDOR hallado por la revisión); errores sin detalles técnicos; secretos en `.env`. Ver `docs/SEGURIDAD.md`.

## 15. Concurrencia
Bloqueo ordenado de cuentas, `FOR NO KEY UPDATE`, advisory locks (administradores), `LOCK TABLE … SHARE ROW EXCLUSIVE` en el cierre diario. Pruebas: transferencias cruzadas, retiros simultáneos, 8 trabajadores × 40 operaciones (≈414 TPS en depósitos que comparten caja y ≈606 TPS en transferencias de cuentas distintas, 0 errores; máquina de 8 GB).

## 16. Idempotencia
`clave_idempotencia` UNIQUE + `ON CONFLICT DO NOTHING`; misma clave y cuerpo → mismo resultado; otro cuerpo → 409. El backend antepone el sujeto autenticado; el ATM reutiliza la clave al reintentar tras un fallo de red.

## 17. Quality Gates
G0–G8 calculados con evidencia (`docs/GATES.md`, `evidencia/gates.json`): **todos en PASS en la última ejecución**. Un gate es PASS solo si todos sus criterios pasan; omitir pruebas da INCOMPLETO/FAIL. Data Quality: 58 controles en 0 (huérfanos, duplicados, ledger balanceado, saldos).

## 18. Performance
EXPLAIN (ANALYZE, BUFFERS) antes/después en `evidencia/explain/` y `docs/RENDIMIENTO.md`. Ejemplos medidos con 1 M de filas: `idx_transaccion_debito` 23.222 → 96 páginas; `idx_evento_registro` 17.280 → 5; reescritura de la conciliación 9,7 s → 0,48 s; desactivar paralelismo en OLTP 42 ms → 0,08 ms. Índices que no superaron la regla (≥3× y ≥256 páginas) se descartaron. Latencia de la API en lecturas típicas ≈15–27 ms de mediana.

## 19. Pruebas
117 SQL/Python (dinero, integridad, seguridad, concurrencia, dominio, cierre, 24 de consultas, mutaciones de controles) · 60 de API (autenticación, RBAC permitido/denegado, dinero, concurrencia, idempotencia, ATM, Bre-B, portal) · 14 de interfaz · 58 controles de calidad · `tsc` sin errores. Última ejecución: 0 fallos, 0 omitidas.

## 20. Revisión ECC
Dos pasadas con revisores de seguridad, base de datos, TypeScript/React y Python. Informes: `evidencia/ecc/pasada1_resumen.md` y `pasada2_resumen.md`. Un "PASS" del revisor no se tomó como evidencia: cada hallazgo se contrastó con el código y se reconstruyó la base y se repitieron todas las suites.

## 21. Problemas encontrados (resumen)
Deadlock en transferencias cruzadas · `NaN` aceptado en montos · dos tarjetas activas por cuenta · cierre de cuenta dejaba tarjetas/llaves activas · TRUNCATE sin trigger · filtro de fecha en UTC · `limpiarMonto` alteraba montos · reintento del retiro ATM con clave nueva · secuestro de llaves Bre-B · ATM confirmaba existencia de tarjeta · `limpiarMonto` ×1000 al teclear un tercer decimal · cierre diario con carrera · mensajes de error localizados enmascarados por mi propia corrección · gates con falsos PASS (omitidas, evidencia vieja, archivo "1"/"2").

## 22. Problemas corregidos
Todos los anteriores, cada uno con prueba o verificación (tablas en los dos informes ECC). Regresiones de rendimiento a 1 M de filas (`count(*) OVER ()`, `OR`, paralelismo) corregidas y medidas.

## 23. Limitaciones
- Bre-B y ATM simulados; sin hardware ni red real.
- Sin TLS, sin pruebas de penetración externas, una sola instancia del backend (limitadores en memoria).
- Reproducibilidad de datos: el gate detecta manipulación de archivos, no no-determinismo (no se genera dos veces para comparar).
- Pruebas de no uniformidad por mes/día del mes son indicativas (efecto calendario).
- Hallazgos ECC **aceptados sin corregir**: PIN erróneo con tarjeta ya bloqueada no cuenta intentos; bloqueo de login por usuario puede usarse como DoS; `users:write` permite autoasignarse ADMIN si se reparte ese permiso; funciones `SECURITY DEFINER` con dueño superusuario; faltan 3 índices por medir; `abrir_cuenta` sin idempotencia; sin `ErrorBoundary` ni pruebas de `Atm.tsx` con temporizadores; algunos controles de `compuertas.py` son débiles (ver pasada 2).
- No existe el documento del laboratorio; se usó el enunciado del prompt como especificación.

## 24. Cómo ejecutar el proyecto
```bash
npm --prefix backend install && npm --prefix frontend install && pip install -r requirements.txt
copy .env.example .env        # completar valores
powershell -File scripts/preparar_base.ps1       # base completa (≈ varios minutos)
npm --prefix backend run dev                     # http://localhost:3000
npm --prefix frontend run dev                    # http://localhost:5173  (ATM: /atm)
python -X utf8 tests/ejecutar_pruebas.py ; npm --prefix backend test ; npm --prefix frontend test
python -X utf8 src/gates.py                      # regenera docs/GATES.md
```
Usuarios de prueba y contraseña (`SEED_PASSWORD`/`SEED_PIN`): ver `README.md` §7.
