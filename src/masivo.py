"""Genera y carga datos SINTETICOS a escala: clientes, cuentas y el libro mayor completo.

    python src/masivo.py                       # 10.000 clientes, 50.000 cuentas, 1.000.000 de transacciones
    python src/masivo.py --clientes 500 --cuentas 2500 --transacciones 50000   # prueba rapida

Reproducible: la misma semilla (SEED, por defecto 20260909) produce archivos identicos byte a byte;
los SHA-256 quedan en evidencia/masivo_hashes.json.

Como funciona (y por que):
  * El generador SIMULA el banco en orden cronologico, de modo que cada saldo nace de movimientos
    reales: ningun retiro supera el saldo disponible, se respetan los limites diarios, las cuentas
    bloqueadas o cerradas dejan de operar, y cada cuenta cerrada termina en saldo cero.
  * Cada transaccion produce dos movimientos (debito y credito) contra otra cuenta del cliente o
    contra la caja del banco: la partida doble cuadra por construccion.
  * La carga usa COPY con session_replication_role = replica (triggers apagados SOLO en esa sesion):
    pasar 1.000.000 de operaciones por las funciones del API tardaria horas. Despues se verifican las
    invariantes con SQL (src/compuertas.py): si algo no cuadra, el gate falla.
  * Historia: 2023-01-02 a 2026-10-06. Todas las cuentas nacen dentro de la ventana, asi que el
    saldo de cada una se explica por completo con sus movimientos.
"""
import argparse
import bisect
import hashlib
import json
import math
import os
import random
import sys
import time
import uuid
from collections import Counter, deque
from datetime import date, timedelta

from config import RAIZ, conectar

# --------------------------------------------------------------------------- constantes
TASA_USD = 4000
INICIO = date(2023, 1, 2)
FIN = date(2026, 10, 6)
ND = (FIN - INICIO).days + 1          # dias de historia (inclusive)
T_FIN = ND * 86400                     # fin exclusivo, en segundos desde INICIO 00:00 (hora Colombia)
INF = 1 << 60
DIAS = [(INICIO + timedelta(days=d)).isoformat() for d in range(ND + 1)]
SALIDA = RAIZ / "datos" / "masivo"

CANALES = ["web", "cajero", "atm", "brebe", "sistema"]
WEB, CAJERO, ATM, BREBE, SISTEMA = range(5)
KINDS = ["deposito", "retiro", "transferencia", "debito", "credito", "ajuste", "reverso"]
DEP, RET, TRF, DEB, CRE, AJU, REV = range(7)
INIT, FINAL = 7, 8

# (departamento, peso aproximado de poblacion, ciudades)
DEPARTAMENTOS = [
    ("Bogota D.C.", 16.0, ["Bogota"]),
    ("Antioquia", 13.0, ["Medellin", "Bello", "Envigado", "Rionegro", "Itagui"]),
    ("Valle del Cauca", 9.0, ["Cali", "Palmira", "Buenaventura", "Tulua"]),
    ("Cundinamarca", 6.0, ["Soacha", "Chia", "Zipaquira", "Facatativa", "Fusagasuga"]),
    ("Atlantico", 5.5, ["Barranquilla", "Soledad", "Malambo"]),
    ("Santander", 4.4, ["Bucaramanga", "Floridablanca", "Giron", "Barrancabermeja"]),
    ("Bolivar", 4.2, ["Cartagena", "Magangue"]),
    ("Cordoba", 3.7, ["Monteria", "Lorica"]),
    ("Narino", 3.5, ["Pasto", "Tumaco"]),
    ("Norte de Santander", 3.1, ["Cucuta", "Ocana"]),
    ("Cauca", 2.9, ["Popayan"]),
    ("Tolima", 2.7, ["Ibague", "Espinal"]),
    ("Magdalena", 2.7, ["Santa Marta", "Cienaga"]),
    ("Boyaca", 2.6, ["Tunja", "Duitama", "Sogamoso"]),
    ("Huila", 2.3, ["Neiva"]),
    ("Meta", 2.1, ["Villavicencio"]),
    ("Cesar", 2.1, ["Valledupar"]),
    ("Caldas", 2.0, ["Manizales"]),
    ("La Guajira", 2.0, ["Riohacha"]),
    ("Risaralda", 1.9, ["Pereira", "Dosquebradas"]),
    ("Sucre", 1.8, ["Sincelejo"]),
    ("Quindio", 1.1, ["Armenia"]),
    ("Choco", 1.0, ["Quibdo"]),
    ("Casanare", 0.8, ["Yopal"]),
    ("Caqueta", 0.8, ["Florencia"]),
    ("Putumayo", 0.7, ["Mocoa"]),
    ("Arauca", 0.6, ["Arauca"]),
    ("Guaviare", 0.2, ["San Jose del Guaviare"]),
    ("Vichada", 0.2, ["Puerto Carreno"]),
    ("San Andres y Providencia", 0.15, ["San Andres"]),
    ("Amazonas", 0.15, ["Leticia"]),
    ("Guainia", 0.1, ["Inirida"]),
    ("Vaupes", 0.1, ["Mitu"]),
]
# Departamentos sin oficina propia -> departamento de la oficina que los atiende.
OFICINA_DE = {
    "Choco": "Risaralda", "Caqueta": "Huila", "Putumayo": "Huila", "Arauca": "Meta", "Casanare": "Meta",
    "Guaviare": "Meta", "Vichada": "Meta", "Guainia": "Meta", "Vaupes": "Meta",
    "San Andres y Providencia": "Bolivar", "Amazonas": "Bogota D.C.",
}

NOMBRES = ["Camila", "Mateo", "Valentina", "Santiago", "Sofia", "Julian", "Daniela", "Andres", "Laura", "Sebastian",
           "Paula", "Felipe", "Natalia", "David", "Juliana", "Nicolas", "Isabela", "Samuel", "Mariana", "Tomas",
           "Carolina", "Jorge", "Luisa", "Carlos", "Maria", "Juan", "Ana", "Diego", "Catalina", "Alejandro",
           "Gabriela", "Camilo", "Manuela", "Esteban", "Alejandra", "Ricardo", "Veronica", "Hector", "Claudia",
           "Oscar", "Angela", "Mauricio", "Diana", "Fernando", "Liliana", "Javier", "Patricia", "Eduardo",
           "Sandra", "Gustavo", "Marcela", "Ivan", "Lorena", "Rafael", "Johana", "Cristian", "Yesenia", "Wilson"]
APELLIDOS = ["Gomez", "Rodriguez", "Martinez", "Lopez", "Garcia", "Hernandez", "Ramirez", "Torres", "Vargas", "Castro",
             "Ortiz", "Rojas", "Moreno", "Jimenez", "Herrera", "Medina", "Aguirre", "Cardona", "Quintero", "Salazar",
             "Mejia", "Restrepo", "Giraldo", "Zapata", "Osorio", "Duque", "Cano", "Bedoya", "Ospina", "Arango",
             "Paz", "Rincon", "Pardo", "Cruz", "Navarro", "Ardila", "Cortes", "Beltran", "Pineda", "Montoya",
             "Villa", "Parra", "Suarez", "Sanchez", "Diaz", "Perez", "Ruiz", "Mendoza", "Acosta", "Valencia"]
EMPRESA_TIPO = ["Comercializadora", "Inversiones", "Distribuciones", "Servicios", "Constructora", "Agroindustrial",
                "Tecnologias", "Transportes", "Importaciones", "Alimentos", "Logistica", "Consultores"]
EMPRESA_SUFIJO = ["S.A.S.", "S.A.S.", "S.A.S.", "Ltda.", "S.A."]
CONCEPTOS = {
    DEP: ["Consignacion en efectivo", "Consignacion nacional", "Abono a cuenta", None, None],
    RET: ["Retiro en efectivo", "Retiro", None],
    TRF: ["Pago de arriendo", "Pago de servicios", "Transferencia entre cuentas", "Pago a proveedor",
          "Mesada", "Pago de cuota", None, None, None],
    DEB: ["Compra con tarjeta", "Cuota de manejo", "Pago de servicios publicos", "Pago de seguro", "Cargo automatico"],
    CRE: ["Pago de nomina", "Abono de intereses", "Pago de honorarios", "Reembolso"],
    AJU: ["Ajuste por conciliacion", "Correccion de saldo por soporte", "Ajuste administrativo"],
}

# Mezcla de operaciones por tipo de producto: [dep, ret, trf, deb, cre, aju, rev]
MEZCLA = {
    "ahorro":    [0.22, 0.20, 0.38, 0.12, 0.055, 0.003, 0.005],
    "corriente": [0.18, 0.15, 0.40, 0.20, 0.050, 0.003, 0.005],
    "nomina":    [0.08, 0.22, 0.30, 0.20, 0.200, 0.003, 0.005],
    "adicional": [0.20, 0.15, 0.40, 0.18, 0.040, 0.003, 0.005],
}
# Canal segun operacion: [(canal, peso)]
CANAL_DE = {
    DEP: [(CAJERO, 78), (SISTEMA, 22)],
    RET: [(ATM, 64), (CAJERO, 36)],
    TRF: [(WEB, 52), (BREBE, 36), (CAJERO, 7), (ATM, 5)],
    DEB: [(SISTEMA, 100)], CRE: [(SISTEMA, 100)], AJU: [(SISTEMA, 100)], REV: [(SISTEMA, 100)],
}

# (mu de ln(pesos), sigma) de los montos en COP
MONTO_LN = {DEP: (math.log(350_000), 1.0), RET: (math.log(180_000), 0.7), TRF: (math.log(220_000), 1.1),
            DEB: (math.log(55_000), 1.0), CRE: (math.log(2_200_000), 0.45), AJU: (math.log(40_000), 0.8),
            INIT: (math.log(1_200_000), 1.2)}


# ------------------------------------------------------------------------------ utilidades
def fmt(c: int) -> str:
    """Centavos enteros -> texto decimal exacto (el dinero nunca pasa por float)."""
    s = "-" if c < 0 else ""
    c = abs(c)
    return f"{s}{c // 100}.{c % 100:02d}"


def ts(t: int) -> str:
    d, s = divmod(t, 86400)
    return f"{DIAS[d]} {s // 3600:02d}:{s // 60 % 60:02d}:{s % 60:02d}-05"


def acum(pesos):
    out = [0.0]
    for p in pesos:
        out.append(out[-1] + p)
    return out


def elegir(rng, items, pesos):
    return rng.choices(items, weights=pesos, k=1)[0]


def dv_nit(base: str) -> int:
    pesos = [3, 7, 13, 17, 19, 23, 29, 37, 41, 43, 47, 53, 59, 67, 71]
    s = sum(int(d) * pesos[i] for i, d in enumerate(reversed(base)))
    r = s % 11
    return r if r < 2 else 11 - r


def uuid_det(rng) -> str:
    return str(uuid.UUID(int=rng.getrandbits(128), version=4))


# --------------------------------------------------------- perfiles de tiempo (dia y hora)
def perfiles_tiempo():
    """Pesos por dia y por hora para cada canal. Producen la estacionalidad que se ve en los datos."""
    base_dia, dia_pago = [], []
    for d in range(ND):
        f = INICIO + timedelta(days=d)
        w = {0: 1.0, 1: 1.0, 2: 1.0, 3: 1.0, 4: 1.1, 5: 0.75, 6: 0.30}[f.weekday()]
        w *= {12: 1.35, 1: 1.10, 6: 1.15, 7: 0.95, 2: 0.95}.get(f.month, 1.0)
        fin_mes = (f + timedelta(days=1)).day == 1
        if f.day in (15, 16) or fin_mes or f.day in (29, 30):
            w *= 1.8
        base_dia.append(w)
        p = 0.05
        if f.day in (14, 15) or fin_mes or f.day in (29, 30):
            p = 1.0
        dia_pago.append(p)
    horas = {
        WEB: [1.0, 0.5, 0.4, 0.4, 0.5, 1.0, 2.0, 4.0, 7.0, 10.0, 12.0, 12.0, 11.0, 10.0, 10.0, 11.0, 12.0, 11.0, 12.0, 12.0, 10.0, 7.0, 4.0, 2.0],
        BREBE: [0.8, 0.4, 0.3, 0.3, 0.4, 0.8, 1.5, 3.0, 5.0, 7.0, 8.0, 10.0, 12.0, 10.0, 8.0, 8.0, 9.0, 10.0, 12.0, 12.0, 9.0, 6.0, 3.0, 1.5],
        ATM: [0.5, 0.3, 0.2, 0.2, 0.3, 0.8, 2.0, 4.0, 6.0, 7.0, 8.0, 9.0, 10.0, 9.0, 8.0, 9.0, 11.0, 12.0, 12.0, 10.0, 8.0, 5.0, 2.5, 1.0],
        CAJERO: [0, 0, 0, 0, 0, 0, 0, 0, 6.0, 12.0, 14.0, 12.0, 8.0, 4.0, 9.0, 12.0, 6.0, 0, 0, 0, 0, 0, 0, 0],
        SISTEMA: [3.0, 5.0, 8.0, 8.0, 5.0, 3.0, 2.0, 2.0, 3.0, 4.0, 5.0, 5.0, 5.0, 5.0, 5.0, 5.0, 5.0, 5.0, 4.0, 4.0, 4.0, 4.0, 3.0, 3.0],
        "pago": [6.0, 8.0, 8.0, 6.0, 4.0, 3.0, 2.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 2.0],
    }
    dias = {}
    for c in (WEB, BREBE, ATM, SISTEMA):
        dias[c] = acum(base_dia)
    # La ventanilla casi no atiende domingos y poco los sabados
    dias[CAJERO] = acum([w * (0.0 if (INICIO + timedelta(days=d)).weekday() == 6 else 1.0) *
                         (0.45 if (INICIO + timedelta(days=d)).weekday() == 5 else 1.0) for d, w in enumerate(base_dia)])
    dias["pago"] = acum(dia_pago)
    return dias, {k: acum(v) for k, v in horas.items()}


class Tiempo:
    def __init__(self, rng):
        self.rng = rng
        self.dias, self.horas = perfiles_tiempo()

    def muestrear(self, perfil, t0, t1):
        """Instante en [t0, t1) con la densidad del perfil (dia y hora)."""
        rng = self.rng
        cd, ch = self.dias[perfil], self.horas[perfil if perfil in self.horas else SISTEMA]
        d0, d1 = t0 // 86400, (t1 - 1) // 86400
        lo, hi = cd[d0], cd[d1 + 1]
        if hi - lo > 1e-9:
            for _ in range(8):
                u = lo + rng.random() * (hi - lo)
                d = min(max(bisect.bisect_right(cd, u) - 1, d0), d1)
                h = min(max(bisect.bisect_right(ch, rng.random() * ch[-1]) - 1, 0), 23)
                t = d * 86400 + h * 3600 + rng.randrange(3600)
                if t0 <= t < t1:
                    return t
        return rng.randrange(t0, t1)


# --------------------------------------------------------------------------- generacion
def generar(args, rng, ctx):
    """Devuelve todo lo necesario para escribir los archivos."""
    n_cli, n_cta, n_tx = args.clientes, args.cuentas, args.transacciones
    tiempo = Tiempo(rng)

    # ---------- clientes
    tipos = ["juridica"] * round(n_cli * 0.12) + ["natural"] * (n_cli - round(n_cli * 0.12))
    rng.shuffle(tipos)
    deptos = [d[0] for d in DEPARTAMENTOS]
    pesos_dep = [d[1] for d in DEPARTAMENTOS]
    ciudades = {d[0]: d[2] for d in DEPARTAMENTOS}
    pesos_dia_vinc = [math.exp(0.0009 * d) for d in range(ND - 10)]    # crecimiento: mas clientes recientes
    cum_vinc = acum(pesos_dia_vinc)
    docs, phones = set(), set()
    clientes = []
    for k in range(n_cli):
        tp = tipos[k]
        dep = elegir(rng, deptos, pesos_dep)
        ciu = rng.choice(ciudades[dep])
        if tp == "natural":
            while True:
                doc = str(rng.randrange(10_000_000, 1_999_999_999))
                if doc not in docs:
                    break
            tdoc = "CE" if rng.random() < 0.02 else "CC"
            nombre = f"{rng.choice(NOMBRES)} {rng.choice(APELLIDOS)} {rng.choice(APELLIDOS)}"
        else:
            while True:
                base = str(rng.randrange(800_000_000, 999_999_999))
                if base not in docs:
                    break
            doc, tdoc = f"{base}-{dv_nit(base)}", "NIT"
            nombre = f"{rng.choice(EMPRESA_TIPO)} {rng.choice(APELLIDOS)} {rng.choice(EMPRESA_SUFIJO)}"
        docs.add(doc if tp == "natural" else doc.split("-")[0])
        while True:
            tel = f"3{rng.randrange(0, 6)}{rng.randrange(0, 10)}{rng.randrange(1_000_000, 9_999_999)}"
            if tel not in phones:
                phones.add(tel)
                break
        dvinc = min(max(bisect.bisect_right(cum_vinc, rng.random() * cum_vinc[-1]) - 1, 0), ND - 11)
        clientes.append({
            "tp": tp, "tdoc": tdoc, "doc": doc, "nombre": nombre, "dep": dep, "ciu": ciu, "tel": tel,
            "dir": f"{rng.choice(['Calle', 'Carrera', 'Avenida', 'Diagonal', 'Transversal'])} {rng.randrange(1, 180)} # {rng.randrange(1, 99)}-{rng.randrange(1, 99)}",
            "dvinc": dvinc, "estado": "activo",
        })
    # Estado del cliente: solo quienes llevan tiempo pueden estar inactivos / bloqueados
    viejos = [k for k, c in enumerate(clientes) if c["dvinc"] <= ND - 150]
    rng.shuffle(viejos)
    n_inac, n_bloq = round(n_cli * 0.03), round(n_cli * 0.01)
    for k in viejos[:n_inac]:
        clientes[k]["estado"] = "inactivo"
    for k in viejos[n_inac:n_inac + n_bloq]:
        clientes[k]["estado"] = "bloqueado"

    # ---------- cuantas cuentas por cliente (cola pesada) y ajuste exacto al total
    cuentas_por = []
    for c in clientes:
        if c["tp"] == "natural":
            n = 1 + int(rng.expovariate(1 / 2.6))
            cuentas_por.append(min(n, 12))
        else:
            cuentas_por.append(min(1 + int(rng.lognormvariate(2.3, 0.9)), 90))
    # los clientes inactivos/bloqueados tienen pocas cuentas
    for k, c in enumerate(clientes):
        if c["estado"] != "activo":
            cuentas_por[k] = min(cuentas_por[k], 3)
    total = sum(cuentas_por)
    while total != n_cta:
        k = rng.randrange(n_cli)
        if total < n_cta and cuentas_por[k] < (90 if clientes[k]["tp"] == "juridica" else 12) and clientes[k]["estado"] == "activo":
            cuentas_por[k] += 1
            total += 1
        elif total > n_cta and cuentas_por[k] > 1:
            cuentas_por[k] -= 1
            total -= 1

    # ---------- cuentas
    prod = ctx["productos"]
    cuentas = []
    for k, c in enumerate(clientes):
        for j in range(cuentas_por[k]):
            if c["tp"] == "natural":
                ptipo = elegir(rng, ["ahorro", "nomina", "corriente", "adicional"], [55, 25, 8, 12])
            else:
                ptipo = elegir(rng, ["corriente", "ahorro", "nomina"], [55, 30, 15])
            usd = rng.random() < 0.07
            if j == 0:
                dabre = c["dvinc"]
            else:
                dabre = min(c["dvinc"] + int(rng.expovariate(1 / 150)), ND - 2)
            if c["estado"] != "activo":
                dabre = min(dabre, ND - 90)
            if c["estado"] == "inactivo":
                estado = "cerrada"
            elif c["estado"] == "bloqueado":
                estado = "bloqueada"
            else:
                estado = elegir(rng, ["activa", "bloqueada", "cerrada", "pendiente"], [90.5, 2.0, 5.0, 2.5])
            if estado == "cerrada" and dabre > ND - 70:
                estado = "activa"
            if estado == "bloqueada" and dabre > ND - 20:
                estado = "activa"
            if c["tp"] == "natural" and ptipo == "adicional" and c["estado"] != "activo":
                ptipo = "ahorro"
            p = prod[ptipo]
            f = TASA_USD if usd else 1
            cuentas.append({
                "cli": k, "ptipo": ptipo, "pid": p["id"], "usd": usd, "dabre": dabre, "estado": estado,
                "sobre": p["sobre"] // f if p["permite_sobre"] else 0,
                "lret": max(p["lret"] // f, 100), "ltr": max(p["ltr"] // f, 100),
            })
    assert len(cuentas) == n_cta
    N = n_cta

    # titularidad y oficina
    por_cliente = {}
    for i, a in enumerate(cuentas):
        por_cliente.setdefault(a["cli"], []).append(i)
    naturales_activos = [k for k, c in enumerate(clientes) if c["tp"] == "natural" and c["estado"] == "activo"]
    for i, a in enumerate(cuentas):
        c = clientes[a["cli"]]
        dep = OFICINA_DE.get(c["dep"], c["dep"])
        a["ofi"] = rng.choice(ctx["oficinas"][dep])
        a["tit"] = "empresarial" if c["tp"] == "juridica" else "individual"
        a["cotit"] = None
        if c["tp"] == "natural" and c["estado"] == "activo" and a["estado"] != "pendiente" and rng.random() < 0.05:
            otro = rng.choice(naturales_activos)
            if otro != a["cli"]:
                a["tit"], a["cotit"] = "conjunta", otro

    # ---------- ventana de actividad de cada cuenta
    A, E, trabajo = [0] * N, [INF] * N, [0] * N     # activacion, fin efectivo, apertura
    cierre_t, cierra = [None] * N, [False] * N
    for i, a in enumerate(cuentas):
        apertura = a["dabre"] * 86400 + rng.randrange(8 * 3600, 20 * 3600)
        trabajo[i] = apertura
        if a["estado"] == "pendiente":
            A[i] = E[i] = -1
            continue
        A[i] = apertura + rng.randrange(60, 7200)
        if a["estado"] == "bloqueada":
            # opera un tiempo y luego se bloquea (al menos 3 dias de actividad)
            E[i] = min(T_FIN - 1, A[i] + max(int(rng.uniform(5, 400) * 86400), 3 * 86400))
        elif a["estado"] == "cerrada":
            lo = A[i] + 20 * 86400
            hi = T_FIN - 3 * 86400
            t_f = rng.randrange(lo, hi) if lo < hi else hi
            cierre_t[i], E[i], cierra[i] = t_f + 60, t_f, True
        if E[i] <= A[i] + 2:
            E[i] = A[i] + 3600

    # ---------- eventos por cuenta: cuantas operaciones tiene cada una
    activas = [i for i in range(N) if A[i] >= 0]
    w = [0.0] * N
    for i in activas:
        vida = max(min(E[i], T_FIN) - A[i], 86400) / 86400
        w[i] = rng.lognormvariate(0, 1.35) * (0.45 if cuentas[i]["usd"] else 1.0) * (vida ** 0.85)
        if rng.random() < 0.06:
            w[i] = 0.0                                   # cuentas "dormidas": solo la consignacion inicial
    fondeadas = [i for i in activas if rng.random() < 0.97]
    fondeada = set(fondeadas)
    n_init = len(fondeadas)
    n_fin = sum(1 for i in range(N) if cierra[i])
    resto = n_tx - n_init - n_fin
    if resto < 0:
        sys.exit("Muy pocas transacciones para el numero de cuentas")
    total_w = sum(w[i] for i in fondeada) or 1.0
    cuota = {i: resto * w[i] / total_w for i in fondeada}
    cnt = {i: int(v) for i, v in cuota.items()}
    faltan = resto - sum(cnt.values())
    for i in sorted(cuota, key=lambda x: (cuota[x] - cnt[x], -x), reverse=True)[:faltan]:
        cnt[i] += 1
    for i in range(N):
        if cierra[i] and i not in fondeada:               # una cuenta que se cierra siempre se fondea
            fondeada.add(i)
            cnt[i] = 0
    # Esto puede sumar unas pocas operaciones estructurales: el total exacto se ajusta al final.

    eventos = []
    for i in sorted(fondeada):
        a = cuentas[i]
        mezcla = MEZCLA[a["ptipo"]]
        t_ini = A[i] + rng.randrange(120, 3600)
        eventos.append((t_ini, i, INIT, elegir(rng, [CAJERO, SISTEMA], [70, 30])))
        t0, t1 = t_ini + 60, E[i] if E[i] < INF else T_FIN
        if t1 <= t0 + 10:
            t1 = t0 + 10
        for _ in range(cnt.get(i, 0)):
            k = elegir(rng, range(7), mezcla)
            canales = CANAL_DE[k]
            if a["usd"]:
                canales = [(c, p) for c, p in canales if c not in (ATM, BREBE)] or canales
            canal = elegir(rng, [c for c, _ in canales], [p for _, p in canales])
            perfil = "pago" if (k == CRE and a["ptipo"] == "nomina") else canal
            eventos.append((tiempo.muestrear(perfil, t0, t1), i, k, canal))
        if cierra[i]:
            eventos.append((E[i], i, FINAL, CAJERO))
    # Exactitud del total: recortar o completar con consignaciones sobre cuentas activas al final
    eventos.sort()
    while len(eventos) > n_tx:
        # recorta el evento no estructural mas reciente (nunca init/final)
        for pos in range(len(eventos) - 1, -1, -1):
            if eventos[pos][2] < INIT:
                del eventos[pos]
                break
    while len(eventos) < n_tx:
        i = rng.choice(fondeadas)
        t0 = A[i] + 3600
        t1 = E[i] if E[i] < INF else T_FIN
        eventos.append((tiempo.muestrear(SISTEMA, t0, max(t1, t0 + 10)), i, DEP, SISTEMA))
        eventos.sort()
    return {"clientes": clientes, "cuentas": cuentas, "eventos": eventos, "A": A, "E": E, "apertura": trabajo,
            "cierre_t": cierre_t, "cierra": cierra, "fondeada": fondeada, "tiempo": tiempo}


# ----------------------------------------------------------------------------- simulacion
def simular(args, rng, g, ctx, ids):
    clientes, cuentas, eventos = g["clientes"], g["cuentas"], g["eventos"]
    A, E, cierra = g["A"], g["E"], g["cierra"]
    N = len(cuentas)
    CAJA = {False: N, True: N + 1}                  # indices de las cajas COP / USD
    bal = [0] * (N + 2)
    usd = [a["usd"] for a in cuentas] + [False, True]
    cuenta_id = [ids["cuenta0"] + i for i in range(N)] + [ctx["caja"]["COP"], ctx["caja"]["USD"]]
    lret = [a["lret"] for a in cuentas] + [0, 0]
    ltr = [a["ltr"] for a in cuentas] + [0, 0]
    sobre = [a["sobre"] if (a["ptipo"] == "corriente" and a["estado"] == "activa" and rng.random() < 0.35) else 0 for a in cuentas]
    sobre += [0, 0]
    llave_t = {}                                    # cuenta -> (t, llave_id)

    # llaves Bre-B: ~28% de los clientes naturales con una cuenta COP activa
    llaves = []
    llave_id = ids["llave0"]
    por_cli = {}
    for i, a in enumerate(cuentas):
        if a["estado"] == "activa" and not a["usd"] and A[i] >= 0:
            por_cli.setdefault(a["cli"], []).append(i)
    for k in sorted(por_cli):
        c = clientes[k]
        if c["tp"] != "natural" or c["estado"] != "activo" or rng.random() > 0.28:
            continue
        i = rng.choice(por_cli[k])
        tipo = elegir(rng, ["celular", "correo", "documento", "alfanumerica"], [45, 25, 10, 20])
        valor = {"celular": c["tel"], "correo": f"{k}@correo-sintetico.test", "documento": c["doc"],
                 "alfanumerica": f"@usuario{k}"}[tipo]
        if tipo == "documento" and not c["doc"].isdigit():
            continue
        creada = min(A[i] + rng.randrange(0, 60 * 86400), T_FIN - 100)
        llaves.append((llave_id, k, i, tipo, valor, creada))
        llave_t[i] = (creada, llave_id)
        llave_id += 1

    # listas ordenadas por activacion para escoger contrapartes
    def lista(pred):
        idx = sorted((i for i in range(N) if A[i] >= 0 and pred(i)), key=lambda i: (A[i], i))
        return idx, [A[i] for i in idx]
    por_act = {False: lista(lambda i: not usd[i]), True: lista(lambda i: usd[i])}
    llaveadas = sorted(llave_t, key=lambda i: (llave_t[i][0], i))
    llaveadas_t = [llave_t[i][0] for i in llaveadas]

    cajeros = ctx["cajeros"] or [None]
    f_tx = open(SALIDA / "transaccion.tsv", "w", encoding="utf-8", newline="\n")
    f_mv = open(SALIDA / "movimiento.tsv", "w", encoding="utf-8", newline="\n")
    f_bo = open(SALIDA / "brebe_operacion.tsv", "w", encoding="utf-8", newline="\n")
    mov_id = ids["mov0"]
    n_op = 0
    dia = -1
    ret_usado, trf_usado = {}, {}
    pool = deque(maxlen=4000)
    reversados = set()
    stats = Counter()
    MIN_C = 100_00                                  # 100 pesos (COP) en centavos
    N_CAJA_COP, N_CAJA_USD = CAJA[False], CAJA[True]

    def monto_base(kind, es_usd):
        mu, sg = MONTO_LN[kind]
        pesos = rng.lognormvariate(mu, sg)
        if es_usd:
            return max(int(round(pesos / TASA_USD * 100)), 100)
        c = max(int(round(pesos / 100)) * 100, 1_000) * 100
        if rng.random() < 0.10:
            c += rng.choice([0, 50]) + rng.randrange(1, 99)
        return c

    def escribir(tipo, deb, cre, monto, t, canal, concepto, actor, rev_de=None):
        nonlocal mov_id, n_op
        n_op += 1
        txid = uuid_det(rng)
        tt = ts(t)
        bal[deb] -= monto
        bal[cre] += monto
        f_tx.write("\t".join([
            txid, f"hist-{n_op:07d}", tipo, "POSTED", fmt(monto), str(cuenta_id[deb]), str(cuenta_id[cre]),
            CANALES[canal], concepto if concepto else "\\N", str(actor) if actor else "\\N", "\\N",
            rev_de if rev_de else "\\N", tt]) + "\n")
        f_mv.write(f"{mov_id}\t{txid}\t{cuenta_id[deb]}\tD\t{fmt(monto)}\t{fmt(bal[deb])}\t{tt}\n")
        f_mv.write(f"{mov_id + 1}\t{txid}\t{cuenta_id[cre]}\tC\t{fmt(monto)}\t{fmt(bal[cre])}\t{tt}\n")
        mov_id += 2
        stats[tipo] += 1
        stats["canal_" + CANALES[canal]] += 1
        return txid

    def actor_de(canal):
        return rng.choice(cajeros) if canal == CAJERO else None

    def disponible(i):
        return bal[i] + sobre[i]

    for (t, i, k, canal) in eventos:
        d = t // 86400
        if d != dia:
            ret_usado.clear()
            trf_usado.clear()
            dia = d
        es_usd = usd[i]
        caja = CAJA[es_usd]
        concepto = None

        if k == INIT:
            monto = monto_base(INIT, es_usd)
            escribir("deposito", caja, i, monto, t, canal, "Consignacion inicial" if rng.random() < 0.7 else None, actor_de(canal))
            continue
        if k == FINAL:
            monto = bal[i]
            assert monto > 0, f"cuenta {i} cerrada sin saldo"
            escribir("debito", i, caja, monto, t, CAJERO, "Cancelacion de producto", actor_de(CAJERO))
            continue

        # ---- operaciones de salida: tope de fondos y limites; si no caben, se convierte en consignacion
        if k in (RET, TRF, DEB):
            monto = monto_base(k, es_usd)
            disp = disponible(i)
            tope = disp * 9 // 10
            if k == RET:
                if canal == ATM and not es_usd:
                    monto = max(monto // 1_000_000 * 1_000_000, 0)
                    monto = min(monto, 150_000_000)
                restante = lret[i] - ret_usado.get(i, 0)
            elif k == TRF:
                restante = ltr[i] - trf_usado.get(i, 0)
            else:
                restante = tope
            monto = min(monto, tope, restante)
            if canal == ATM and k == RET:
                monto = monto // 1_000_000 * 1_000_000
            minimo = 100 if es_usd else MIN_C
            if monto < minimo or (canal == ATM and k == RET and monto < 1_000_000):
                k = DEP
                canal = CAJERO if canal in (ATM, BREBE, WEB) else canal
            elif k == TRF:
                # contraparte: otra cuenta de la misma moneda, activa en ese instante
                es_brebe = canal == BREBE and not es_usd
                dest = None
                if es_brebe:
                    n = bisect.bisect_right(llaveadas_t, t)
                    for _ in range(14):
                        if n == 0:
                            break
                        j = llaveadas[int(n * rng.random() ** 1.5)]
                        if j != i and E[j] > t and A[j] <= t and not usd[j]:
                            dest = j
                            break
                    if dest is None:
                        es_brebe, canal = False, WEB
                if dest is None:
                    lst, tl = por_act[es_usd]
                    n = bisect.bisect_right(tl, t)
                    for _ in range(14):
                        if n == 0:
                            break
                        j = lst[int(n * rng.random() ** 1.5)]
                        if j != i and E[j] > t and A[j] <= t:
                            dest = j
                            break
                if dest is None:
                    k = DEP
                    canal = CAJERO if canal in (ATM, BREBE, WEB) else canal
                else:
                    if canal == ATM and es_usd:
                        canal = WEB
                    concepto = rng.choice(CONCEPTOS[TRF])
                    txid = escribir("transferencia", i, dest, monto, t, canal, concepto, actor_de(canal))
                    trf_usado[i] = trf_usado.get(i, 0) + monto
                    pool.append((txid, i, dest, monto, t))
                    if es_brebe:
                        f_bo.write(f"{txid}\t{llave_t[dest][1]}\ttrue\n")
                    continue
            else:
                tipo = "retiro" if k == RET else "debito"
                concepto = rng.choice(CONCEPTOS[k])
                if k == RET and canal == ATM:
                    concepto = "Retiro en cajero automatico"
                escribir(tipo, i, caja, monto, t, canal if k == RET else SISTEMA, concepto, actor_de(canal if k == RET else SISTEMA))
                if k == RET:
                    ret_usado[i] = ret_usado.get(i, 0) + monto
                continue

        if k == REV:
            elegido = None
            for _ in range(10):
                if not pool:
                    break
                o = pool[rng.randrange(len(pool))]
                txid, deb, cre, monto, to = o
                if txid in reversados or to >= t or t - to > 30 * 86400:
                    continue
                if (deb < N and E[deb] <= t) or (cre < N and E[cre] <= t):
                    continue
                if bal[cre] - monto < MIN_C:          # el destino ya no tiene con que devolver
                    continue
                elegido = o
                break
            if elegido is not None:
                txid, deb, cre, monto, to = elegido
                reversados.add(txid)
                escribir("reverso", cre, deb, monto, t, SISTEMA, "Reverso por solicitud", None, rev_de=txid)
                continue
            k = DEP
            canal = CAJERO

        if k == AJU:
            monto = monto_base(AJU, es_usd)
            if rng.random() < 0.5 and disponible(i) * 9 // 10 > monto:
                escribir("ajuste", i, caja, monto, t, SISTEMA, rng.choice(CONCEPTOS[AJU]), None)
            else:
                escribir("ajuste", caja, i, monto, t, SISTEMA, rng.choice(CONCEPTOS[AJU]), None)
            continue

        if k == CRE:
            escribir("credito", caja, i, monto_base(CRE, es_usd), t, SISTEMA, rng.choice(CONCEPTOS[CRE]), None)
            continue

        # consignacion (incluye las conversiones)
        if canal not in (CAJERO, SISTEMA):
            canal = CAJERO
        monto = monto_base(DEP, es_usd)
        txid = escribir("deposito", caja, i, monto, t, canal, rng.choice(CONCEPTOS[DEP]), actor_de(canal))
        pool.append((txid, caja, i, monto, t))

    f_tx.close()
    f_mv.close()
    f_bo.close()
    # invariantes del propio simulador
    for i in range(N):
        if cierra[i]:
            assert bal[i] == 0, f"cuenta {i} cerrada con saldo {bal[i]}"
        assert bal[i] >= -sobre[i], f"cuenta {i} bajo su sobregiro"
    return {"bal": bal, "llaves": llaves, "n_op": n_op, "stats": stats, "sobre": sobre, "mov_fin": mov_id}


# ------------------------------------------------------------------------------- salida
def escribir_maestros(g, sim, ids, ctx, rng):
    clientes, cuentas = g["clientes"], g["cuentas"]
    A, E = g["A"], g["E"]
    cli0, cta0 = ids["cliente0"], ids["cuenta0"]
    cajeros = ctx["cajeros"] or [None]

    with open(SALIDA / "cliente.tsv", "w", encoding="utf-8", newline="\n") as f:
        for k, c in enumerate(clientes):
            correo = f"{k}@correo-sintetico.test"
            creado = ts(c["dvinc"] * 86400 + 9 * 3600 + (k * 37) % 36000)
            f.write("\t".join([
                str(cli0 + k), c["tp"], c["tdoc"], c["doc"], c["nombre"], correo, c["tel"], c["dep"], c["ciu"],
                c["dir"], c["estado"], DIAS[c["dvinc"]], creado]) + "\n")

    seq0 = ids["numero0"]
    with open(SALIDA / "cuenta.tsv", "w", encoding="utf-8", newline="\n") as f_c, \
         open(SALIDA / "cuenta_titular.tsv", "w", encoding="utf-8", newline="\n") as f_t, \
         open(SALIDA / "evento_cuenta.tsv", "w", encoding="utf-8", newline="\n") as f_e:
        ev = ids["evento0"]

        def evento(cuenta, tipo, motivo, t, datos=None):
            nonlocal ev
            actor = rng.choice(cajeros)
            f_e.write("\t".join([str(ev), str(cuenta), tipo, motivo or "\\N", str(actor) if actor else "\\N",
                                 datos or "\\N", ts(t)]) + "\n")
            ev += 1

        for i, a in enumerate(cuentas):
            cid = cta0 + i
            apertura = g["apertura"][i]
            f_c.write("\t".join([
                str(cid), str(cli0 + a["cli"]), str(a["pid"]), str(a["ofi"]), f"LB-{seq0 + i:010d}",
                "USD" if a["usd"] else "COP", "cliente", a["tit"], a["estado"], fmt(sim["bal"][i]),
                fmt(a["sobre"]), fmt(a["lret"]), fmt(a["ltr"]), DIAS[apertura // 86400], ts(apertura)]) + "\n")
            f_t.write(f"{cid}\t{cli0 + a['cli']}\ttitular\t{ts(apertura)}\n")
            if a["cotit"] is not None:
                f_t.write(f"{cid}\t{cli0 + a['cotit']}\tcotitular\t{ts(apertura)}\n")
            evento(cid, "creacion", None, apertura, '{"producto": "%s"}' % a["ptipo"])
            if a["estado"] != "pendiente":
                evento(cid, "activacion", None, A[i])
            if a["estado"] == "bloqueada":
                evento(cid, "bloqueo", rng.choice(["Sospecha de fraude", "Solicitud del cliente", "Documentacion pendiente"]),
                       E[i], '{"antes": "activa", "despues": "bloqueada"}')
            if a["estado"] == "cerrada":
                evento(cid, "cierre", "Cierre solicitado por el cliente", g["cierre_t"][i],
                       '{"antes": "activa", "despues": "cerrada"}')

    with open(SALIDA / "llave_brebe.tsv", "w", encoding="utf-8", newline="\n") as f:
        for (lid, k, i, tipo, valor, creada) in sim["llaves"]:
            f.write(f"{lid}\t{cli0 + k}\t{cta0 + i}\t{tipo}\t{valor}\tactiva\t{ts(creada)}\n")


TABLAS = [
    ("nucleo.cliente", "id, tipo_persona, tipo_documento, documento, nombre, correo, telefono, departamento, ciudad, direccion, estado, fecha_vinculacion, creado_en", "cliente.tsv"),
    ("nucleo.cuenta", "id, cliente_id, producto_id, oficina_id, numero, moneda, tipo, tipo_titularidad, estado, saldo, sobregiro_autorizado, limite_retiro_diario, limite_transferencia_diaria, fecha_apertura, creado_en", "cuenta.tsv"),
    ("nucleo.cuenta_titular", "cuenta_id, cliente_id, rol, creado_en", "cuenta_titular.tsv"),
    ("nucleo.evento_cuenta", "id, cuenta_id, tipo, motivo, actor_usuario_id, datos, creado_en", "evento_cuenta.tsv"),
    ("nucleo.llave_brebe", "id, cliente_id, cuenta_id, tipo, valor, estado, creado_en", "llave_brebe.tsv"),
    ("nucleo.transaccion", "id, clave_idempotencia, tipo, estado, monto, cuenta_debito, cuenta_credito, canal, concepto, actor_usuario_id, ip, reversa_de, creado_en", "transaccion.tsv"),
    ("nucleo.movimiento", "id, transaccion_id, cuenta_id, sentido, monto, saldo_posterior, creado_en", "movimiento.tsv"),
    ("nucleo.brebe_operacion", "transaccion_id, llave_destino_id, es_simulacion", "brebe_operacion.tsv"),
]


def contexto(cur):
    cur.execute("SELECT count(*) FROM nucleo.cliente WHERE tipo_documento <> 'SIS'")
    if cur.fetchone()[0]:
        sys.exit("La base ya tiene clientes. Reconstruye primero: python src/reconstruir.py")
    cur.execute("SELECT departamento, array_agg(id ORDER BY id) FROM nucleo.oficina GROUP BY departamento")
    oficinas = {d: ids for d, ids in cur.fetchall()}
    cur.execute("SELECT tipo, id, permite_sobregiro, sobregiro_maximo, limite_retiro_diario, limite_transferencia_diaria "
                "FROM nucleo.producto WHERE activo ORDER BY id")
    productos = {}
    for tipo, pid, perm, sob, lr, lt in cur.fetchall():
        productos.setdefault(tipo, {"id": pid, "permite_sobre": perm, "sobre": int(sob * 100),
                                    "lret": int(lr * 100), "ltr": int(lt * 100)})
    cur.execute("SELECT moneda, id FROM nucleo.cuenta WHERE tipo = 'sistema'")
    caja = dict(cur.fetchall())
    cur.execute("SELECT u.id FROM seguridad.usuario u JOIN seguridad.usuario_rol ur ON ur.usuario_id = u.id "
                "JOIN seguridad.rol r ON r.id = ur.rol_id AND r.codigo = 'CAJERO' ORDER BY u.id")
    cajeros = [r[0] for r in cur.fetchall()]
    ids = {}
    for clave, tabla in [("cliente0", "nucleo.cliente"), ("cuenta0", "nucleo.cuenta"), ("evento0", "nucleo.evento_cuenta"),
                         ("llave0", "nucleo.llave_brebe"), ("mov0", "nucleo.movimiento")]:
        cur.execute(f"SELECT coalesce(max(id), 0) + 1 FROM {tabla}")
        ids[clave] = cur.fetchone()[0]
    ids["numero0"] = 1
    return {"oficinas": oficinas, "productos": productos, "caja": caja, "cajeros": cajeros}, ids


def sha256(ruta):
    h = hashlib.sha256()
    with open(ruta, "rb") as f:
        for bloque in iter(lambda: f.read(1 << 20), b""):
            h.update(bloque)
    return h.hexdigest()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--clientes", type=int, default=10_000)
    ap.add_argument("--cuentas", type=int, default=50_000)
    ap.add_argument("--transacciones", type=int, default=1_000_000)
    ap.add_argument("--semilla", type=int, default=int(os.getenv("SEED", "20260909")))
    ap.add_argument("--solo-generar", action="store_true", help="escribe los TSV sin tocar la base de datos")
    args = ap.parse_args()
    if args.cuentas < args.clientes:
        sys.exit("Se necesita al menos una cuenta por cliente")

    SALIDA.mkdir(parents=True, exist_ok=True)
    conn = conectar(autocommit=False)
    cur = conn.cursor()
    ctx, ids = contexto(cur)
    # Con --solo-generar el contexto viene de una base recien reconstruida (ids deterministas)
    rng = random.Random(args.semilla)

    t0 = time.perf_counter()
    print(f"[1/4] Generando poblacion (semilla {args.semilla})...")
    g = generar(args, rng, ctx)
    print(f"      {len(g['clientes'])} clientes, {len(g['cuentas'])} cuentas, {len(g['eventos'])} eventos "
          f"({time.perf_counter() - t0:.1f}s)")
    print("[2/4] Simulando el libro mayor en orden cronologico...")
    sim = simular(args, rng, g, ctx, ids)
    escribir_maestros(g, sim, ids, ctx, rng)
    print(f"      {sim['n_op']} transacciones, {2 * sim['n_op']} movimientos ({time.perf_counter() - t0:.1f}s)")

    hashes = {t[2]: sha256(SALIDA / t[2]) for t in TABLAS}
    (RAIZ / "evidencia").mkdir(exist_ok=True)
    (RAIZ / "evidencia" / "masivo_hashes.json").write_text(
        json.dumps({"semilla": args.semilla, "sha256": hashes}, indent=2), encoding="utf-8")
    if args.solo_generar:
        print("Archivos escritos en datos/masivo (sin cargar).")
        return

    print("[3/4] Cargando con COPY (triggers apagados solo en esta sesion)...")
    cur.execute("SET session_replication_role = replica")
    for tabla, cols, archivo in TABLAS:
        with open(SALIDA / archivo, "r", encoding="utf-8") as fh:
            cur.copy_expert(f"COPY {tabla} ({cols}) FROM STDIN", fh)
        print(f"      {tabla}")
    n = len(g["cuentas"])
    N = n
    for moneda, idx in (("COP", N), ("USD", N + 1)):
        cur.execute("UPDATE nucleo.cuenta SET saldo = %s WHERE id = %s", (fmt(sim["bal"][idx]), ctx["caja"][moneda]))
    cur.execute("SET session_replication_role = DEFAULT")

    for seq, tabla in [("nucleo.cliente_id_seq", "nucleo.cliente"), ("nucleo.cuenta_id_seq", "nucleo.cuenta"),
                       ("nucleo.evento_cuenta_id_seq", "nucleo.evento_cuenta"),
                       ("nucleo.llave_brebe_id_seq", "nucleo.llave_brebe"), ("nucleo.movimiento_id_seq", "nucleo.movimiento")]:
        cur.execute(f"SELECT setval('{seq}', (SELECT max(id) FROM {tabla}))")
    cur.execute("SELECT setval('nucleo.seq_numero_cuenta', %s)", (ids["numero0"] + n - 1,))
    # Rastro de auditoria de la carga (la carga masiva no pasa por los triggers de auditoria)
    cur.execute(
        "INSERT INTO auditoria.evento (tabla, operacion, usuario, resultado, despues) "
        "VALUES ('nucleo.*', 'CARGA_MASIVA', session_user, 'OK', %s::jsonb)",
        (json.dumps({"semilla": args.semilla, "clientes": len(g["clientes"]), "cuentas": n,
                     "transacciones": sim["n_op"], "sha256": hashes}),))
    conn.commit()
    cur.execute("ANALYZE")
    conn.commit()
    print(f"[4/4] Listo en {time.perf_counter() - t0:.1f}s. Verifica con: python src/compuertas.py")
    conn.close()


if __name__ == "__main__":
    main()
