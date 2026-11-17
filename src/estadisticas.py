"""Estadisticas de distribucion de los datos sinteticos (evidencia del gate G4).

Demuestra que los datos NO son artificialmente uniformes: concentracion por departamento, cola pesada
de cuentas por cliente y de actividad por cuenta, estacionalidad horaria/semanal/mensual y montos
log-normales. Escribe evidencia/distribuciones.json.
"""
import json
import math

from config import RAIZ, conectar


def q(cur, sql, params=None):
    cur.execute(sql, params or ())
    return cur.fetchall()


def gini(valores):
    v = sorted(valores)
    n, s = len(v), sum(v)
    if not n or not s:
        return 0.0
    return round((2 * sum((i + 1) * x for i, x in enumerate(v)) / (n * s)) - (n + 1) / n, 4)


def chi2_vs_uniforme(conteos):
    """Estadistico chi-cuadrado contra uniformidad y valor critico (alfa = 0.001, Wilson-Hilferty)."""
    n, k = sum(conteos), len(conteos)
    esperado = n / k
    chi = sum((o - esperado) ** 2 / esperado for o in conteos)
    df = k - 1
    z = 3.0902
    critico = df * (1 - 2 / (9 * df) + z * math.sqrt(2 / (9 * df))) ** 3
    return {"chi2": round(chi, 1), "gl": df, "critico_0.001": round(critico, 1), "rechaza_uniformidad": chi > critico}


def pct(valores, p):
    return valores[min(len(valores) - 1, int(len(valores) * p))]


def main():
    conn = conectar()
    cur = conn.cursor()
    out = {}

    out["totales"] = {
        "clientes": q(cur, "SELECT count(*) FROM nucleo.cliente WHERE tipo_documento <> 'SIS'")[0][0],
        "cuentas_cliente": q(cur, "SELECT count(*) FROM nucleo.cuenta WHERE tipo = 'cliente'")[0][0],
        "transacciones": q(cur, "SELECT count(*) FROM nucleo.transaccion")[0][0],
        "movimientos": q(cur, "SELECT count(*) FROM nucleo.movimiento")[0][0],
        "rango_fechas": [str(x) for x in q(cur, "SELECT min(creado_en)::date, max(creado_en)::date FROM nucleo.transaccion")[0]],
    }

    dep = q(cur, "SELECT departamento, count(*) FROM nucleo.cliente WHERE tipo_documento <> 'SIS' GROUP BY 1 ORDER BY 2 DESC")
    out["clientes_por_departamento"] = {"top5": dep[:5], "bottom3": dep[-3:], "n_departamentos": len(dep),
                                         "razon_max_min": round(dep[0][1] / max(dep[-1][1], 1), 1),
                                         "uniformidad": chi2_vs_uniforme([n for _, n in dep])}

    por_cli = [n for _, n in q(cur, "SELECT cliente_id, count(*) FROM nucleo.cuenta WHERE tipo = 'cliente' GROUP BY 1")]
    por_cli.sort()
    out["cuentas_por_cliente"] = {"min": por_cli[0], "mediana": pct(por_cli, 0.5), "p90": pct(por_cli, 0.9),
                                   "p99": pct(por_cli, 0.99), "max": por_cli[-1], "gini": gini(por_cli)}

    act = [n for _, n in q(cur, "SELECT c.id, count(m.id) FROM nucleo.cuenta c LEFT JOIN nucleo.movimiento m ON m.cuenta_id = c.id "
                                 "WHERE c.tipo = 'cliente' GROUP BY 1")]
    act.sort()
    total_mov = sum(act)
    top10 = sum(act[int(len(act) * 0.9):])
    out["actividad_por_cuenta"] = {"cuentas_sin_movimientos": sum(1 for x in act if x == 0), "mediana": pct(act, 0.5),
                                    "p90": pct(act, 0.9), "p99": pct(act, 0.99), "max": act[-1], "gini": gini(act),
                                    "participacion_del_10pct_mas_activo": round(top10 / total_mov, 3)}

    horas = [n for _, n in q(cur, "SELECT extract(hour FROM creado_en AT TIME ZONE 'America/Bogota')::int h, count(*) FROM nucleo.transaccion GROUP BY 1 ORDER BY 1")]
    dias = q(cur, "SELECT extract(isodow FROM creado_en AT TIME ZONE 'America/Bogota')::int d, count(*) FROM nucleo.transaccion GROUP BY 1 ORDER BY 1")
    meses = q(cur, "SELECT extract(month FROM creado_en AT TIME ZONE 'America/Bogota')::int m, count(*) FROM nucleo.transaccion GROUP BY 1 ORDER BY 1")
    dia_mes = q(cur, "SELECT extract(day FROM creado_en AT TIME ZONE 'America/Bogota')::int d, count(*) FROM nucleo.transaccion GROUP BY 1 ORDER BY 1")
    out["horario"] = {"por_hora": horas, "razon_pico_valle": round(max(horas) / max(min(horas), 1), 1), "uniformidad": chi2_vs_uniforme(horas)}
    out["dia_de_semana"] = {"conteos_lun_a_dom": [n for _, n in dias], "uniformidad": chi2_vs_uniforme([n for _, n in dias])}
    out["mes"] = {"conteos_ene_a_dic": [n for _, n in meses], "uniformidad": chi2_vs_uniforme([n for _, n in meses])}
    out["dia_del_mes"] = {"pico_dia": max(dia_mes, key=lambda x: x[1])[0], "uniformidad": chi2_vs_uniforme([n for _, n in dia_mes])}

    montos = {}
    for tipo, p50, p90, p99, mx in q(cur, "SELECT t.tipo, percentile_cont(0.5) WITHIN GROUP (ORDER BY monto), percentile_cont(0.9) WITHIN GROUP (ORDER BY monto), "
                                          "percentile_cont(0.99) WITHIN GROUP (ORDER BY monto), max(monto) FROM nucleo.transaccion t "
                                          "JOIN nucleo.cuenta c ON c.id = t.cuenta_debito OR c.id = t.cuenta_credito "
                                          "WHERE c.moneda = 'COP' AND c.tipo = 'cliente' GROUP BY 1 ORDER BY 1"):
        montos[tipo] = {"p50": float(p50), "p90": float(p90), "p99": float(p99), "max": float(mx)}
    out["montos_cop_por_tipo"] = montos

    out["estados_cuenta"] = dict(q(cur, "SELECT estado, count(*) FROM nucleo.cuenta WHERE tipo = 'cliente' GROUP BY 1 ORDER BY 2 DESC"))
    out["estados_cliente"] = dict(q(cur, "SELECT estado, count(*) FROM nucleo.cliente WHERE tipo_documento <> 'SIS' GROUP BY 1 ORDER BY 2 DESC"))
    out["tipo_persona"] = dict(q(cur, "SELECT tipo_persona, count(*) FROM nucleo.cliente WHERE tipo_documento <> 'SIS' GROUP BY 1"))
    out["tipo_titularidad"] = dict(q(cur, "SELECT tipo_titularidad, count(*) FROM nucleo.cuenta WHERE tipo = 'cliente' GROUP BY 1"))
    out["producto"] = dict(q(cur, "SELECT p.tipo, count(*) FROM nucleo.cuenta c JOIN nucleo.producto p ON p.id = c.producto_id GROUP BY 1 ORDER BY 2 DESC"))
    out["moneda"] = dict(q(cur, "SELECT moneda, count(*) FROM nucleo.cuenta WHERE tipo = 'cliente' GROUP BY 1"))
    out["transacciones_por_tipo"] = dict(q(cur, "SELECT tipo, count(*) FROM nucleo.transaccion GROUP BY 1 ORDER BY 2 DESC"))
    out["transacciones_por_canal"] = dict(q(cur, "SELECT canal, count(*) FROM nucleo.transaccion GROUP BY 1 ORDER BY 2 DESC"))
    out["altas_de_clientes_por_anio"] = dict((int(a), n) for a, n in q(cur, "SELECT extract(year FROM fecha_vinculacion), count(*) FROM nucleo.cliente WHERE tipo_documento <> 'SIS' GROUP BY 1 ORDER BY 1"))

    (RAIZ / "evidencia").mkdir(exist_ok=True)
    (RAIZ / "evidencia" / "distribuciones.json").write_text(json.dumps(out, indent=2, ensure_ascii=False, default=str), encoding="utf-8")
    print(json.dumps(out, indent=2, ensure_ascii=False, default=str))
    conn.close()


if __name__ == "__main__":
    main()
