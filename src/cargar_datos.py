"""Carga los CSV usando unicamente las funciones del esquema api."""
import csv
from collections import defaultdict
from decimal import Decimal

from config import RAIZ, conectar


def leer(nombre):
    with open(RAIZ / "datos" / nombre, newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def main():
    clientes = leer("clientes.csv")
    por_cliente = defaultdict(list)
    for fila in leer("cuentas.csv"):
        por_cliente[fila["documento"]].append(fila)

    conn = conectar()
    n_cuentas = 0
    with conn.cursor() as cur:
        for cl in clientes:
            # Carga ligera por la API (ejercita las funciones). Para volumen real: src/masivo.py
            cur.execute("SELECT api.registrar_cliente(%s, %s, %s, 'natural', NULL, NULL, 'Bogota D.C.', 'Bogota')",
                        (cl["documento"], cl["nombre"], cl["correo"]))
            cliente_id = cur.fetchone()[0]
            for orden, cu in enumerate(por_cliente[cl["documento"]]):
                cur.execute("SELECT api.abrir_cuenta(%s, %s)", (cliente_id, cu["moneda"]))
                cuenta_id = cur.fetchone()[0]
                n_cuentas += 1
                cur.execute(
                    "SELECT api.registrar_transaccion(%s, 'deposito', NULL, %s, %s)",
                    (f"carga-{cl['documento']}-{orden}", cuenta_id, Decimal(cu["deposito_inicial"])),
                )
    conn.commit()
    conn.close()
    print(f"Cargados {len(clientes)} clientes y {n_cuentas} cuentas con deposito inicial.")


if __name__ == "__main__":
    main()
