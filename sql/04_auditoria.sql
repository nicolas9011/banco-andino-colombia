-- Bitacora de auditoria. El actor de negocio llega por variables de sesion que el
-- backend fija con set_config(..., true) al inicio de cada transaccion:
--   app.usuario_id, app.rol, app.ip
CREATE TABLE auditoria.evento (
    id              bigserial PRIMARY KEY,
    tabla           text        NOT NULL,
    operacion       text        NOT NULL,
    usuario         text        NOT NULL,           -- usuario de base de datos (session_user)
    usuario_app_id  bigint,                         -- usuario de negocio (seguridad.usuario)
    rol             text,
    ip              inet,
    registro_id     text,
    resultado       text        NOT NULL DEFAULT 'OK' CHECK (resultado IN ('OK', 'DENEGADO', 'ERROR')),
    antes           jsonb,
    despues         jsonb,
    ocurrido_en     timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION auditoria.ctx_usuario() RETURNS bigint
LANGUAGE sql STABLE AS $$
    SELECT nullif(pg_catalog.current_setting('app.usuario_id', true), '')::bigint
$$;

CREATE OR REPLACE FUNCTION auditoria.ctx_rol() RETURNS text
LANGUAGE sql STABLE AS $$
    SELECT nullif(pg_catalog.current_setting('app.rol', true), '')
$$;

CREATE OR REPLACE FUNCTION auditoria.ctx_ip() RETURNS inet
LANGUAGE plpgsql STABLE AS $$
BEGIN
    RETURN nullif(pg_catalog.current_setting('app.ip', true), '')::inet;
EXCEPTION WHEN OTHERS THEN
    RETURN NULL;   -- una IP mal formada nunca debe romper una operacion financiera
END
$$;

-- Registra INSERT/UPDATE/DELETE. Los argumentos del trigger son claves JSON a omitir
-- (hashes de contrasena o PIN no deben copiarse a la bitacora).
CREATE OR REPLACE FUNCTION auditoria.fn_registrar() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    -- Sin argumentos TG_ARGV no es un arreglo vacio: sin COALESCE la resta devolveria NULL.
    v_omitir  text[] := COALESCE(TG_ARGV, ARRAY[]::text[]);
    v_antes   jsonb := CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN to_jsonb(OLD) - v_omitir END;
    v_despues jsonb := CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN to_jsonb(NEW) - v_omitir END;
    v_fila    jsonb := COALESCE(CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN to_jsonb(NEW) END, to_jsonb(OLD));
BEGIN
    INSERT INTO auditoria.evento (tabla, operacion, usuario, usuario_app_id, rol, ip, registro_id, antes, despues)
    VALUES (
        TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME,
        TG_OP,
        session_user,
        auditoria.ctx_usuario(),
        auditoria.ctx_rol(),
        auditoria.ctx_ip(),
        -- Identificador del registro afectado. Las tablas sin columna "id" usan su clave primaria compuesta:
        -- asi siempre se puede responder "¿que paso con este registro?".
        COALESCE(v_fila ->> 'id',
                 CASE TG_TABLE_NAME
                     WHEN 'cuenta_titular' THEN concat_ws('-', v_fila ->> 'cuenta_id', v_fila ->> 'cliente_id')
                     WHEN 'usuario_rol'    THEN concat_ws('-', v_fila ->> 'usuario_id', v_fila ->> 'rol_id')
                     WHEN 'rol_permiso'    THEN concat_ws('-', v_fila ->> 'rol_id', v_fila ->> 'permiso_id')
                     WHEN 'cierre_diario'  THEN concat_ws('-', v_fila ->> 'fecha', v_fila ->> 'moneda')
                 END),
        v_antes,
        v_despues
    );
    RETURN NULL;
END
$$;

CREATE TRIGGER tg_cliente_auditoria
    AFTER INSERT OR UPDATE OR DELETE ON nucleo.cliente
    FOR EACH ROW EXECUTE FUNCTION auditoria.fn_registrar();

CREATE TRIGGER tg_oficina_auditoria
    AFTER INSERT OR UPDATE OR DELETE ON nucleo.oficina
    FOR EACH ROW EXECUTE FUNCTION auditoria.fn_registrar();

CREATE TRIGGER tg_producto_auditoria
    AFTER INSERT OR UPDATE OR DELETE ON nucleo.producto
    FOR EACH ROW EXECUTE FUNCTION auditoria.fn_registrar();

CREATE TRIGGER tg_cuenta_alta_baja
    AFTER INSERT OR DELETE ON nucleo.cuenta
    FOR EACH ROW EXECUTE FUNCTION auditoria.fn_registrar();

-- Los cambios de saldo no se auditan aqui (ya estan en movimiento); si estado y limites.
CREATE TRIGGER tg_cuenta_cambios
    AFTER UPDATE ON nucleo.cuenta
    FOR EACH ROW
    WHEN (OLD.estado IS DISTINCT FROM NEW.estado
          OR OLD.cliente_id IS DISTINCT FROM NEW.cliente_id OR OLD.producto_id IS DISTINCT FROM NEW.producto_id
          OR OLD.oficina_id IS DISTINCT FROM NEW.oficina_id OR OLD.moneda IS DISTINCT FROM NEW.moneda
          OR OLD.tipo IS DISTINCT FROM NEW.tipo OR OLD.tipo_titularidad IS DISTINCT FROM NEW.tipo_titularidad
          OR OLD.limite_retiro_diario IS DISTINCT FROM NEW.limite_retiro_diario
          OR OLD.limite_transferencia_diaria IS DISTINCT FROM NEW.limite_transferencia_diaria
          OR OLD.sobregiro_autorizado IS DISTINCT FROM NEW.sobregiro_autorizado)
    EXECUTE FUNCTION auditoria.fn_registrar();

CREATE TRIGGER tg_titular_auditoria
    AFTER INSERT OR DELETE ON nucleo.cuenta_titular
    FOR EACH ROW EXECUTE FUNCTION auditoria.fn_registrar();

-- Toda transaccion financiera contabilizada deja huella con su actor, canal e IP.
CREATE TRIGGER tg_transaccion_auditoria
    AFTER INSERT ON nucleo.transaccion
    FOR EACH ROW EXECUTE FUNCTION auditoria.fn_registrar();

CREATE TRIGGER tg_tarjeta_auditoria
    AFTER INSERT OR UPDATE OF estado, pin_hash, vence, cuenta_id, numero_hash ON nucleo.tarjeta
    FOR EACH ROW EXECUTE FUNCTION auditoria.fn_registrar('pin_hash', 'numero_hash');

CREATE TRIGGER tg_llave_brebe_auditoria
    AFTER INSERT OR UPDATE OF estado, cuenta_id, cliente_id, tipo, valor ON nucleo.llave_brebe
    FOR EACH ROW EXECUTE FUNCTION auditoria.fn_registrar();

CREATE TRIGGER tg_evento_inmutable
    BEFORE UPDATE OR DELETE ON auditoria.evento
    FOR EACH ROW EXECUTE FUNCTION nucleo.fn_inmutable();
CREATE TRIGGER tg_evento_truncate
    BEFORE TRUNCATE ON auditoria.evento
    FOR EACH STATEMENT EXECUTE FUNCTION nucleo.fn_inmutable();
