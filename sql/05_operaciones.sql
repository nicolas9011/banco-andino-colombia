-- Codigos de error de aplicacion (SQLSTATE):
--   22023 parametro invalido        P0002 recurso inexistente o no activo
--   P0003 clave de idempotencia reutilizada con otros datos
--   P0004 saldo insuficiente        P0005 limite diario excedido
--   P0006 transicion/estado invalido  P0007 transaccion ya reversada
--   P0008 llave Bre-B ya registrada

-- ---------------------------------------------------------------------------
-- Auxiliares internos (no expuestos a la aplicacion)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION nucleo.fn_evento_cuenta(p_cuenta bigint, p_tipo text, p_motivo text, p_datos jsonb DEFAULT NULL)
RETURNS void LANGUAGE sql SET search_path = pg_catalog, nucleo AS $$
    INSERT INTO nucleo.evento_cuenta (cuenta_id, tipo, motivo, actor_usuario_id, datos)
    VALUES (p_cuenta, p_tipo, p_motivo, auditoria.ctx_usuario(), p_datos)
$$;

-- Nucleo contable. Orden obligatorio:
--   1) bloquear cuentas (menor id primero), 2) insertar transaccion idempotente, 3) validar, 4) asentar.
-- Las cuentas se bloquean ANTES del INSERT: el INSERT toma KEY SHARE sobre las cuentas por las FK,
-- y un FOR UPDATE posterior chocaba entre transferencias cruzadas (deadlock detectado en la linea base).
CREATE OR REPLACE FUNCTION nucleo.fn_postear(
    p_clave text, p_tipo text, p_deb bigint, p_cre bigint, p_monto numeric,
    p_canal text, p_concepto text, p_reversa_de uuid DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql SET search_path = pg_catalog, nucleo AS $$
DECLARE
    v_id      uuid;
    v_previa  nucleo.transaccion%ROWTYPE;
    v_origen  nucleo.cuenta%ROWTYPE;
    v_destino nucleo.cuenta%ROWTYPE;
    v_inicio  timestamptz;
    v_limite  numeric;
    v_acum    numeric;
BEGIN
    PERFORM 1 FROM nucleo.cuenta WHERE id = least(p_deb, p_cre) FOR NO KEY UPDATE;
    PERFORM 1 FROM nucleo.cuenta WHERE id = greatest(p_deb, p_cre) FOR NO KEY UPDATE;

    -- Idempotencia: la restriccion unica serializa claves iguales concurrentes.
    INSERT INTO nucleo.transaccion (clave_idempotencia, tipo, monto, cuenta_debito, cuenta_credito,
                                    canal, concepto, actor_usuario_id, ip, reversa_de)
    VALUES (p_clave, p_tipo, p_monto, p_deb, p_cre, p_canal, p_concepto,
            auditoria.ctx_usuario(), auditoria.ctx_ip(), p_reversa_de)
    ON CONFLICT (clave_idempotencia) DO NOTHING
    RETURNING id INTO v_id;

    IF v_id IS NULL THEN
        SELECT * INTO v_previa FROM nucleo.transaccion WHERE clave_idempotencia = p_clave;
        -- La MISMA solicitud: todo lo que define la operacion debe coincidir (un reverso apunta a su original;
        -- el canal y el concepto tambien cuentan). Otra cosa con la misma clave es un error, no un reintento.
        IF v_previa.tipo <> p_tipo OR v_previa.monto <> p_monto
           OR v_previa.cuenta_debito <> p_deb OR v_previa.cuenta_credito <> p_cre
           OR v_previa.reversa_de IS DISTINCT FROM p_reversa_de OR v_previa.canal <> p_canal
           OR v_previa.concepto IS DISTINCT FROM p_concepto THEN
            RAISE EXCEPTION 'clave reutilizada con datos distintos' USING ERRCODE = 'P0003';
        END IF;
        RETURN v_previa.id;
    END IF;

    SELECT * INTO v_origen  FROM nucleo.cuenta WHERE id = p_deb;
    SELECT * INTO v_destino FROM nucleo.cuenta WHERE id = p_cre;

    IF v_origen.tipo = 'cliente' THEN
        IF v_origen.estado <> 'activa' THEN
            RAISE EXCEPTION 'la cuenta de origen no esta activa' USING ERRCODE = 'P0002';
        END IF;
        IF v_origen.saldo + v_origen.sobregiro_autorizado < p_monto THEN
            RAISE EXCEPTION 'saldo insuficiente' USING ERRCODE = 'P0004';
        END IF;
    END IF;
    IF v_destino.tipo = 'cliente' AND v_destino.estado <> 'activa' THEN
        RAISE EXCEPTION 'la cuenta de destino no esta activa' USING ERRCODE = 'P0002';
    END IF;

    -- Limites diarios (dia calendario de Colombia). La suma ya incluye esta transaccion.
    v_limite := CASE WHEN v_origen.tipo <> 'cliente' THEN NULL
                     WHEN p_tipo = 'retiro'          THEN v_origen.limite_retiro_diario
                     WHEN p_tipo = 'transferencia'   THEN v_origen.limite_transferencia_diaria END;
    IF v_limite IS NOT NULL THEN
        v_inicio := date_trunc('day', now() AT TIME ZONE 'America/Bogota') AT TIME ZONE 'America/Bogota';
        SELECT COALESCE(sum(monto), 0) INTO v_acum
          FROM nucleo.transaccion
         WHERE cuenta_debito = p_deb AND tipo = p_tipo AND creado_en >= v_inicio;
        IF v_acum > v_limite THEN
            RAISE EXCEPTION 'limite diario excedido' USING ERRCODE = 'P0005';
        END IF;
    END IF;

    INSERT INTO nucleo.movimiento (transaccion_id, cuenta_id, sentido, monto, saldo_posterior)
    VALUES (v_id, p_deb, 'D', p_monto, 0);
    INSERT INTO nucleo.movimiento (transaccion_id, cuenta_id, sentido, monto, saldo_posterior)
    VALUES (v_id, p_cre, 'C', p_monto, 0);

    RETURN v_id;
END
$$;

-- ---------------------------------------------------------------------------
-- API publica
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION api.registrar_cliente(
    p_documento    text,
    p_nombre       text,
    p_correo       text DEFAULT NULL,
    p_tipo_persona text DEFAULT 'natural',
    p_tipo_documento text DEFAULT NULL,
    p_telefono     text DEFAULT NULL,
    p_departamento text DEFAULT NULL,
    p_ciudad       text DEFAULT NULL,
    p_direccion    text DEFAULT NULL
) RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, nucleo AS $$
DECLARE
    v_id   bigint;
    v_doc  text := btrim(p_documento);
    v_tdoc text;
BEGIN
    IF v_doc IS NULL OR v_doc = '' OR p_nombre IS NULL OR btrim(p_nombre) = '' THEN
        RAISE EXCEPTION 'documento y nombre son obligatorios' USING ERRCODE = '22023';
    END IF;
    IF v_doc !~ '^[0-9A-Za-z-]{3,20}$' OR upper(v_doc) = 'SISTEMA' THEN
        RAISE EXCEPTION 'documento invalido' USING ERRCODE = '22023';
    END IF;
    IF p_tipo_persona NOT IN ('natural', 'juridica') THEN
        RAISE EXCEPTION 'tipo de persona invalido' USING ERRCODE = '22023';
    END IF;
    IF p_departamento IS NULL OR btrim(p_departamento) = '' OR p_ciudad IS NULL OR btrim(p_ciudad) = '' THEN
        RAISE EXCEPTION 'departamento y ciudad son obligatorios' USING ERRCODE = '22023';
    END IF;
    IF p_correo IS NOT NULL AND p_correo !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' THEN
        RAISE EXCEPTION 'correo invalido' USING ERRCODE = '22023';
    END IF;
    v_tdoc := COALESCE(p_tipo_documento, CASE WHEN p_tipo_persona = 'juridica' THEN 'NIT' ELSE 'CC' END);
    IF v_tdoc NOT IN ('CC', 'CE', 'TI', 'PAS', 'NIT') OR (p_tipo_persona = 'juridica') <> (v_tdoc = 'NIT') THEN
        RAISE EXCEPTION 'tipo de documento incompatible con el tipo de persona' USING ERRCODE = '22023';
    END IF;

    INSERT INTO nucleo.cliente (tipo_persona, tipo_documento, documento, nombre, correo,
                                telefono, departamento, ciudad, direccion)
    VALUES (p_tipo_persona, v_tdoc, v_doc, btrim(p_nombre), p_correo,
            p_telefono, p_departamento, p_ciudad, p_direccion)
    ON CONFLICT (documento) DO NOTHING
    RETURNING id INTO v_id;

    IF v_id IS NULL THEN
        SELECT id INTO v_id FROM nucleo.cliente WHERE documento = v_doc;
    END IF;
    RETURN v_id;
END
$$;

CREATE OR REPLACE FUNCTION api.abrir_cuenta(
    p_cliente     bigint,
    p_moneda      char(3),
    p_producto    bigint   DEFAULT NULL,
    p_oficina     bigint   DEFAULT NULL,
    p_cotitulares bigint[] DEFAULT '{}',
    p_activar     boolean  DEFAULT true
) RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, nucleo AS $$
DECLARE
    v_cli   nucleo.cliente%ROWTYPE;
    v_prod  nucleo.producto%ROWTYPE;
    v_of    bigint;
    v_tit   text;
    v_f     numeric := CASE WHEN p_moneda = 'USD' THEN 4000 ELSE 1 END;
    v_cot   bigint[] := COALESCE(p_cotitulares, '{}');
    v_id    bigint;
BEGIN
    SELECT * INTO v_cli FROM nucleo.cliente WHERE id = p_cliente AND tipo_documento <> 'SIS';
    IF NOT FOUND THEN
        RAISE EXCEPTION 'cliente % inexistente', p_cliente USING ERRCODE = 'P0002';
    END IF;
    IF v_cli.estado <> 'activo' THEN
        RAISE EXCEPTION 'el cliente no esta activo' USING ERRCODE = 'P0006';
    END IF;
    IF p_moneda NOT IN ('COP', 'USD') THEN
        RAISE EXCEPTION 'moneda invalida' USING ERRCODE = '22023';
    END IF;

    IF p_producto IS NULL THEN
        SELECT * INTO v_prod FROM nucleo.producto WHERE tipo = 'ahorro' AND activo ORDER BY id LIMIT 1;
    ELSE
        SELECT * INTO v_prod FROM nucleo.producto WHERE id = p_producto AND activo;
    END IF;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'producto inexistente' USING ERRCODE = 'P0002';
    END IF;

    IF p_oficina IS NOT NULL THEN
        SELECT id INTO v_of FROM nucleo.oficina WHERE estado = 'activa' AND id = p_oficina;
        IF v_of IS NULL THEN
            RAISE EXCEPTION 'oficina inexistente' USING ERRCODE = 'P0002';
        END IF;
        -- Consistencia geografica: si el departamento del cliente tiene oficina, la cuenta se abre alli.
        IF EXISTS (SELECT 1 FROM nucleo.oficina WHERE estado = 'activa' AND departamento = v_cli.departamento)
           AND NOT EXISTS (SELECT 1 FROM nucleo.oficina WHERE id = v_of AND departamento = v_cli.departamento) THEN
            RAISE EXCEPTION 'la oficina debe estar en el departamento del cliente (%)', v_cli.departamento
                USING ERRCODE = '22023';
        END IF;
    ELSE
        -- Por defecto: oficina del departamento del cliente; si no hay, la primera oficina activa.
        SELECT id INTO v_of FROM nucleo.oficina
         WHERE estado = 'activa' ORDER BY (departamento = v_cli.departamento) DESC, id LIMIT 1;
        IF v_of IS NULL THEN
            RAISE EXCEPTION 'no hay oficinas activas' USING ERRCODE = 'P0002';
        END IF;
    END IF;

    IF p_cliente = ANY (v_cot)
       OR (SELECT count(DISTINCT x) FROM unnest(v_cot) x) <> cardinality(v_cot) THEN
        RAISE EXCEPTION 'cotitulares repetidos o igual al titular' USING ERRCODE = '22023';
    END IF;
    IF (SELECT count(*) FROM nucleo.cliente
         WHERE id = ANY (v_cot) AND estado = 'activo' AND tipo_persona = 'natural') <> cardinality(v_cot) THEN
        RAISE EXCEPTION 'cotitular inexistente, inactivo o persona juridica' USING ERRCODE = 'P0002';
    END IF;

    v_tit := CASE WHEN v_cli.tipo_persona = 'juridica' THEN 'empresarial'
                  WHEN cardinality(v_cot) > 0 THEN 'conjunta' ELSE 'individual' END;
    IF v_tit = 'empresarial' AND cardinality(v_cot) > 0 THEN
        RAISE EXCEPTION 'una cuenta empresarial no admite cotitulares naturales' USING ERRCODE = '22023';
    END IF;

    INSERT INTO nucleo.cuenta (cliente_id, producto_id, oficina_id, numero, moneda, tipo_titularidad, estado,
                               sobregiro_autorizado, limite_retiro_diario, limite_transferencia_diaria)
    VALUES (p_cliente, v_prod.id, v_of, 'LB-' || lpad(nextval('nucleo.seq_numero_cuenta')::text, 10, '0'),
            p_moneda, v_tit, 'pendiente',
            round(v_prod.sobregiro_maximo / v_f, 2),
            round(v_prod.limite_retiro_diario / v_f, 2),
            round(v_prod.limite_transferencia_diaria / v_f, 2))
    RETURNING id INTO v_id;

    INSERT INTO nucleo.cuenta_titular (cuenta_id, cliente_id, rol) VALUES (v_id, p_cliente, 'titular');
    INSERT INTO nucleo.cuenta_titular (cuenta_id, cliente_id, rol)
    SELECT v_id, x, 'cotitular' FROM unnest(v_cot) x;

    PERFORM nucleo.fn_evento_cuenta(v_id, 'creacion', NULL, jsonb_build_object('producto', v_prod.codigo));
    IF p_activar THEN
        UPDATE nucleo.cuenta SET estado = 'activa' WHERE id = v_id;
        PERFORM nucleo.fn_evento_cuenta(v_id, 'activacion', NULL);
    END IF;
    RETURN v_id;
END
$$;

CREATE OR REPLACE FUNCTION api.cambiar_estado_cuenta(p_cuenta bigint, p_estado text, p_motivo text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, nucleo AS $$
DECLARE
    v_cta    nucleo.cuenta%ROWTYPE;
    v_evento text;
BEGIN
    IF p_estado NOT IN ('activa', 'bloqueada', 'cerrada') THEN
        RAISE EXCEPTION 'estado invalido: %', p_estado USING ERRCODE = '22023';
    END IF;

    SELECT * INTO v_cta FROM nucleo.cuenta WHERE id = p_cuenta AND tipo = 'cliente' FOR NO KEY UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'cuenta % inexistente', p_cuenta USING ERRCODE = 'P0002';
    END IF;

    v_evento := CASE
        WHEN v_cta.estado = 'pendiente' AND p_estado = 'activa'   THEN 'activacion'
        WHEN v_cta.estado = 'activa'    AND p_estado = 'bloqueada' THEN 'bloqueo'
        WHEN v_cta.estado = 'bloqueada' AND p_estado = 'activa'   THEN 'desbloqueo'
        WHEN v_cta.estado IN ('pendiente', 'activa', 'bloqueada') AND p_estado = 'cerrada' THEN 'cierre'
    END;
    IF v_evento IS NULL THEN
        RAISE EXCEPTION 'transicion no permitida: % -> %', v_cta.estado, p_estado USING ERRCODE = 'P0006';
    END IF;
    IF v_evento = 'cierre' AND v_cta.saldo <> 0 THEN
        RAISE EXCEPTION 'solo se puede cerrar una cuenta con saldo cero' USING ERRCODE = 'P0006';
    END IF;

    UPDATE nucleo.cuenta SET estado = p_estado WHERE id = p_cuenta;
    PERFORM nucleo.fn_evento_cuenta(p_cuenta, v_evento, p_motivo,
                                    jsonb_build_object('antes', v_cta.estado, 'despues', p_estado));

    -- Cerrar una cuenta deja sin efecto sus tarjetas y llaves Bre-B (no quedan medios de acceso colgando).
    IF v_evento = 'cierre' THEN
        UPDATE nucleo.tarjeta SET estado = 'cancelada' WHERE cuenta_id = p_cuenta AND estado IN ('activa', 'bloqueada');
        UPDATE nucleo.llave_brebe SET estado = 'inactiva' WHERE cuenta_id = p_cuenta AND estado = 'activa';
    END IF;
END
$$;

CREATE OR REPLACE FUNCTION api.cambiar_limites(
    p_cuenta bigint, p_retiro_diario numeric, p_transferencia_diaria numeric,
    p_sobregiro numeric DEFAULT NULL, p_motivo text DEFAULT NULL
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, nucleo AS $$
DECLARE
    v_cta  nucleo.cuenta%ROWTYPE;
    v_prod nucleo.producto%ROWTYPE;
    v_f    numeric;
    v_sob  numeric;
BEGIN
    -- NaN pasaria "<= 0" y "<> round()" y desactivaria el limite diario (v_acum > NaN es siempre falso).
    IF p_retiro_diario IS NULL OR p_retiro_diario = 'NaN'::numeric OR p_retiro_diario <= 0 OR p_retiro_diario <> round(p_retiro_diario, 2)
       OR p_transferencia_diaria IS NULL OR p_transferencia_diaria = 'NaN'::numeric OR p_transferencia_diaria <= 0
       OR p_transferencia_diaria <> round(p_transferencia_diaria, 2)
       OR p_sobregiro = 'NaN'::numeric THEN
        RAISE EXCEPTION 'limites invalidos' USING ERRCODE = '22023';
    END IF;

    SELECT * INTO v_cta FROM nucleo.cuenta WHERE id = p_cuenta AND tipo = 'cliente' FOR NO KEY UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'cuenta % inexistente', p_cuenta USING ERRCODE = 'P0002';
    END IF;
    IF v_cta.estado = 'cerrada' THEN
        RAISE EXCEPTION 'la cuenta esta cerrada' USING ERRCODE = 'P0006';
    END IF;

    v_sob := COALESCE(p_sobregiro, v_cta.sobregiro_autorizado);
    IF v_sob <> v_cta.sobregiro_autorizado THEN
        SELECT * INTO v_prod FROM nucleo.producto WHERE id = v_cta.producto_id;
        v_f := CASE WHEN v_cta.moneda = 'USD' THEN 4000 ELSE 1 END;
        IF v_sob < 0 OR v_sob <> round(v_sob, 2) OR NOT v_prod.permite_sobregiro
           OR v_sob > round(v_prod.sobregiro_maximo / v_f, 2) THEN
            RAISE EXCEPTION 'sobregiro fuera de lo permitido por el producto' USING ERRCODE = '22023';
        END IF;
        IF v_cta.saldo < -v_sob THEN
            RAISE EXCEPTION 'el sobregiro no puede ser menor al saldo en uso' USING ERRCODE = 'P0006';
        END IF;
    END IF;

    UPDATE nucleo.cuenta
       SET limite_retiro_diario = p_retiro_diario,
           limite_transferencia_diaria = p_transferencia_diaria,
           sobregiro_autorizado = v_sob
     WHERE id = p_cuenta;
    PERFORM nucleo.fn_evento_cuenta(p_cuenta, 'cambio_limites', p_motivo, jsonb_build_object(
        'antes',   jsonb_build_object('retiro', v_cta.limite_retiro_diario,
                                      'transferencia', v_cta.limite_transferencia_diaria,
                                      'sobregiro', v_cta.sobregiro_autorizado),
        'despues', jsonb_build_object('retiro', p_retiro_diario,
                                      'transferencia', p_transferencia_diaria, 'sobregiro', v_sob)));
END
$$;

CREATE OR REPLACE FUNCTION api.registrar_transaccion(
    p_clave    text,
    p_tipo     text,
    p_origen   bigint,
    p_destino  bigint,
    p_monto    numeric,
    p_canal    text DEFAULT 'sistema',
    p_concepto text DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, nucleo AS $$
DECLARE
    v_deb    bigint;
    v_cre    bigint;
    v_moneda char(3);
    v_n      int;
    v_m      int;
BEGIN
    IF p_clave IS NULL OR btrim(p_clave) = '' OR length(p_clave) > 100 THEN
        RAISE EXCEPTION 'clave de idempotencia requerida (maximo 100 caracteres)' USING ERRCODE = '22023';
    END IF;
    -- NaN es mayor que todo e igual a si mismo en numeric: "<= 0" y "<> round()" lo dejarian pasar.
    IF p_monto IS NULL OR p_monto = 'NaN'::numeric OR p_monto <= 0 OR p_monto <> round(p_monto, 2) THEN
        RAISE EXCEPTION 'monto invalido' USING ERRCODE = '22023';
    END IF;
    IF p_canal NOT IN ('web', 'cajero', 'atm', 'brebe', 'sistema') THEN
        RAISE EXCEPTION 'canal invalido' USING ERRCODE = '22023';
    END IF;
    IF p_tipo = 'ajuste' AND (p_concepto IS NULL OR btrim(p_concepto) = '') THEN
        RAISE EXCEPTION 'un ajuste requiere concepto' USING ERRCODE = '22023';
    END IF;

    CASE
        -- Operaciones contra caja que acreditan al cliente
        WHEN p_tipo IN ('deposito', 'credito') OR (p_tipo = 'ajuste' AND p_origen IS NULL) THEN
            IF p_destino IS NULL OR p_origen IS NOT NULL THEN
                RAISE EXCEPTION 'la operacion requiere solo cuenta destino' USING ERRCODE = '22023';
            END IF;
            SELECT moneda INTO v_moneda FROM nucleo.cuenta WHERE id = p_destino AND tipo = 'cliente';
            IF NOT FOUND THEN
                RAISE EXCEPTION 'cuenta destino inexistente' USING ERRCODE = 'P0002';
            END IF;
            SELECT id INTO v_deb FROM nucleo.cuenta WHERE tipo = 'sistema' AND moneda = v_moneda;
            v_cre := p_destino;

        -- Operaciones contra caja que debitan al cliente
        WHEN p_tipo IN ('retiro', 'debito') OR (p_tipo = 'ajuste' AND p_destino IS NULL) THEN
            IF p_origen IS NULL OR p_destino IS NOT NULL THEN
                RAISE EXCEPTION 'la operacion requiere solo cuenta origen' USING ERRCODE = '22023';
            END IF;
            SELECT moneda INTO v_moneda FROM nucleo.cuenta WHERE id = p_origen AND tipo = 'cliente';
            IF NOT FOUND THEN
                RAISE EXCEPTION 'cuenta origen inexistente' USING ERRCODE = 'P0002';
            END IF;
            SELECT id INTO v_cre FROM nucleo.cuenta WHERE tipo = 'sistema' AND moneda = v_moneda;
            v_deb := p_origen;

        WHEN p_tipo = 'transferencia' THEN
            IF p_origen IS NULL OR p_destino IS NULL OR p_origen = p_destino THEN
                RAISE EXCEPTION 'transferencia requiere dos cuentas distintas' USING ERRCODE = '22023';
            END IF;
            SELECT count(*), count(DISTINCT moneda) INTO v_n, v_m
              FROM nucleo.cuenta WHERE id IN (p_origen, p_destino) AND tipo = 'cliente';
            IF v_n <> 2 THEN
                RAISE EXCEPTION 'cuenta origen o destino inexistente' USING ERRCODE = 'P0002';
            END IF;
            IF v_m <> 1 THEN
                RAISE EXCEPTION 'las cuentas tienen monedas distintas' USING ERRCODE = '22023';
            END IF;
            v_deb := p_origen;
            v_cre := p_destino;

        WHEN p_tipo = 'reverso' THEN
            RAISE EXCEPTION 'use api.reversar_transaccion para reversar' USING ERRCODE = '22023';
        ELSE
            RAISE EXCEPTION 'tipo invalido: %', p_tipo USING ERRCODE = '22023';
    END CASE;

    IF v_deb IS NULL OR v_cre IS NULL THEN
        RAISE EXCEPTION 'cuenta de caja no configurada' USING ERRCODE = 'P0002';
    END IF;

    RETURN nucleo.fn_postear(p_clave, p_tipo, v_deb, v_cre, p_monto, p_canal, p_concepto);
END
$$;

-- Un reverso es una NUEVA transaccion compensatoria; la original nunca se modifica.
CREATE OR REPLACE FUNCTION api.reversar_transaccion(p_clave text, p_original uuid, p_motivo text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, nucleo AS $$
DECLARE
    v_orig nucleo.transaccion%ROWTYPE;
BEGIN
    IF p_clave IS NULL OR btrim(p_clave) = '' OR length(p_clave) > 100 THEN
        RAISE EXCEPTION 'clave de idempotencia requerida (maximo 100 caracteres)' USING ERRCODE = '22023';
    END IF;
    IF p_motivo IS NULL OR btrim(p_motivo) = '' THEN
        RAISE EXCEPTION 'el motivo del reverso es obligatorio' USING ERRCODE = '22023';
    END IF;

    SELECT * INTO v_orig FROM nucleo.transaccion WHERE id = p_original;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'transaccion original inexistente' USING ERRCODE = 'P0002';
    END IF;
    IF v_orig.tipo = 'reverso' THEN
        RAISE EXCEPTION 'un reverso no puede reversarse' USING ERRCODE = '22023';
    END IF;

    BEGIN
        RETURN nucleo.fn_postear(p_clave, 'reverso', v_orig.cuenta_credito, v_orig.cuenta_debito,
                                 v_orig.monto, 'sistema', left(p_motivo, 200), p_original);
    EXCEPTION WHEN unique_violation THEN
        RAISE EXCEPTION 'la transaccion ya fue reversada' USING ERRCODE = 'P0007';
    END;
END
$$;

-- Registro explicito de eventos que no generan filas por si solos (intentos denegados, login...).
CREATE OR REPLACE FUNCTION api.registrar_auditoria(
    p_operacion text, p_tabla text, p_registro text DEFAULT NULL,
    p_resultado text DEFAULT 'OK', p_detalle jsonb DEFAULT NULL
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, auditoria AS $$
BEGIN
    IF p_resultado NOT IN ('OK', 'DENEGADO', 'ERROR') THEN
        RAISE EXCEPTION 'resultado invalido' USING ERRCODE = '22023';
    END IF;
    INSERT INTO auditoria.evento (tabla, operacion, usuario, usuario_app_id, rol, ip, registro_id, resultado, despues)
    VALUES (p_tabla, p_operacion, session_user, auditoria.ctx_usuario(), auditoria.ctx_rol(),
            auditoria.ctx_ip(), p_registro, p_resultado, p_detalle);
END
$$;
