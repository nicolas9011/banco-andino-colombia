"""Mide el tiempo de las 30 consultas de sql/consultas/consultas.sql y guarda evidencia/benchmark.json."""
import argparse
import json
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))
from config import RAIZ, conectar  # noqa: E402
from consultas import leer_consultas  # noqa: E402


def percentil(valores, p):
    ordenados = sorted(valores)
    return ordenados[min(len(ordenados) - 1, int(len(ordenados) * p))]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repeticiones", type=int, default=3)
    ap.add_argument("--nivel", choices=["basica", "intermedia", "avanzada"])
    args = ap.parse_args()

    conn = conectar(autocommit=True)
    informe = {}
    with conn.cursor() as cur:
        cur.execute("SET statement_timeout = 0")
        for c in leer_consultas(args.nivel):
            tiempos, filas = [], 0
            for _ in range(args.repeticiones):
                t0 = time.perf_counter()
                cur.execute(c["sql"])
                filas = len(cur.fetchall())
                tiempos.append((time.perf_counter() - t0) * 1000)
            informe[c["nombre"]] = {"nivel": c["nivel"], "filas": filas,
                                    "mediana_ms": round(percentil(tiempos, 0.5), 1), "max_ms": round(max(tiempos), 1)}
            print(f"{c['nombre']:52s} {c['nivel']:10s} filas={filas:5d} mediana={informe[c['nombre']]['mediana_ms']:9.1f} ms")
    conn.close()

    (RAIZ / "evidencia").mkdir(exist_ok=True)
    (RAIZ / "evidencia" / "benchmark.json").write_text(json.dumps(informe, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
