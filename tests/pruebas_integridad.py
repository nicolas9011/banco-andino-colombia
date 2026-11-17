import uuid

import psycopg2
import psycopg2.errors

from base import BaseLab


class PruebasIntegridad(BaseLab):
    def test_movimiento_inmutable(self):
        self.cuenta(saldo=10)
        with self.assertRaises(psycopg2.Error) as ctx:
            self.cur.execute("UPDATE nucleo.movimiento SET monto = 1 WHERE id = (SELECT min(id) FROM nucleo.movimiento)")
        self.assertEqual(ctx.exception.pgcode, "55000")

    def test_transaccion_no_se_borra(self):
        self.cuenta(saldo=10)
        with self.assertRaises(psycopg2.Error) as ctx:
            self.cur.execute("DELETE FROM nucleo.transaccion")
        self.assertEqual(ctx.exception.pgcode, "55000")

    def test_truncate_bloqueado(self):
        with self.assertRaises(psycopg2.Error) as ctx:
            self.cur.execute("TRUNCATE nucleo.movimiento")
        self.assertEqual(ctx.exception.pgcode, "55000")

    def test_bitacora_inmutable(self):
        self.cuenta()
        with self.assertRaises(psycopg2.Error) as ctx:
            self.cur.execute("DELETE FROM auditoria.evento")
        self.assertEqual(ctx.exception.pgcode, "55000")

    def test_saldo_negativo_rechazado(self):
        c = self.cuenta()
        with self.assertRaises(psycopg2.errors.CheckViolation):
            self.cur.execute("UPDATE nucleo.cuenta SET saldo = -1 WHERE id = %s", (c,))

    def test_transaccion_desbalanceada_falla_al_confirmar(self):
        a, b = self.cuenta(saldo=100), self.cuenta()
        self.cur.execute(
            "INSERT INTO nucleo.transaccion (clave_idempotencia, tipo, monto, cuenta_debito, cuenta_credito) "
            "VALUES (%s, 'transferencia', 5, %s, %s) RETURNING id", (uuid.uuid4().hex, a, b))
        tid = self.cur.fetchone()[0]
        self.cur.execute(
            "INSERT INTO nucleo.movimiento (transaccion_id, cuenta_id, sentido, monto, saldo_posterior) "
            "VALUES (%s, %s, 'D', 5, 0)", (tid, a))
        with self.assertRaises(psycopg2.Error):
            self.conn.commit()

    def test_conciliacion_vacia(self):
        self.cuenta(saldo=25)
        self.cur.execute("SELECT count(*) FROM api.v_conciliacion")
        self.assertEqual(self.cur.fetchone()[0], 0)

    def test_alta_de_cuenta_auditada(self):
        c = self.cuenta()
        self.cur.execute(
            "SELECT count(*) FROM auditoria.evento WHERE tabla = 'nucleo.cuenta' "
            "AND operacion = 'INSERT' AND (despues->>'id')::bigint = %s", (c,))
        self.assertEqual(self.cur.fetchone()[0], 1)
