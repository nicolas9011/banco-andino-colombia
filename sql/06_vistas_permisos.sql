-- Saldo contable = saldo registrado. Disponible = contable + sobregiro autorizado.
CREATE VIEW api.v_saldos AS
SELECT c.id AS cuenta_id, c.numero, c.moneda, c.saldo, c.saldo AS saldo_contable,
       c.saldo + c.sobregiro_autorizado AS saldo_disponible,
       c.sobregiro_autorizado, c.estado, c.tipo_titularidad,
       c.limite_retiro_diario, c.limite_transferencia_diaria, c.fecha_apertura,
       p.codigo AS producto_codigo, p.nombre AS producto, p.tipo AS producto_tipo,
       o.id AS oficina_id, o.nombre AS oficina,
       cl.id AS cliente_id, cl.nombre
  FROM nucleo.cuenta c
  JOIN nucleo.cliente cl ON cl.id = c.cliente_id
  JOIN nucleo.producto p ON p.id = c.producto_id
  JOIN nucleo.oficina o ON o.id = c.oficina_id
 WHERE c.tipo = 'cliente';

CREATE VIEW api.v_clientes AS
SELECT id, tipo_persona, tipo_documento, documento, nombre, correo, telefono,
       departamento, ciudad, direccion, estado, fecha_vinculacion
  FROM nucleo.cliente
 WHERE tipo_documento <> 'SIS';

CREATE VIEW api.v_titulares AS
SELECT t.cuenta_id, t.cliente_id, t.rol, cl.nombre, cl.documento
  FROM nucleo.cuenta_titular t
  JOIN nucleo.cliente cl ON cl.id = t.cliente_id;

CREATE VIEW api.v_extracto AS
SELECT m.id, c.id AS cuenta_id, c.numero, m.transaccion_id, t.tipo, t.canal, t.concepto,
       m.sentido, m.monto, m.saldo_posterior, m.creado_en
  FROM nucleo.movimiento m
  JOIN nucleo.cuenta c ON c.id = m.cuenta_id
  JOIN nucleo.transaccion t ON t.id = m.transaccion_id;

-- No expone clave_idempotencia ni actor_usuario_id: quien RECIBE una transferencia veria el id interno del
-- usuario remitente y el patron de sus claves. El actor se consulta por la auditoria (solo personal autorizado).
CREATE VIEW api.v_transacciones AS
SELECT t.id, t.tipo, t.estado, t.monto, t.canal, t.concepto,
       t.reversa_de, t.creado_en,
       d.id AS cuenta_debito, d.numero AS numero_debito, d.tipo AS tipo_debito,
       c.id AS cuenta_credito, c.numero AS numero_credito, c.tipo AS tipo_credito,
       d.moneda
  FROM nucleo.transaccion t
  JOIN nucleo.cuenta d ON d.id = t.cuenta_debito
  JOIN nucleo.cuenta c ON c.id = t.cuenta_credito;

-- Vistas DELGADAS (sin joins) para filtrar, ordenar y contar al paginar; el detalle (con numeros de
-- cuenta, etc.) se une solo a las filas de la pagina. Contar sobre las vistas con joins costaba 100-200 ms.
CREATE VIEW api.v_tx_base AS
SELECT id, tipo, canal, actor_usuario_id, cuenta_debito, cuenta_credito, creado_en FROM nucleo.transaccion;

CREATE VIEW api.v_mov_base AS
SELECT id, cuenta_id, creado_en FROM nucleo.movimiento;

-- Titularidad sin el join con cliente (v_titulares): para filtros de propiedad el planificador estima mejor.
CREATE VIEW api.v_titular_base AS
SELECT cuenta_id, cliente_id FROM nucleo.cuenta_titular;

CREATE VIEW api.v_eventos_cuenta AS
SELECT e.id, e.cuenta_id, c.numero, e.tipo, e.motivo, e.actor_usuario_id, e.datos, e.creado_en
  FROM nucleo.evento_cuenta e
  JOIN nucleo.cuenta c ON c.id = e.cuenta_id;

CREATE VIEW api.v_oficinas AS
SELECT id, codigo, nombre, departamento, ciudad, estado FROM nucleo.oficina;

CREATE VIEW api.v_productos AS
SELECT id, codigo, nombre, tipo, permite_sobregiro, sobregiro_maximo,
       limite_retiro_diario, limite_transferencia_diaria, activo
  FROM nucleo.producto;

CREATE VIEW api.v_llaves_brebe AS
SELECT l.id, l.cliente_id, l.cuenta_id, c.numero, l.tipo, l.valor, l.estado, l.creado_en
  FROM nucleo.llave_brebe l
  JOIN nucleo.cuenta c ON c.id = l.cuenta_id;

-- Cuentas cuyo saldo no coincide con la suma de sus movimientos (debe estar vacia).
-- Una sola agregacion por cuenta (15x mas rapida que un LATERAL por cuenta: ver R01 en docs/RENDIMIENTO.md).
CREATE VIEW api.v_conciliacion AS
SELECT c.id AS cuenta_id, c.numero, c.saldo, COALESCE(x.calculado, 0) AS calculado
  FROM nucleo.cuenta c
  LEFT JOIN (SELECT cuenta_id, SUM(CASE sentido WHEN 'C' THEN monto ELSE -monto END) AS calculado
               FROM nucleo.movimiento GROUP BY cuenta_id) x ON x.cuenta_id = c.id
 WHERE c.saldo <> COALESCE(x.calculado, 0);

CREATE VIEW api.v_auditoria AS
SELECT id, tabla, operacion, usuario, usuario_app_id, rol, ip, registro_id, resultado,
       antes, despues, ocurrido_en
  FROM auditoria.evento;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA api FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA api FROM PUBLIC;

-- Funciones: solo la aplicacion. Vistas: la aplicacion filtra por permiso (RBAC en el backend).
GRANT USAGE ON SCHEMA api TO rol_lab_app, rol_lab_lectura, rol_lab_auditor;
GRANT SELECT ON api.v_saldos, api.v_extracto, api.v_clientes, api.v_titulares, api.v_transacciones, api.v_tx_base, api.v_mov_base, api.v_titular_base,
                api.v_eventos_cuenta, api.v_oficinas, api.v_productos, api.v_llaves_brebe
      TO rol_lab_app, rol_lab_lectura, rol_lab_auditor;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA api TO rol_lab_app;

GRANT USAGE ON SCHEMA auditoria TO rol_lab_auditor;
GRANT SELECT ON auditoria.evento TO rol_lab_auditor;
GRANT SELECT ON api.v_conciliacion, api.v_auditoria TO rol_lab_auditor, rol_lab_app;
