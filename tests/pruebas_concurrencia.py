import threading
import uuid
from decimal import Decimal

from base import BaseLab
from config import conectar


def en_hilos(cantidad, funcion):
    errores, resultados = [], []

    def envoltura(i):
        conn = conectar()
        try:
            resultados.append(funcion(conn, i))
            conn.commit()
        except Exception as e:  # noqa: BLE001
            conn.rollback()
            errores.append(e)
        finally:
            conn.close()

    hilos = [threading.Thread(target=envoltura, args=(i,)) for i in range(cantidad)]
    for h in hilos:
        h.start()
    for h in hilos:
        h.join()
    return resultados, errores


class PruebasConcurrencia(BaseLab):
    def test_transferencias_cruzadas_sin_interbloqueo(self):
        a, b = self.cuenta(saldo=1000), self.cuenta(saldo=1000)

        def mover(conn, i):
            origen, destino = (a, b) if i % 2 == 0 else (b, a)
            with conn.cursor() as cur:
                cur.execute("SELECT api.registrar_transaccion(%s, 'transferencia', %s, %s, 10)",
                            (uuid.uuid4().hex, origen, destino))

        _, errores = en_hilos(20, mover)
        self.assertEqual(errores, [])
        self.assertEqual(self.saldo(a), Decimal("1000.00"))
        self.assertEqual(self.saldo(b), Decimal("1000.00"))

    def test_misma_clave_en_paralelo_aplica_una_vez(self):
        c = self.cuenta()
        clave = uuid.uuid4().hex

        def depositar(conn, _):
            with conn.cursor() as cur:
                cur.execute("SELECT api.registrar_transaccion(%s, 'deposito', NULL, %s, 50)", (clave, c))
                return cur.fetchone()[0]

        ids, errores = en_hilos(8, depositar)
        self.assertEqual(errores, [])
        self.assertEqual(len(set(ids)), 1)
        self.assertEqual(self.saldo(c), Decimal("50.00"))

    def test_reverso_concurrente_con_claves_distintas_aplica_una_vez(self):
        c = self.cuenta()
        original = self.tx("deposito", None, c, 80)
        self.conn.commit()

        def reversar(conn, _):
            with conn.cursor() as cur:
                cur.execute("SELECT api.reversar_transaccion(%s, %s, 'doble clic')", (uuid.uuid4().hex, original))

        _, errores = en_hilos(6, reversar)
        self.assertEqual(len(errores), 5)
        self.assertTrue(all(e.pgcode == "P0007" for e in errores))
        self.assertEqual(self.saldo(c), Decimal("0.00"))

    def test_retiros_simultaneos_no_sobregiran(self):
        c = self.cuenta(saldo=100)

        def retirar(conn, _):
            with conn.cursor() as cur:
                cur.execute("SELECT api.registrar_transaccion(%s, 'retiro', %s, NULL, 30)", (uuid.uuid4().hex, c))

        _, errores = en_hilos(6, retirar)
        self.assertEqual(len(errores), 3)  # solo caben 3 retiros de 30 en 100
        self.assertEqual(self.saldo(c), Decimal("10.00"))
