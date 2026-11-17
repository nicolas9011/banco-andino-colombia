import uuid
from decimal import Decimal

import psycopg2

from base import BaseLab


class PruebasCuentas(BaseLab):
    def _eventos(self, cuenta):
        self.cur.execute("SELECT tipo FROM nucleo.evento_cuenta WHERE cuenta_id = %s ORDER BY id", (cuenta,))
        return [f[0] for f in self.cur.fetchall()]

    def _cambiar(self, cuenta, estado):
        self.cur.execute("SELECT api.cambiar_estado_cuenta(%s, %s, 'prueba')", (cuenta, estado))

    def test_ciclo_de_vida_genera_eventos_y_no_movimientos(self):
        c = self.cuenta()
        self._cambiar(c, "bloqueada")
        self._cambiar(c, "activa")
        self._cambiar(c, "cerrada")
        self.assertEqual(self._eventos(c), ["creacion", "activacion", "bloqueo", "desbloqueo", "cierre"])
        self.cur.execute("SELECT count(*) FROM nucleo.movimiento WHERE cuenta_id = %s", (c,))
        self.assertEqual(self.cur.fetchone()[0], 0)

    def test_cuenta_pendiente_no_opera_hasta_activarse(self):
        cli = self.cliente()
        self.cur.execute("SELECT api.abrir_cuenta(%s, 'COP', NULL, NULL, '{}', false)", (cli,))
        c = self.cur.fetchone()[0]
        with self.assertRaises(psycopg2.Error) as ctx:
            self.tx("deposito", None, c, 10)
        self.assertEqual(ctx.exception.pgcode, "P0002")
        self.conn.rollback()

    def test_transicion_invalida(self):
        c = self.cuenta()
        self._cambiar(c, "cerrada")
        with self.assertRaises(psycopg2.Error) as ctx:
            self._cambiar(c, "activa")          # una cuenta cerrada no se reabre
        self.assertEqual(ctx.exception.pgcode, "P0006")

    def test_no_se_cierra_con_saldo(self):
        c = self.cuenta(saldo=5)
        with self.assertRaises(psycopg2.Error) as ctx:
            self._cambiar(c, "cerrada")
        self.assertEqual(ctx.exception.pgcode, "P0006")

    def test_evento_cuenta_inmutable(self):
        c = self.cuenta()
        with self.assertRaises(psycopg2.Error) as ctx:
            self.cur.execute("DELETE FROM nucleo.evento_cuenta WHERE cuenta_id = %s", (c,))
        self.assertEqual(ctx.exception.pgcode, "55000")

    def test_titularidad_conjunta(self):
        a, b = self.cliente(), self.cliente()
        self.cur.execute("SELECT api.abrir_cuenta(%s, 'COP', NULL, NULL, %s)", (a, [b]))
        c = self.cur.fetchone()[0]
        self.cur.execute("SELECT tipo_titularidad FROM nucleo.cuenta WHERE id = %s", (c,))
        self.assertEqual(self.cur.fetchone()[0], "conjunta")
        self.assertTrue(self._es_titular(b, c))

    def test_titularidad_empresarial_y_cotitular_invalido(self):
        emp = self.cliente(tipo_persona="juridica")
        self.cur.execute("SELECT api.abrir_cuenta(%s, 'COP')", (emp,))
        c = self.cur.fetchone()[0]
        self.cur.execute("SELECT tipo_titularidad FROM nucleo.cuenta WHERE id = %s", (c,))
        self.assertEqual(self.cur.fetchone()[0], "empresarial")
        persona = self.cliente()
        with self.assertRaises(psycopg2.Error) as ctx:
            self.cur.execute("SELECT api.abrir_cuenta(%s, 'COP', NULL, NULL, %s)", (emp, [persona]))
        self.assertEqual(ctx.exception.pgcode, "22023")

    def test_no_titular_no_es_titular(self):
        c = self.cuenta()
        self.assertFalse(self._es_titular(self.cliente(), c))

    def _es_titular(self, cliente, cuenta):
        self.cur.execute("SELECT api.es_titular(%s, %s)", (cliente, cuenta))
        return self.cur.fetchone()[0]

    def test_persona_juridica_exige_nit(self):
        with self.assertRaises(psycopg2.Error) as ctx:
            self.cur.execute("SELECT api.registrar_cliente('900123456', 'Empresa', NULL, 'juridica', 'CC', NULL, 'Antioquia', 'Medellin')")
        self.assertEqual(ctx.exception.pgcode, "22023")
        self.assertIn("tipo de documento", ctx.exception.pgerror)

    def test_ubicacion_obligatoria_en_funcion_y_en_tabla(self):
        with self.assertRaises(psycopg2.Error) as ctx:
            self.cur.execute("SELECT api.registrar_cliente('UBI-1', 'Sin Ubicacion', NULL)")
        self.assertEqual(ctx.exception.pgcode, "22023")
        self.conn.rollback()
        with self.assertRaises(psycopg2.errors.CheckViolation):   # y la tabla se defiende sola
            self.cur.execute("INSERT INTO nucleo.cliente (documento, nombre) VALUES ('UBI-2', 'Directo')")

    def test_oficina_por_defecto_es_la_del_departamento_del_cliente(self):
        cli = self.cliente(departamento="Atlantico", ciudad="Barranquilla")
        self.cur.execute("SELECT api.abrir_cuenta(%s, 'COP')", (cli,))
        c = self.cur.fetchone()[0]
        self.cur.execute("SELECT o.departamento FROM nucleo.cuenta c JOIN nucleo.oficina o ON o.id = c.oficina_id WHERE c.id = %s", (c,))
        self.assertEqual(self.cur.fetchone()[0], "Atlantico")

    def test_departamento_sin_oficina_usa_la_primera_activa(self):
        cli = self.cliente(departamento="Amazonas", ciudad="Leticia")
        self.cur.execute("SELECT api.abrir_cuenta(%s, 'COP')", (cli,))
        self.assertIsNotNone(self.cur.fetchone()[0])

    def test_oficina_de_otro_departamento_se_rechaza(self):
        cli = self.cliente(departamento="Atlantico", ciudad="Barranquilla")
        self.cur.execute("SELECT id FROM nucleo.oficina WHERE departamento = 'Antioquia' LIMIT 1")
        ajena = self.cur.fetchone()[0]
        with self.assertRaises(psycopg2.Error) as ctx:
            self.cur.execute("SELECT api.abrir_cuenta(%s, 'COP', NULL, %s)", (cli, ajena))
        self.assertEqual(ctx.exception.pgcode, "22023")


class PruebasLimites(BaseLab):
    def test_limite_de_retiro_diario(self):
        c = self.cuenta(saldo=5_000_000)       # ahorro basica: limite 2.000.000
        self.tx("retiro", c, None, 1_500_000)
        self.conn.commit()                      # el rechazo de abajo solo debe deshacer el segundo retiro
        with self.assertRaises(psycopg2.Error) as ctx:
            self.tx("retiro", c, None, 600_000)
        self.assertEqual(ctx.exception.pgcode, "P0005")
        self.conn.rollback()
        self.assertEqual(self.saldo(c), Decimal("3500000.00"))

    def test_limite_de_transferencia_diaria(self):
        a, b = self.cuenta(saldo=9_000_000), self.cuenta()
        self.tx("transferencia", a, b, 4_000_000)
        with self.assertRaises(psycopg2.Error) as ctx:
            self.tx("transferencia", a, b, 1_500_000)   # limite 5.000.000
        self.assertEqual(ctx.exception.pgcode, "P0005")

    def test_cambio_de_limites_registra_evento_y_se_aplica(self):
        c = self.cuenta(saldo=1_000_000)
        self.cur.execute("SELECT api.cambiar_limites(%s, 100000, 200000, NULL, 'prueba')", (c,))
        self.cur.execute("SELECT count(*) FROM nucleo.evento_cuenta WHERE cuenta_id = %s AND tipo = 'cambio_limites'", (c,))
        self.assertEqual(self.cur.fetchone()[0], 1)
        with self.assertRaises(psycopg2.Error) as ctx:
            self.tx("retiro", c, None, 100_001)
        self.assertEqual(ctx.exception.pgcode, "P0005")

    def test_limites_invalidos(self):
        c = self.cuenta()
        with self.assertRaises(psycopg2.Error) as ctx:
            self.cur.execute("SELECT api.cambiar_limites(%s, -1, 10)", (c,))
        self.assertEqual(ctx.exception.pgcode, "22023")

    def test_sobregiro_solo_en_producto_que_lo_permite(self):
        corriente = self.producto("CTE-EMPRE")
        cli = self.cliente()
        self.cur.execute("SELECT api.abrir_cuenta(%s, 'COP', %s)", (cli, corriente))
        c = self.cur.fetchone()[0]
        self.tx("deposito", None, c, 100_000)
        self.tx("retiro", c, None, 600_000)                 # saldo -500.000, dentro del sobregiro de 1.000.000
        self.assertEqual(self.saldo(c), Decimal("-500000.00"))
        self.cur.execute("SELECT saldo_contable, saldo_disponible FROM api.v_saldos WHERE cuenta_id = %s", (c,))
        self.assertEqual(self.cur.fetchone(), (Decimal("-500000.00"), Decimal("500000.00")))
        with self.assertRaises(psycopg2.Error) as ctx:
            self.tx("retiro", c, None, 600_000)             # excede el disponible
        self.assertEqual(ctx.exception.pgcode, "P0004")


class PruebasReverso(BaseLab):
    def test_reverso_restituye_saldos_sin_tocar_la_original(self):
        a, b = self.cuenta(saldo=1000), self.cuenta()
        t = self.tx("transferencia", a, b, 400)
        self.cur.execute("SELECT api.reversar_transaccion(%s, %s, 'error del cliente')", (uuid.uuid4().hex, t))
        self.assertEqual(self.saldo(a), Decimal("1000.00"))
        self.assertEqual(self.saldo(b), Decimal("0.00"))
        self.cur.execute("SELECT count(*) FROM nucleo.transaccion WHERE id = %s AND tipo = 'transferencia'", (t,))
        self.assertEqual(self.cur.fetchone()[0], 1)

    def test_reverso_idempotente_con_la_misma_clave(self):
        c = self.cuenta()
        t = self.tx("deposito", None, c, 70)
        clave = uuid.uuid4().hex
        self.cur.execute("SELECT api.reversar_transaccion(%s, %s, 'x')", (clave, t))
        r1 = self.cur.fetchone()[0]
        self.cur.execute("SELECT api.reversar_transaccion(%s, %s, 'x')", (clave, t))
        self.assertEqual(r1, self.cur.fetchone()[0])
        self.assertEqual(self.saldo(c), Decimal("0.00"))

    def test_no_se_reversa_dos_veces(self):
        c = self.cuenta()
        t = self.tx("deposito", None, c, 70)
        self.cur.execute("SELECT api.reversar_transaccion(%s, %s, 'x')", (uuid.uuid4().hex, t))
        self.conn.commit()
        with self.assertRaises(psycopg2.Error) as ctx:
            self.cur.execute("SELECT api.reversar_transaccion(%s, %s, 'otra vez')", (uuid.uuid4().hex, t))
        self.assertEqual(ctx.exception.pgcode, "P0007")

    def test_un_reverso_no_se_reversa(self):
        c = self.cuenta()
        t = self.tx("deposito", None, c, 70)
        self.cur.execute("SELECT api.reversar_transaccion(%s, %s, 'x')", (uuid.uuid4().hex, t))
        r = self.cur.fetchone()[0]
        with self.assertRaises(psycopg2.Error) as ctx:
            self.cur.execute("SELECT api.reversar_transaccion(%s, %s, 'x')", (uuid.uuid4().hex, r))
        self.assertEqual(ctx.exception.pgcode, "22023")

    def test_reverso_sin_fondos_se_rechaza(self):
        a, b = self.cuenta(saldo=500), self.cuenta()
        t = self.tx("transferencia", a, b, 500)
        self.tx("retiro", b, None, 500)                      # el destino ya gasto el dinero
        with self.assertRaises(psycopg2.Error) as ctx:
            self.cur.execute("SELECT api.reversar_transaccion(%s, %s, 'x')", (uuid.uuid4().hex, t))
        self.assertEqual(ctx.exception.pgcode, "P0004")

    def test_reverso_requiere_motivo(self):
        c = self.cuenta()
        t = self.tx("deposito", None, c, 5)
        with self.assertRaises(psycopg2.Error) as ctx:
            self.cur.execute("SELECT api.reversar_transaccion(%s, %s, '  ')", (uuid.uuid4().hex, t))
        self.assertEqual(ctx.exception.pgcode, "22023")

    def test_ajuste_requiere_concepto_y_tipos_adicionales(self):
        c = self.cuenta(saldo=100)
        with self.assertRaises(psycopg2.Error) as ctx:
            self.tx("ajuste", None, c, 5)
        self.assertEqual(ctx.exception.pgcode, "22023")
        self.conn.rollback()
        c = self.cuenta(saldo=100)
        self.cur.execute("SELECT api.registrar_transaccion(%s, 'ajuste', NULL, %s, 5, 'sistema', 'ajuste por error')",
                         (uuid.uuid4().hex, c))
        self.tx("credito", None, c, 10)
        self.tx("debito", c, None, 20)
        self.assertEqual(self.saldo(c), Decimal("95.00"))


class PruebasAuditoriaActor(BaseLab):
    def _fijar_actor(self, uid, rol="CAJERO", ip="10.1.2.3"):
        self.cur.execute("SELECT set_config('app.usuario_id', %s, true), set_config('app.rol', %s, true), "
                         "set_config('app.ip', %s, true)", (str(uid), rol, ip))

    def test_transaccion_registra_actor_rol_e_ip(self):
        c = self.cuenta()
        uid = self.usuario("CAJERO")
        self._fijar_actor(uid)
        t = self.tx("deposito", None, c, 25)
        self.cur.execute("SELECT actor_usuario_id, host(ip), canal FROM nucleo.transaccion WHERE id = %s", (t,))
        self.assertEqual(self.cur.fetchone(), (uid, "10.1.2.3", "sistema"))
        self.cur.execute(
            "SELECT usuario_app_id, rol, host(ip), despues->>'monto' FROM auditoria.evento "
            "WHERE tabla = 'nucleo.transaccion' AND registro_id = %s", (str(t),))
        self.assertEqual(self.cur.fetchone(), (uid, "CAJERO", "10.1.2.3", "25.00"))

    def test_cambio_de_estado_guarda_antes_y_despues(self):
        c = self.cuenta()
        self.cur.execute("SELECT api.cambiar_estado_cuenta(%s, 'bloqueada', 'sospecha')", (c,))
        self.cur.execute(
            "SELECT antes->>'estado', despues->>'estado' FROM auditoria.evento "
            "WHERE tabla = 'nucleo.cuenta' AND operacion = 'UPDATE' AND registro_id = %s "
            "ORDER BY id DESC LIMIT 1", (str(c),))
        self.assertEqual(self.cur.fetchone(), ("activa", "bloqueada"))

    def test_ip_invalida_no_rompe_la_operacion(self):
        c = self.cuenta()
        self._fijar_actor(self.usuario("CAJERO"), ip="no-es-una-ip")
        self.tx("deposito", None, c, 1)
        self.assertEqual(self.saldo(c), Decimal("1.00"))

    def test_hash_de_contrasena_no_llega_a_la_bitacora(self):
        uid = self.usuario("ADMIN")
        self.cur.execute("SELECT despues::text FROM auditoria.evento "
                         "WHERE tabla = 'seguridad.usuario' AND registro_id = %s", (str(uid),))
        texto = self.cur.fetchone()[0]
        self.assertNotIn("password_hash", texto)
        self.assertIn("username", texto)

    def test_registro_manual_de_acceso_denegado(self):
        self.cur.execute("SELECT api.registrar_auditoria('ACCESO', 'api.audit', NULL, 'DENEGADO', "
                         "'{\"ruta\": \"/api/audit\"}'::jsonb)")
        self.cur.execute("SELECT resultado FROM auditoria.evento WHERE tabla = 'api.audit' "
                         "ORDER BY id DESC LIMIT 1")
        self.assertEqual(self.cur.fetchone()[0], "DENEGADO")


class PruebasRBAC(BaseLab):
    def _permisos(self, rol):
        self.cur.execute(
            "SELECT p.codigo FROM seguridad.rol r JOIN seguridad.rol_permiso rp ON rp.rol_id = r.id "
            "JOIN seguridad.permiso p ON p.id = rp.permiso_id WHERE r.codigo = %s", (rol,))
        return {f[0] for f in self.cur.fetchall()}

    def test_matriz_de_permisos(self):
        self.assertIn("audit:read", self._permisos("AUDITOR"))
        self.assertIn("users:write", self._permisos("ADMIN"))
        self.assertNotIn("audit:read", self._permisos("CLIENTE"))
        self.assertNotIn("roles:write", self._permisos("CAJERO"))
        self.assertNotIn("tx:deposit", self._permisos("ADMIN"))
        self.assertNotIn("tx:reverse", self._permisos("AUDITOR"))

    def test_usuario_cliente_requiere_cliente_vinculado(self):
        with self.assertRaises(psycopg2.Error) as ctx:
            self.usuario("CLIENTE")
        self.assertEqual(ctx.exception.pgcode, "23514")

    def test_rol_de_personal_no_puede_ligarse_a_un_cliente(self):
        with self.assertRaises(psycopg2.Error) as ctx:
            self.usuario("CAJERO", cliente_id=self.cliente())
        self.assertEqual(ctx.exception.pgcode, "23514")

    def test_usuario_cliente_valido(self):
        self.usuario("CLIENTE", cliente_id=self.cliente())

    def test_username_unico_y_en_minusculas(self):
        sql = ("INSERT INTO seguridad.usuario (username, password_hash, nombre_completo) "
               "VALUES (%s, %s, 'A')")
        hash_ = "$2b$12$" + "x" * 40
        self.cur.execute(sql, ("duplicado1", hash_))
        self.cur.execute("SAVEPOINT s")
        with self.assertRaises(psycopg2.errors.UniqueViolation):
            self.cur.execute(sql, ("duplicado1", hash_))
        self.cur.execute("ROLLBACK TO SAVEPOINT s")
        with self.assertRaises(psycopg2.errors.CheckViolation):    # mayusculas no se admiten
            self.cur.execute(sql, ("DUPLICADO1", hash_))

    def test_app_no_lee_tablas_de_seguridad(self):
        self.cur.execute("SET LOCAL ROLE rol_lab_app")
        with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
            self.cur.execute("SELECT password_hash FROM seguridad.usuario")


class PruebasTarjetaYBreB(BaseLab):
    def _tarjeta(self, cuenta):
        self.cur.execute("SELECT api.emitir_tarjeta(%s, %s, '1234', %s, current_date + 365)",
                         (cuenta, uuid.uuid4().hex, "$2b$12$" + "p" * 40))
        return self.cur.fetchone()[0]

    def test_tarjeta_se_bloquea_al_tercer_pin_incorrecto(self):
        t = self._tarjeta(self.cuenta())
        for esperado in (("activa", 1), ("activa", 2), ("bloqueada", 3)):
            self.cur.execute("SELECT * FROM api.registrar_resultado_pin(%s, false)", (t,))
            self.assertEqual(self.cur.fetchone(), esperado)

    def test_pin_correcto_reinicia_intentos(self):
        t = self._tarjeta(self.cuenta())
        self.cur.execute("SELECT * FROM api.registrar_resultado_pin(%s, false)", (t,))
        self.cur.execute("SELECT * FROM api.registrar_resultado_pin(%s, true)", (t,))
        self.assertEqual(self.cur.fetchone(), ("activa", 0))

    def test_hashes_de_tarjeta_no_van_a_la_bitacora(self):
        t = self._tarjeta(self.cuenta())
        self.cur.execute("SELECT despues::text FROM auditoria.evento "
                         "WHERE tabla = 'nucleo.tarjeta' AND registro_id = %s", (str(t),))
        texto = self.cur.fetchone()[0]
        self.assertNotIn("pin_hash", texto)
        self.assertNotIn("numero_hash", texto)

    def test_tarjeta_vencida_no_se_emite(self):
        c = self.cuenta()
        with self.assertRaises(psycopg2.Error) as ctx:
            self.cur.execute("SELECT api.emitir_tarjeta(%s, %s, '1234', %s, current_date - 1)",
                             (c, uuid.uuid4().hex, "$2b$12$" + "p" * 40))
        self.assertEqual(ctx.exception.pgcode, "22023")

    def _llave(self, cliente, cuenta, tipo="alfanumerica", valor=None):
        valor = valor or "@" + uuid.uuid4().hex[:10]
        self.cur.execute("SELECT api.registrar_llave_brebe(%s, %s, %s, %s)", (cliente, cuenta, tipo, valor))
        return valor

    def _cuenta_con_dueno(self, saldo=0):
        cli = self.cliente()
        self.cur.execute("SELECT api.abrir_cuenta(%s, 'COP')", (cli,))
        c = self.cur.fetchone()[0]
        if saldo:
            self.tx("deposito", None, c, saldo)
        return cli, c

    def test_envio_brebe_mueve_dinero_y_marca_simulacion(self):
        cli_a, a = self._cuenta_con_dueno(1000)
        cli_b, b = self._cuenta_con_dueno()
        llave = self._llave(cli_b, b)
        clave = uuid.uuid4().hex
        self.cur.execute("SELECT api.enviar_brebe(%s, %s, %s, 300, 'almuerzo')", (clave, a, llave))
        t1 = self.cur.fetchone()[0]
        self.cur.execute("SELECT api.enviar_brebe(%s, %s, %s, 300, 'almuerzo')", (clave, a, llave))
        self.assertEqual(t1, self.cur.fetchone()[0])           # idempotente
        self.assertEqual(self.saldo(a), Decimal("700.00"))
        self.assertEqual(self.saldo(b), Decimal("300.00"))
        self.cur.execute("SELECT es_simulacion FROM nucleo.brebe_operacion WHERE transaccion_id = %s", (t1,))
        self.assertTrue(self.cur.fetchone()[0])
        self.cur.execute("SELECT canal FROM nucleo.transaccion WHERE id = %s", (t1,))
        self.assertEqual(self.cur.fetchone()[0], "brebe")

    def test_llave_duplicada(self):
        cli, c = self._cuenta_con_dueno()
        otro, d = self._cuenta_con_dueno()
        llave = self._llave(cli, c)
        with self.assertRaises(psycopg2.Error) as ctx:
            self._llave(otro, d, valor=llave)
        self.assertEqual(ctx.exception.pgcode, "P0008")

    def test_llave_con_formato_invalido(self):
        cli, c = self._cuenta_con_dueno()
        with self.assertRaises(psycopg2.Error) as ctx:
            self._llave(cli, c, tipo="celular", valor="12345")
        self.assertEqual(ctx.exception.pgcode, "22023")

    def test_no_se_registra_llave_en_cuenta_ajena(self):
        _, c = self._cuenta_con_dueno()
        with self.assertRaises(psycopg2.Error) as ctx:
            self._llave(self.cliente(), c)
        self.assertEqual(ctx.exception.pgcode, "P0002")

    def test_envio_a_llave_propia_misma_cuenta_se_rechaza(self):
        cli, c = self._cuenta_con_dueno(100)
        llave = self._llave(cli, c)
        with self.assertRaises(psycopg2.Error) as ctx:
            self.cur.execute("SELECT api.enviar_brebe(%s, %s, %s, 10)", (uuid.uuid4().hex, c, llave))
        self.assertEqual(ctx.exception.pgcode, "22023")

    def test_llave_inexistente(self):
        _, c = self._cuenta_con_dueno(100)
        with self.assertRaises(psycopg2.Error) as ctx:
            self.cur.execute("SELECT api.enviar_brebe(%s, %s, '@noexiste99', 10)", (uuid.uuid4().hex, c))
        self.assertEqual(ctx.exception.pgcode, "P0002")
