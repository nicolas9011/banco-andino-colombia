import { Router } from 'express';
import { z } from 'zod';
import { one, rows, withTx } from '../db';
import { AppError } from '../errors';
import { actorDe, fechaDiaSchema, fechaSchema, idParam, idSchema, listarPaginado, paginar, parse } from '../lib/http';
import { hashPassword, passwordValida } from '../lib/security';
import { authenticate, requirePermission, requireWeb } from '../middleware/auth';

// ---------------------------------------------------------------- auditoria
export const auditRouter = Router();
auditRouter.use(authenticate, requireWeb);

const auditSchema = z.object({
  tabla: z.string().trim().max(60).optional(),
  registroId: z.string().trim().max(40).optional(),
  usuarioId: idSchema.optional(),
  operacion: z.string().trim().max(30).optional(),
  resultado: z.enum(['OK', 'DENEGADO', 'ERROR']).optional(),
  desde: fechaSchema.optional(),
  hasta: fechaSchema.optional(),
});

// Responde: quien, que, cuando, sobre que registro, valores antes y despues, y con que resultado.
auditRouter.get('/', requirePermission('audit:read'), async (req, res) => {
  const f = parse(auditSchema, req.query);
  const { limit, offset } = paginar(req);
  const where: string[] = [];
  const p: unknown[] = [];
  const add = (cond: string, v: unknown) => { p.push(v); where.push(cond.replace('?', `$${p.length}`)); };
  if (f.tabla) add('tabla = ?', f.tabla);
  if (f.registroId) add('registro_id = ?', f.registroId);
  if (f.usuarioId) add('usuario_app_id = ?', f.usuarioId);
  if (f.operacion) add('operacion = ?', f.operacion);
  if (f.resultado) add('resultado = ?', f.resultado);
  if (f.desde) add('ocurrido_en >= ?', f.desde);
  if (f.hasta) add('ocurrido_en < ?', f.hasta);
  res.json(await listarPaginado({
    from: 'api.v_auditoria a LEFT JOIN api.v_usuarios u ON u.id = a.usuario_app_id', select: 'a.*, u.username',
    where: where.map((w) => 'a.' + w), params: p, order: 'a.id DESC', limit, offset,
  }));
});

// ----------------------------------------------------------------- usuarios
export const usersRouter = Router();
usersRouter.use(authenticate, requireWeb);

usersRouter.get('/', requirePermission('users:read'), async (req, res) => {
  const { limit, offset } = paginar(req);
  const data = await withTx(null, (c) =>
    rows(c, 'SELECT *, count(*) OVER () AS total FROM api.v_usuarios ORDER BY id LIMIT $1 OFFSET $2', [limit, offset]),
  );
  res.json({ total: data[0]?.total ? Number(data[0].total) : 0, items: data.map(({ total, ...r }) => r) });
});

const crearUsuarioSchema = z.object({
  username: z.string().trim().toLowerCase().regex(/^[a-z0-9._-]{3,40}$/, 'usuario de 3 a 40 caracteres: letras, numeros . _ -'),
  password: z.string().refine(passwordValida, 'la contrasena requiere 10+ caracteres con letras y numeros'),
  nombreCompleto: z.string().trim().min(3).max(120),
  correo: z.string().trim().email().max(120).optional(),
  clienteId: idSchema.optional(),
  oficinaId: idSchema.optional(),
  roles: z.array(z.string().regex(/^[A-Z_]{3,30}$/)).min(1).max(4),
});

usersRouter.post('/', requirePermission('users:write'), async (req, res) => {
  const b = parse(crearUsuarioSchema, req.body);
  const hash = await hashPassword(b.password);
  const id = await withTx(actorDe(req), async (c) => {
    const r = await one(c, 'SELECT api.crear_usuario($1,$2,$3,$4,$5,$6,$7::text[]) AS id', [
      b.username, hash, b.nombreCompleto, b.correo ?? null, b.clienteId ?? null, b.oficinaId ?? null, b.roles,
    ]);
    return r!.id as number;
  });
  res.status(201).json({ id });
});

const estadoSchema = z.object({ estado: z.enum(['activo', 'bloqueado', 'inactivo']) });

usersRouter.patch('/:id/status', requirePermission('users:block'), async (req, res) => {
  const id = idParam(req);
  const { estado } = parse(estadoSchema, req.body);
  if (id === req.auth!.usuarioId && estado !== 'activo') {
    throw new AppError(409, 'ESTADO_INVALIDO', 'No puedes bloquear tu propio usuario.');
  }
  await withTx(actorDe(req), (c) => c.query('SELECT api.cambiar_estado_usuario($1,$2)', [id, estado]));
  res.json(await withTx(null, (c) => one(c, 'SELECT * FROM api.v_usuarios WHERE id = $1', [id])));
});

const rolesSchema = z.object({ roles: z.array(z.string().regex(/^[A-Z_]{3,30}$/)).min(1).max(4) });

usersRouter.put('/:id/roles', requirePermission('users:write'), async (req, res) => {
  const id = idParam(req);
  const { roles } = parse(rolesSchema, req.body);
  await withTx(actorDe(req), async (c) => {
    await c.query('SELECT api.asignar_roles_usuario($1,$2::text[])', [id, roles]);
    // Fuerza a reautenticarse: los permisos efectivos cambiaron.
    await c.query('SELECT api.revocar_sesiones_usuario($1)', [id]);
  });
  res.json(await withTx(null, (c) => one(c, 'SELECT * FROM api.v_usuarios WHERE id = $1', [id])));
});

// ------------------------------------------------------------ roles/permisos
export const rolesRouter = Router();

rolesRouter.get('/roles', authenticate, requireWeb, requirePermission('roles:read'), async (_req, res) => {
  res.json({ items: await withTx(null, (c) => rows(c, 'SELECT * FROM api.v_roles ORDER BY id')) });
});

rolesRouter.get('/permissions', authenticate, requireWeb, requirePermission('roles:read'), async (_req, res) => {
  res.json({ items: await withTx(null, (c) => rows(c, 'SELECT * FROM api.v_permisos ORDER BY codigo')) });
});

const permisosSchema = z.object({ permisos: z.array(z.string().regex(/^[a-z_]+:[a-z_]+$/)).max(60) });

rolesRouter.put('/roles/:codigo/permissions', authenticate, requireWeb, requirePermission('roles:write'), async (req, res) => {
  const codigo = String(req.params.codigo);
  if (!/^[A-Z_]{3,30}$/.test(codigo)) throw new AppError(400, 'VALIDACION', 'Codigo de rol invalido.');
  const { permisos } = parse(permisosSchema, req.body);
  await withTx(actorDe(req), (c) => c.query('SELECT api.asignar_permisos_rol($1,$2::text[])', [codigo, permisos]));
  res.json(await withTx(null, (c) => one(c, 'SELECT * FROM api.v_roles WHERE codigo = $1', [codigo])));
});

// ----------------------------------------------------- catalogos y estadisticas
export const catalogRouter = Router();
catalogRouter.use(authenticate, requireWeb);

catalogRouter.get('/offices', requirePermission('accounts:read', 'accounts:write'), async (_req, res) => {
  res.json({ items: await withTx(null, (c) => rows(c, 'SELECT * FROM api.v_oficinas ORDER BY id')) });
});
catalogRouter.get('/products', requirePermission('accounts:read', 'accounts:write'), async (_req, res) => {
  res.json({ items: await withTx(null, (c) => rows(c, 'SELECT * FROM api.v_productos ORDER BY id')) });
});

export const statsRouter = Router();
statsRouter.use(authenticate, requireWeb);

// Cierre diario contable (procedimiento almacenado api.cerrar_dia). Un dia descuadrado se rechaza.
statsRouter.get('/cierres', requirePermission('stats:read'), async (req, res) => {
  const { limit, offset } = paginar(req);
  res.json(await listarPaginado({ from: 'api.v_cierres', where: [], params: [], order: 'fecha DESC, moneda', limit, offset }));
});

const cierreSchema = z.object({ fecha: fechaDiaSchema });

statsRouter.post('/cierres', requirePermission('admin:queries'), async (req, res) => {
  const { fecha } = parse(cierreSchema, req.body);
  await withTx(actorDe(req), (c) => c.query('CALL api.cerrar_dia($1::date)', [fecha]));
  const cierres = await withTx(null, (c) => rows(c, 'SELECT * FROM api.v_cierres WHERE fecha = $1::date ORDER BY moneda', [fecha]));
  res.status(201).json({ items: cierres });
});

// El panel agrega millones de filas (conciliacion ~0,7 s). Se calcula una vez por minuto y se comparte:
// los indicadores no necesitan ser de tiempo real al segundo. Las consultas son SECUENCIALES porque
// comparten un solo cliente de conexion (en paralelo, pg las encola y avisa que esta obsoleto).
const TTL_PANEL_MS = 60_000;
let cachePanel: { en: number; datos: unknown } | null = null;
// Al vencer la cache, las peticiones concurrentes comparten UN solo calculo (si no, cada una retendria una
// conexion del pool ejecutando la consulta pesada: "stampede").
let calculoEnVuelo: Promise<{ en: number; datos: unknown }> | null = null;

async function calcularPanel() {
  const datos = await withTx(null, async (c) => {
    // Consulta analitica (agrega millones de filas): aqui SI conviene el paralelismo.
    await c.query('SET LOCAL max_parallel_workers_per_gather = 2');
    const clientes = await one(c, 'SELECT count(*)::int AS total FROM api.v_clientes');
    const cuentas = await rows(c, 'SELECT estado, moneda, count(*)::int AS cuentas, COALESCE(sum(saldo_contable),0)::text AS saldo FROM api.v_saldos GROUP BY estado, moneda ORDER BY 1,2');
    // Montos solo en pesos: nunca se suman pesos con dolares.
    const hoy = await rows(c, `SELECT tipo, count(*)::int AS operaciones,
                       COALESCE(sum(monto) FILTER (WHERE moneda = 'COP'), 0)::text AS monto
                 FROM api.v_transacciones
                WHERE creado_en >= date_trunc('day', now() AT TIME ZONE 'America/Bogota') AT TIME ZONE 'America/Bogota'
                GROUP BY tipo ORDER BY tipo`);
    const usuarios = await rows(c, 'SELECT estado, count(*)::int AS usuarios FROM api.v_usuarios GROUP BY estado');
    const denegados = await one(c, "SELECT count(*)::int AS total FROM api.v_auditoria WHERE resultado <> 'OK' AND ocurrido_en > now() - interval '24 hours'");
    const conciliacion = await one(c, 'SELECT count(*)::int AS total FROM api.v_conciliacion');
    return {
      clientes: clientes!.total,
      cuentas,
      operacionesHoy: hoy,
      usuarios,
      eventosDenegadosUltimas24h: denegados!.total,
      cuentasDescuadradas: conciliacion!.total,
    };
  });
  return { en: Date.now(), datos };
}

statsRouter.get('/overview', requirePermission('stats:read'), async (_req, res) => {
  if (cachePanel && Date.now() - cachePanel.en < TTL_PANEL_MS) {
    res.json({ ...(cachePanel.datos as object), calculadoEn: new Date(cachePanel.en).toISOString(), desdeCache: true });
    return;
  }
  const propio = !calculoEnVuelo;
  calculoEnVuelo ??= calcularPanel().finally(() => { calculoEnVuelo = null; });
  const r = await calculoEnVuelo;
  cachePanel = r;
  res.json({ ...(r.datos as object), calculadoEn: new Date(r.en).toISOString(), desdeCache: !propio });
});

