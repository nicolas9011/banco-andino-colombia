-- ============================================================================
-- BANCO ANDINO COLOMBIA - MODELO DIMENSIONAL (DWH) Y ETL (FASE 2 Y 3)
-- Fuente: Esquema OLTP 'nucleo' -> Destino: Esquema Estrella 'dwh'
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS dwh;

-- 1. TABLAS DE DIMENSIONES
DROP TABLE IF EXISTS dwh.fact_transacciones_mensuales CASCADE;
DROP TABLE IF EXISTS dwh.fact_saldos_cartera CASCADE;
DROP TABLE IF EXISTS dwh.fact_cierres_diarios CASCADE;
DROP TABLE IF EXISTS dwh.dim_tiempo CASCADE;
DROP TABLE IF EXISTS dwh.dim_oficina CASCADE;
DROP TABLE IF EXISTS dwh.dim_producto CASCADE;
DROP TABLE IF EXISTS dwh.dim_canal CASCADE;

CREATE TABLE dwh.dim_tiempo (
    id_tiempo     integer PRIMARY KEY, -- YYYYMM
    anio          smallint NOT NULL,
    mes           smallint NOT NULL,
    nombre_mes    text NOT NULL,
    trimestre     text NOT NULL,
    periodo       text NOT NULL        -- Ej: '2026-09'
);

CREATE TABLE dwh.dim_oficina (
    oficina_id    bigint PRIMARY KEY,
    codigo        text NOT NULL,
    nombre        text NOT NULL,
    departamento  text NOT NULL,
    ciudad        text NOT NULL,
    pais          text NOT NULL DEFAULT 'Colombia',
    estado        text NOT NULL
);

CREATE TABLE dwh.dim_producto (
    producto_id         bigint PRIMARY KEY,
    codigo              text NOT NULL,
    nombre              text NOT NULL,
    tipo                text NOT NULL,
    permite_sobregiro   text NOT NULL,
    sobregiro_maximo    numeric(18,2) NOT NULL
);

CREATE TABLE dwh.dim_canal (
    canal_codigo  text PRIMARY KEY,
    nombre_canal  text NOT NULL,
    es_digital    text NOT NULL
);

-- 2. TABLAS DE HECHOS (FACT TABLES)

-- Hecho 1: Operaciones y Flujo Transaccional Mensual
CREATE TABLE dwh.fact_transacciones_mensuales (
    id_tiempo               integer REFERENCES dwh.dim_tiempo(id_tiempo),
    oficina_id              bigint REFERENCES dwh.dim_oficina(oficina_id),
    producto_id             bigint REFERENCES dwh.dim_producto(producto_id),
    canal_codigo            text REFERENCES dwh.dim_canal(canal_codigo),
    tipo_transaccion        text NOT NULL,
    moneda                  char(3) NOT NULL,
    cantidad_operaciones    bigint NOT NULL,
    monto_total             numeric(22,2) NOT NULL,
    monto_equivalente_cop   numeric(22,2) NOT NULL,
    ticket_promedio         numeric(18,2) NOT NULL
);

-- Hecho 2: Foto de Cartera, Saldos y Rango de Clientes por Oficina y Producto
CREATE TABLE dwh.fact_saldos_cartera (
    oficina_id              bigint REFERENCES dwh.dim_oficina(oficina_id),
    producto_id             bigint REFERENCES dwh.dim_producto(producto_id),
    moneda                  char(3) NOT NULL,
    estado_cuenta           text NOT NULL,
    tipo_persona            text NOT NULL,
    rango_saldo             text NOT NULL,
    total_cuentas           bigint NOT NULL,
    total_clientes          bigint NOT NULL,
    saldo_contable_total    numeric(22,2) NOT NULL,
    saldo_disponible_total  numeric(22,2) NOT NULL,
    sobregiro_total         numeric(22,2) NOT NULL,
    saldo_equivalente_cop   numeric(22,2) NOT NULL
);

-- Hecho 3: Auditoría de Cierres Contables Diarios (Doble Partida)
CREATE TABLE dwh.fact_cierres_diarios (
    fecha          date NOT NULL,
    id_tiempo      integer REFERENCES dwh.dim_tiempo(id_tiempo),
    moneda         char(3) NOT NULL,
    operaciones    bigint NOT NULL,
    movimientos    bigint NOT NULL,
    total_debitos  numeric(22,2) NOT NULL,
    total_creditos numeric(22,2) NOT NULL,
    diferencia     numeric(22,2) NOT NULL,
    saldo_caja     numeric(22,2) NOT NULL,
    PRIMARY KEY (fecha, moneda)
);

-- ============================================================================
-- 3. PROCEDIMIENTO ALMACENADO ETL (PL/pgSQL)
-- ============================================================================
CREATE OR REPLACE PROCEDURE dwh.sp_cargar_dwh_andino()
LANGUAGE plpgsql
AS $$
DECLARE
    v_nombres_mes text[] := ARRAY[
        'Enero','Febrero','Marzo','Abril','Mayo','Junio',
        'Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'
    ];
BEGIN
    TRUNCATE TABLE 
        dwh.fact_transacciones_mensuales,
        dwh.fact_saldos_cartera,
        dwh.fact_cierres_diarios,
        dwh.dim_tiempo,
        dwh.dim_oficina,
        dwh.dim_producto,
        dwh.dim_canal;

    -- A. Poblar dim_tiempo desde el rango real de transacciones y cierres (2023 a 2026)
    INSERT INTO dwh.dim_tiempo (id_tiempo, anio, mes, nombre_mes, trimestre, periodo)
    SELECT DISTINCT
        (EXTRACT(YEAR FROM d)::int * 100 + EXTRACT(MONTH FROM d)::int) AS id_tiempo,
        EXTRACT(YEAR FROM d)::smallint AS anio,
        EXTRACT(MONTH FROM d)::smallint AS mes,
        v_nombres_mes[EXTRACT(MONTH FROM d)::int] AS nombre_mes,
        'Q' || EXTRACT(QUARTER FROM d)::int AS trimestre,
        TO_CHAR(d, 'YYYY-MM') AS periodo
    FROM generate_series('2023-01-01'::date, '2026-12-01'::date, '1 month'::interval) AS d
    ORDER BY 1;

    -- B. Poblar dim_oficina (desde nucleo.oficina)
    INSERT INTO dwh.dim_oficina (oficina_id, codigo, nombre, departamento, ciudad, pais, estado)
    SELECT id, codigo, nombre, departamento, ciudad, 'Colombia', estado
    FROM nucleo.oficina;

    -- C. Poblar dim_producto (desde nucleo.producto)
    INSERT INTO dwh.dim_producto (producto_id, codigo, nombre, tipo, permite_sobregiro, sobregiro_maximo)
    SELECT 
        id, codigo, nombre, UPPER(tipo),
        CASE WHEN permite_sobregiro THEN 'Con Sobregiro' ELSE 'Sin Sobregiro' END,
        sobregiro_maximo
    FROM nucleo.producto;

    -- D. Poblar dim_canal
    INSERT INTO dwh.dim_canal (canal_codigo, nombre_canal, es_digital) VALUES
        ('web',     'Portal Web',         'Digital'),
        ('brebe',   'Bre-B Inmediato',    'Digital'),
        ('atm',     'Cajero Automático',  'Físico / Autoservicio'),
        ('cajero',  'Ventanilla Oficina', 'Físico / Presencial'),
        ('sistema', 'Motor Interno',      'Automático');

    -- E. Poblar fact_transacciones_mensuales (1M de transacciones agregadas para BI)
    INSERT INTO dwh.fact_transacciones_mensuales (
        id_tiempo, oficina_id, producto_id, canal_codigo, tipo_transaccion, moneda,
        cantidad_operaciones, monto_total, monto_equivalente_cop, ticket_promedio
    )
    SELECT
        (EXTRACT(YEAR FROM (t.creado_en AT TIME ZONE 'America/Bogota'))::int * 100 +
         EXTRACT(MONTH FROM (t.creado_en AT TIME ZONE 'America/Bogota'))::int) AS id_tiempo,
        COALESCE(cd.oficina_id, cc.oficina_id) AS oficina_id,
        COALESCE(cd.producto_id, cc.producto_id) AS producto_id,
        t.canal AS canal_codigo,
        UPPER(t.tipo) AS tipo_transaccion,
        cd.moneda,
        COUNT(*) AS cantidad_operaciones,
        SUM(t.monto) AS monto_total,
        SUM(CASE WHEN cd.moneda = 'USD' THEN t.monto * 4000 ELSE t.monto END) AS monto_equivalente_cop,
        ROUND(AVG(t.monto), 2) AS ticket_promedio
    FROM nucleo.transaccion t
    JOIN nucleo.cuenta cd ON cd.id = t.cuenta_debito
    JOIN nucleo.cuenta cc ON cc.id = t.cuenta_credito
    WHERE COALESCE(cd.oficina_id, cc.oficina_id) IS NOT NULL
    GROUP BY 1, 2, 3, 4, 5, 6;

    -- F. Poblar fact_saldos_cartera (Con clasificación por Rango de Saldo en COP)
    INSERT INTO dwh.fact_saldos_cartera (
        oficina_id, producto_id, moneda, estado_cuenta, tipo_persona, rango_saldo,
        total_cuentas, total_clientes, saldo_contable_total, saldo_disponible_total,
        sobregiro_total, saldo_equivalente_cop
    )
    SELECT
        c.oficina_id,
        c.producto_id,
        c.moneda,
        UPPER(c.estado) AS estado_cuenta,
        UPPER(cl.tipo_persona) AS tipo_persona,
        CASE
            WHEN (CASE WHEN c.moneda = 'USD' THEN c.saldo * 4000 ELSE c.saldo END) <= 1000000 THEN '0 - 1M COP'
            WHEN (CASE WHEN c.moneda = 'USD' THEN c.saldo * 4000 ELSE c.saldo END) <= 10000000 THEN '1M - 10M COP'
            WHEN (CASE WHEN c.moneda = 'USD' THEN c.saldo * 4000 ELSE c.saldo END) <= 50000000 THEN '10M - 50M COP'
            ELSE '50M+ COP'
        END AS rango_saldo,
        COUNT(c.id) AS total_cuentas,
        COUNT(DISTINCT c.cliente_id) AS total_clientes,
        SUM(c.saldo) AS saldo_contable_total,
        SUM(c.saldo + c.sobregiro_autorizado) AS saldo_disponible_total,
        SUM(c.sobregiro_autorizado) AS sobregiro_total,
        SUM(CASE WHEN c.moneda = 'USD' THEN c.saldo * 4000 ELSE c.saldo END) AS saldo_equivalente_cop
    FROM nucleo.cuenta c
    JOIN nucleo.cliente cl ON cl.id = c.cliente_id
    WHERE c.tipo = 'cliente'
    GROUP BY 1, 2, 3, 4, 5, 6;

    -- G. Poblar fact_cierres_diarios
    INSERT INTO dwh.fact_cierres_diarios (
        fecha, id_tiempo, moneda, operaciones, movimientos,
        total_debitos, total_creditos, diferencia, saldo_caja
    )
    SELECT
        fecha,
        (EXTRACT(YEAR FROM fecha)::int * 100 + EXTRACT(MONTH FROM fecha)::int),
        moneda,
        operaciones,
        movimientos,
        total_debitos,
        total_creditos,
        (total_debitos - total_creditos) AS diferencia,
        saldo_caja
    FROM nucleo.cierre_diario;
END;
$$;

GRANT USAGE ON SCHEMA dwh TO rol_lab_app, rol_lab_lectura, rol_lab_auditor;
GRANT SELECT ON ALL TABLES IN SCHEMA dwh TO rol_lab_app, rol_lab_lectura, rol_lab_auditor;

CALL dwh.sp_cargar_dwh_andino();