# Banco Andino Colombia

Aplicación web bancaria sobre PostgreSQL: **frontend React → API Express → PostgreSQL** (la base es la fuente de verdad). Contabilidad de doble partida, transacciones inmutables, idempotencia, auditoría, RBAC real en el backend, ATM independiente y Bre-B **simulado** (no se conecta a ninguna red real).

> Todos los datos son sintéticos (semilla `20260909`). Ningún dato real, ninguna integración bancaria real.

## 1. Requisitos
- PostgreSQL 18 (probado en 18.6) con un usuario capaz de crear roles y bases.
- Node.js 24+ y npm.
- Python 3.12+ con `psycopg` (ver `requirements.txt`).
- Windows/PowerShell (los scripts de orquestación son `.ps1`; los demás pasos son multiplataforma).

## 2. Instalación
```bash
npm --prefix backend install
npm --prefix frontend install
pip install -r requirements.txt
```

## 3. Configuración
Copia `.env.example` a `.env` y completa los valores (nunca se sube `.env`): credenciales de administración de PostgreSQL, `LAB_API_PASSWORD` (rol de login del backend, sin superusuario), `JWT_SECRET` (32+ caracteres aleatorios), `CARD_PEPPER`, `SEED_PASSWORD` y `SEED_PIN` (contraseña y PIN de los usuarios de prueba).

## 4. Base de datos
```bash
powershell -File scripts/preparar_base.ps1            # completo: 10.000 clientes / 50.000 cuentas / 1.000.000 de transacciones
powershell -File scripts/preparar_base.ps1 -Rapido    # 500 / 2.500 / 50.000, para pruebas
```
Pasos: reconstruir esquema → usuarios del personal → carga masiva (COPY) → clientes de demostración → cierre diario del historial → 58 controles de calidad de datos. Esquemas: `nucleo` (datos), `auditoria`, `seguridad` (usuarios, roles, sesiones) y `api` (funciones y vistas `SECURITY DEFINER`, única puerta de entrada del backend).

## 5. Backend
```bash
npm --prefix backend run dev        # http://localhost:3000  (API en /api)
```
Express 5 + TypeScript estricto, validación con zod, JWT HS256 con `jti` revocable en base de datos, helmet, CORS restringido, rate limiting en login, errores sin detalles técnicos. Detalle en `docs/API.md`.

## 6. Frontend
```bash
npm --prefix frontend run dev       # http://localhost:5173
```
React 19 + Vite + Tailwind. Portal de cliente, ventanilla (cajero), administración/auditoría y simulador de ATM en `/atm`. Los menús ocultan lo no permitido, pero **la autorización real la hace el backend**.

## 7. Usuarios de prueba
La contraseña es `SEED_PASSWORD` y el PIN `SEED_PIN` de tu `.env`.

| Usuario | Rol |
|---|---|
| `admin1` | ADMIN |
| `auditor1` | AUDITOR |
| `cajero1` … `cajero6` | CAJERO |
| `cliente1`, `cliente2` | CLIENTE (cliente1 tiene tarjeta ATM; el número lo imprime el seed) |

## 8. Roles y permisos
24 permisos agrupados en 4 roles; la matriz es editable por el ADMIN (`/admin/roles`) y se valida en cada petición.
- **ADMIN:** gestión de usuarios, roles, cierres, consultas y estadísticas.
- **CAJERO:** clientes, cuentas, depósitos, retiros, transferencias y reversos de ventanilla.
- **AUDITOR:** solo lectura (bitácora, conciliación, cierres); no opera.
- **CLIENTE:** sus propias cuentas, transferencias, llaves Bre-B simuladas; nunca ve datos ajenos.

## 9. Endpoints
Listado completo con permisos, entradas y errores en [`docs/API.md`](docs/API.md). Operaciones monetarias exigen cabecera `Idempotency-Key`.

## 10. Pruebas
```bash
python -X utf8 tests/ejecutar_pruebas.py     # 117 pruebas SQL/Python (dinero, integridad, seguridad, concurrencia, consultas, cierre)
npm --prefix backend test                    # 60 pruebas de API (autenticación, RBAC permitido/denegado, dinero, concurrencia, idempotencia, auditoría)
npm --prefix frontend test                   # 14 pruebas de interfaz
python -X utf8 src/compuertas.py             # 58 controles de calidad de datos
```
Rendimiento: `npm --prefix backend run latencia` y `python -X utf8 src/rendimiento.py` (EXPLAIN ANALYZE, BUFFERS antes/después; resultados en `docs/RENDIMIENTO.md` y `evidencia/explain/`).

## 11. Quality Gates
`python -X utf8 src/gates.py` calcula G0–G8 con evidencia y escribe [`docs/GATES.md`](docs/GATES.md). Un gate es PASS solo si todos sus criterios pasan; si algo no se pudo ejecutar queda INCOMPLETO. Las 30 consultas SQL (10 básicas, 10 intermedias, 10 avanzadas) están en `sql/consultas/consultas.sql`.

## 12. Revisión ECC
Revisión por agentes especializados (seguridad, base de datos, TypeScript, React, Python) en dos pasadas; cada hallazgo se verificó contra el código antes de corregirse. Informes en `evidencia/ecc/`. Un "PASS" del revisor no se toma como evidencia: se reconstruyó la base y se volvieron a ejecutar todas las suites tras las correcciones.

## 13. Arquitectura
Resumen en [`docs/ARQUITECTURA.md`](docs/ARQUITECTURA.md); reglas de dominio en [`docs/DOMINIO.md`](docs/DOMINIO.md); modelo de amenazas en [`docs/SEGURIDAD.md`](docs/SEGURIDAD.md); guion de defensa en [`docs/DEFENSA.md`](docs/DEFENSA.md).

### Limitaciones declaradas
- Bre-B es una simulación local, claramente rotulada en la interfaz.
- El ATM es una pantalla web de práctica; no controla hardware.
- No se ha probado con más de una instancia del backend ni con carga sostenida más allá de `latencia`/`simulador_carga`.
