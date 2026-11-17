# Rendimiento

> Documento **generado** por `python src/rendimiento.py` a partir de mediciones reales con `EXPLAIN (ANALYZE, BUFFERS)` sobre la base con **1.000.000 de transacciones y 2.000.000 de movimientos**. No se edita a mano: se regenera. Los planes completos estan en `evidencia/explain/`.

## Metodo

Cada experimento corre dentro de una transaccion que se **revierte**: (1) se quita el indice y se mide el plan *antes*; (2) se crea el indice (o se usa la consulta reescrita) y se mide el plan *despues*; (3) `ROLLBACK`. Cada medicion es la mediana de 5 ejecuciones con cache caliente, y cada experimento se repite 2 veces (se reporta la corrida menos favorable al indice).

**Regla de decision, fijada de antemano:** un indice solo se conserva si reduce las **paginas leidas** al menos **3x** y ahorra al menos **256 paginas (2 MiB)** en todas las corridas. Se decide con paginas (`EXPLAIN BUFFERS`) y no con milisegundos porque las paginas son **deterministas**: no dependen de lo cargado que este el equipo (en una corrida con poca RAM libre los milisegundos variaron 3x y cambiaron los veredictos marginales). Lo marginal se descarta. Los indices que usa un trigger en la ruta de escritura se marcan *estructurales*. Asi no se crean indices indiscriminadamente. Los milisegundos se muestran como dato informativo.

## Resumen

| ID | Consulta | Indice / propuesta | Paginas antes → despues | Tiempo antes → despues | Mejora (paginas) | Veredicto |
|---|---|---|---:|---:|---:|---|
| E01 | Extracto de una cuenta (ultimos 15 movimientos) | `idx_movimiento_cuenta` | 62,198 → 86 | 314.65 → 0.08 ms | x723.2 | **CONSERVAR** |
| E02 | Limite diario: suma de retiros recientes de una cuenta (corre dentro de cada retiro/transferencia) | `idx_transaccion_debito` | 2,513 → 31 | 9.48 → 0.03 ms | x81.1 | **INFORMATIVO** |
| E03 | Trigger de partida doble: movimientos de una transaccion (corre por cada movimiento insertado) | `idx_movimiento_transac` | 22,272 → 4 | 71.33 → 0.01 ms | x5568 | **CONSERVAR** |
| E04 | Cierre diario: movimientos de un dia | `idx_movimiento_fecha` | 22,272 → 104 | 81.02 → 0.73 ms | x214.2 | **CONSERVAR** |
| E05 | Operaciones de hoy (panel del administrador) | `idx_transaccion_fecha` | 17,876 → 753 | 69.55 → 0.40 ms | x23.7 | **CONSERVAR** |
| E06 | Cuentas de un cliente via titularidad (dashboard y control de propiedad) | `idx_titular_cliente` | 423 → 42 | 1.93 → 0.09 ms | x10.1 | **CONSERVAR** |
| E07 | Cuentas de un cliente por la columna cliente_id de cuenta | `idx_cuenta_cliente` | 901 → 3 | 4.48 → 0.01 ms | x300.3 | **CONSERVAR** |
| E08 | Historial de transacciones de una cuenta (origen o destino) | `idx_transaccion_debito + idx_transaccion_credito (y UNION ALL)` | 23,222 → 96 | 263.17 → 0.13 ms | x241.9 | **CONSERVAR** |
| E09 | Eventos de una cuenta | `idx_evento_cuenta` | 1,251 → 7 | 4.43 → 0.02 ms | x178.7 | **CONSERVAR** |
| E10 | Clientes de un departamento | `idx_cliente_departamento` | 261 → 52 | 0.80 → 0.14 ms | x5 | **DESCARTAR** |
| E11 | Cuentas de una oficina | `idx_cuenta_oficina` | 901 → 650 | 3.63 → 1.52 ms | x1.4 | **DESCARTAR** |
| E12 | Llaves Bre-B de un cliente | `idx_llave_cliente` | 28 → 2 | 0.09 → 0.01 ms | x14 | **DESCARTAR** |
| E13 | Auditoria: historia de un registro (quien lo toco) [bitacora simulada de 1.000.000 filas] | `idx_evento_registro` | 17,280 → 5 | 199.67 → 0.02 ms | x3456 | **CONSERVAR** |
| E14 | Auditoria: actividad reciente de un usuario [bitacora simulada de 1.000.000 filas] | `idx_evento_usuario` | 17,280 → 24 | 238.52 → 0.02 ms | x720 | **CONSERVAR** |
| E15 | Auditoria: ultimos eventos de una tabla [bitacora simulada de 1.000.000 filas] | `idx_evento_tabla_fecha` | 17,280 → 24 | 358.34 → 0.04 ms | x720 | **CONSERVAR** |
| P01 | Pagina de transacciones de un cliente (OLTP corta): paralelismo por defecto vs desactivado | `(parametro) max_parallel_workers_per_gather = 0 en el rol del backend` | 50 → 20 | 42.03 → 0.08 ms | x525.4 | **ADOPTAR** |
| R01 | Conciliacion de saldos de TODAS las cuentas (api.v_conciliacion) | `(reescritura, sin indice nuevo)` | 1,541,907 → 23,173 | 9703.66 → 483.01 ms | x20.1 | **ADOPTAR** |

## Detalle de cada experimento

### E01 — Extracto de una cuenta (ultimos 15 movimientos)

- **Consulta:**
  ```sql
  SELECT * FROM api.v_extracto WHERE cuenta_id = %s ORDER BY creado_en DESC, id DESC LIMIT 15
  ```
- **Problema:** Sin indice por cuenta el planificador solo puede recorrer el indice por fecha (o la tabla) descartando fila a fila las de otras cuentas, entre 2 millones de movimientos.
- **Plan antes:** Limit → Incremental Sort → Nested Loop → Gather Merge → Index Scan (idx_movimiento_fecha) → Materialize; **62198 paginas leidas** (31116 en cache / 31082 de disco); 314.65 ms  (`evidencia/explain/E01_antes.txt`)
- **Indice / propuesta:** `idx_movimiento_cuenta`
  ```sql
  CREATE INDEX idx_movimiento_cuenta ON nucleo.movimiento (cuenta_id, creado_en DESC)
  ```
- **Plan despues:** Limit → Incremental Sort → Nested Loop → Index Scan (idx_movimiento_cuenta) → Materialize → Index Scan (cuenta_pkey); **86 paginas leidas** (86 en cache / 0 de disco); 0.08 ms  (`evidencia/explain/E01_despues.txt`)
- **Mejora:** x3933.1 (314.65 ms → 0.08 ms)
- **Conclusion:** El indice reduce el costo de forma consistente y por encima del umbral: se conserva en `sql/07_indices.sql`.

### E02 — Limite diario: suma de retiros recientes de una cuenta (corre dentro de cada retiro/transferencia)

- **Consulta:**
  ```sql
  SELECT COALESCE(sum(monto), 0) FROM nucleo.transaccion WHERE cuenta_debito = %s AND tipo = 'retiro' AND creado_en >= %s
  ```
- **Problema:** Se ejecuta en CADA retiro/transferencia, mientras la cuenta esta bloqueada con FOR UPDATE. INFORMATIVO: el indice por fecha ya lo acota a pocas filas, asi que este indice no se justifica solo por esto (lo justifica E08).
- **Plan antes:** Aggregate → Index Scan (idx_transaccion_fecha); **2513 paginas leidas** (2513 en cache / 0 de disco); 9.48 ms  (`evidencia/explain/E02_antes.txt`)
- **Indice / propuesta:** `idx_transaccion_debito`
  ```sql
  CREATE INDEX idx_transaccion_debito ON nucleo.transaccion (cuenta_debito, creado_en DESC)
  ```
- **Plan despues:** Aggregate → Index Scan (idx_transaccion_debito); **31 paginas leidas** (31 en cache / 0 de disco); 0.03 ms  (`evidencia/explain/E02_despues.txt`)
- **Mejora:** x316 (9.48 ms → 0.03 ms)
- **Conclusion:** Solo informativo: no decide por si solo la existencia del indice (lo justifica otro experimento).

### E03 — Trigger de partida doble: movimientos de una transaccion (corre por cada movimiento insertado)

- **Consulta:**
  ```sql
  SELECT COALESCE(SUM(CASE sentido WHEN 'C' THEN monto ELSE -monto END), 0) FROM nucleo.movimiento WHERE transaccion_id = %s
  ```
- **Problema:** El trigger fn_verificar_balance busca los movimientos de la transaccion por cada INSERT; sin indice cada operacion escanearia 2 millones de filas.
- **Plan antes:** Aggregate → Gather → Seq Scan (movimiento); **22272 paginas leidas** (13445 en cache / 8827 de disco); 71.33 ms  (`evidencia/explain/E03_antes.txt`)
- **Indice / propuesta:** `idx_movimiento_transac`
  ```sql
  CREATE INDEX idx_movimiento_transac ON nucleo.movimiento (transaccion_id)
  ```
- **Plan despues:** Aggregate → Index Scan (idx_movimiento_transac); **4 paginas leidas** (4 en cache / 0 de disco); 0.01 ms  (`evidencia/explain/E03_despues.txt`)
- **Mejora:** x7133 (71.33 ms → 0.01 ms)
- **Conclusion:** El indice reduce el costo de forma consistente y por encima del umbral: se conserva en `sql/07_indices.sql`.

### E04 — Cierre diario: movimientos de un dia

- **Consulta:**
  ```sql
  SELECT count(*), sum(monto) FROM nucleo.movimiento WHERE creado_en >= %s AND creado_en <= %s
  ```
- **Problema:** Un dia es ~0,1 % de la tabla; sin indice por fecha se lee toda.
- **Plan antes:** Aggregate → Gather → Seq Scan (movimiento); **22272 paginas leidas** (16002 en cache / 6270 de disco); 81.02 ms  (`evidencia/explain/E04_antes.txt`)
- **Indice / propuesta:** `idx_movimiento_fecha`
  ```sql
  CREATE INDEX idx_movimiento_fecha ON nucleo.movimiento (creado_en DESC)
  ```
- **Plan despues:** Aggregate → Index Scan (idx_movimiento_fecha); **104 paginas leidas** (104 en cache / 0 de disco); 0.73 ms  (`evidencia/explain/E04_despues.txt`)
- **Mejora:** x111 (81.02 ms → 0.73 ms)
- **Conclusion:** El indice reduce el costo de forma consistente y por encima del umbral: se conserva en `sql/07_indices.sql`.

### E05 — Operaciones de hoy (panel del administrador)

- **Consulta:**
  ```sql
  SELECT tipo, count(*), sum(monto) FROM nucleo.transaccion WHERE creado_en >= %s GROUP BY tipo
  ```
- **Problema:** El panel pide solo el dia actual; sin indice agrega 1 millon de filas.
- **Plan antes:** Aggregate → Gather Merge → Sort → Seq Scan (transaccion); **17876 paginas leidas** (1648 en cache / 16228 de disco); 69.55 ms  (`evidencia/explain/E05_antes.txt`)
- **Indice / propuesta:** `idx_transaccion_fecha`
  ```sql
  CREATE INDEX idx_transaccion_fecha ON nucleo.transaccion (creado_en)
  ```
- **Plan despues:** Aggregate → Index Scan (idx_transaccion_fecha); **753 paginas leidas** (753 en cache / 0 de disco); 0.40 ms  (`evidencia/explain/E05_despues.txt`)
- **Mejora:** x173.9 (69.55 ms → 0.40 ms)
- **Conclusion:** El indice reduce el costo de forma consistente y por encima del umbral: se conserva en `sql/07_indices.sql`.

### E06 — Cuentas de un cliente via titularidad (dashboard y control de propiedad)

- **Consulta:**
  ```sql
  SELECT * FROM api.v_saldos WHERE cuenta_id IN (SELECT cuenta_id FROM api.v_titulares WHERE cliente_id = %s)
  ```
- **Problema:** La PK es (cuenta_id, cliente_id): buscar por cliente no puede usarla.
- **Plan antes:** Nested Loop → Aggregate → Index Only Scan (cliente_pkey) → Seq Scan (cuenta_titular) → Index Scan (cuenta_pkey) → Index Scan (cliente_pkey); **423 paginas leidas** (423 en cache / 0 de disco); 1.93 ms  (`evidencia/explain/E06_antes.txt`)
- **Indice / propuesta:** `idx_titular_cliente`
  ```sql
  CREATE INDEX idx_titular_cliente ON nucleo.cuenta_titular (cliente_id)
  ```
- **Plan despues:** Nested Loop → Aggregate → Index Only Scan (cliente_pkey) → Index Scan (idx_titular_cliente) → Index Scan (cuenta_pkey) → Index Scan (cliente_pkey); **42 paginas leidas** (42 en cache / 0 de disco); 0.09 ms  (`evidencia/explain/E06_despues.txt`)
- **Mejora:** x21.4 (1.93 ms → 0.09 ms)
- **Conclusion:** El indice reduce el costo de forma consistente y por encima del umbral: se conserva en `sql/07_indices.sql`.

### E07 — Cuentas de un cliente por la columna cliente_id de cuenta

- **Consulta:**
  ```sql
  SELECT id, numero, saldo FROM nucleo.cuenta WHERE cliente_id = %s
  ```
- **Problema:** Consulta directa de las cuentas de un cliente.
- **Plan antes:** Seq Scan (cuenta); **901 paginas leidas** (901 en cache / 0 de disco); 4.48 ms  (`evidencia/explain/E07_antes.txt`)
- **Indice / propuesta:** `idx_cuenta_cliente`
  ```sql
  CREATE INDEX idx_cuenta_cliente ON nucleo.cuenta (cliente_id)
  ```
- **Plan despues:** Index Scan (idx_cuenta_cliente); **3 paginas leidas** (3 en cache / 0 de disco); 0.01 ms  (`evidencia/explain/E07_despues.txt`)
- **Mejora:** x448 (4.48 ms → 0.01 ms)
- **Conclusion:** El indice reduce el costo de forma consistente y por encima del umbral: se conserva en `sql/07_indices.sql`.

### E08 — Historial de transacciones de una cuenta (origen o destino)

- **Consulta:**
  ```sql
  -- ANTES:
  SELECT * FROM api.v_transacciones WHERE cuenta_debito = %s OR cuenta_credito = %s ORDER BY creado_en DESC LIMIT 20
  -- DESPUES:
  SELECT * FROM (
         (SELECT * FROM api.v_transacciones WHERE cuenta_debito = %s ORDER BY creado_en DESC LIMIT 20)
         UNION ALL
         (SELECT * FROM api.v_transacciones WHERE cuenta_credito = %s ORDER BY creado_en DESC LIMIT 20)) u
       ORDER BY creado_en DESC LIMIT 20
  ```
- **Problema:** La forma 'A OR B ... ORDER BY fecha LIMIT' obliga al planificador a elegir un barrido completo (~400 ms) aunque existan indices por cuenta.
- **Plan antes:** Limit → Gather Merge → Sort → Hash Join → Seq Scan (transaccion) → Hash; **23222 paginas leidas** (12060 en cache / 11162 de disco); 263.17 ms  (`evidencia/explain/E08_antes.txt`)
- **Indice / propuesta:** `idx_transaccion_debito + idx_transaccion_credito (y UNION ALL)`
  ```sql
  CREATE INDEX idx_transaccion_debito ON nucleo.transaccion (cuenta_debito, creado_en DESC);
  CREATE INDEX idx_transaccion_credito ON nucleo.transaccion (cuenta_credito, creado_en DESC)
  ```
- **Plan despues:** Limit → Merge Append → Nested Loop → Index Scan (idx_transaccion_debito) → Materialize → Index Scan (cuenta_pkey); **96 paginas leidas** (96 en cache / 0 de disco); 0.13 ms  (`evidencia/explain/E08_despues.txt`)
- **Mejora:** x2024.4 (263.17 ms → 0.13 ms)
- **Conclusion:** El indice reduce el costo de forma consistente y por encima del umbral: se conserva en `sql/07_indices.sql`.

### E09 — Eventos de una cuenta

- **Consulta:**
  ```sql
  SELECT * FROM api.v_eventos_cuenta WHERE cuenta_id = %s ORDER BY id DESC
  ```
- **Problema:** Pantalla de eventos de una cuenta.
- **Plan antes:** Sort → Nested Loop → Index Scan (cuenta_pkey) → Seq Scan (evento_cuenta); **1251 paginas leidas** (1251 en cache / 0 de disco); 4.43 ms  (`evidencia/explain/E09_antes.txt`)
- **Indice / propuesta:** `idx_evento_cuenta`
  ```sql
  CREATE INDEX idx_evento_cuenta ON nucleo.evento_cuenta (cuenta_id, creado_en DESC)
  ```
- **Plan despues:** Sort → Nested Loop → Index Scan (cuenta_pkey) → Index Scan (idx_evento_cuenta); **7 paginas leidas** (7 en cache / 0 de disco); 0.02 ms  (`evidencia/explain/E09_despues.txt`)
- **Mejora:** x221.5 (4.43 ms → 0.02 ms)
- **Conclusion:** El indice reduce el costo de forma consistente y por encima del umbral: se conserva en `sql/07_indices.sql`.

### E10 — Clientes de un departamento

- **Consulta:**
  ```sql
  SELECT count(*) FROM nucleo.cliente WHERE departamento = 'Antioquia'
  ```
- **Problema:** Filtro por departamento sobre 10.000 clientes.
- **Plan antes:** Aggregate → Seq Scan (cliente); **261 paginas leidas** (261 en cache / 0 de disco); 0.80 ms  (`evidencia/explain/E10_antes.txt`)
- **Indice / propuesta:** `idx_cliente_departamento`
  ```sql
  CREATE INDEX idx_cliente_departamento ON nucleo.cliente (departamento)
  ```
- **Plan despues:** Aggregate → Index Only Scan (idx_cliente_departamento); **52 paginas leidas** (52 en cache / 0 de disco); 0.14 ms  (`evidencia/explain/E10_despues.txt`)
- **Mejora:** x5.7 (0.80 ms → 0.14 ms)
- **Conclusion:** No alcanza el umbral: el indice cuesta espacio y escritura sin beneficio medible. Se **elimina**.

### E11 — Cuentas de una oficina

- **Consulta:**
  ```sql
  SELECT count(*), sum(saldo) FROM nucleo.cuenta WHERE oficina_id = 3
  ```
- **Problema:** Filtro de cuentas por oficina.
- **Plan antes:** Aggregate → Seq Scan (cuenta); **901 paginas leidas** (901 en cache / 0 de disco); 3.63 ms  (`evidencia/explain/E11_antes.txt`)
- **Indice / propuesta:** `idx_cuenta_oficina`
  ```sql
  CREATE INDEX idx_cuenta_oficina ON nucleo.cuenta (oficina_id)
  ```
- **Plan despues:** Aggregate → Bitmap Heap Scan (cuenta) → Bitmap Index Scan (idx_cuenta_oficina); **650 paginas leidas** (650 en cache / 0 de disco); 1.52 ms  (`evidencia/explain/E11_despues.txt`)
- **Mejora:** x2.4 (3.63 ms → 1.52 ms)
- **Conclusion:** No alcanza el umbral: el indice cuesta espacio y escritura sin beneficio medible. Se **elimina**.

### E12 — Llaves Bre-B de un cliente

- **Consulta:**
  ```sql
  SELECT * FROM api.v_llaves_brebe WHERE cliente_id = %s
  ```
- **Problema:** Listado de llaves del cliente.
- **Plan antes:** Nested Loop → Seq Scan (llave_brebe) → Index Scan (cuenta_pkey); **28 paginas leidas** (28 en cache / 0 de disco); 0.09 ms  (`evidencia/explain/E12_antes.txt`)
- **Indice / propuesta:** `idx_llave_cliente`
  ```sql
  CREATE INDEX idx_llave_cliente ON nucleo.llave_brebe (cliente_id)
  ```
- **Plan despues:** Nested Loop → Index Scan (idx_llave_cliente) → Index Scan (cuenta_pkey); **2 paginas leidas** (2 en cache / 0 de disco); 0.01 ms  (`evidencia/explain/E12_despues.txt`)
- **Mejora:** x9 (0.09 ms → 0.01 ms)
- **Conclusion:** No alcanza el umbral: el indice cuesta espacio y escritura sin beneficio medible. Se **elimina**.

### E13 — Auditoria: historia de un registro (quien lo toco) [bitacora simulada de 1.000.000 filas]

- **Consulta:**
  ```sql
  SELECT * FROM auditoria.evento WHERE tabla = 'nucleo.transaccion' AND registro_id = %s ORDER BY id
  ```
- **Problema:** Pregunta central de la auditoria: ¿que paso con este registro? Sin indice recorre toda la bitacora.
- **Plan antes:** Sort → Seq Scan (ev_sim); **17280 paginas leidas** (0 en cache / 17280 de disco); 199.67 ms  (`evidencia/explain/E13_antes.txt`)
- **Indice / propuesta:** `idx_evento_registro`
  ```sql
  CREATE INDEX idx_evento_registro ON auditoria.evento (tabla, registro_id)
  ```
- **Plan despues:** Sort → Index Scan (idx_evento_registro); **5 paginas leidas** (5 en cache / 0 de disco); 0.02 ms  (`evidencia/explain/E13_despues.txt`)
- **Mejora:** x9983.5 (199.67 ms → 0.02 ms)
- **Conclusion:** El indice reduce el costo de forma consistente y por encima del umbral: se conserva en `sql/07_indices.sql`.

### E14 — Auditoria: actividad reciente de un usuario [bitacora simulada de 1.000.000 filas]

- **Consulta:**
  ```sql
  SELECT * FROM auditoria.evento WHERE usuario_app_id = 3 ORDER BY ocurrido_en DESC LIMIT 25
  ```
- **Problema:** Pregunta de auditoria: ¿que hizo este usuario?
- **Plan antes:** Limit → Sort → Seq Scan (ev_sim); **17280 paginas leidas** (0 en cache / 17280 de disco); 238.52 ms  (`evidencia/explain/E14_antes.txt`)
- **Indice / propuesta:** `idx_evento_usuario`
  ```sql
  CREATE INDEX idx_evento_usuario ON auditoria.evento (usuario_app_id, ocurrido_en DESC)
  ```
- **Plan despues:** Limit → Index Scan (idx_evento_usuario); **24 paginas leidas** (24 en cache / 0 de disco); 0.02 ms  (`evidencia/explain/E14_despues.txt`)
- **Mejora:** x11926 (238.52 ms → 0.02 ms)
- **Conclusion:** El indice reduce el costo de forma consistente y por encima del umbral: se conserva en `sql/07_indices.sql`.

### E15 — Auditoria: ultimos eventos de una tabla [bitacora simulada de 1.000.000 filas]

- **Consulta:**
  ```sql
  SELECT * FROM auditoria.evento WHERE tabla = 'nucleo.transaccion' ORDER BY ocurrido_en DESC LIMIT 25
  ```
- **Problema:** Pantalla de auditoria filtrada por tabla y ordenada por fecha.
- **Plan antes:** Limit → Sort → Seq Scan (ev_sim); **17280 paginas leidas** (0 en cache / 17280 de disco); 358.34 ms  (`evidencia/explain/E15_antes.txt`)
- **Indice / propuesta:** `idx_evento_tabla_fecha`
  ```sql
  CREATE INDEX idx_evento_tabla_fecha ON auditoria.evento (tabla, ocurrido_en DESC)
  ```
- **Plan despues:** Limit → Index Scan (idx_evento_tabla_fecha); **24 paginas leidas** (24 en cache / 0 de disco); 0.04 ms  (`evidencia/explain/E15_despues.txt`)
- **Mejora:** x8958.5 (358.34 ms → 0.04 ms)
- **Conclusion:** El indice reduce el costo de forma consistente y por encima del umbral: se conserva en `sql/07_indices.sql`.

### P01 — Pagina de transacciones de un cliente (OLTP corta): paralelismo por defecto vs desactivado

- **Consulta:**
  ```sql
  SELECT id FROM (SELECT id, tipo, canal, actor_usuario_id, cuenta_debito, cuenta_credito, creado_en FROM api.v_tx_base WHERE cuenta_debito IN (SELECT cuenta_id FROM api.v_titular_base WHERE cliente_id = %s) UNION ALL SELECT id, tipo, canal, actor_usuario_id, cuenta_debito, cuenta_credito, creado_en FROM api.v_tx_base WHERE cuenta_credito IN (SELECT cuenta_id FROM api.v_titular_base WHERE cliente_id = %s)) b ORDER BY creado_en DESC, id LIMIT 25
  ```
- **Problema:** El planificador supone ~70 transacciones por cuenta y elige Gather Merge con 2 workers; lanzarlos cuesta ~50 ms para devolver 2 filas.
- **Plan antes:** Limit → Gather Merge → Sort → Append → Subquery Scan → Nested Loop; **50 paginas leidas** (50 en cache / 0 de disco); 42.03 ms  (`evidencia/explain/P01_antes.txt`)
- **Indice / propuesta:** `(parametro) max_parallel_workers_per_gather = 0 en el rol del backend`
  ```sql
  SET max_parallel_workers_per_gather = 0
  ```
- **Plan despues:** Limit → Sort → Append → Subquery Scan → Nested Loop → Index Scan (idx_titular_cliente); **20 paginas leidas** (20 en cache / 0 de disco); 0.08 ms  (`evidencia/explain/P01_despues.txt`)
- **Mejora:** x525.4 (42.03 ms → 0.08 ms)
- **Conclusion:** Mejora medida y reproducible: se adopta en el codigo.

### R01 — Conciliacion de saldos de TODAS las cuentas (api.v_conciliacion)

- **Consulta:**
  ```sql
  SELECT count(*) FROM nucleo.cuenta c
                      LEFT JOIN (SELECT cuenta_id, SUM(CASE sentido WHEN 'C' THEN monto ELSE -monto END) AS calculado
                                   FROM nucleo.movimiento GROUP BY cuenta_id) x ON x.cuenta_id = c.id
                     WHERE c.saldo <> COALESCE(x.calculado, 0)
  ```
- **Problema:** El LATERAL hace una busqueda por cuenta (50.000 veces) y suma sus movimientos; el panel del administrador la ejecuta en cada carga.
- **Plan antes:** Aggregate → Nested Loop → Seq Scan (cuenta) → Subquery Scan → Bitmap Heap Scan (movimiento) → Bitmap Index Scan (idx_movimiento_cuenta); **1541907 paginas leidas** (1122149 en cache / 419758 de disco); 9703.66 ms  (`evidencia/explain/R01_antes.txt`)
- **Indice / propuesta:** `(reescritura, sin indice nuevo)`
  ```sql
  GROUP BY cuenta_id + LEFT JOIN en lugar de LATERAL
  ```
- **Plan despues:** Aggregate → Hash Join → Seq Scan (cuenta) → Hash → Subquery Scan → Gather; **23173 paginas leidas** (15973 en cache / 7200 de disco); 483.01 ms  (`evidencia/explain/R01_despues.txt`)
- **Mejora:** x20.1 (9703.66 ms → 483.01 ms)
- **Conclusion:** Mejora medida y reproducible: se adopta en el codigo.

## Indices resultantes

**Se conservan** (justificados por medicion): `idx_movimiento_cuenta` (E01), `idx_movimiento_transac` (E03), `idx_movimiento_fecha` (E04), `idx_transaccion_fecha` (E05), `idx_titular_cliente` (E06), `idx_cuenta_cliente` (E07), `idx_transaccion_debito + idx_transaccion_credito (y UNION ALL)` (E08), `idx_evento_cuenta` (E09), `idx_evento_registro` (E13), `idx_evento_usuario` (E14), `idx_evento_tabla_fecha` (E15).

**Descartados por no superar el umbral:** `idx_cliente_departamento` (E10), `idx_cuenta_oficina` (E11), `idx_llave_cliente` (E12). Ademas se eliminaron `cuenta(producto_id)` y `tarjeta(cuenta_id)` por analisis estatico: ninguna consulta del sistema filtra por esas columnas.

## Latencia de la API (HTTP, 1.000.000 de transacciones)

Medida con `npm --prefix backend run latencia` (mediana de 7 ejecuciones).

| Endpoint | Mediana | Maximo |
|---|---:|---:|
| `GET /stats/overview (panel admin)` | 15.3 ms | 496.8 ms |
| `GET /customers?limit=25` | 15.8 ms | 19.8 ms |
| `GET /customers?q=Gomez` | 15.9 ms | 23.5 ms |
| `GET /accounts?limit=20` | 14.5 ms | 20.9 ms |
| `GET /accounts/:id (cuenta muy activa)` | 15.4 ms | 17.6 ms |
| `GET /accounts/:id/statement (cuenta muy activa)` | 16 ms | 24.1 ms |
| `GET /transactions?limit=20` | 16.5 ms | 22.3 ms |
| `GET /transactions?cuentaId=:id (historial de cuenta)` | 27.1 ms | 52.2 ms |
| `GET /transactions?tipo=retiro&limit=20` | 17.3 ms | 18.3 ms |
| `GET /audit?limit=25` | 15.9 ms | 18.5 ms |
| `GET /users` | 10.3 ms | 18.4 ms |
| `GET /me/dashboard (cliente)` | 11.9 ms | 16.2 ms |
| `GET /transactions (cliente)` | 15.7 ms | 17.2 ms |

| Escritura (20 operaciones secuenciales) | Mediana | p95 |
|---|---:|---:|
| `POST /transactions/deposit` | 15.1 ms | 17.7 ms |
| `POST /transactions/transfer` | 15.7 ms | 17.2 ms |

**Concurrencia** (8 trabajadores en paralelo, 320 operaciones cada prueba, 0 errores):

| Prueba | TPS | p50 | p95 |
|---|---:|---:|---:|
| Consignaciones (todas bloquean la fila de CAJA) | 414.2 | 16.1 ms | 30.9 ms |
| Transferencias (cuentas distintas) | 606.3 | 12.4 ms | 18.3 ms |

## Hallazgos de diseno (lo que la medicion destapo)

1. **`count(*) OVER ()` para paginar:** el listado de transacciones tardaba **3,7 s** porque cada pagina recorria y unia el millon de filas. Ahora se filtra/ordena/corta la pagina sobre una vista delgada sin joins, el detalle se une solo a 20 filas y el total se cuenta con tope (exacto hasta 10.000, despues `10.000+`). Resultado: ~15 ms.
2. **`A OR B ... ORDER BY fecha LIMIT n`:** nunca obtiene un buen plan (~400-600 ms) aunque existan indices por cuenta. Dos busquedas por indice `(cuenta, creado_en DESC)` unidas con `UNION ALL` bajan a decimas de milisegundo (E08).
3. **Paralelismo en consultas OLTP cortas:** el planificador asume ~70 transacciones por cuenta y usa `Gather Merge` con 2 workers; lanzarlos cuesta ~50 ms para devolver 2 filas (P01). El backend usa `max_parallel_workers_per_gather = 0`; el panel analitico lo reactiva con `SET LOCAL`.
4. **Conciliacion de saldos:** `LATERAL` por cuenta (50.000 busquedas) -> una sola agregacion (R01, ~14x).
5. **Panel del administrador:** agrega millones de filas, por eso se calcula una vez por minuto y se comparte (cache en memoria de 60 s).
6. **Hipotesis descartada:** se penso que el *plan generico* de las sentencias preparadas explicaba una regresion; se probo `plan_cache_mode = force_custom_plan` y **no tuvo efecto**; la causa real era el paralelismo (punto 3). Se retiro esa opcion.
7. **Cuello de botella conocido:** toda consignacion y retiro toca la fila de la caja del banco (`CAJA-COP`), por lo que se serializan. En esta maquina las consignaciones rinden aproximadamente la mitad que las transferencias entre cuentas distintas (ver tabla de concurrencia). Para un banco real habria que repartir la caja por oficina; aqui se documenta como limitacion y no se optimiza prematuramente.
8. **`work_mem`:** con el valor por defecto (4 MB) los ordenamientos de ~1 millon de filas se derraman a disco. Medido en las mismas condiciones, `work_mem = 64MB` baja la consulta de anomalias (`a05`) de 8,7 s a 4,1 s y la de percentiles (`a02`) de 5,7 s a 4,7 s, sin afectar al resto. Se fija a nivel de base de datos (`ALTER DATABASE ... SET work_mem`, en `reconstruir.py`); solo se reserva cuando una consulta lo necesita.

## Advertencia sobre las cifras absolutas

Esta medicion se hizo en un equipo de 8 GB de RAM con ~1,4 GB libres y PostgreSQL con `shared_buffers = 128MB` (valor por defecto). Los tiempos **absolutos** de las consultas analiticas variaron entre 2 y 4 veces entre corridas segun la presion de memoria del equipo (p. ej. la misma consulta `a02` midio 1,5 s y 5,7 s). Por eso todas las comparaciones antes/despues se miden **en las mismas condiciones, alternadas, con medianas y repetidas** (y los indices marginales se descartan): las *proporciones* son confiables, los milisegundos absolutos no son una promesa.
