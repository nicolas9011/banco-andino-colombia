"""Ejecuta todas las pruebas y guarda evidencia/informe_pruebas.json."""
import json
import sys
import time
import unittest
from datetime import datetime
from pathlib import Path

AQUI = Path(__file__).resolve().parent
RAIZ = AQUI.parent


def main():
    suite = unittest.defaultTestLoader.discover(str(AQUI), pattern="pruebas_*.py")
    inicio = time.perf_counter()
    resultado = unittest.TextTestRunner(verbosity=2).run(suite)
    informe = {
        "fecha": datetime.now().isoformat(timespec="seconds"),
        "ejecutadas": resultado.testsRun,
        "fallos": len(resultado.failures),
        "errores": len(resultado.errors),
        "duracion_s": round(time.perf_counter() - inicio, 3),
        "omitidas": len(resultado.skipped),
        # Una prueba omitida no demuestra nada: no cuenta como exito.
        "exitoso": resultado.wasSuccessful() and not resultado.skipped,
    }
    (RAIZ / "evidencia").mkdir(exist_ok=True)
    (RAIZ / "evidencia" / "informe_pruebas.json").write_text(
        json.dumps(informe, indent=2, ensure_ascii=False), encoding="utf-8")
    print(json.dumps(informe, indent=2, ensure_ascii=False))
    sys.exit(0 if informe["exitoso"] else 1)


if __name__ == "__main__":
    main()
