# Arquitectura

```
Navegador (React) ──HTTP/JSON──▶ Express (/api) ──pg (rol lab_api)──▶ PostgreSQL
                                   │ authenticate → requirePermission → zod → api.* (SECURITY DEFINER)
```

## Principios
1. **La base es la fuente de verdad.** Saldos, límites, idempotencia, inmutabilidad y cuadre se garantizan con funciones, triggers y restricciones; el backend no recalcula dinero.
2. **Una sola puerta.** El backend usa `lab_api`, sin superusuario y sin acceso directo a `nucleo`: solo ejecuta funciones y lee vistas del esquema `api` (`SECURITY DEFINER`, `search_path` fijo).
3. **Autorización en el servidor.** El frontend oculta opciones; el backend valida permiso por ruta y propiedad del recurso (un cliente solo ve lo suyo).

## Esquemas
| Esquema | Contenido |
|---|---|
| `nucleo` | clientes, cuentas, titulares, transacciones, movimientos, tarjetas, llaves Bre-B, cierres diarios |
| `auditoria` | bitácora inmutable con valores antes/después (JSONB); usuario, rol e IP vienen de variables de sesión |
| `seguridad` | usuarios, roles, permisos, sesiones revocables |
| `api` | funciones y vistas expuestas al backend |

## Modelo contable
- Cada transacción genera exactamente dos movimientos (débito y crédito); un `constraint trigger` diferido verifica que sumen cero.
- Depósitos y retiros usan cuentas de caja del sistema por moneda; no hay mezcla de monedas.
- `transaccion` y `movimiento` son inmutables (triggers `fn_inmutable`, incluido TRUNCATE). La corrección es un **reverso**: nueva transacción compensatoria, única por original (`reversa_de` UNIQUE).
- Dinero en `NUMERIC` con CHECK anti-negativo y anti-`NaN`; fechas en `TIMESTAMPTZ`; la zona de la base es `America/Bogota`.

## Concurrencia e idempotencia
- Las cuentas se bloquean en orden de id (`FOR NO KEY UPDATE`) antes de insertar → sin deadlocks en transferencias cruzadas.
- `clave_idempotencia` UNIQUE + `ON CONFLICT DO NOTHING`: repetir con el mismo cuerpo devuelve el mismo resultado; con otro cuerpo, 409. El backend antepone el sujeto autenticado a la clave.

## Cierre diario
`api.cerrar_dia(fecha)` verifica que débitos = créditos por moneda, guarda el cierre y rechaza días ya cerrados o futuros.

## Frontend
React 19 + Vite + Tailwind. `lib/api` centraliza tokens (web y ATM separados), manejo de 401 y claves de idempotencia; los formularios muestran los mensajes del backend, nunca detalles técnicos.
