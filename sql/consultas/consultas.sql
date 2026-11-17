-- 30 consultas del laboratorio. Formato: cada bloque empieza con "-- nombre:", "-- nivel:" y "-- descripcion:".
-- Todas son de solo lectura y deterministas (no dependen de now(): usan el ultimo dato del historial).

-- ============================================================================ BASICAS (10)

-- nombre: b01_clientes_por_tipo_y_estado
-- nivel: basica
-- descripcion: Cuantos clientes hay por tipo de persona y estado.
SELECT tipo_persona, estado, count(*) AS clientes
  FROM nucleo.cliente WHERE tipo_documento <> 'SIS'
 GROUP BY 1, 2 ORDER BY 1, 3 DESC;

-- nombre: b02_cuentas_por_producto_y_moneda
-- nivel: basica
-- descripcion: Numero de cuentas y saldo total por producto y moneda.
SELECT p.tipo AS producto, c.moneda, count(*) AS cuentas, sum(c.saldo) AS saldo_total, round(avg(c.saldo), 2) AS saldo_promedio
  FROM nucleo.cuenta c JOIN nucleo.producto p ON p.id = c.producto_id
 WHERE c.tipo = 'cliente'
 GROUP BY 1, 2 ORDER BY 1, 2;

-- nombre: b03_top20_saldos_cop
-- nivel: basica
-- descripcion: Las 20 cuentas en pesos con mayor saldo.
SELECT numero, nombre AS titular, saldo_contable, estado
  FROM api.v_saldos WHERE moneda = 'COP'
 ORDER BY saldo_contable DESC LIMIT 20;

-- nombre: b04_operaciones_por_tipo
-- nivel: basica
-- descripcion: Cantidad, monto total y promedio de cada tipo de transaccion, por moneda (nunca se suman pesos con dolares).
SELECT t.tipo, d.moneda, count(*) AS operaciones, sum(t.monto) AS monto_total, round(avg(t.monto), 2) AS monto_promedio
  FROM nucleo.transaccion t JOIN nucleo.cuenta d ON d.id = t.cuenta_debito
 GROUP BY 1, 2 ORDER BY 3 DESC;

-- nombre: b05_volumen_diario_ultimos_30_dias
-- nivel: basica
-- descripcion: Operaciones y monto en pesos por dia en los ultimos 30 dias del historial.
SELECT (t.creado_en AT TIME ZONE 'America/Bogota')::date AS dia, count(*) AS operaciones, sum(t.monto) AS monto_cop
  FROM nucleo.transaccion t JOIN nucleo.cuenta d ON d.id = t.cuenta_debito
 WHERE d.moneda = 'COP'
   AND t.creado_en >= (SELECT max(creado_en) FROM nucleo.transaccion) - interval '30 days'
 GROUP BY 1 ORDER BY 1 DESC;

-- nombre: b06_clientes_por_departamento
-- nivel: basica
-- descripcion: Los 10 departamentos con mas clientes.
SELECT departamento, count(*) AS clientes
  FROM nucleo.cliente WHERE tipo_documento <> 'SIS'
 GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 10;

-- nombre: b07_cuentas_por_estado_y_titularidad
-- nivel: basica
-- descripcion: Cuentas segun su estado y tipo de titularidad.
SELECT estado, tipo_titularidad, count(*) AS cuentas
  FROM nucleo.cuenta WHERE tipo = 'cliente'
 GROUP BY 1, 2 ORDER BY 1, 3 DESC;

-- nombre: b08_oficinas_con_mas_cuentas
-- nivel: basica
-- descripcion: Las 10 oficinas con mas cuentas abiertas.
SELECT o.nombre, o.ciudad, count(c.id) AS cuentas
  FROM nucleo.oficina o LEFT JOIN nucleo.cuenta c ON c.oficina_id = o.id
 GROUP BY o.id ORDER BY 3 DESC, 1 LIMIT 10;

-- nombre: b09_retiros_por_canal
-- nivel: basica
-- descripcion: Retiros por canal (cajero automatico vs ventanilla) y moneda.
SELECT t.canal, d.moneda, count(*) AS retiros, sum(t.monto) AS monto
  FROM nucleo.transaccion t JOIN nucleo.cuenta d ON d.id = t.cuenta_debito
 WHERE t.tipo = 'retiro'
 GROUP BY 1, 2 ORDER BY 3 DESC;

-- nombre: b10_cuentas_sin_movimientos
-- nivel: basica
-- descripcion: Cuentas sin ningun movimiento, por producto y estado.
SELECT p.tipo AS producto, c.estado, count(*) AS cuentas_sin_movimientos
  FROM nucleo.cuenta c JOIN nucleo.producto p ON p.id = c.producto_id
 WHERE c.tipo = 'cliente' AND NOT EXISTS (SELECT 1 FROM nucleo.movimiento m WHERE m.cuenta_id = c.id)
 GROUP BY 1, 2 ORDER BY 3 DESC;

-- ================================================================================ INTERMEDIAS (10)

-- nombre: i01_saldo_por_departamento
-- nivel: intermedia
-- descripcion: Saldo en pesos por departamento del cliente (solo departamentos con 100+ cuentas).
SELECT cl.departamento, count(DISTINCT cl.id) AS clientes, count(*) AS cuentas,
       sum(c.saldo) AS saldo_total, round(avg(c.saldo), 2) AS saldo_promedio
  FROM nucleo.cuenta c JOIN nucleo.cliente cl ON cl.id = c.cliente_id
 WHERE c.tipo = 'cliente' AND c.moneda = 'COP'
 GROUP BY 1 HAVING count(*) >= 100 ORDER BY 4 DESC;

-- nombre: i02_clientes_con_muchas_cuentas
-- nivel: intermedia
-- descripcion: Clientes con 10 o mas cuentas activas en pesos y su saldo consolidado.
SELECT cl.id, cl.nombre, cl.tipo_persona, count(*) AS cuentas, sum(c.saldo) AS saldo_total
  FROM nucleo.cliente cl JOIN nucleo.cuenta c ON c.cliente_id = cl.id
 WHERE c.moneda = 'COP' AND c.estado = 'activa'
 GROUP BY cl.id HAVING count(*) >= 10
 ORDER BY saldo_total DESC LIMIT 25;

-- nombre: i03_operaciones_por_mes
-- nivel: intermedia
-- descripcion: Evolucion mensual de consignaciones, retiros y transferencias (agregados condicionales); el monto es solo en pesos.
SELECT date_trunc('month', t.creado_en AT TIME ZONE 'America/Bogota')::date AS mes,
       count(*) FILTER (WHERE t.tipo = 'deposito') AS depositos,
       count(*) FILTER (WHERE t.tipo = 'retiro') AS retiros,
       count(*) FILTER (WHERE t.tipo = 'transferencia') AS transferencias,
       sum(t.monto) FILTER (WHERE t.tipo = 'transferencia' AND d.moneda = 'COP') AS monto_transferido_cop
  FROM nucleo.transaccion t JOIN nucleo.cuenta d ON d.id = t.cuenta_debito
 GROUP BY 1 ORDER BY 1;

-- nombre: i04_entradas_vs_salidas_por_producto
-- nivel: intermedia
-- descripcion: Dinero que entra y sale de cada producto (pesos) y su razon.
SELECT p.tipo AS producto,
       sum(m.monto) FILTER (WHERE m.sentido = 'C') AS entradas,
       sum(m.monto) FILTER (WHERE m.sentido = 'D') AS salidas,
       round(sum(m.monto) FILTER (WHERE m.sentido = 'C') / NULLIF(sum(m.monto) FILTER (WHERE m.sentido = 'D'), 0), 3) AS razon
  FROM nucleo.movimiento m
  JOIN nucleo.cuenta c ON c.id = m.cuenta_id JOIN nucleo.producto p ON p.id = c.producto_id
 WHERE c.tipo = 'cliente' AND c.moneda = 'COP'
 GROUP BY 1 ORDER BY 1;

-- nombre: i05_bloqueadas_y_actividad_previa
-- nivel: intermedia
-- descripcion: Cuentas hoy bloqueadas: cuando se bloquearon (ULTIMO bloqueo) y cuantos movimientos habian tenido antes.
SELECT c.numero, e.creado_en AS bloqueada_en, e.motivo,
       (SELECT count(*) FROM nucleo.movimiento m WHERE m.cuenta_id = c.id AND m.creado_en <= e.creado_en) AS movimientos_previos,
       c.saldo
  FROM nucleo.cuenta c
  JOIN LATERAL (SELECT creado_en, motivo FROM nucleo.evento_cuenta
                 WHERE cuenta_id = c.id AND tipo = 'bloqueo' ORDER BY id DESC LIMIT 1) e ON true
 WHERE c.estado = 'bloqueada'
 ORDER BY movimientos_previos DESC, c.numero LIMIT 20;

-- nombre: i06_antiguedad_por_estado
-- nivel: intermedia
-- descripcion: Antiguedad media de las cuentas segun su estado, medida hasta la ultima operacion del historial (resultado reproducible).
SELECT estado, count(*) AS cuentas,
       round(avg(extract(epoch FROM ((SELECT max(creado_en) FROM nucleo.transaccion) - creado_en)) / 86400)) AS antiguedad_media_dias,
       min(fecha_apertura) AS primera_apertura, max(fecha_apertura) AS ultima_apertura
  FROM nucleo.cuenta WHERE tipo = 'cliente'
 GROUP BY 1 ORDER BY 2 DESC;

-- nombre: i07_participacion_brebe_mensual
-- nivel: intermedia
-- descripcion: Que porcentaje de las transferencias de cada mes se hizo por Bre-B (simulado).
SELECT date_trunc('month', creado_en AT TIME ZONE 'America/Bogota')::date AS mes,
       count(*) FILTER (WHERE canal = 'brebe') AS brebe, count(*) AS transferencias,
       round(100.0 * count(*) FILTER (WHERE canal = 'brebe') / count(*), 1) AS pct_brebe
  FROM nucleo.transaccion WHERE tipo = 'transferencia'
 GROUP BY 1 ORDER BY 1;

-- nombre: i08_empresas_con_mayor_volumen
-- nivel: intermedia
-- descripcion: Las 15 personas juridicas que mas dinero transfieren.
SELECT cl.nombre, cl.documento, count(*) AS transferencias, sum(t.monto) AS volumen
  FROM nucleo.transaccion t
  JOIN nucleo.cuenta c ON c.id = t.cuenta_debito JOIN nucleo.cliente cl ON cl.id = c.cliente_id
 WHERE cl.tipo_persona = 'juridica' AND t.tipo = 'transferencia' AND c.moneda = 'COP'
 GROUP BY cl.id ORDER BY volumen DESC LIMIT 15;

-- nombre: i09_hora_pico_por_canal
-- nivel: intermedia
-- descripcion: La hora del dia con mas operaciones en cada canal (DISTINCT ON).
SELECT DISTINCT ON (canal) canal, hora, operaciones
  FROM (SELECT canal, extract(hour FROM creado_en AT TIME ZONE 'America/Bogota')::int AS hora, count(*) AS operaciones
          FROM nucleo.transaccion GROUP BY 1, 2) x
 ORDER BY canal, operaciones DESC, hora;

-- nombre: i10_distribucion_de_saldos
-- nivel: intermedia
-- descripcion: Cuantas cuentas hay en cada rango de saldo, por moneda.
SELECT moneda,
       CASE WHEN saldo < 0 THEN '0_sobregiro' WHEN saldo = 0 THEN '1_cero'
            WHEN saldo < 1000000 * CASE moneda WHEN 'USD' THEN 0.00025 ELSE 1 END THEN '2_menos_de_1M'
            WHEN saldo < 10000000 * CASE moneda WHEN 'USD' THEN 0.00025 ELSE 1 END THEN '3_1M_a_10M'
            WHEN saldo < 100000000 * CASE moneda WHEN 'USD' THEN 0.00025 ELSE 1 END THEN '4_10M_a_100M'
            ELSE '5_mas_de_100M' END AS rango,
       count(*) AS cuentas
  FROM nucleo.cuenta WHERE tipo = 'cliente' AND estado <> 'cerrada'
 GROUP BY 1, 2 ORDER BY 1, 2;

-- ================================================================================== AVANZADAS (10)

-- nombre: a01_ranking_cuentas_por_departamento
-- nivel: avanzada
-- descripcion: Top 3 cuentas por volumen en los ultimos 90 dias dentro de cada departamento (RANK + SUM OVER).
WITH vol AS (
  SELECT cl.departamento, c.numero, sum(m.monto) AS volumen
    FROM nucleo.movimiento m
    JOIN nucleo.cuenta c ON c.id = m.cuenta_id JOIN nucleo.cliente cl ON cl.id = c.cliente_id
   WHERE c.tipo = 'cliente' AND c.moneda = 'COP'
     AND m.creado_en >= (SELECT max(creado_en) FROM nucleo.transaccion) - interval '90 days'
   GROUP BY 1, 2),
r AS (
  SELECT *, rank() OVER (PARTITION BY departamento ORDER BY volumen DESC) AS posicion,
         sum(volumen) OVER (PARTITION BY departamento) AS total_departamento
    FROM vol)
SELECT departamento, posicion, numero, volumen, round(100 * volumen / total_departamento, 2) AS pct_del_departamento
  FROM r WHERE posicion <= 3 ORDER BY departamento, posicion, numero;

-- nombre: a02_percentiles_de_montos
-- nivel: avanzada
-- descripcion: Mediana, P90, P99 y desviacion de los montos en pesos por tipo de operacion (percentile_cont).
SELECT t.tipo, count(*) AS operaciones,
       percentile_cont(0.50) WITHIN GROUP (ORDER BY t.monto) AS p50,
       percentile_cont(0.90) WITHIN GROUP (ORDER BY t.monto) AS p90,
       percentile_cont(0.99) WITHIN GROUP (ORDER BY t.monto) AS p99,
       max(t.monto) AS maximo, round(stddev_samp(t.monto), 2) AS desviacion
  FROM nucleo.transaccion t JOIN nucleo.cuenta d ON d.id = t.cuenta_debito
 WHERE d.moneda = 'COP'
 GROUP BY 1 ORDER BY 1;

-- nombre: a03_saldo_acumulado_de_caja
-- nivel: avanzada
-- descripcion: Posicion diaria de la caja del banco en pesos como suma acumulada (SUM OVER); el ultimo valor es el saldo.
WITH dia AS (
  SELECT (m.creado_en AT TIME ZONE 'America/Bogota')::date AS fecha, count(*) AS movimientos,
         sum(CASE m.sentido WHEN 'C' THEN m.monto ELSE -m.monto END) AS neto
    FROM nucleo.movimiento m
   WHERE m.cuenta_id = (SELECT id FROM nucleo.cuenta WHERE numero = 'CAJA-COP')
   GROUP BY 1)
SELECT fecha, movimientos, neto, sum(neto) OVER (ORDER BY fecha) AS saldo_acumulado
  FROM dia ORDER BY fecha;

-- nombre: a04_cohortes_de_retencion
-- nivel: avanzada
-- descripcion: Retencion por cohorte mensual de vinculacion: % de clientes con salidas de dinero k meses despues (k = 0..6).
WITH cohorte AS (
  SELECT id, date_trunc('month', fecha_vinculacion)::date AS mes_cohorte
    FROM nucleo.cliente WHERE tipo_documento <> 'SIS'),
actividad AS (
  SELECT DISTINCT c.cliente_id, date_trunc('month', m.creado_en AT TIME ZONE 'America/Bogota')::date AS mes
    FROM nucleo.movimiento m JOIN nucleo.cuenta c ON c.id = m.cuenta_id
   WHERE c.tipo = 'cliente' AND m.sentido = 'D'),
tamanos AS (SELECT mes_cohorte, count(*) AS clientes FROM cohorte GROUP BY 1),
retencion AS (
  SELECT co.mes_cohorte,
         ((extract(year FROM a.mes) - extract(year FROM co.mes_cohorte)) * 12
          + extract(month FROM a.mes) - extract(month FROM co.mes_cohorte))::int AS mes_k,
         count(DISTINCT co.id) AS activos
    FROM cohorte co JOIN actividad a ON a.cliente_id = co.id AND a.mes >= co.mes_cohorte
   GROUP BY 1, 2)
SELECT r.mes_cohorte, t.clientes AS tamano_cohorte, r.mes_k, r.activos,
       round(100.0 * r.activos / t.clientes, 1) AS retencion_pct
  FROM retencion r JOIN tamanos t USING (mes_cohorte)
 WHERE r.mes_k <= 6 ORDER BY 1, 3;

-- nombre: a05_anomalias_por_zscore
-- nivel: avanzada
-- descripcion: Salidas de dinero atipicas: monto a mas de 3 desviaciones del historial de su propia cuenta (AVG/STDDEV OVER).
WITH est AS (
  SELECT t.id, t.cuenta_debito, t.tipo, t.monto, t.creado_en,
         avg(t.monto) OVER w AS media, stddev_samp(t.monto) OVER w AS desviacion, count(*) OVER w AS n
    FROM nucleo.transaccion t
   WHERE t.tipo IN ('retiro', 'transferencia', 'debito')
  WINDOW w AS (PARTITION BY t.cuenta_debito))
SELECT c.numero, e.tipo, e.creado_en, e.monto, round(e.media, 2) AS media_de_la_cuenta,
       round((e.monto - e.media) / NULLIF(e.desviacion, 0), 2) AS z
  FROM est e JOIN nucleo.cuenta c ON c.id = e.cuenta_debito
 WHERE e.n >= 30 AND (e.monto - e.media) / NULLIF(e.desviacion, 0) > 3
 ORDER BY z DESC, e.id LIMIT 50;

-- nombre: a06_picos_y_valles_con_media_movil
-- nivel: avanzada
-- descripcion: Dias con actividad muy superior o inferior a su media movil de 7 dias CALENDARIO, el dia incluido (AVG con marco RANGE de intervalo).
WITH diario AS (
  SELECT (creado_en AT TIME ZONE 'America/Bogota')::date AS dia, count(*) AS operaciones
    FROM nucleo.transaccion GROUP BY 1),
mov AS (
  SELECT dia, operaciones,
         avg(operaciones) OVER (ORDER BY dia RANGE BETWEEN INTERVAL '6 days' PRECEDING AND CURRENT ROW) AS media_7d
    FROM diario)
SELECT dia, operaciones, round(media_7d, 1) AS media_7d, round(operaciones / media_7d, 2) AS razon,
       CASE WHEN operaciones > 1.8 * media_7d THEN 'pico' ELSE 'valle' END AS clasificacion
  FROM mov WHERE operaciones > 1.8 * media_7d OR operaciones < 0.4 * media_7d
 ORDER BY razon DESC, dia LIMIT 40;

-- nombre: a07_crecimiento_mensual_de_clientes
-- nivel: avanzada
-- descripcion: Altas de clientes por mes con variacion porcentual y acumulado (LAG y SUM OVER).
WITH mensual AS (
  SELECT date_trunc('month', fecha_vinculacion)::date AS mes, count(*) AS nuevos
    FROM nucleo.cliente WHERE tipo_documento <> 'SIS' GROUP BY 1)
SELECT mes, nuevos, lag(nuevos) OVER (ORDER BY mes) AS mes_anterior,
       round(100.0 * (nuevos - lag(nuevos) OVER (ORDER BY mes)) / NULLIF(lag(nuevos) OVER (ORDER BY mes), 0), 1) AS variacion_pct,
       sum(nuevos) OVER (ORDER BY mes) AS acumulado
  FROM mensual ORDER BY mes;

-- nombre: a08_saldos_sobre_el_percentil_95_del_producto
-- nivel: avanzada
-- descripcion: Cuentas activas en pesos con saldo superior al P95 de su producto, ordenadas con DENSE_RANK por producto.
WITH umbral AS (
  SELECT p.id AS producto_id, p.tipo AS producto, percentile_cont(0.95) WITHIN GROUP (ORDER BY c.saldo) AS p95
    FROM nucleo.cuenta c JOIN nucleo.producto p ON p.id = c.producto_id
   WHERE c.tipo = 'cliente' AND c.moneda = 'COP' AND c.estado = 'activa'
   GROUP BY 1, 2),
r AS (
  SELECT c.numero, u.producto, c.saldo, u.p95,
         dense_rank() OVER (PARTITION BY u.producto_id ORDER BY c.saldo DESC) AS posicion
    FROM nucleo.cuenta c JOIN umbral u ON u.producto_id = c.producto_id
   WHERE c.tipo = 'cliente' AND c.moneda = 'COP' AND c.estado = 'activa' AND c.saldo > u.p95)
SELECT producto, posicion, numero, saldo, round(p95::numeric, 2) AS p95_del_producto
  FROM r WHERE posicion <= 5 ORDER BY producto, posicion;

-- nombre: a09_rafagas_de_transferencias
-- nivel: avanzada
-- descripcion: Posibles rafagas: cuentas con 2+ transferencias en una ventana de 10 minutos (COUNT/SUM con RANGE de intervalo).
WITH t AS (
  SELECT cuenta_debito, creado_en,
         count(*) OVER w AS en_10min, sum(monto) OVER w AS monto_10min
    FROM nucleo.transaccion WHERE tipo = 'transferencia'
  WINDOW w AS (PARTITION BY cuenta_debito ORDER BY creado_en
               RANGE BETWEEN INTERVAL '10 minutes' PRECEDING AND CURRENT ROW))
SELECT c.numero, t.creado_en, t.en_10min, t.monto_10min
  FROM t JOIN nucleo.cuenta c ON c.id = t.cuenta_debito
 WHERE t.en_10min >= 2
 ORDER BY t.en_10min DESC, t.monto_10min DESC, t.creado_en LIMIT 30;

-- nombre: a10_concentracion_de_saldos_por_decil
-- nivel: avanzada
-- descripcion: Concentracion de la riqueza: participacion y acumulado por decil de cuentas en pesos (NTILE + SUM OVER).
WITH s AS (
  SELECT saldo, ntile(10) OVER (ORDER BY saldo) AS decil
    FROM nucleo.cuenta WHERE tipo = 'cliente' AND moneda = 'COP' AND estado <> 'cerrada' AND saldo > 0),
d AS (
  SELECT decil, count(*) AS cuentas, sum(saldo) AS saldo, min(saldo) AS minimo, max(saldo) AS maximo FROM s GROUP BY 1)
SELECT decil, cuentas, saldo, minimo, maximo,
       round(100 * saldo / sum(saldo) OVER (), 2) AS pct_del_total,
       round(100 * sum(saldo) OVER (ORDER BY decil) / sum(saldo) OVER (), 2) AS pct_acumulado
  FROM d ORDER BY decil;
