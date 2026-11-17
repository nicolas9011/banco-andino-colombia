"""Pruebas de MUTACION de las compuertas de calidad.

Un control que siempre devuelve 0 no demuestra nada. Aqui se corrompen los datos a proposito (con los
triggers apagados, dentro de una transaccion que se revierte) y se exige que el control
correspondiente DETECTE el dano. Requiere datos cargados con src/masivo.py.
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))
from compuertas import CONTROLES  # noqa: E402
from config import conectar  # noqa: E402

SQL = {nombre: sql for _, nombre, sql in CONTROLES}


def buscar(fragmento):
    clave = [n for n in SQL if fragmento in n]
    assert len(clave) == 1, f"control ambiguo o inexistente: {fragmento} -> {clave}"
    return SQL[clave[0]]


class PruebasMutacion(unittest.TestCase):
    def setUp(self):
        self.conn = conectar()
        self.cur = self.conn.cursor()
        self.cur.execute("SELECT count(*) FROM nucleo.transaccion WHERE clave_idempotencia LIKE 'hist-%'")
        if self.cur.fetchone()[0] < 1000:
            self.skipTest("No hay carga masiva (python src/masivo.py)")
        self.cur.execute("SET session_replication_role = replica")   # permite corromper a proposito

    def tearDown(self):
        self.conn.rollback()
        self.conn.close()

    def problemas(self, fragmento):
        self.cur.execute(buscar(fragmento))
        return self.cur.fetchone()[0]

    def test_base_limpia_antes_de_corromper(self):
        # LINEA BASE de TODOS los controles: cada mutacion posterior solo prueba algo si el control daba 0 antes
        # (mutaciones se revierten con rollback en tearDown).
        for _, nombre, sql in CONTROLES:
            self.cur.execute(sql)
            self.assertEqual(self.cur.fetchone()[0], 0, nombre)

    def test_saldo_alterado_rompe_conciliacion(self):
        self.cur.execute("UPDATE nucleo.cuenta SET saldo = saldo + 1 WHERE id = (SELECT cuenta_id FROM nucleo.movimiento WHERE cuenta_id > 2 LIMIT 1)")
        self.assertGreater(self.problemas("conciliacion"), 0)
        self.assertGreater(self.problemas("saldo de cuenta <> ultimo"), 0)

    def test_movimiento_borrado_rompe_la_partida_doble(self):
        self.cur.execute("DELETE FROM nucleo.movimiento WHERE id = (SELECT min(id) FROM nucleo.movimiento WHERE sentido = 'C')")
        self.assertGreater(self.problemas("doble partida"), 0)
        self.assertGreater(self.problemas("exactamente un debito"), 0)

    def test_saldo_posterior_alterado_rompe_la_cadena(self):
        self.cur.execute("UPDATE nucleo.movimiento SET saldo_posterior = saldo_posterior + 5 WHERE id = (SELECT max(id) / 2 FROM nucleo.movimiento)")
        self.assertGreater(self.problemas("cadena de saldos"), 0)

    def test_referencia_inexistente_es_huerfana(self):
        self.cur.execute("UPDATE nucleo.movimiento SET cuenta_id = 99999999 WHERE id = (SELECT min(id) FROM nucleo.movimiento)")
        self.assertGreater(self.problemas("huerfanos nucleo.movimiento.cuenta_id"), 0)

    def test_transaccion_con_otra_cuenta_no_coincide_con_su_movimiento(self):
        self.cur.execute("UPDATE nucleo.transaccion SET cuenta_credito = cuenta_debito + 1 WHERE id = (SELECT transaccion_id FROM nucleo.movimiento ORDER BY id LIMIT 1 OFFSET 500)")
        self.assertGreater(self.problemas("no coincide con su transaccion"), 0)

    def test_limite_diario_violado(self):
        self.cur.execute("UPDATE nucleo.cuenta SET limite_retiro_diario = 0.01 WHERE id = (SELECT cuenta_debito FROM nucleo.transaccion WHERE tipo = 'retiro' LIMIT 1)")
        self.assertGreater(self.problemas("retiros por encima"), 0)

    def test_cuenta_cerrada_con_saldo(self):
        self.cur.execute("UPDATE nucleo.cuenta SET saldo = 5 WHERE id = (SELECT id FROM nucleo.cuenta WHERE estado = 'cerrada' LIMIT 1)")
        self.assertGreater(self.problemas("cuenta cerrada con saldo"), 0)

    def test_transaccion_en_el_futuro(self):
        self.cur.execute("UPDATE nucleo.transaccion SET creado_en = now() + interval '2 days' WHERE id = (SELECT id FROM nucleo.transaccion LIMIT 1)")
        self.assertGreater(self.problemas("transacciones en el futuro"), 0)

    def test_operacion_en_cuenta_bloqueada_despues_del_bloqueo(self):
        self.cur.execute(
            "UPDATE nucleo.movimiento SET creado_en = now() - interval '1 hour' "
            "WHERE id = (SELECT m.id FROM nucleo.movimiento m JOIN nucleo.cuenta c ON c.id = m.cuenta_id "
            "            WHERE c.estado = 'bloqueada' LIMIT 1)")
        self.assertGreater(self.problemas("fuera de la vida activa"), 0)

    def test_oficina_en_otro_departamento(self):
        self.cur.execute(
            "UPDATE nucleo.cuenta SET oficina_id = (SELECT o.id FROM nucleo.oficina o JOIN nucleo.cliente cl ON cl.id = nucleo.cuenta.cliente_id "
            "WHERE o.departamento <> cl.departamento LIMIT 1) WHERE tipo = 'cliente' AND id = (SELECT min(id) FROM nucleo.cuenta WHERE tipo = 'cliente' AND "
            "cliente_id IN (SELECT id FROM nucleo.cliente WHERE departamento IN (SELECT departamento FROM nucleo.oficina)))")
        self.assertGreater(self.problemas("fuera del departamento"), 0)

    def test_cuenta_conjunta_con_un_solo_titular(self):
        self.cur.execute("UPDATE nucleo.cuenta SET tipo_titularidad = 'conjunta' WHERE id = (SELECT min(id) FROM nucleo.cuenta WHERE tipo = 'cliente' AND tipo_titularidad = 'individual')")
        self.assertGreater(self.problemas("conjunta debe tener"), 0)

    def test_reverso_con_monto_distinto(self):
        self.cur.execute("UPDATE nucleo.transaccion SET monto = monto + 1 WHERE id = (SELECT id FROM nucleo.transaccion WHERE tipo = 'reverso' LIMIT 1)")
        self.assertGreater(self.problemas("reverso inconsistente"), 0)


if __name__ == "__main__":
    unittest.main()
