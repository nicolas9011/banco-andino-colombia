-- Indices: cada uno esta respaldado por un experimento medido con EXPLAIN (ANALYZE, BUFFERS) sobre
-- 1.000.000 de transacciones (src/rendimiento.py -> docs/RENDIMIENTO.md). Regla fija: se conserva solo si reduce
-- las paginas leidas >= 3x y ahorra >= 256 paginas (2 MiB) en todas las corridas, o si es estructural (lo usa un
-- trigger). Se mide en paginas y no en ms porque son deterministas. Las PK/UNIQUE ya crean los suyos.
--
-- DESCARTADOS por la medicion (no superan el umbral):
--   cliente(departamento) [E10: 228 -> 23 paginas], cuenta(oficina_id) [E11: 901 -> 650], llave_brebe(cliente_id) [E12: 28 -> 2].
-- DESCARTADOS por analisis estatico (ninguna consulta del sistema filtra por esas columnas):
--   cuenta(producto_id), tarjeta(cuenta_id) (el ATM busca por numero_hash, que es UNIQUE), sesion(usuario_id), usuario_rol(rol_id).

-- E07: cuentas de un cliente (901 -> 3 paginas)
CREATE INDEX idx_cuenta_cliente        ON nucleo.cuenta (cliente_id);
-- E06: la PK (cuenta_id, cliente_id) no sirve para buscar "las cuentas de este cliente" (dashboard, control de propiedad)
CREATE INDEX idx_titular_cliente       ON nucleo.cuenta_titular (cliente_id);

-- E01: extracto de una cuenta, mas reciente primero (65.879 -> 87 paginas)
CREATE INDEX idx_movimiento_cuenta     ON nucleo.movimiento (cuenta_id, creado_en DESC);
-- E03 (ESTRUCTURAL): el trigger de partida doble busca los movimientos de la transaccion en cada INSERT (22.377 -> 4)
CREATE INDEX idx_movimiento_transac    ON nucleo.movimiento (transaccion_id);
-- E04: cierre diario / consultas por rango de fechas (22.377 -> 103)
CREATE INDEX idx_movimiento_fecha      ON nucleo.movimiento (creado_en DESC);
-- E05: operaciones del dia (panel del administrador) (17.970 -> 4.642)
CREATE INDEX idx_transaccion_fecha     ON nucleo.transaccion (creado_en);
-- E08: historial de una cuenta. Dos indices (origen y destino) + consulta UNION ALL ordenada (ver api) (23.316 -> 96).
--      Tambien acotan la suma del limite diario (E02, informativo).
CREATE INDEX idx_transaccion_debito    ON nucleo.transaccion (cuenta_debito, creado_en DESC);
CREATE INDEX idx_transaccion_credito   ON nucleo.transaccion (cuenta_credito, creado_en DESC);

-- E09: eventos de una cuenta (1.251 -> 7)
CREATE INDEX idx_evento_cuenta         ON nucleo.evento_cuenta (cuenta_id, creado_en DESC);

-- E13/E14/E15: preguntas de auditoria (¿que paso con este registro?, ¿que hizo este usuario?, ultimos eventos de una tabla)
CREATE INDEX idx_evento_registro       ON auditoria.evento (tabla, registro_id);
CREATE INDEX idx_evento_usuario        ON auditoria.evento (usuario_app_id, ocurrido_en DESC);
CREATE INDEX idx_evento_tabla_fecha    ON auditoria.evento (tabla, ocurrido_en DESC);
ANALYZE;
