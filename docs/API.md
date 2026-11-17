# API REST

Base: `http://localhost:3000/api`. JSON UTF-8. Autenticación: `Authorization: Bearer <token>` (token web desde `/auth/login`; token ATM desde `/atm/login`, no intercambiables).
Las operaciones que mueven dinero exigen `Idempotency-Key` (8–100 caracteres). Repetir la misma clave y cuerpo devuelve el mismo resultado; la misma clave con otro cuerpo → `409 CLAVE_REUTILIZADA`.
Montos: cadena decimal positiva con máximo 2 decimales (`"1500.50"`). Paginación: `limit` y `offset`; la respuesta trae `total` (con `totalTruncado` si supera 10.000) e `items`.

## Formato de error
```json
{ "error": { "code": "SALDO_INSUFICIENTE", "message": "Saldo insuficiente.", "requestId": "…" } }
```
Nunca incluye trazas ni mensajes internos de la base.

| HTTP | Códigos frecuentes |
|---|---|
| 400 | `PARAMETRO_INVALIDO`, `DATO_INVALIDO` |
| 401 | `NO_AUTENTICADO`, `TARJETA_O_PIN`, `PIN_INCORRECTO` |
| 403 | `SIN_PERMISO`, `TARJETA_BLOQUEADA` |
| 404 | `NO_ENCONTRADO`, `RUTA_NO_ENCONTRADA` |
| 409 | `CLAVE_REUTILIZADA`, `CUENTA_NO_ACTIVA`, `YA_REVERSADA`, `ESTADO_INVALIDO`, `LLAVE_DUPLICADA` |
| 422 | `SALDO_INSUFICIENTE`, `LIMITE_EXCEDIDO`, `OPERACION_NO_PERMITIDA` |
| 423 | `BLOQUEO_TEMPORAL` |
| 429 | `DEMASIADAS_SOLICITUDES` |

## Autenticación — `/auth`
| Método y ruta | Permiso | Descripción |
|---|---|---|
| POST `/auth/login` | pública (limitada) | `{username, password}` → `{token, usuario}` |
| POST `/auth/logout` | sesión | revoca la sesión |
| GET `/auth/me` | sesión | usuario, roles y permisos |

## Clientes y cuentas
| Método y ruta | Permiso |
|---|---|
| GET `/customers`, GET `/customers/:id` | `customers:read` |
| POST `/customers` | `customers:write` |
| GET `/accounts`, GET `/accounts/:id`, GET `/accounts/:id/statement` | `accounts:read` o `accounts:read_own` (cliente: solo lo suyo) |
| GET `/accounts/:id/events` | `accounts:read` |
| POST `/accounts`, POST `/accounts/:id/card` | `accounts:write` |
| POST `/accounts/:id/{activate,unblock,block,close}` | `accounts:state` (motivo obligatorio al bloquear/cerrar) |
| PUT `/accounts/:id/limits` | `accounts:limits` |
| GET `/accounts/lookup?numero=LB-…` | `tx:transfer` o `tx:transfer_own` (titular enmascarado) |

## Transacciones — `/transactions`
| Método y ruta | Permiso | Notas |
|---|---|---|
| GET `/` , GET `/:id` | `tx:read` o `tx:read_own` | filtros `tipo`, `canal`, `desde`, `actorId` |
| POST `/deposit` | `tx:deposit` | `{cuentaId, monto}` |
| POST `/withdraw` | `tx:withdraw` | `{cuentaId, monto}`; respeta saldo y límite diario |
| POST `/transfer` | `tx:transfer` / `tx:transfer_own` | `{origenId, destinoId, monto}` |
| POST `/reverse` | `tx:reverse` | `{transaccionId, motivo}`; una sola vez por original |
| POST `/adjust` | `tx:adjust` | ajuste manual con concepto; audita |

## Administración
| Método y ruta | Permiso |
|---|---|
| GET `/audit` | `audit:read` |
| GET/POST `/users`, PUT `/users/:id/roles` | `users:read` / `users:write` |
| PATCH `/users/:id/status` | `users:block` |
| GET `/roles`, GET `/permissions` | `roles:read` |
| PUT `/roles/:codigo/permissions` | `roles:write` |
| GET `/catalog/offices`, `/catalog/products` | `accounts:read` o `accounts:write` |
| GET `/stats/overview`, GET `/stats/cierres` | `stats:read` |
| POST `/stats/cierres` `{fecha}` | `admin:queries` (solo días pasados; día cerrado → 409) |

## Portal del cliente y Bre-B (simulado)
| Método y ruta | Permiso |
|---|---|
| GET `/me/dashboard` | `accounts:read_own` |
| GET/POST `/brebe/keys`, DELETE `/brebe/keys/:id`, GET `/brebe/resolve`, POST `/brebe/send`, GET `/brebe/history` | `brebe:use` |

## ATM — `/atm` (token propio, expira por inactividad)
| Método y ruta | Descripción |
|---|---|
| POST `/atm/login` | `{tarjeta, pin}`; al 3.er PIN erróneo la tarjeta se bloquea |
| GET `/atm/balance`, GET `/atm/movements` | saldo y últimos movimientos |
| POST `/atm/withdraw` | `{monto}` múltiplo de 10.000, máx. 1.500.000; idempotente |
| POST `/atm/transfer` | `{cuentaDestino, monto}` |
| POST `/atm/change-pin` | `{pinActual, pinNuevo}` |
| POST `/atm/logout` | cierra la sesión ATM |
