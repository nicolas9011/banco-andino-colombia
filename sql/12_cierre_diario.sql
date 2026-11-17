-- Cierre diario contable: foto inmutable de cada dia y moneda. Si el dia no cuadra (debitos <> creditos)
-- el procedimiento FALLA y no registra nada: un descuadre nunca se oculta (QUALITY_GATE = FAIL).
CREATE TABLE nucleo.cierre_diario (
    fecha          date          NOT NULL,
    moneda         char(3)       NOT NULL CHECK (moneda IN ('COP', 'USD')),
    operaciones    bigint        NOT NULL CHECK (operaciones >= 0),
    movimientos    bigint        NOT NULL CHECK (movimientos >= 0),
    total_debitos  numeric(22,2) NOT NULL,
    total_creditos numeric(22,2) NOT NULL,
    saldo_caja     numeric(22,2) NOT NULL,
    cerrado_en     timestamptz   NOT NULL DEFAULT now(),
    cerrado_por    bigint        REFERENCES seguridad.usuario (id),
    PRIMARY KEY (fecha, moneda),
    -- La propia tabla impide guardar un dia descuadrado, aunque alguien se salte el procedimiento.
    CONSTRAINT cierre_cuadrado CHECK (total_debitos = total_creditos)
);

CREATE TRIGGER tg_cierre_inmutable BEFORE UPDATE OR DELETE ON nucleo.cierre_diario
    FOR EACH ROW EXECUTE FUNCTION nucleo.fn_inmutable();
CREATE TRIGGER tg_cierre_truncate BEFORE TRUNCATE ON nucleo.cierre_diario
    FOR EACH STATEMENT EXECUTE FUNCTION nucleo.fn_inmutable();
-- registro_id de la bitacora: la tabla no tiene "id"; la fecha identifica el cierre
CREATE TRIGGER tg_cierre_auditoria AFTER INSERT ON nucleo.cierre_diario
    FOR EACH ROW EXECUTE FUNCTION auditoria.fn_registrar();

CREATE OR REPLACE PROCEDURE api.cerrar_dia(p_fecha date)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, nucleo AS $$
DECLARE
    v_ini  timestamptz;
    v_fin  timestamptz;
    r      record;
    v_caja numeric;
BEGIN
    IF p_fecha IS NULL OR p_fecha >= (now() AT TIME ZONE 'America/Bogota')::date THEN
        RAISE EXCEPTION 'solo se pueden cerrar dias anteriores a hoy' USING ERRCODE = '22023';
    END IF;
    -- creado_en es el INICIO de la transaccion: una operacion iniciada a las 23:59:58 puede confirmar despues de
    -- medianoche. Este lock espera a las que estan en vuelo (y frena las nuevas hasta terminar el cierre), de modo
    -- que el contenido del cierre inmutable sea completo. Tambien serializa dos cierres concurrentes.
    LOCK TABLE nucleo.movimiento IN SHARE ROW EXCLUSIVE MODE;
    IF EXISTS (SELECT 1 FROM nucleo.cierre_diario WHERE fecha = p_fecha) THEN
        RAISE EXCEPTION 'el dia % ya fue cerrado', p_fecha USING ERRCODE = 'P0006';
    END IF;

    v_ini := p_fecha::timestamp AT TIME ZONE 'America/Bogota';
    v_fin := (p_fecha + 1)::timestamp AT TIME ZONE 'America/Bogota';

    FOR r IN
        SELECT c.moneda,
               count(DISTINCT m.transaccion_id) AS operaciones,
               count(*) AS movimientos,
               COALESCE(sum(m.monto) FILTER (WHERE m.sentido = 'D'), 0) AS debitos,
               COALESCE(sum(m.monto) FILTER (WHERE m.sentido = 'C'), 0) AS creditos
          FROM nucleo.movimiento m JOIN nucleo.cuenta c ON c.id = m.cuenta_id
         WHERE m.creado_en >= v_ini AND m.creado_en < v_fin
         GROUP BY c.moneda ORDER BY c.moneda
    LOOP
        IF r.debitos <> r.creditos THEN
            RAISE EXCEPTION 'el dia % esta DESCUADRADO en %: debitos % <> creditos %',
                p_fecha, r.moneda, r.debitos, r.creditos USING ERRCODE = '23514';
        END IF;

        -- Saldo de la caja al final del dia: el saldo_posterior de su ULTIMO movimiento hasta esa hora.
        -- creado_en es el INICIO de la transaccion: puede quedar desordenado respecto del candado de la caja, que es
        -- lo que fija el orden real de aplicacion (el id). Se toman las 50 filas mas recientes por fecha (usa el
        -- indice (cuenta_id, creado_en)) y entre ellas se elige la de mayor id. Ordenar toda la caja por id
        -- (~600.000 filas) para cada dia seria inaceptable.
        SELECT s.saldo_posterior INTO v_caja
          FROM (SELECT m.id, m.saldo_posterior
                  FROM nucleo.movimiento m
                 WHERE m.cuenta_id = (SELECT id FROM nucleo.cuenta WHERE tipo = 'sistema' AND moneda = r.moneda)
                   AND m.creado_en < v_fin
                 ORDER BY m.creado_en DESC LIMIT 50) s
         ORDER BY s.id DESC LIMIT 1;

        INSERT INTO nucleo.cierre_diario (fecha, moneda, operaciones, movimientos, total_debitos, total_creditos,
                                          saldo_caja, cerrado_por)
        VALUES (p_fecha, r.moneda, r.operaciones, r.movimientos, r.debitos, r.creditos,
                COALESCE(v_caja, 0), auditoria.ctx_usuario());
    END LOOP;
END
$$;

CREATE VIEW api.v_cierres AS
SELECT fecha, moneda, operaciones, movimientos, total_debitos, total_creditos, saldo_caja, cerrado_en, cerrado_por
  FROM nucleo.cierre_diario;

REVOKE ALL ON PROCEDURE api.cerrar_dia(date) FROM PUBLIC;
GRANT EXECUTE ON PROCEDURE api.cerrar_dia(date) TO rol_lab_app;
GRANT SELECT ON api.v_cierres TO rol_lab_app, rol_lab_lectura, rol_lab_auditor;
