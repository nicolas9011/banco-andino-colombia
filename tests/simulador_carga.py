"""Simula transferencias concurrentes y reporta throughput y latencia."""
import argparse
import json
import os
import random
import sys
import threading
import time
import uuid

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))
from config import RAIZ, conectar  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--hilos", type=int, default=8)
    ap.add_argument("--operaciones", type=int, default=100, help="por hilo")
    args = ap.parse_args()

    conn = conectar()
    with conn.cursor() as cur:
        cur.execute("SELECT cuenta_id FROM api.v_saldos WHERE moneda = 'COP' AND saldo > 1000 LIMIT 500")
        cuentas = [f[0] for f in cur.fetchall()]
    conn.close()
    if len(cuentas) < 2:
        sys.exit("Faltan cuentas con saldo: ejecuta generar_datos.py y cargar_datos.py")

    latencias, errores = [], []
    candado = threading.Lock()

    def trabajador(semilla):
        azar = random.Random(semilla)
        c = conectar()
        cur = c.cursor()
        for _ in range(args.operaciones):
            origen, destino = azar.sample(cuentas, 2)
            t0 = time.perf_counter()
            try:
                cur.execute("SELECT api.registrar_transaccion(%s, 'transferencia', %s, %s, 1)",
                            (uuid.uuid4().hex, origen, destino))
                c.commit()
                with candado:
                    latencias.append((time.perf_counter() - t0) * 1000)
            except Exception as e:  # noqa: BLE001
                c.rollback()
                with candado:
                    errores.append(str(e).strip())
        c.close()

    inicio = time.perf_counter()
    hilos = [threading.Thread(target=trabajador, args=(i,)) for i in range(args.hilos)]
    [h.start() for h in hilos]
    [h.join() for h in hilos]
    total = time.perf_counter() - inicio

    latencias.sort()
    informe = {
        "hilos": args.hilos,
        "exitosas": len(latencias),
        "fallidas": len(errores),
        "duracion_s": round(total, 3),
        "tps": round(len(latencias) / total, 1) if total else 0,
        "p50_ms": round(latencias[len(latencias) // 2], 2) if latencias else None,
        "p95_ms": round(latencias[int(len(latencias) * 0.95)], 2) if latencias else None,
    }
    (RAIZ / "evidencia").mkdir(exist_ok=True)
    (RAIZ / "evidencia" / "carga.json").write_text(json.dumps(informe, indent=2), encoding="utf-8")
    print(json.dumps(informe, indent=2))


if __name__ == "__main__":
    main()
