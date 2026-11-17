"""Borra y recrea esquemas, tablas, funciones, vistas e indices.

Tambien crea (o actualiza) el rol de login `lab_api` que usa el backend. Su contrasena
viene de LAB_API_PASSWORD y nunca se escribe en un archivo SQL.
"""
import os
import sys

from config import RAIZ, conectar


def main():
    clave_api = os.getenv("LAB_API_PASSWORD")
    if not clave_api:
        sys.exit("Define LAB_API_PASSWORD en .env (contrasena del rol lab_api).")

    scripts = sorted((RAIZ / "sql").glob("[0-9][0-9]_*.sql"))
    conn = conectar(autocommit=True)
    with conn.cursor() as cur:
        cur.execute("DROP SCHEMA IF EXISTS api, auditoria, seguridad, nucleo CASCADE")
        for ruta in scripts:
            print(f"-> {ruta.name}")
            cur.execute(ruta.read_text(encoding="utf-8"))

        # Rol del backend: sin superusuario, sin crear roles/BD, solo hereda rol_lab_app.
        cur.execute("SELECT 1 FROM pg_roles WHERE rolname = 'lab_api'")
        verbo = "ALTER" if cur.fetchone() else "CREATE"
        cur.execute(f"{verbo} ROLE lab_api LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD %s", (clave_api,))
        cur.execute("GRANT rol_lab_app TO lab_api")
        cur.execute("SELECT current_database()")
        base = cur.fetchone()[0]
        cur.execute(f'GRANT CONNECT ON DATABASE "{base}" TO lab_api')
        # Con el work_mem por defecto (4 MB) los ordenamientos de 1 millon de filas se derraman a disco:
        # la consulta a05 pasa de 8,7 s a 4,1 s con 64 MB (docs/RENDIMIENTO.md). Solo se usa cuando una consulta lo necesita.
        cur.execute(f'ALTER DATABASE "{base}" SET work_mem = \'64MB\'')
        # Los reportes por "dia" se calculan en hora de Colombia, no en la zona del servidor.
        cur.execute(f'ALTER DATABASE "{base}" SET timezone = \'America/Bogota\'')
    conn.close()
    print("Base reconstruida.")


if __name__ == "__main__":
    main()
