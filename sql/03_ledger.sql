-- Aplica el movimiento al saldo y registra el saldo resultante.
CREATE OR REPLACE FUNCTION nucleo.fn_aplicar_movimiento() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    v_saldo numeric(18,2);
BEGIN
    UPDATE nucleo.cuenta
       SET saldo = saldo + CASE NEW.sentido WHEN 'C' THEN NEW.monto ELSE -NEW.monto END
     WHERE id = NEW.cuenta_id AND estado = 'activa'
    RETURNING saldo INTO v_saldo;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'cuenta % inexistente o no activa', NEW.cuenta_id USING ERRCODE = 'P0002';
    END IF;

    NEW.saldo_posterior := v_saldo;
    RETURN NEW;
END
$$;

CREATE TRIGGER tg_movimiento_aplicar
    BEFORE INSERT ON nucleo.movimiento
    FOR EACH ROW EXECUTE FUNCTION nucleo.fn_aplicar_movimiento();

-- Partida doble: cada transaccion debe sumar cero al cierre.
CREATE OR REPLACE FUNCTION nucleo.fn_verificar_balance() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    v_diferencia numeric;
BEGIN
    SELECT COALESCE(SUM(CASE sentido WHEN 'C' THEN monto ELSE -monto END), 0)
      INTO v_diferencia
      FROM nucleo.movimiento
     WHERE transaccion_id = NEW.transaccion_id;

    IF v_diferencia <> 0 THEN
        RAISE EXCEPTION 'transaccion % desbalanceada (diferencia %)', NEW.transaccion_id, v_diferencia
            USING ERRCODE = '23514';
    END IF;
    RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER tg_movimiento_balance
    AFTER INSERT ON nucleo.movimiento
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION nucleo.fn_verificar_balance();

-- Inmutabilidad
CREATE OR REPLACE FUNCTION nucleo.fn_inmutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'registro inmutable: % sobre %.%', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
        USING ERRCODE = '55000';
END
$$;

CREATE TRIGGER tg_movimiento_inmutable
    BEFORE UPDATE OR DELETE ON nucleo.movimiento
    FOR EACH ROW EXECUTE FUNCTION nucleo.fn_inmutable();
CREATE TRIGGER tg_movimiento_truncate
    BEFORE TRUNCATE ON nucleo.movimiento
    FOR EACH STATEMENT EXECUTE FUNCTION nucleo.fn_inmutable();

CREATE TRIGGER tg_transaccion_inmutable
    BEFORE UPDATE OR DELETE ON nucleo.transaccion
    FOR EACH ROW EXECUTE FUNCTION nucleo.fn_inmutable();
CREATE TRIGGER tg_transaccion_truncate
    BEFORE TRUNCATE ON nucleo.transaccion
    FOR EACH STATEMENT EXECUTE FUNCTION nucleo.fn_inmutable();

-- Los eventos de cuenta y las operaciones Bre-B tambien son historial: no se editan.
CREATE TRIGGER tg_evento_cuenta_inmutable
    BEFORE UPDATE OR DELETE ON nucleo.evento_cuenta
    FOR EACH ROW EXECUTE FUNCTION nucleo.fn_inmutable();
CREATE TRIGGER tg_evento_cuenta_truncate
    BEFORE TRUNCATE ON nucleo.evento_cuenta
    FOR EACH STATEMENT EXECUTE FUNCTION nucleo.fn_inmutable();
CREATE TRIGGER tg_brebe_operacion_inmutable
    BEFORE UPDATE OR DELETE ON nucleo.brebe_operacion
    FOR EACH ROW EXECUTE FUNCTION nucleo.fn_inmutable();
CREATE TRIGGER tg_brebe_operacion_truncate
    BEFORE TRUNCATE ON nucleo.brebe_operacion
    FOR EACH STATEMENT EXECUTE FUNCTION nucleo.fn_inmutable();
