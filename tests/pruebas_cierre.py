"""Procedimiento api.cerrar_dia: cierre diario contable."""
import os
import sys
import unittest

import psycopg2
import psycopg2.errors

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))
from config import conectar  # noqa: E402


class PruebasCierre(unittest.TestCase):
    def setUp(self):
        self.conn = conectar()
        self.cur = self.conn.cursor()
        self.cur.execute("SELECT fecha FROM nucleo.cierre_diario ORDER BY operaciones DESC LIMIT 1")
        fila = self.cur.fetchone()
        if not fila:
            self.skipTest("No hay cierres (python src/cerrar_historico.py)")
        self.dia = fila[0]

    def tearDown(self):
        self.conn.rollback()
        self.conn.close()

    def _cierre(self):
        self.cur.execute("SELECT moneda, operaciones, movimientos, total_debitos, total_creditos, saldo_caja "
                         "FROM nucleo.cierre_diario WHERE fecha = %s ORDER BY moneda", (self.dia,))
        return self.cur.fetchall()

    def test_un_dia_cerrado_no_se_cierra_dos_veces(self):
        with self.assertRaises(psycopg2.Error) as ctx:
            self.cur.execute("CALL api.cerrar_dia(%s)", (self.dia,))
        self.assertEqual(ctx.exception.pgcode, "P0006")

    def test_no_se_puede_cerrar_hoy_ni_el_futuro(self):
        for expr in ("current_date", "current_date + 5"):
            with self.assertRaises(psycopg2.Error) as ctx:
                self.cur.execute(f"CALL api.cerrar_dia({expr})")
            self.assertEqual(ctx.exception.pgcode, "22023")
            self.conn.rollback()

    def test_recalcular_un_cierre_da_exactamente_lo_mismo(self):
        original = self._cierre()
        self.assertTrue(original)
        self.cur.execute("SET session_replication_role = replica")        # permite borrar el cierre (inmutable)
        self.cur.execute("DELETE FROM nucleo.cierre_diario WHERE fecha = %s", (self.dia,))
        self.cur.execute("SET session_replication_role = DEFAULT")
        self.cur.execute("CALL api.cerrar_dia(%s)", (self.dia,))
        self.assertEqual(self._cierre(), original)

    def test_un_dia_descuadrado_se_rechaza_y_no_deja_cierre(self):
        self.cur.execute("SET session_replication_role = replica")
        self.cur.execute("DELETE FROM nucleo.cierre_diario WHERE fecha = %s", (self.dia,))
        # Se corrompe un movimiento de ese dia: ya no suma cero
        self.cur.execute(
            "UPDATE nucleo.movimiento SET monto = monto + 1 WHERE id = (SELECT min(id) FROM nucleo.movimiento "
            "WHERE (creado_en AT TIME ZONE 'America/Bogota')::date = %s AND sentido = 'C')", (self.dia,))
        self.cur.execute("SET session_replication_role = DEFAULT")
        with self.assertRaises(psycopg2.Error) as ctx:
            self.cur.execute("CALL api.cerrar_dia(%s)", (self.dia,))
        self.assertEqual(ctx.exception.pgcode, "23514")
        self.assertIn("DESCUADRADO", ctx.exception.pgerror)

    def test_la_tabla_rechaza_un_cierre_descuadrado_aunque_se_salte_el_procedimiento(self):
        with self.assertRaises(psycopg2.errors.CheckViolation):
            self.cur.execute("INSERT INTO nucleo.cierre_diario (fecha, moneda, operaciones, movimientos, total_debitos, total_creditos, saldo_caja) "
                             "VALUES ('2001-01-01', 'COP', 1, 2, 10, 11, 0)")

    def test_el_cierre_es_inmutable(self):
        for sql in ("UPDATE nucleo.cierre_diario SET operaciones = 0", "DELETE FROM nucleo.cierre_diario", "TRUNCATE nucleo.cierre_diario"):
            with self.assertRaises(psycopg2.Error) as ctx:
                self.cur.execute(sql)
            self.assertEqual(ctx.exception.pgcode, "55000", sql)
            self.conn.rollback()

    def test_el_rol_de_la_app_puede_ejecutar_pero_no_modificar(self):
        self.cur.execute("SET LOCAL ROLE rol_lab_app")
        self.cur.execute("SELECT count(*) FROM api.v_cierres")
        with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
            self.cur.execute("DELETE FROM nucleo.cierre_diario")

    def test_saldo_de_caja_del_cierre_coincide_con_la_cadena_de_saldos(self):
        self.cur.execute("SELECT moneda, saldo_caja FROM nucleo.cierre_diario WHERE fecha = %s", (self.dia,))
        for moneda, saldo in self.cur.fetchall():
            self.cur.execute(
                "SELECT m.saldo_posterior FROM nucleo.movimiento m JOIN nucleo.cuenta c ON c.id = m.cuenta_id "
                "WHERE c.tipo = 'sistema' AND c.moneda = %s AND m.creado_en < (%s::date + 1)::timestamp AT TIME ZONE 'America/Bogota' "
                "ORDER BY m.creado_en DESC, m.id DESC LIMIT 1", (moneda, self.dia))
            self.assertEqual(self.cur.fetchone()[0], saldo)


if __name__ == "__main__":
    unittest.main()
