# Guion de defensa

## Mensaje central
La integridad del dinero no depende del frontend ni del backend: la garantiza PostgreSQL. Aunque alguien salte la interfaz o la API, la base rechaza lo que rompe las reglas.

## Preguntas probables y dónde está la prueba
| Pregunta | Respuesta corta | Evidencia |
|---|---|---|
| ¿Cómo evitas descuadres? | Dos movimientos por transacción y trigger diferido que exige suma cero; 0 transacciones descuadradas en 1 M | `sql/03_ledger.sql`, `evidencia/data_quality.json` |
| ¿Se puede editar una transacción? | No: triggers lo impiden (incluido TRUNCATE). Se corrige con reverso, único por original | `tests/pruebas_integridad.py` |
| ¿Doble clic o reintento de red? | `Idempotency-Key` + UNIQUE; el ATM reutiliza la clave al reintentar | `backend/tests/money.test.ts`, `Atm.tsx` |
| ¿Dos transferencias cruzadas a la vez? | Cuentas bloqueadas en orden de id antes de insertar: sin deadlock | `tests/pruebas_concurrencia.py`, `latencia_api.json` |
| ¿Un cliente puede ver cuentas ajenas? | No: el permiso `*_own` filtra por titular en el servidor | `backend/tests/auth_rbac.test.ts` |
| ¿Quién cambió qué? | Bitácora por trigger con antes/después, usuario, rol e IP | `sql/04_auditoria.sql` |
| ¿Por qué estos índices? | Cada uno se midió con EXPLAIN (ANALYZE, BUFFERS); los de poco beneficio se descartaron | `docs/RENDIMIENTO.md` |
| ¿Cómo sabes que los gates no son de adorno? | Se calculan; las pruebas de mutación demuestran que los controles detectan datos corrompidos | `docs/GATES.md`, `tests/pruebas_calidad.py` |
| ¿Qué falló en el camino? | NaN pasaba los CHECK; el reintento del ATM generaba clave nueva; mensajes de error localizados se enmascaraban | `evidencia/ecc/` |

## Demostración sugerida (5 min)
1. Entrar como `cajero1`, depositar y transferir; mostrar el comprobante.
2. Repetir la misma petición con la misma `Idempotency-Key` desde curl: mismo resultado, un solo movimiento.
3. Reversar la transacción; intentar reversarla de nuevo (409).
4. Entrar como `auditor1`: ver bitácora; probar una operación (403).
5. `/atm`: 3 PIN erróneos bloquean la tarjeta.
6. Mostrar `docs/GATES.md`.

## Qué NO afirmar
Producción (sin TLS ni pentest externo), Bre-B real, ATM con hardware, tolerancia a múltiples instancias.
