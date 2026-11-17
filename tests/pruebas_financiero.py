import uuid
from decimal import Decimal

import psycopg2
import psycopg2.errors

from base import BaseLab


class PruebasFinancieras(BaseLab):
    def test_deposito_y_retiro(self):
        c = self.cuenta(saldo=100)
        self.tx("retiro", c, None, 30)
        self.assertEqual(self.saldo(c), Decimal("70.00"))

    def test_transferencia_conserva_dinero(self):
        a, b = self.cuenta(saldo=500), self.cuenta(saldo=100)
        self.tx("transferencia", a, b, 200)
        self.assertEqual(self.saldo(a), Decimal("300.00"))
        self.assertEqual(self.saldo(b), Decimal("300.00"))

    def test_fondos_insuficientes(self):
        a, b = self.cuenta(saldo=50), self.cuenta()
        with self.assertRaises(psycopg2.Error) as ctx:
            self.tx("transferencia", a, b, 51)
        self.assertEqual(ctx.exception.pgcode, "P0004")
        self.conn.rollback()
        self.assertEqual(self.saldo(a), Decimal("50.00"))

    def test_monedas_distintas(self):
        a, b = self.cuenta("COP", 100), self.cuenta("USD")
        with self.assertRaises(psycopg2.Error) as ctx:
            self.tx("transferencia", a, b, 10)
        self.assertEqual(ctx.exception.pgcode, "22023")

    def test_monto_invalido(self):
        c = self.cuenta()
        for monto in ("0", "-5", "10.555"):
            with self.assertRaises(psycopg2.Error) as ctx:
                self.tx("deposito", None, c, monto)
            self.assertEqual(ctx.exception.pgcode, "22023")
            self.conn.rollback()

    def test_idempotencia_repetir_clave(self):
        c = self.cuenta()
        clave = uuid.uuid4().hex
        t1 = self.tx("deposito", None, c, 40, clave)
        t2 = self.tx("deposito", None, c, 40, clave)
        self.assertEqual(t1, t2)
        self.assertEqual(self.saldo(c), Decimal("40.00"))

    def test_clave_reutilizada_con_otros_datos(self):
        c = self.cuenta()
        clave = uuid.uuid4().hex
        self.tx("deposito", None, c, 40, clave)
        with self.assertRaises(psycopg2.Error) as ctx:
            self.tx("deposito", None, c, 41, clave)
        self.assertEqual(ctx.exception.pgcode, "P0003")

    def test_cuenta_bloqueada_no_opera(self):
        c = self.cuenta(saldo=10)
        self.cur.execute("SELECT api.cambiar_estado_cuenta(%s, 'bloqueada')", (c,))
        with self.assertRaises(psycopg2.Error) as ctx:
            self.tx("retiro", c, None, 5)
        self.assertEqual(ctx.exception.pgcode, "P0002")
