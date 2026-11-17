"""Utilidades comunes para las pruebas."""
import os
import sys
import unittest
import uuid
from decimal import Decimal

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))
from config import conectar  # noqa: E402


class BaseLab(unittest.TestCase):
    def setUp(self):
        self.conn = conectar()
        self.cur = self.conn.cursor()

    def tearDown(self):
        self.conn.rollback()
        self.conn.close()

    # --- ayudas -------------------------------------------------
    def cuenta(self, moneda="COP", saldo=0):
        doc = uuid.uuid4().hex[:12]
        cliente = self.cliente(documento=doc)
        self.cur.execute("SELECT api.abrir_cuenta(%s, %s)", (cliente, moneda))
        cuenta = self.cur.fetchone()[0]
        if saldo:
            self.tx("deposito", None, cuenta, saldo)
        self.conn.commit()
        return cuenta

    def cliente(self, **kw):
        """Crea un cliente sintetico y devuelve su id (sin commit)."""
        doc = kw.pop("documento", uuid.uuid4().hex[:12])
        self.cur.execute(
            "SELECT api.registrar_cliente(%s, %s, %s, %s, NULL, NULL, %s, %s)",
            (doc, kw.pop("nombre", "Cliente Prueba"), doc + "@t.test", kw.pop("tipo_persona", "natural"),
             kw.pop("departamento", "Antioquia"), kw.pop("ciudad", "Medellin")))
        return self.cur.fetchone()[0]

    def producto(self, codigo):
        self.cur.execute("SELECT id FROM nucleo.producto WHERE codigo = %s", (codigo,))
        return self.cur.fetchone()[0]

    def usuario(self, rol, cliente_id=None):
        """Crea un usuario de prueba con el rol dado (sin commit)."""
        self.cur.execute(
            "INSERT INTO seguridad.usuario (username, password_hash, nombre_completo, cliente_id) "
            "VALUES (%s, %s, 'Usuario Prueba', %s) RETURNING id",
            ("t" + uuid.uuid4().hex[:12], "$2b$12$" + "x" * 40, cliente_id))
        uid = self.cur.fetchone()[0]
        self.cur.execute("INSERT INTO seguridad.usuario_rol SELECT %s, id FROM seguridad.rol WHERE codigo = %s",
                         (uid, rol))
        return uid

    def tx(self, tipo, origen, destino, monto, clave=None):
        self.cur.execute(
            "SELECT api.registrar_transaccion(%s, %s, %s, %s, %s)",
            (clave or uuid.uuid4().hex, tipo, origen, destino, Decimal(str(monto))),
        )
        return self.cur.fetchone()[0]

    def saldo(self, cuenta):
        self.cur.execute("SELECT saldo FROM nucleo.cuenta WHERE id = %s", (cuenta,))
        return self.cur.fetchone()[0]
