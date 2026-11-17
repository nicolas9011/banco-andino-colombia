"""Configuracion y conexion compartida."""
import os
from pathlib import Path

import psycopg2

RAIZ = Path(__file__).resolve().parents[1]


def _cargar_env():
    ruta = RAIZ / ".env"
    if not ruta.exists():
        return
    for linea in ruta.read_text(encoding="utf-8").splitlines():
        linea = linea.strip()
        if not linea or linea.startswith("#") or "=" not in linea:
            continue
        clave, valor = linea.split("=", 1)
        os.environ.setdefault(clave.strip(), valor.strip())


_cargar_env()

DSN = {
    "host": os.getenv("LAB_DB_HOST", "localhost"),
    "port": int(os.getenv("LAB_DB_PORT", "5432")),
    "dbname": os.getenv("LAB_DB_NAME", "lab_banco"),
    "user": os.getenv("LAB_DB_USER", "postgres"),
    "password": os.getenv("LAB_DB_PASSWORD", "postgres"),
}


def conectar(autocommit=False):
    conn = psycopg2.connect(**DSN)
    conn.autocommit = autocommit
    return conn
