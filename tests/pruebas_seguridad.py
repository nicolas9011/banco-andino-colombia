import psycopg2.errors

from base import BaseLab


class PruebasSeguridad(BaseLab):
    def _como(self, rol):
        self.cur.execute("SET LOCAL ROLE " + rol)

    def test_app_no_toca_tablas_del_nucleo(self):
        self._como("rol_lab_app")
        with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
            self.cur.execute("SELECT * FROM nucleo.cuenta LIMIT 1")

    def test_app_no_modifica_movimientos(self):
        self._como("rol_lab_app")
        with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
            self.cur.execute("DELETE FROM nucleo.movimiento")

    def test_app_si_lee_vistas_y_ejecuta_funciones(self):
        self._como("rol_lab_app")
        self.cur.execute("SELECT count(*) FROM api.v_saldos")
        self.cur.execute("SELECT api.registrar_cliente('SEG-1', 'Prueba Seguridad', NULL, 'natural', NULL, NULL, 'Antioquia', 'Medellin')")

    def test_lectura_no_ejecuta_funciones(self):
        self._como("rol_lab_lectura")
        with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
            self.cur.execute("SELECT api.registrar_cliente('SEG-2', 'No Debe', NULL, 'natural', NULL, NULL, 'Antioquia', 'Medellin')")

    def test_lectura_no_ve_bitacora(self):
        self._como("rol_lab_lectura")
        with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
            self.cur.execute("SELECT * FROM auditoria.evento LIMIT 1")

    def test_auditor_ve_bitacora_y_conciliacion(self):
        self._como("rol_lab_auditor")
        self.cur.execute("SELECT count(*) FROM auditoria.evento")
        self.cur.execute("SELECT count(*) FROM api.v_conciliacion")
