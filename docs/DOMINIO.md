# Dominio — Banco Andino Colombia

Banco académico con **datos 100 % sintéticos**. Este documento define las entidades, sus relaciones y las reglas que el sistema hace cumplir. El Gate G1 verifica por consulta al catálogo de PostgreSQL que cada elemento exista.

## Entidades

| Entidad | Qué representa | Tabla |
|---|---|---|
| Cliente | Persona natural (CC/CE) o jurídica (NIT con dígito de verificación), con ubicación obligatoria | `nucleo.cliente` |
| Oficina | Sucursal por departamento/ciudad | `nucleo.oficina` |
| Producto | Ahorro, corriente, nómina o adicional; trae límites diarios y sobregiro máximo | `nucleo.producto` |
| Cuenta | Cuenta de un cliente: número único, moneda (COP/USD), estado, saldo contable, límites, sobregiro | `nucleo.cuenta` |
| Titularidad | Quién es titular o cotitular de cada cuenta | `nucleo.cuenta_titular` |
| Evento de cuenta | Creación, activación, bloqueo, desbloqueo, cambio de límites y cierre. **No es dinero** | `nucleo.evento_cuenta` |
| Transacción | Operación contabilizada (`POSTED`): consignación, retiro, transferencia, débito, crédito, ajuste, reverso | `nucleo.transaccion` |
| Movimiento | Una pata del libro mayor: un débito (`D`) o un crédito (`C`), con el saldo resultante | `nucleo.movimiento` |
| Tarjeta | Tarjeta débito del ATM; número solo como HMAC y PIN solo como hash | `nucleo.tarjeta` |
| Llave y operación Bre-B | **Simulación académica** de pagos inmediatos por llave | `nucleo.llave_brebe`, `nucleo.brebe_operacion` |
| Cierre diario | Foto inmutable y cuadrada de cada día y moneda | `nucleo.cierre_diario` |
| Auditoría | Bitácora inmutable: quién, qué, cuándo, sobre qué registro, antes/después, resultado | `auditoria.evento` |
| Usuario, rol, permiso | RBAC de la aplicación y sesiones revocables | `seguridad.*` |

## Relaciones principales

```
cliente 1──* cuenta *──1 producto          cuenta *──1 oficina
cliente *──* cuenta   (cuenta_titular: titular / cotitular)
cuenta  1──* evento_cuenta
transaccion 1──2 movimiento *──1 cuenta    (un débito y un crédito: partida doble)
transaccion 0..1──1 transaccion            (un reverso apunta a su original, una sola vez)
transaccion 1──0..1 brebe_operacion *──1 llave_brebe
usuario *──* rol *──* permiso               (CLIENTE ⇒ vinculado a un cliente)
```

## Reglas de negocio que impone la base de datos

1. **Partida doble.** Cada transacción tiene exactamente un débito y un crédito por el mismo monto. Un *constraint trigger* diferido lo verifica al `COMMIT`: o se confirma balanceada o no se confirma.
2. **Historial inmutable.** Movimientos, transacciones, eventos de cuenta, cierres y auditoría no admiten `UPDATE`, `DELETE` ni `TRUNCATE`. Un error se corrige con un **reverso** (una transacción nueva y compensatoria, una sola vez por original).
3. **Dinero exacto.** `NUMERIC(18,2)`; nunca `FLOAT`. Los instantes son `TIMESTAMPTZ`.
4. **Saldo.** Contable = suma de movimientos. Disponible = contable + sobregiro autorizado. Ningún saldo baja de `-sobregiro`; las cuentas cerradas quedan en cero.
5. **Estados de cuenta.** `pendiente → activa ⇄ bloqueada → cerrada` (cierre solo con saldo cero; no se reabre). Solo una cuenta activa opera, como origen y como destino.
6. **Límites diarios** de retiro y de transferencia por cuenta (día calendario de Colombia), verificados dentro de la misma transacción que bloquea la cuenta.
7. **Idempotencia.** Toda operación de dinero lleva una clave única: repetirla devuelve la transacción original; reutilizarla con otros datos es un error.
8. **Concurrencia.** Las cuentas se bloquean en orden ascendente de id (sin interbloqueos) y *antes* de insertar la transacción.
9. **Ubicación.** Todo cliente tiene departamento y ciudad; la cuenta se abre en la oficina de su departamento (o en la primera activa si no hay oficina allí).
10. **Titularidad.** Individual = 1 titular; conjunta = 2 o más; empresarial = cliente jurídico.
11. **Cierre diario.** `CALL api.cerrar_dia(fecha)` rechaza un día descuadrado y no deja huella; la propia tabla exige débitos = créditos.
12. **Auditoría con actor.** El backend fija usuario, rol e IP en variables de sesión por transacción; los triggers los copian a la bitácora. Los hashes nunca se copian.

## Códigos de error de aplicación

| SQLSTATE | Significado | HTTP |
|---|---|---|
| `22023` | parámetro inválido | 400 |
| `P0002` | recurso inexistente o cuenta no activa | 404 / 409 |
| `P0003` | clave de idempotencia reutilizada con otros datos | 409 |
| `P0004` | saldo insuficiente | 422 |
| `P0005` | límite diario excedido | 422 |
| `P0006` | transición o estado inválido | 409 |
| `P0007` | transacción ya reversada | 409 |
| `P0008` | llave Bre-B ya registrada | 409 |

## Lo que es simulación

- **Bre-B**: no hay conexión con la red real; usa el mismo motor contable y está marcado `es_simulacion = true` y `simulacion: true` en la API.
- **Tarjetas, clientes, cuentas, oficinas y teléfonos**: sintéticos. Los correos usan el dominio reservado `.test`.
