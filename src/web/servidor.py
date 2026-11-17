"""Servidor web minimo (biblioteca estandar + psycopg2)."""
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import psycopg2
import psycopg2.extras
from psycopg2.pool import ThreadedConnectionPool

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from config import DSN  # noqa: E402

ESTATICOS = Path(__file__).parent / "static"
ESTADOS = {"22023": 400, "42501": 403, "P0002": 404, "P0003": 409, "23514": 422}
POOL = None


def consultar(sql, params=()):
    conn = POOL.getconn()
    try:
        with conn, conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(sql, params)
            return cur.fetchall()
    finally:
        POOL.putconn(conn)


class Manejador(BaseHTTPRequestHandler):
    def _responder(self, estado, cuerpo, tipo="application/json; charset=utf-8"):
        datos = cuerpo if isinstance(cuerpo, bytes) else json.dumps(cuerpo, default=str).encode()
        self.send_response(estado)
        self.send_header("Content-Type", tipo)
        self.send_header("Content-Length", str(len(datos)))
        self.end_headers()
        self.wfile.write(datos)

    def _protegido(self, accion):
        try:
            accion()
        except psycopg2.Error as e:
            mensaje = e.diag.message_primary if e.diag and e.diag.message_primary else str(e)
            self._responder(ESTADOS.get(e.pgcode, 500), {"error": mensaje, "codigo": e.pgcode})
        except (ValueError, KeyError, json.JSONDecodeError) as e:
            self._responder(400, {"error": f"solicitud invalida: {e}"})

    def do_GET(self):
        self._protegido(self._get)

    def do_POST(self):
        self._protegido(self._post)

    def _get(self):
        url = urlparse(self.path)
        partes = [p for p in url.path.split("/") if p]
        params = parse_qs(url.query)

        if not partes:
            return self._responder(200, (ESTATICOS / "index.html").read_bytes(), "text/html; charset=utf-8")
        if partes == ["health"]:
            return self._responder(200, {"estado": "ok"})
        if partes == ["api", "cuentas"]:
            limite = min(max(int(params.get("limite", ["25"])[0]), 1), 200)
            return self._responder(200, consultar(
                "SELECT * FROM api.v_saldos ORDER BY cuenta_id DESC LIMIT %s", (limite,)))
        if len(partes) == 4 and partes[:2] == ["api", "cuentas"] and partes[3] == "extracto":
            return self._responder(200, consultar(
                "SELECT * FROM api.v_extracto WHERE cuenta_id = %s ORDER BY id DESC LIMIT 100",
                (int(partes[2]),)))
        self._responder(404, {"error": "ruta no encontrada"})

    def _post(self):
        if urlparse(self.path).path != "/api/transacciones":
            return self._responder(404, {"error": "ruta no encontrada"})
        largo = int(self.headers.get("Content-Length", 0))
        d = json.loads(self.rfile.read(largo) or b"{}")
        origen = int(d["origen"]) if d.get("origen") not in (None, "") else None
        destino = int(d["destino"]) if d.get("destino") not in (None, "") else None
        fila = consultar(
            "SELECT api.registrar_transaccion(%s, %s, %s, %s, %s::numeric) AS id",
            (d["clave"], d["tipo"], origen, destino, str(d["monto"])))
        self._responder(201, {"transaccion_id": fila[0]["id"]})

    def log_message(self, formato, *args):
        sys.stderr.write("[web] " + formato % args + "\n")


def main():
    global POOL
    POOL = ThreadedConnectionPool(1, 8, **DSN)
    puerto = int(os.getenv("LAB_WEB_PUERTO", "8080"))
    print(f"Lab Banco en http://localhost:{puerto}")
    ThreadingHTTPServer(("0.0.0.0", puerto), Manejador).serve_forever()


if __name__ == "__main__":
    main()
