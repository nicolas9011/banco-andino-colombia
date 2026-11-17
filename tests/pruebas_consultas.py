"""Las 30 consultas: estructura del catalogo y CORRECCION contrastada con calculos independientes."""
import os
import re
import statistics
import sys
import unittest
from decimal import Decimal

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))
from config import conectar  # noqa: E402
from consultas import leer_consultas  # noqa: E402

CATALOGO = {c["nombre"]: c for c in leer_consultas()}


def sql(prefijo):
    return next(c["sql"] for n, c in CATALOGO.items() if n.startswith(prefijo))


class PruebasCatalogo(unittest.TestCase):
    def test_hay_30_consultas_10_por_nivel_con_nombres_unicos(self):
        todas = leer_consultas()
        self.assertEqual(len(todas), 30)
        self.assertEqual(len({c["nombre"] for c in todas}), 30)
        for nivel in ("basica", "intermedia", "avanzada"):
            self.assertEqual(len(leer_consultas(nivel)), 10, nivel)
        for c in todas:
            self.assertTrue(c["descripcion"], c["nombre"])
            self.assertTrue(c["nombre"].startswith({"basica": "b", "intermedia": "i", "avanzada": "a"}[c["nivel"]]), c["nombre"])

    def test_las_avanzadas_usan_los_conceptos_exigidos(self):
        texto = "\n".join(c["sql"].lower() for c in leer_consultas("avanzada"))
        exigidos = {
            "funciones de ventana": r"\bover\s*\(|\bwindow\s+\w+\s+as",
            "ranking": r"\b(rank|dense_rank|row_number|ntile)\s*\(",
            "percentiles": r"percentile_cont",
            "acumulados": r"sum\([^)]*\)\s+over\s*\(\s*order by",
            "cohortes": r"cohorte",
            "deteccion de anomalias": r"stddev|desviacion",
            "marco de ventana": r"rows between|range between",
            "lag/lead": r"\blag\s*\(",
        }
        for concepto, patron in exigidos.items():
            self.assertTrue(re.search(patron, texto), f"falta en las avanzadas: {concepto}")

    def test_todas_son_de_solo_lectura(self):
        for c in leer_consultas():
            self.assertNotRegex(c["sql"].lower(), r"\b(insert|update|delete|drop|alter|truncate|create)\b", c["nombre"])


class PruebasResultados(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.conn = conectar(autocommit=True)
        cls.cur = cls.conn.cursor()
        cls.cur.execute("SET statement_timeout = 0")
        cls.cur.execute("SELECT count(*) FROM nucleo.transaccion")
        if cls.cur.fetchone()[0] < 100_000:
            raise unittest.SkipTest("Se requiere la carga masiva (python src/masivo.py)")

    @classmethod
    def tearDownClass(cls):
        cls.conn.close()

    def q(self, texto, params=None):
        self.cur.execute(texto, params or ())
        return self.cur.fetchall()

    def test_las_30_devuelven_filas(self):
        for c in leer_consultas():
            filas = self.q(c["sql"])
            self.assertGreater(len(filas), 0, c["nombre"])

    # ------------------------------------------------------------ basicas
    def test_b01_suma_de_clientes(self):
        total = sum(f[2] for f in self.q(sql("b01")))
        self.assertEqual(total, self.q("SELECT count(*) FROM nucleo.cliente WHERE tipo_documento <> 'SIS'")[0][0])

    def test_b02_suma_de_cuentas_y_saldos(self):
        filas = self.q(sql("b02"))
        self.assertEqual(sum(f[2] for f in filas), self.q("SELECT count(*) FROM nucleo.cuenta WHERE tipo = 'cliente'")[0][0])
        self.assertEqual(sum(f[3] for f in filas if True), self.q("SELECT sum(saldo) FROM nucleo.cuenta WHERE tipo = 'cliente'")[0][0])

    def test_b04_suma_de_operaciones(self):
        self.assertEqual(sum(f[2] for f in self.q(sql("b04"))), self.q("SELECT count(*) FROM nucleo.transaccion")[0][0])

    def test_b03_esta_ordenada_y_es_la_maxima(self):
        filas = self.q(sql("b03"))
        saldos = [f[2] for f in filas]
        self.assertEqual(saldos, sorted(saldos, reverse=True))
        self.assertEqual(saldos[0], self.q("SELECT max(saldo) FROM nucleo.cuenta WHERE tipo = 'cliente' AND moneda = 'COP'")[0][0])

    def test_b10_coincide_con_un_antijoin_distinto(self):
        a = sum(f[2] for f in self.q(sql("b10")))
        b = self.q("SELECT count(*) FROM nucleo.cuenta c LEFT JOIN (SELECT DISTINCT cuenta_id FROM nucleo.movimiento) m "
                   "ON m.cuenta_id = c.id WHERE c.tipo = 'cliente' AND m.cuenta_id IS NULL")[0][0]
        self.assertEqual(a, b)

    # -------------------------------------------------------- intermedias
    def test_i03_totales_por_tipo(self):
        filas = self.q(sql("i03"))
        for idx, tipo in ((1, "deposito"), (2, "retiro"), (3, "transferencia")):
            self.assertEqual(sum(f[idx] for f in filas), self.q("SELECT count(*) FROM nucleo.transaccion WHERE tipo = %s", (tipo,))[0][0], tipo)

    def test_i04_entradas_menos_salidas_es_la_suma_de_saldos(self):
        filas = self.q(sql("i04"))
        neto = sum(f[1] - f[2] for f in filas)
        saldos = self.q("SELECT sum(saldo) FROM nucleo.cuenta WHERE tipo = 'cliente' AND moneda = 'COP'")[0][0]
        self.assertEqual(neto, saldos)

    def test_i07_porcentaje_brebe(self):
        for mes, brebe, total, pct in self.q(sql("i07")):
            self.assertLessEqual(brebe, total)
            self.assertAlmostEqual(float(pct), round(100.0 * brebe / total, 1), places=1)

    def test_i09_hora_pico_coincide_con_conteo_directo(self):
        for canal, hora, ops in self.q(sql("i09")):
            directo = self.q("SELECT max(n) FROM (SELECT count(*) n FROM nucleo.transaccion WHERE canal = %s "
                             "GROUP BY extract(hour FROM creado_en AT TIME ZONE 'America/Bogota')) x", (canal,))[0][0]
            self.assertEqual(ops, directo, canal)

    def test_i10_distribucion_suma_las_cuentas_no_cerradas(self):
        total = sum(f[2] for f in self.q(sql("i10")))
        self.assertEqual(total, self.q("SELECT count(*) FROM nucleo.cuenta WHERE tipo = 'cliente' AND estado <> 'cerrada'")[0][0])

    # ---------------------------------------------------------- avanzadas
    def test_a01_el_primero_de_un_departamento_es_el_maximo_real(self):
        filas = self.q(sql("a01"))
        dep, _, numero, volumen, _ = next(f for f in filas if f[1] == 1 and f[0] == "Antioquia")
        real = self.q(
            "SELECT c.numero, sum(m.monto) v FROM nucleo.movimiento m JOIN nucleo.cuenta c ON c.id = m.cuenta_id "
            "JOIN nucleo.cliente cl ON cl.id = c.cliente_id WHERE c.tipo = 'cliente' AND c.moneda = 'COP' AND cl.departamento = %s "
            "AND m.creado_en >= (SELECT max(creado_en) FROM nucleo.transaccion) - interval '90 days' GROUP BY 1 ORDER BY 2 DESC LIMIT 1", (dep,))[0]
        self.assertEqual((numero, volumen), real)

    def test_a02_la_mediana_coincide_con_la_calculada_en_python(self):
        p50 = {f[0]: f[2] for f in self.q(sql("a02"))}
        montos = [r[0] for r in self.q(
            "SELECT t.monto FROM nucleo.transaccion t JOIN nucleo.cuenta d ON d.id = t.cuenta_debito WHERE t.tipo = 'retiro' AND d.moneda = 'COP'")]
        self.assertAlmostEqual(float(p50["retiro"]), float(statistics.median(montos)), places=2)

    def test_a03_el_ultimo_acumulado_es_el_saldo_de_la_caja(self):
        filas = self.q(sql("a03"))
        caja = self.q("SELECT saldo FROM nucleo.cuenta WHERE numero = 'CAJA-COP'")[0][0]
        self.assertEqual(filas[-1][3], caja)
        self.assertEqual(sum(f[2] for f in filas), caja)

    def test_a04_cohortes_suman_los_clientes_y_la_retencion_es_porcentaje(self):
        filas = self.q(sql("a04"))
        tamanos = {f[0]: f[1] for f in filas}
        self.assertEqual(sum(tamanos.values()), self.q("SELECT count(*) FROM nucleo.cliente WHERE tipo_documento <> 'SIS'")[0][0])
        for _, tam, k, activos, pct in filas:
            self.assertTrue(0 <= k <= 6 and 0 < activos <= tam and 0 < pct <= 100)

    def test_a05_el_z_del_primero_coincide_con_python(self):
        numero, tipo, creado, monto, media, z = self.q(sql("a05"))[0]
        montos = [r[0] for r in self.q(
            "SELECT t.monto FROM nucleo.transaccion t JOIN nucleo.cuenta c ON c.id = t.cuenta_debito "
            "WHERE c.numero = %s AND t.tipo IN ('retiro', 'transferencia', 'debito')", (numero,))]
        z_py = (float(monto) - statistics.fmean(map(float, montos))) / statistics.stdev(map(float, montos))
        self.assertAlmostEqual(float(z), z_py, places=1)
        self.assertGreater(float(z), 3)

    def test_a06_clasificacion_coherente(self):
        for dia, ops, media, razon, clase in self.q(sql("a06")):
            self.assertEqual(clase, "pico" if razon > 1 else "valle")

    def test_a07_el_acumulado_final_es_el_total_de_clientes(self):
        filas = self.q(sql("a07"))
        self.assertEqual(filas[-1][4], self.q("SELECT count(*) FROM nucleo.cliente WHERE tipo_documento <> 'SIS'")[0][0])
        self.assertIsNone(filas[0][2])    # el primer mes no tiene mes anterior

    def test_a08_solo_cuentas_sobre_su_p95(self):
        for producto, pos, numero, saldo, p95 in self.q(sql("a08")):
            self.assertGreater(saldo, p95)
            self.assertLessEqual(pos, 5)

    def test_a09_la_ventana_de_10_minutos_se_verifica_con_conteo_directo(self):
        numero, creado, n, monto = self.q(sql("a09"))[0]
        directo = self.q(
            "SELECT count(*), sum(t.monto) FROM nucleo.transaccion t JOIN nucleo.cuenta c ON c.id = t.cuenta_debito "
            "WHERE c.numero = %s AND t.tipo = 'transferencia' AND t.creado_en > %s - interval '10 minutes' AND t.creado_en <= %s",
            (numero, creado, creado))[0]
        self.assertEqual((n, monto), directo)

    def test_a10_deciles_suman_cien_por_ciento(self):
        filas = self.q(sql("a10"))
        self.assertEqual([f[0] for f in filas], list(range(1, 11)))
        self.assertAlmostEqual(float(sum(f[5] for f in filas)), 100.0, delta=0.05)
        self.assertAlmostEqual(float(filas[-1][6]), 100.0, delta=0.01)
        self.assertGreater(filas[-1][5], filas[0][5])      # el decil superior concentra mas que el inferior


if __name__ == "__main__":
    unittest.main()
