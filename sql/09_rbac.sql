-- RBAC de aplicacion: Usuario - Rol - Permiso. El backend consulta esto en CADA peticion.
-- password_hash guarda solo el hash (bcrypt/argon2 calculado por el backend).
CREATE TABLE seguridad.usuario (
    id                 bigserial PRIMARY KEY,
    username           text        NOT NULL CHECK (username ~ '^[a-z0-9._-]{3,40}$'),
    password_hash      text        NOT NULL CHECK (length(password_hash) >= 20),
    nombre_completo    text        NOT NULL CHECK (length(btrim(nombre_completo)) > 0),
    correo             text,
    estado             text        NOT NULL DEFAULT 'activo' CHECK (estado IN ('activo', 'bloqueado', 'inactivo')),
    cliente_id         bigint      REFERENCES nucleo.cliente (id),   -- solo usuarios con rol CLIENTE
    oficina_id         bigint      REFERENCES nucleo.oficina (id),   -- cajeros
    intentos_fallidos  integer     NOT NULL DEFAULT 0 CHECK (intentos_fallidos >= 0),
    bloqueado_hasta    timestamptz,
    ultimo_acceso      timestamptz,
    creado_en          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_usuario_username ON seguridad.usuario (lower(username));
CREATE UNIQUE INDEX uq_usuario_cliente  ON seguridad.usuario (cliente_id) WHERE cliente_id IS NOT NULL;

CREATE TABLE seguridad.rol (
    id           bigserial PRIMARY KEY,
    codigo       text NOT NULL UNIQUE CHECK (codigo ~ '^[A-Z_]{3,30}$'),
    nombre       text NOT NULL,
    descripcion  text
);

CREATE TABLE seguridad.permiso (
    id           bigserial PRIMARY KEY,
    codigo       text NOT NULL UNIQUE CHECK (codigo ~ '^[a-z_]+:[a-z_]+$'),
    descripcion  text NOT NULL
);

CREATE TABLE seguridad.usuario_rol (
    usuario_id  bigint NOT NULL REFERENCES seguridad.usuario (id),
    rol_id      bigint NOT NULL REFERENCES seguridad.rol (id),
    PRIMARY KEY (usuario_id, rol_id)
);

CREATE TABLE seguridad.rol_permiso (
    rol_id      bigint NOT NULL REFERENCES seguridad.rol (id),
    permiso_id  bigint NOT NULL REFERENCES seguridad.permiso (id),
    PRIMARY KEY (rol_id, permiso_id)
);

-- Sesiones revocables: cada JWT lleva un jti que se valida en base de datos en CADA peticion,
-- de modo que bloquear a un usuario o cerrar sesion tiene efecto inmediato.
-- Una sesion es web (usuario) o ATM (tarjeta), nunca ambas.
CREATE TABLE seguridad.sesion (
    jti         uuid        PRIMARY KEY,
    tipo        text        NOT NULL CHECK (tipo IN ('web', 'atm')),
    usuario_id  bigint      REFERENCES seguridad.usuario (id),
    tarjeta_id  bigint      REFERENCES nucleo.tarjeta (id),
    creada_en   timestamptz NOT NULL DEFAULT now(),
    expira      timestamptz NOT NULL,
    revocada    boolean     NOT NULL DEFAULT false,
    ip          inet,
    CONSTRAINT sesion_un_sujeto CHECK ((usuario_id IS NULL) <> (tarjeta_id IS NULL)),
    CONSTRAINT sesion_tipo_coherente CHECK ((tipo = 'web') = (usuario_id IS NOT NULL))
);
-- Sin indices secundarios a proposito: la ruta caliente busca por la PK (jti); revocar todas las sesiones de un
-- usuario es raro (bloqueo / cambio de rol) y la tabla es chica. Ver la politica de indices en docs/RENDIMIENTO.md.

-- El actor de las transacciones apunta a un usuario real.
ALTER TABLE nucleo.transaccion ADD CONSTRAINT fk_transaccion_actor
    FOREIGN KEY (actor_usuario_id) REFERENCES seguridad.usuario (id);
ALTER TABLE nucleo.evento_cuenta ADD CONSTRAINT fk_evento_cuenta_actor
    FOREIGN KEY (actor_usuario_id) REFERENCES seguridad.usuario (id);

-- Un usuario con rol CLIENTE debe estar ligado a un cliente; el resto no.
CREATE OR REPLACE FUNCTION seguridad.fn_validar_usuario_rol() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    v_codigo  text;
    v_cliente bigint;
BEGIN
    SELECT codigo INTO v_codigo FROM seguridad.rol WHERE id = NEW.rol_id;
    SELECT cliente_id INTO v_cliente FROM seguridad.usuario WHERE id = NEW.usuario_id;
    IF v_codigo = 'CLIENTE' AND v_cliente IS NULL THEN
        RAISE EXCEPTION 'un usuario CLIENTE debe estar vinculado a un cliente' USING ERRCODE = '23514';
    END IF;
    IF v_codigo <> 'CLIENTE' AND v_cliente IS NOT NULL THEN
        RAISE EXCEPTION 'un usuario vinculado a un cliente solo puede tener el rol CLIENTE' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END
$$;
CREATE TRIGGER tg_usuario_rol_valida BEFORE INSERT ON seguridad.usuario_rol
    FOR EACH ROW EXECUTE FUNCTION seguridad.fn_validar_usuario_rol();

-- Auditoria (sin copiar el hash de la contrasena)
CREATE TRIGGER tg_usuario_auditoria
    AFTER INSERT OR DELETE ON seguridad.usuario
    FOR EACH ROW EXECUTE FUNCTION auditoria.fn_registrar('password_hash');
CREATE TRIGGER tg_usuario_cambios
    AFTER UPDATE ON seguridad.usuario
    FOR EACH ROW
    WHEN (OLD.estado IS DISTINCT FROM NEW.estado OR OLD.password_hash IS DISTINCT FROM NEW.password_hash)
    EXECUTE FUNCTION auditoria.fn_registrar('password_hash');
CREATE TRIGGER tg_usuario_rol_auditoria
    AFTER INSERT OR DELETE ON seguridad.usuario_rol
    FOR EACH ROW EXECUTE FUNCTION auditoria.fn_registrar();
CREATE TRIGGER tg_rol_permiso_auditoria
    AFTER INSERT OR DELETE ON seguridad.rol_permiso
    FOR EACH ROW EXECUTE FUNCTION auditoria.fn_registrar();

-- Catalogo de roles y permisos
INSERT INTO seguridad.rol (codigo, nombre, descripcion) VALUES
    ('ADMIN',   'Administrador', 'Gestion de usuarios, catalogos, consulta global y auditoria'),
    ('CAJERO',  'Cajero',        'Operaciones de ventanilla sobre clientes y cuentas'),
    ('AUDITOR', 'Auditor',       'Consulta de solo lectura incluida la auditoria global'),
    ('CLIENTE', 'Cliente',       'Portal personal: sus cuentas, transferencias y Bre-B');

INSERT INTO seguridad.permiso (codigo, descripcion) VALUES
    ('customers:read',    'Consultar clientes'),
    ('customers:write',   'Crear y editar clientes'),
    ('accounts:read',     'Consultar cualquier cuenta'),
    ('accounts:read_own', 'Consultar las cuentas propias'),
    ('accounts:write',    'Abrir cuentas'),
    ('accounts:state',    'Activar, bloquear, desbloquear y cerrar cuentas'),
    ('accounts:limits',   'Cambiar limites de cuentas'),
    ('tx:read',           'Consultar todas las transacciones'),
    ('tx:read_own',       'Consultar transacciones propias'),
    ('tx:deposit',        'Registrar consignaciones'),
    ('tx:withdraw',       'Registrar retiros de ventanilla'),
    ('tx:transfer',       'Transferir entre cualquier cuenta (ventanilla)'),
    ('tx:transfer_own',   'Transferir desde cuentas propias'),
    ('tx:reverse',        'Reversar transacciones'),
    ('tx:adjust',         'Registrar ajustes contables'),
    ('brebe:use',         'Usar Bre-B academico'),
    ('audit:read',        'Consultar la auditoria global'),
    ('users:read',        'Consultar usuarios'),
    ('users:write',       'Crear usuarios y asignar roles'),
    ('users:block',       'Bloquear y desbloquear usuarios'),
    ('roles:read',        'Consultar roles y permisos'),
    ('roles:write',       'Modificar roles y permisos'),
    ('stats:read',        'Consultar estadisticas e indicadores'),
    ('admin:queries',     'Ejecutar consultas administrativas predefinidas');

INSERT INTO seguridad.rol_permiso (rol_id, permiso_id)
SELECT r.id, p.id
  FROM (VALUES
    ('ADMIN',   'customers:read'), ('ADMIN', 'customers:write'),
    ('ADMIN',   'accounts:read'),  ('ADMIN', 'accounts:write'), ('ADMIN', 'accounts:state'),
    ('ADMIN',   'accounts:limits'),('ADMIN', 'tx:read'),        ('ADMIN', 'tx:reverse'),
    ('ADMIN',   'tx:adjust'),
    ('ADMIN',   'audit:read'),     ('ADMIN', 'users:read'),     ('ADMIN', 'users:write'),
    ('ADMIN',   'users:block'),    ('ADMIN', 'roles:read'),     ('ADMIN', 'roles:write'),
    ('ADMIN',   'stats:read'),     ('ADMIN', 'admin:queries'),
    ('CAJERO',  'customers:read'), ('CAJERO', 'customers:write'),
    ('CAJERO',  'accounts:read'),  ('CAJERO', 'accounts:write'), ('CAJERO', 'accounts:state'),
    ('CAJERO',  'tx:read'),        ('CAJERO', 'tx:deposit'),     ('CAJERO', 'tx:withdraw'),
    ('CAJERO',  'tx:transfer'),
    ('AUDITOR', 'customers:read'), ('AUDITOR', 'accounts:read'), ('AUDITOR', 'tx:read'),
    ('AUDITOR', 'audit:read'),     ('AUDITOR', 'stats:read'),
    ('CLIENTE', 'accounts:read_own'), ('CLIENTE', 'tx:read_own'),
    ('CLIENTE', 'tx:transfer_own'),   ('CLIENTE', 'brebe:use')
  ) AS m (rol, permiso)
  JOIN seguridad.rol r ON r.codigo = m.rol
  JOIN seguridad.permiso p ON p.codigo = m.permiso;
