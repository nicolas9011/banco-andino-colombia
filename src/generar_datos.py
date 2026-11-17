"""Genera datos sinteticos reproducibles en datos/*.csv."""
import argparse
import csv
import random

from config import RAIZ

NOMBRES = ["Camila", "Mateo", "Valentina", "Santiago", "Sofia", "Julian", "Daniela", "Andres",
           "Laura", "Sebastian", "Paula", "Felipe", "Natalia", "David", "Juliana", "Nicolas",
           "Isabela", "Samuel", "Mariana", "Tomas"]
APELLIDOS = ["Gomez", "Rodriguez", "Martinez", "Lopez", "Garcia", "Hernandez", "Ramirez", "Torres",
             "Vargas", "Castro", "Ortiz", "Rojas", "Moreno", "Jimenez", "Herrera", "Medina"]


def generar(cantidad, semilla):
    azar = random.Random(semilla)
    clientes, cuentas = [], []
    for i in range(cantidad):
        # Cada documento cae en un tramo propio de 7 numeros: nunca se repite.
        documento = str(10_000_000 + i * 7 + azar.randrange(7))
        nombre = f"{azar.choice(NOMBRES)} {azar.choice(APELLIDOS)} {azar.choice(APELLIDOS)}"
        clientes.append((documento, nombre, f"cliente{i}@labbanco.test"))

        for _ in range(azar.choices([1, 2, 3], weights=[60, 30, 10])[0]):
            moneda = azar.choices(["COP", "USD"], weights=[85, 15])[0]
            if moneda == "COP":
                monto = azar.lognormvariate(12.5, 1.0)
            else:
                monto = azar.lognormvariate(6.5, 0.8)
            cuentas.append((documento, moneda, f"{max(monto, 1):.2f}"))
    return clientes, cuentas


def escribir(ruta, cabecera, filas):
    with open(ruta, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(cabecera)
        w.writerows(filas)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--clientes", type=int, default=1000)
    p.add_argument("--semilla", type=int, default=2024)
    args = p.parse_args()

    clientes, cuentas = generar(args.clientes, args.semilla)
    salida = RAIZ / "datos"
    salida.mkdir(exist_ok=True)
    escribir(salida / "clientes.csv", ["documento", "nombre", "correo"], clientes)
    escribir(salida / "cuentas.csv", ["documento", "moneda", "deposito_inicial"], cuentas)
    print(f"{len(clientes)} clientes y {len(cuentas)} cuentas en {salida}")


if __name__ == "__main__":
    main()
