"""Cierra (CALL api.cerrar_dia) todos los dias anteriores a hoy que tienen movimientos y aun no estan cerrados.

Idempotente: en una operacion real esto lo ejecutaria un proceso nocturno. Si algun dia esta descuadrado
el procedimiento falla con un mensaje claro y este script termina con codigo 1 (nunca se oculta).
"""
import sys
import time

from config import conectar


def main():
    conn = conectar(autocommit=True)
    cur = conn.cursor()
    cur.execute("SET statement_timeout = 0")
    cur.execute("""
        SELECT d::date FROM (
            SELECT DISTINCT (creado_en AT TIME ZONE 'America/Bogota')::date AS d FROM nucleo.movimiento) x(d)
         WHERE d < (now() AT TIME ZONE 'America/Bogota')::date
           AND NOT EXISTS (SELECT 1 FROM nucleo.cierre_diario c WHERE c.fecha = x.d)
         ORDER BY 1""")
    pendientes = [r[0] for r in cur.fetchall()]
    t0, fallos = time.perf_counter(), 0
    for dia in pendientes:
        try:
            cur.execute("CALL api.cerrar_dia(%s)", (dia,))
        except Exception as e:  # noqa: BLE001
            fallos += 1
            print(f"FALLA {dia}: {str(e).splitlines()[0]}")
    cur.execute("SELECT count(DISTINCT fecha), COALESCE(sum(operaciones), 0) FROM nucleo.cierre_diario")
    dias, ops = cur.fetchone()
    print(f"Cierres: {len(pendientes) - fallos} nuevos de {len(pendientes)} pendientes ({time.perf_counter() - t0:.1f}s). "
          f"Total cerrado: {dias} dias, {ops} operaciones.")
    conn.close()
    sys.exit(1 if fallos else 0)


if __name__ == "__main__":
    main()
