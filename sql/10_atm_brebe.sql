-- ATM: tarjeta + PIN. El backend calcula los hashes; la base nunca ve el numero ni el PIN.
CREATE OR REPLACE FUNCTION api.emitir_tarjeta(p_cuenta bigint, p_numero_hash text, p_ultimos4 text,
                                              p_pin_hash text, p_vence date)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, nucleo AS $$
DECLARE
    v_id bigint;
BEGIN
    IF p_numero_hash IS NULL OR p_pin_hash IS NULL OR p_vence IS NULL OR p_vence <= current_date THEN
        RAISE EXCEPTION 'datos de tarjeta invalidos' USING ERRCODE = '22023';
    END IF;
    -- FOR SHARE: un cierre concurrente de la cuenta (FOR NO KEY UPDATE) espera a que termine la emision.
    PERFORM 1 FROM nucleo.cuenta WHERE id = p_cuenta AND tipo = 'cliente' AND estado = 'activa' FOR SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'cuenta inexistente o no activa' USING ERRCODE = 'P0002';
    END IF;
    BEGIN
        INSERT INTO nucleo.tarjeta (cuenta_id, numero_hash, ultimos4, pin_hash, vence)
        VALUES (p_cuenta, p_numero_hash, p_ultimos4, p_pin_hash, p_vence)
        RETURNING id INTO v_id;
    EXCEPTION WHEN unique_violation THEN
        RAISE EXCEPTION 'la cuenta ya tiene una tarjeta activa' USING ERRCODE = 'P0006';
    END;
    RETURN v_id;
END
$$;

-- Devuelve el hash de PIN para que el backend lo verifique; nunca llega al navegador.
CREATE OR REPLACE FUNCTION api.obtener_tarjeta(p_numero_hash text)
RETURNS TABLE (tarjeta_id bigint, cuenta_id bigint, pin_hash text, estado text,
               intentos_fallidos integer, vence date, estado_cuenta text)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, nucleo AS $$
    SELECT t.id, t.cuenta_id, t.pin_hash, t.estado, t.intentos_fallidos, t.vence, c.estado
      FROM nucleo.tarjeta t JOIN nucleo.cuenta c ON c.id = t.cuenta_id
     WHERE t.numero_hash = p_numero_hash
$$;

-- Cuenta intentos de PIN. Al tercer fallo consecutivo la tarjeta queda bloqueada.
CREATE OR REPLACE FUNCTION api.registrar_resultado_pin(p_tarjeta bigint, p_ok boolean)
RETURNS TABLE (estado text, intentos_fallidos integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, nucleo AS $$
DECLARE
    v_t nucleo.tarjeta%ROWTYPE;
BEGIN
    SELECT * INTO v_t FROM nucleo.tarjeta WHERE id = p_tarjeta FOR NO KEY UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'tarjeta inexistente' USING ERRCODE = 'P0002';
    END IF;
    IF v_t.estado <> 'activa' THEN
        RETURN QUERY SELECT v_t.estado, v_t.intentos_fallidos;
        RETURN;
    END IF;
    IF p_ok THEN
        UPDATE nucleo.tarjeta SET intentos_fallidos = 0 WHERE id = p_tarjeta;
    ELSE
        UPDATE nucleo.tarjeta
           SET intentos_fallidos = nucleo.tarjeta.intentos_fallidos + 1,
               estado = CASE WHEN nucleo.tarjeta.intentos_fallidos + 1 >= 3 THEN 'bloqueada' ELSE 'activa' END
         WHERE id = p_tarjeta;
    END IF;
    RETURN QUERY SELECT t.estado, t.intentos_fallidos FROM nucleo.tarjeta t WHERE t.id = p_tarjeta;
END
$$;

CREATE OR REPLACE FUNCTION api.cambiar_pin(p_tarjeta bigint, p_pin_hash text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, nucleo AS $$
BEGIN
    IF p_pin_hash IS NULL OR length(p_pin_hash) < 20 THEN
        RAISE EXCEPTION 'hash de PIN invalido' USING ERRCODE = '22023';
    END IF;
    UPDATE nucleo.tarjeta SET pin_hash = p_pin_hash, intentos_fallidos = 0
     WHERE id = p_tarjeta AND estado = 'activa';
    IF NOT FOUND THEN
        RAISE EXCEPTION 'tarjeta inexistente o no activa' USING ERRCODE = 'P0002';
    END IF;
END
$$;

-- Verdadero si el cliente es titular o cotitular de la cuenta (control de propiedad para el portal).
CREATE OR REPLACE FUNCTION api.es_titular(p_cliente bigint, p_cuenta bigint)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, nucleo AS $$
    SELECT EXISTS (SELECT 1 FROM nucleo.cuenta_titular WHERE cuenta_id = p_cuenta AND cliente_id = p_cliente)
$$;

-- ---------------------------------------------------------------------------
-- Bre-B ACADEMICO (simulado): llaves + envios que usan el mismo motor contable.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION api.registrar_llave_brebe(p_cliente bigint, p_cuenta bigint, p_tipo text, p_valor text)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, nucleo AS $$
DECLARE
    v_valor text := lower(btrim(p_valor));
    v_id    bigint;
BEGIN
    IF p_tipo NOT IN ('celular', 'correo', 'documento', 'alfanumerica') THEN
        RAISE EXCEPTION 'tipo de llave invalido' USING ERRCODE = '22023';
    END IF;
    IF (p_tipo = 'celular'      AND v_valor !~ '^3[0-9]{9}$')
    OR (p_tipo = 'correo'       AND v_valor !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$')
    OR (p_tipo = 'documento'    AND v_valor !~ '^[0-9]{5,15}$')
    OR (p_tipo = 'alfanumerica' AND v_valor !~ '^@[a-z0-9]{4,20}$') THEN
        RAISE EXCEPTION 'formato de llave invalido para el tipo %', p_tipo USING ERRCODE = '22023';
    END IF;
    -- Pertenencia: una llave de documento/correo/celular solo puede registrarla la persona a quien identifica;
    -- si no, cualquiera podria "secuestrar" la llave ajena y recibir los pagos destinados a otra persona.
    IF p_tipo <> 'alfanumerica' AND NOT EXISTS (
        SELECT 1 FROM nucleo.cliente cl WHERE cl.id = p_cliente AND (
               (p_tipo = 'documento' AND lower(btrim(cl.documento)) = v_valor)
            OR (p_tipo = 'correo'    AND lower(btrim(cl.correo))    = v_valor)
            OR (p_tipo = 'celular'   AND regexp_replace(coalesce(cl.telefono, ''), '[^0-9]', '', 'g') IN (v_valor, '57' || v_valor)))) THEN
        RAISE EXCEPTION 'la llave de tipo % debe coincidir con los datos registrados del cliente', p_tipo USING ERRCODE = '22023';
    END IF;
    PERFORM 1 FROM nucleo.cuenta c
      JOIN nucleo.cuenta_titular t ON t.cuenta_id = c.id AND t.cliente_id = p_cliente
     WHERE c.id = p_cuenta AND c.tipo = 'cliente' AND c.estado = 'activa' AND c.moneda = 'COP'
       FOR SHARE OF c;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'la cuenta no existe, no esta activa, no es COP o no pertenece al cliente' USING ERRCODE = 'P0002';
    END IF;
    BEGIN
        INSERT INTO nucleo.llave_brebe (cliente_id, cuenta_id, tipo, valor)
        VALUES (p_cliente, p_cuenta, p_tipo, v_valor) RETURNING id INTO v_id;
    EXCEPTION WHEN unique_violation THEN
        RAISE EXCEPTION 'la llave ya esta registrada' USING ERRCODE = 'P0008';
    END;
    RETURN v_id;
END
$$;

CREATE OR REPLACE FUNCTION api.desactivar_llave_brebe(p_llave bigint, p_cliente bigint)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, nucleo AS $$
BEGIN
    UPDATE nucleo.llave_brebe SET estado = 'inactiva'
     WHERE id = p_llave AND cliente_id = p_cliente AND estado = 'activa';
    IF NOT FOUND THEN
        RAISE EXCEPTION 'llave inexistente' USING ERRCODE = 'P0002';
    END IF;
END
$$;

CREATE OR REPLACE FUNCTION api.enviar_brebe(p_clave text, p_cuenta_origen bigint, p_llave text,
                                            p_monto numeric, p_concepto text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, nucleo AS $$
DECLARE
    v_llave nucleo.llave_brebe%ROWTYPE;
    v_id    uuid;
BEGIN
    SELECT * INTO v_llave FROM nucleo.llave_brebe WHERE valor = lower(btrim(p_llave)) AND estado = 'activa';
    IF NOT FOUND THEN
        RAISE EXCEPTION 'llave Bre-B no encontrada' USING ERRCODE = 'P0002';
    END IF;
    PERFORM 1 FROM nucleo.cuenta WHERE id = p_cuenta_origen AND moneda = 'COP';
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Bre-B solo opera cuentas en COP' USING ERRCODE = '22023';
    END IF;

    v_id := api.registrar_transaccion(p_clave, 'transferencia', p_cuenta_origen, v_llave.cuenta_id,
                                      p_monto, 'brebe', p_concepto);
    INSERT INTO nucleo.brebe_operacion (transaccion_id, llave_destino_id)
    VALUES (v_id, v_llave.id) ON CONFLICT (transaccion_id) DO NOTHING;
    RETURN v_id;
END
$$;

-- Las funciones creadas despues de 06 nacen ejecutables por PUBLIC: se cierra aqui.
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA api FROM PUBLIC;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA api TO rol_lab_app;
