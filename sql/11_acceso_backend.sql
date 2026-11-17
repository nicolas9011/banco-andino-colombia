-- Funciones que el backend usa para autenticar y administrar usuarios/roles.
-- El backend (rol lab_api) no lee tablas de seguridad directamente: solo estas funciones y vistas.

CREATE OR REPLACE FUNCTION api.auth_usuario(p_username text)
RETURNS TABLE (id bigint, password_hash text, estado text, intentos_fallidos integer, bloqueado_hasta timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, seguridad AS $$
    SELECT u.id, u.password_hash, u.estado, u.intentos_fallidos, u.bloqueado_hasta
      FROM seguridad.usuario u WHERE lower(u.username) = lower(p_username)
$$;

-- Tras p_max fallos consecutivos el usuario queda bloqueado temporalmente p_minutos.
CREATE OR REPLACE FUNCTION api.auth_registrar_fallo(p_usuario bigint, p_max integer, p_minutos integer)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, seguridad AS $$
    UPDATE seguridad.usuario
       SET intentos_fallidos = CASE WHEN intentos_fallidos + 1 >= p_max THEN 0 ELSE intentos_fallidos + 1 END,
           bloqueado_hasta   = CASE WHEN intentos_fallidos + 1 >= p_max
                                    THEN now() + make_interval(mins => p_minutos) ELSE bloqueado_hasta END
     WHERE id = p_usuario
$$;

CREATE OR REPLACE FUNCTION api.auth_registrar_exito(p_usuario bigint)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, seguridad AS $$
    UPDATE seguridad.usuario SET intentos_fallidos = 0, bloqueado_hasta = NULL, ultimo_acceso = now()
     WHERE id = p_usuario
$$;

CREATE OR REPLACE FUNCTION api.crear_sesion(p_jti uuid, p_tipo text, p_usuario bigint, p_tarjeta bigint,
                                            p_expira timestamptz, p_ip inet DEFAULT NULL)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, seguridad AS $$
    INSERT INTO seguridad.sesion (jti, tipo, usuario_id, tarjeta_id, expira, ip)
    VALUES (p_jti, p_tipo, p_usuario, p_tarjeta, p_expira, p_ip)
$$;

CREATE OR REPLACE FUNCTION api.revocar_sesion(p_jti uuid)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, seguridad AS $$
    UPDATE seguridad.sesion SET revocada = true WHERE jti = p_jti
$$;

CREATE OR REPLACE FUNCTION api.revocar_sesiones_usuario(p_usuario bigint)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, seguridad AS $$
    UPDATE seguridad.sesion SET revocada = true WHERE usuario_id = p_usuario AND NOT revocada
$$;

-- Estado vigente de una sesion con sus roles y permisos ACTUALES (no los del momento del login).
CREATE OR REPLACE FUNCTION api.cargar_sesion(p_jti uuid)
RETURNS TABLE (usuario_id bigint, username text, nombre_completo text, cliente_id bigint, oficina_id bigint,
               roles text[], permisos text[], tarjeta_id bigint, cuenta_id bigint, valida boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, seguridad, nucleo AS $$
    SELECT s.usuario_id, u.username, u.nombre_completo, u.cliente_id, u.oficina_id,
           COALESCE((SELECT array_agg(r.codigo ORDER BY r.codigo)
                       FROM seguridad.usuario_rol ur JOIN seguridad.rol r ON r.id = ur.rol_id
                      WHERE ur.usuario_id = u.id), ARRAY[]::text[]),
           COALESCE((SELECT array_agg(DISTINCT p.codigo ORDER BY p.codigo)
                       FROM seguridad.usuario_rol ur
                       JOIN seguridad.rol_permiso rp ON rp.rol_id = ur.rol_id
                       JOIN seguridad.permiso p ON p.id = rp.permiso_id
                      WHERE ur.usuario_id = u.id), ARRAY[]::text[]),
           s.tarjeta_id, t.cuenta_id,
           COALESCE(NOT s.revocada AND s.expira > now()
                    AND ((u.id IS NOT NULL AND u.estado = 'activo') OR (t.id IS NOT NULL AND t.estado = 'activa')),
                    false)
      FROM seguridad.sesion s
      LEFT JOIN seguridad.usuario u ON u.id = s.usuario_id
      LEFT JOIN nucleo.tarjeta t ON t.id = s.tarjeta_id
     WHERE s.jti = p_jti
$$;

-- ---------------------------------------------------------------------------
-- Administracion de usuarios y roles
-- ---------------------------------------------------------------------------
CREATE VIEW api.v_usuarios AS
SELECT u.id, u.username, u.nombre_completo, u.correo, u.estado, u.cliente_id, u.oficina_id,
       u.bloqueado_hasta, u.ultimo_acceso, u.creado_en,
       COALESCE((SELECT array_agg(r.codigo ORDER BY r.codigo)
                   FROM seguridad.usuario_rol ur JOIN seguridad.rol r ON r.id = ur.rol_id
                  WHERE ur.usuario_id = u.id), ARRAY[]::text[]) AS roles
  FROM seguridad.usuario u;

CREATE VIEW api.v_roles AS
SELECT r.id, r.codigo, r.nombre, r.descripcion,
       COALESCE((SELECT array_agg(p.codigo ORDER BY p.codigo)
                   FROM seguridad.rol_permiso rp JOIN seguridad.permiso p ON p.id = rp.permiso_id
                  WHERE rp.rol_id = r.id), ARRAY[]::text[]) AS permisos
  FROM seguridad.rol r;

CREATE VIEW api.v_permisos AS
SELECT id, codigo, descripcion FROM seguridad.permiso;

CREATE OR REPLACE FUNCTION api.crear_usuario(
    p_username text, p_hash text, p_nombre text, p_correo text,
    p_cliente bigint, p_oficina bigint, p_roles text[]
) RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, seguridad, nucleo AS $$
DECLARE
    v_id bigint;
BEGIN
    IF p_roles IS NULL OR cardinality(p_roles) = 0 THEN
        RAISE EXCEPTION 'el usuario requiere al menos un rol' USING ERRCODE = '22023';
    END IF;
    IF (SELECT count(*) FROM seguridad.rol WHERE codigo = ANY (p_roles)) <> cardinality(p_roles) THEN
        RAISE EXCEPTION 'rol inexistente' USING ERRCODE = '22023';
    END IF;
    INSERT INTO seguridad.usuario (username, password_hash, nombre_completo, correo, cliente_id, oficina_id)
    VALUES (lower(p_username), p_hash, p_nombre, p_correo, p_cliente, p_oficina)
    RETURNING id INTO v_id;
    INSERT INTO seguridad.usuario_rol (usuario_id, rol_id)
    SELECT v_id, id FROM seguridad.rol WHERE codigo = ANY (p_roles);
    RETURN v_id;
END
$$;

-- Evita dejar el sistema sin ningun administrador activo.
CREATE OR REPLACE FUNCTION seguridad.fn_quedan_admins(p_excluir bigint) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, seguridad AS $$
    SELECT EXISTS (
        SELECT 1 FROM seguridad.usuario u
          JOIN seguridad.usuario_rol ur ON ur.usuario_id = u.id
          JOIN seguridad.rol r ON r.id = ur.rol_id AND r.codigo = 'ADMIN'
         WHERE u.estado = 'activo' AND u.id <> p_excluir)
$$;

CREATE OR REPLACE FUNCTION api.asignar_roles_usuario(p_usuario bigint, p_roles text[])
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, seguridad AS $$
BEGIN
    -- Serializa TODOS los cambios que pueden quitar administradores: sin este candado, dos administradores que se
    -- bloquean entre si a la vez ven "queda otro" y ambos confirman (write skew), dejando el sistema sin admin.
    PERFORM pg_advisory_xact_lock(hashtext('seguridad.administradores'));
    PERFORM 1 FROM seguridad.usuario WHERE id = p_usuario FOR NO KEY UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'usuario inexistente' USING ERRCODE = 'P0002';
    END IF;
    IF p_roles IS NULL OR cardinality(p_roles) = 0
       OR (SELECT count(*) FROM seguridad.rol WHERE codigo = ANY (p_roles)) <> cardinality(p_roles) THEN
        RAISE EXCEPTION 'lista de roles invalida' USING ERRCODE = '22023';
    END IF;
    IF NOT ('ADMIN' = ANY (p_roles)) AND NOT seguridad.fn_quedan_admins(p_usuario)
       AND EXISTS (SELECT 1 FROM seguridad.usuario_rol ur JOIN seguridad.rol r ON r.id = ur.rol_id
                    WHERE ur.usuario_id = p_usuario AND r.codigo = 'ADMIN') THEN
        RAISE EXCEPTION 'no se puede quitar el ultimo administrador activo' USING ERRCODE = 'P0006';
    END IF;
    DELETE FROM seguridad.usuario_rol WHERE usuario_id = p_usuario;
    INSERT INTO seguridad.usuario_rol (usuario_id, rol_id)
    SELECT p_usuario, id FROM seguridad.rol WHERE codigo = ANY (p_roles);
END
$$;

CREATE OR REPLACE FUNCTION api.cambiar_estado_usuario(p_usuario bigint, p_estado text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, seguridad AS $$
DECLARE
    v_es_admin boolean;
BEGIN
    IF p_estado NOT IN ('activo', 'bloqueado', 'inactivo') THEN
        RAISE EXCEPTION 'estado invalido' USING ERRCODE = '22023';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtext('seguridad.administradores'));   -- ver asignar_roles_usuario
    SELECT EXISTS (SELECT 1 FROM seguridad.usuario_rol ur JOIN seguridad.rol r ON r.id = ur.rol_id
                    WHERE ur.usuario_id = p_usuario AND r.codigo = 'ADMIN') INTO v_es_admin;
    IF p_estado <> 'activo' AND v_es_admin AND NOT seguridad.fn_quedan_admins(p_usuario) THEN
        RAISE EXCEPTION 'no se puede desactivar al ultimo administrador activo' USING ERRCODE = 'P0006';
    END IF;
    UPDATE seguridad.usuario
       SET estado = p_estado,
           intentos_fallidos = 0,
           bloqueado_hasta = NULL
     WHERE id = p_usuario;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'usuario inexistente' USING ERRCODE = 'P0002';
    END IF;
    IF p_estado <> 'activo' THEN
        UPDATE seguridad.sesion SET revocada = true WHERE usuario_id = p_usuario AND NOT revocada;
    END IF;
END
$$;

CREATE OR REPLACE FUNCTION api.asignar_permisos_rol(p_rol text, p_permisos text[])
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, seguridad AS $$
DECLARE
    v_rol bigint;
BEGIN
    SELECT id INTO v_rol FROM seguridad.rol WHERE codigo = p_rol FOR NO KEY UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'rol inexistente' USING ERRCODE = 'P0002';
    END IF;
    IF p_permisos IS NULL
       OR (SELECT count(*) FROM seguridad.permiso WHERE codigo = ANY (p_permisos)) <> cardinality(p_permisos) THEN
        RAISE EXCEPTION 'permiso inexistente' USING ERRCODE = '22023';
    END IF;
    IF p_rol = 'ADMIN' AND NOT (p_permisos @> ARRAY['roles:write', 'users:write']) THEN
        RAISE EXCEPTION 'ADMIN debe conservar roles:write y users:write' USING ERRCODE = 'P0006';
    END IF;
    DELETE FROM seguridad.rol_permiso WHERE rol_id = v_rol;
    INSERT INTO seguridad.rol_permiso (rol_id, permiso_id)
    SELECT v_rol, id FROM seguridad.permiso WHERE codigo = ANY (p_permisos);
END
$$;

-- Vista previa de Bre-B: devuelve el nombre del titular parcialmente oculto (privacidad).
CREATE OR REPLACE FUNCTION api.resolver_llave_brebe(p_valor text)
RETURNS TABLE (llave_id bigint, titular text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, nucleo AS $$
    SELECT l.id,
           (SELECT string_agg(left(w, 1) || repeat('*', greatest(length(w) - 1, 2)), ' ')
              FROM unnest(string_to_array(c.nombre, ' ')) w)
      FROM nucleo.llave_brebe l JOIN nucleo.cliente c ON c.id = l.cliente_id
     WHERE l.valor = lower(btrim(p_valor)) AND l.estado = 'activa'
$$;

-- Hash vigente del PIN de una tarjeta ACTIVA, para verificar el PIN actual al cambiarlo.
CREATE OR REPLACE FUNCTION api.obtener_pin_hash(p_tarjeta bigint) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, nucleo AS $$
    SELECT pin_hash FROM nucleo.tarjeta WHERE id = p_tarjeta AND estado = 'activa'
$$;

GRANT SELECT ON api.v_usuarios, api.v_roles, api.v_permisos TO rol_lab_app;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA api FROM PUBLIC;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA api TO rol_lab_app;
