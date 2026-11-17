import type { Request } from 'express';
import { Router } from 'express';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { one, withTx } from '../db';
import { AppError } from '../errors';
import { baseTx, CUENTAS_DEL_CLIENTE, esTitular } from '../lib/access';
import {
  actorDe, claveIdempotencia, conceptoSchema, fechaSchema, idSchema, listarPaginado, montoSchema, paginar, parse, tienePermiso,
} from '../lib/http';
import { authenticate, denegar, requirePermission, requireWeb } from '../middleware/auth';

export const transactionsRouter = Router();
transactionsRouter.use(authenticate, requireWeb);

const SELECT_TX = 'SELECT * FROM api.v_transacciones';

const listaSchema = z.object({
  tipo: z.enum(['deposito', 'retiro', 'transferencia', 'debito', 'credito', 'ajuste', 'reverso']).optional(),
  canal: z.enum(['web', 'cajero', 'atm', 'brebe', 'sistema']).optional(),
  cuentaId: idSchema.optional(),
  actorId: idSchema.optional(),
  desde: fechaSchema.optional(),
  hasta: fechaSchema.optional(),
});

/** El personal con tx:read ve todo; un cliente (tx:read_own) solo lo de sus cuentas. */
function esPersonal(req: Request): boolean {
  if (tienePermiso(req, 'tx:read')) return true;
  if (!tienePermiso(req, 'tx:read_own')) throw new AppError(403, 'SIN_PERMISO', 'No tienes permiso para realizar esta accion.');
  return false;
}

transactionsRouter.get('/', requirePermission('tx:read', 'tx:read_own'), async (req, res) => {
  const f = parse(listaSchema, req.query);
  const { limit, offset } = paginar(req);
  const p: unknown[] = [];
  const where: string[] = [];
  const personal = esPersonal(req);

  // Origen de filas: todas, o solo las de una cuenta / las cuentas del cliente (dos busquedas por indice, sin OR)
  let base = 'api.v_tx_base';
  if (f.cuentaId) {
    if (!personal && !(await withTx(null, (c) => esTitular(c, req.auth!.clienteId, f.cuentaId!)))) {
      throw new AppError(404, 'NO_ENCONTRADO', 'Cuenta no encontrada.');
    }
    p.push(f.cuentaId);
    base = baseTx(`SELECT $${p.length}::bigint`);
  } else if (!personal) {
    p.push(req.auth!.clienteId ?? 0);
    base = baseTx(CUENTAS_DEL_CLIENTE(p.length));
  }
  if (f.tipo) { p.push(f.tipo); where.push(`tipo = $${p.length}`); }
  if (f.canal) { p.push(f.canal); where.push(`canal = $${p.length}`); }
  if (f.actorId) { p.push(f.actorId); where.push(`actor_usuario_id = $${p.length}`); }
  if (f.desde) { p.push(f.desde); where.push(`creado_en >= $${p.length}`); }
  if (f.hasta) { p.push(f.hasta); where.push(`creado_en < $${p.length}`); }
  res.json(await listarPaginado({
    from: 'api.v_transacciones', base, where, params: p,
    order: 'creado_en DESC, id', orderDetalle: 'd.creado_en DESC, d.id', limit, offset,
  }));
});

// Comprobante de una transaccion (usado tambien por el cajero para imprimir).
transactionsRouter.get('/:id', requirePermission('tx:read', 'tx:read_own'), async (req, res) => {
  const id = String(req.params.id);
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new AppError(400, 'VALIDACION', 'Identificador invalido.');
  const personal = esPersonal(req);
  const tx = await withTx(null, async (c) => {
    const t = await one(c, `${SELECT_TX} WHERE id = $1`, [id]);
    if (!t || personal) return t;
    // Un cliente solo ve transacciones de cuentas suyas (origen o destino)
    const mia = (await esTitular(c, req.auth!.clienteId, t.cuenta_debito)) || (await esTitular(c, req.auth!.clienteId, t.cuenta_credito));
    return mia ? t : undefined;
  });
  if (!tx) throw new AppError(404, 'NO_ENCONTRADO', 'Transaccion no encontrada.');
  res.json(tx);
});

/** Ejecuta una operacion de dinero y devuelve el comprobante. */
async function operar(req: Request, fn: (c: PoolClient) => Promise<string>) {
  const id = await withTx(actorDe(req), fn);
  const comprobante = await withTx(null, (c) => one(c, `${SELECT_TX} WHERE id = $1`, [id]));
  return comprobante;
}

const depositoSchema = z.object({ cuentaId: idSchema, monto: montoSchema, concepto: conceptoSchema });

transactionsRouter.post('/deposit', requirePermission('tx:deposit'), async (req, res) => {
  const b = parse(depositoSchema, req.body);
  const clave = claveIdempotencia(req);
  const tx = await operar(req, async (c) => {
    const r = await one(c, "SELECT api.registrar_transaccion($1,'deposito',NULL,$2,$3,'cajero',$4) AS id",
      [clave, b.cuentaId, b.monto, b.concepto ?? null]);
    return r!.id;
  });
  res.status(201).json(tx);
});

transactionsRouter.post('/withdraw', requirePermission('tx:withdraw'), async (req, res) => {
  const b = parse(depositoSchema, req.body);
  const clave = claveIdempotencia(req);
  const tx = await operar(req, async (c) => {
    const r = await one(c, "SELECT api.registrar_transaccion($1,'retiro',$2,NULL,$3,'cajero',$4) AS id",
      [clave, b.cuentaId, b.monto, b.concepto ?? null]);
    return r!.id;
  });
  res.status(201).json(tx);
});

const transferSchema = z.object({
  origenId: idSchema, destinoId: idSchema, monto: montoSchema, concepto: conceptoSchema,
});

transactionsRouter.post('/transfer', requirePermission('tx:transfer', 'tx:transfer_own'), async (req, res) => {
  const b = parse(transferSchema, req.body);
  const clave = claveIdempotencia(req);
  const porVentanilla = tienePermiso(req, 'tx:transfer'); // personal que mueve dinero ajeno (vs. cliente: solo desde sus cuentas)
  const tx = await operar(req, async (c) => {
    // Un cliente solo puede mover dinero DESDE sus propias cuentas (verificado en el servidor).
    if (!porVentanilla && !(await esTitular(c, req.auth!.clienteId, b.origenId))) {
      throw new AppError(403, 'SIN_PERMISO', 'Solo puedes transferir desde tus propias cuentas.');
    }
    const r = await one(c, "SELECT api.registrar_transaccion($1,'transferencia',$2,$3,$4,$5,$6) AS id",
      [clave, b.origenId, b.destinoId, b.monto, porVentanilla ? 'cajero' : 'web', b.concepto ?? null]);
    return r!.id;
  }).catch(async (e) => {
    if (e instanceof AppError && e.status === 403) await denegar(req, ['propiedad_cuenta_origen']);
    throw e;
  });
  res.status(201).json(tx);
});

const reversoSchema = z.object({
  transaccionId: z.string().uuid(),
  motivo: z.string().trim().min(5, 'motivo de al menos 5 caracteres').max(200),
});

transactionsRouter.post('/reverse', requirePermission('tx:reverse'), async (req, res) => {
  const b = parse(reversoSchema, req.body);
  const clave = claveIdempotencia(req);
  const tx = await operar(req, async (c) => {
    const r = await one(c, 'SELECT api.reversar_transaccion($1,$2,$3) AS id', [clave, b.transaccionId, b.motivo]);
    return r!.id;
  });
  res.status(201).json(tx);
});

const ajusteSchema = z.object({
  cuentaId: idSchema,
  sentido: z.enum(['credito', 'debito']),
  monto: montoSchema,
  concepto: z.string().trim().min(5).max(200),
});

transactionsRouter.post('/adjust', requirePermission('tx:adjust'), async (req, res) => {
  const b = parse(ajusteSchema, req.body);
  const clave = claveIdempotencia(req);
  const tx = await operar(req, async (c) => {
    const abona = b.sentido === 'credito';
    const r = await one(c, "SELECT api.registrar_transaccion($1,'ajuste',$2,$3,$4,'sistema',$5) AS id",
      [clave, abona ? null : b.cuentaId, abona ? b.cuentaId : null, b.monto, b.concepto]);
    return r!.id;
  });
  res.status(201).json(tx);
});
