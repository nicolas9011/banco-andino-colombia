"""Lector del catalogo de consultas (sql/consultas/consultas.sql)."""
import re

from config import RAIZ

RUTA = RAIZ / "sql" / "consultas" / "consultas.sql"
NIVELES = ("basica", "intermedia", "avanzada")


def leer_consultas(nivel=None):
    """Devuelve [{nombre, nivel, descripcion, sql}] en el orden del archivo."""
    consultas, actual = [], None
    for linea in RUTA.read_text(encoding="utf-8").splitlines():
        m = re.match(r"^-- (nombre|nivel|descripcion):\s*(.*)$", linea)
        if m:
            campo, valor = m.groups()
            if campo == "nombre":
                if actual:
                    consultas.append(actual)
                actual = {"nombre": valor.strip(), "nivel": None, "descripcion": "", "_sql": []}
            elif actual is not None:
                actual[campo] = valor.strip()
        elif actual is not None and not linea.startswith("-- ====") and not linea.startswith("-- "):
            actual["_sql"].append(linea)
        elif actual is not None and linea.startswith("-- ====") :
            continue
    if actual:
        consultas.append(actual)
    for c in consultas:
        c["sql"] = "\n".join(c.pop("_sql")).strip().rstrip(";").strip()
    return [c for c in consultas if nivel is None or c["nivel"] == nivel]
