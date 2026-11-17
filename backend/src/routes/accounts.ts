import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { hashPassword, hashTarjeta } from '../lib/security';
import { one, rows, withTx } from '../db';
import { AppError } from '../errors';
import { assertPuedeVerCuenta, filtroTitular } from '../lib/access';
import { actorDe, fechaSchema, idParam, idSchema, listarPaginado, montoNoNegativoSchema, montoSchema, paginar, parse, pinSchema } from '../lib/http';
import { authenticate, requirePermission, requireWeb } from '../middleware/auth';

export const accountsRouter = Router();
accountsRouter.use(authenticate, requireWeb);

const listaSchema = z.object({
  q: z.string().trim().max(30).optional(),
  clienteId: idSchema.optional(),
  oficinaId: idSchema.optional(),
  estado: z.enum(['pendiente', 'activa', 'bloqueada', 'cerrada']).optional(),
  moneda: z.enum(['COP', 'USD']).optional(),
});

accountsRouter.get('/', requirePermission('accounts:read', 'accounts:read_own'), async (req, res) => {
  const f = parse(listaSchema, req.query);
  const { limit, offset } = paginar(req);
  const where: string[] = [];
  const p: unknown[] = [];
  const propio = filtroTitular(req, 1);
  if (propio) { p.push(...propio.params); where.push(propio.sql); }
  if (f.q) { p.push(`%${f.q.replace(/[%_\\]/g, '\\$&')}%`); where.push(`numero ILIKE $${p.length}`); }
  if (f.clienteId) { p.push(f.clienteId); where.push(`cliente_id = $${p.length}`); }
  if (f.oficinaId) { p.push(f.oficinaId); where.push(`oficina_id = $${p.length}`); }
  if (f.estado) { p.push(f.estado); where.push(`estado = $${p.length}`); }
  if (f.moneda) { p.push(f.moneda); where.push(`moneda = $${p.length}`); }
  res.json(await listarPaginado({ from: 'api.v_saldos', where, params: p, order: 'cuenta_id DESC', limit, offset }));
});

const abrirSchema = z.object({
  clienteId: idSchema,
  moneda: z.enum(['COP', 'USD']).default('COP'),
  productoId: idSchema.optional(),
  oficinaId: idSchema.optional(),
  cotitulares: z.array(idSchema).max(3).default([]),
  activar: z.boolean().default(true),
});

accountsRouter.post('/', requirePermission('accounts:write'), async (req, res) => {
  const b = parse(abrirSchema, req.body);
  const id = await withTx(actorDe(req), async (c) => {
    const r = await one(c, 'SELECT api.abrir_cuenta($1,$2,$3,$4,$5::bigint[],$6) AS id', [
      b.clienteId, b.moneda, b.productoId ?? null, b.oficinaId ?? null, b.cotitulares, b.activar,
    ]);
    return r!.id as number;
  });
  res.status(201).json({ id });
});

const maskNombre = (n: string) =>
  n.split(' ').map((w) => w.charAt(0) + '*'.repeat(Math.max(w.length - 1, 2))).join(' ');

// Confirmacion de destinatario antes de transferir: devuelve solo lo minimo, con el nombre oculto.
accountsRouter.get('/lookup', requirePermission('tx:transfer', 'tx:transfer_own'), async (req, res) => {
  const { numero } = parse(z.object({ numero: z.string().regex(/^LB-\d{10}$/, 'formato LB-0000000000') }), req.query);
  const c = await withTx(null, (cl) =>
    one(cl, "SELECT cuenta_id, nombre, moneda, estado FROM api.v_saldos WHERE numero = $1", [numero]));
  if (!c || c.estado !== 'activa') throw new AppError(404, 'NO_ENCONTRADO', 'No encontramos una cuenta activa con ese numero.');
  res.json({ id: c.cuenta_id, numero, moneda: c.moneda, titular: maskNombre(c.nombre) });
});

accountsRouter.get('/:id', requirePermission('accounts:read', 'accounts:read_own'), async (req, res) => {
  const id = idParam(req);
  const out = await withTx(null, async (c) => {
    await assertPuedeVerCuenta(req, c, id);
    const cuenta = await one(c, 'SELECT * FROM api.v_saldos WHERE cuenta_id = $1', [id]);
    if (!cuenta) throw new AppError(404, 'NO_ENCONTRADO', 'Cuenta no encontrada.');
    const titulares = await rows(c, 'SELECT cliente_id, nombre, documento, rol FROM api.v_titulares WHERE cuenta_id = $1', [id]);
    return { ...cuenta, titulares };
  });
  res.json(out);
});

const extractoSchema = z.object({ desde: fechaSchema.optional(), hasta: fechaSchema.optional() });

accountsRouter.get('/:id/statement', requirePermission('accounts:read', 'accounts:read_own'), async (req, res) => {
  const id = idParam(req);
  const f = parse(extractoSchema, req.query);
  const { limit, offset } = paginar(req);
  const p: unknown[] = [id];
  const where = ['cuenta_id = $1'];
  if (f.desde) { p.push(f.desde); where.push(`creado_en >= $${p.length}`); }
  if (f.hasta) { p.push(f.hasta); where.push(`creado_en < $${p.length}`); }
  await withTx(null, (c) => assertPuedeVerCuenta(req, c, id));
  res.json(await listarPaginado({
    from: 'api.v_extracto', base: 'api.v_mov_base', where, params: p,
    order: 'creado_en DESC, id DESC', orderDetalle: 'd.creado_en DESC, d.id DESC', limit, offset,
  }));
});

// Eventos administrativos (activacion, bloqueo, limites...). No son movimientos de dinero.
accountsRouter.get('/:id/events', requirePermission('accounts:read'), async (req, res) => {
  const id = idParam(req);
  const items = await withTx(null, (c) =>
    rows(c, 'SELECT * FROM api.v_eventos_cuenta WHERE cuenta_id = $1 ORDER BY id DESC', [id]),
  );
  res.json({ items });
});

const motivoObligatorio = z.object({ motivo: z.string().trim().min(5, 'motivo de al menos 5 caracteres').max(200) });
const motivoOpcional = z.object({ motivo: z.string().trim().max(200).optional() });

function cambioEstado(destino: 'activa' | 'bloqueada' | 'cerrada', motivoRequerido: boolean) {
  return async (req: import('express').Request, res: import('express').Response) => {
    const id = idParam(req);
    const { motivo } = parse(motivoRequerido ? motivoObligatorio : motivoOpcional, req.body ?? {});
    await withTx(actorDe(req), (c) =>
      c.query('SELECT api.cambiar_estado_cuenta($1, $2, $3)', [id, destino, motivo ?? null]),
    );
    const cuenta = await withTx(null, (c) => one(c, 'SELECT * FROM api.v_saldos WHERE cuenta_id = $1', [id]));
    res.json(cuenta);
  };
}

accountsRouter.post('/:id/activate', requirePermission('accounts:state'), cambioEstado('activa', false));
accountsRouter.post('/:id/unblock', requirePermission('accounts:state'), cambioEstado('activa', false));
accountsRouter.post('/:id/block', requirePermission('accounts:state'), cambioEstado('bloqueada', true));
accountsRouter.post('/:id/close', requirePermission('accounts:state'), cambioEstado('cerrada', true));

// Emision de tarjeta debito (ventanilla). El numero se muestra UNA sola vez; solo se guarda su HMAC.
const tarjetaSchema = z.object({ pin: pinSchema }); // la misma regla de PIN que al cambiarlo en el ATM

function numeroTarjetaSintetico(): string {
  const cuerpo = '400000' + Array.from({ length: 9 }, () => crypto.randomInt(0, 10)).join('');
  let suma = 0;
  [...cuerpo].reverse().forEach((d, i) => {
    let n = Number(d);
    if (i % 2 === 0) { n *= 2; if (n > 9) n -= 9; }
    suma += n;
  });
  return cuerpo + ((10 - (suma % 10)) % 10);
}

accountsRouter.post('/:id/card', requirePermission('accounts:write'), async (req, res) => {
  const id = idParam(req);
  const { pin } = parse(tarjetaSchema, req.body);
  const numero = numeroTarjetaSintetico();
  const pinHash = await hashPassword(pin);
  const tarjetaId = await withTx(actorDe(req), async (c) => {
    const r = await one(c, 'SELECT api.emitir_tarjeta($1,$2,$3,$4,(current_date + 1460)) AS id', [
      id, hashTarjeta(numero), numero.slice(-4), pinHash,
    ]);
    return r!.id as number;
  });
  res.status(201).json({ tarjetaId, numeroTarjeta: numero, aviso: 'Guarda este numero: no se vuelve a mostrar.' });
});

const limitesSchema = z.object({
  retiroDiario: montoSchema,
  transferenciaDiaria: montoSchema,
  sobregiro: montoNoNegativoSchema.optional(),
  motivo: z.string().trim().min(5).max(200),
});

accountsRouter.put('/:id/limits', requirePermission('accounts:limits'), async (req, res) => {
  const id = idParam(req);
  const b = parse(limitesSchema, req.body);
  await withTx(actorDe(req), (c) =>
    c.query('SELECT api.cambiar_limites($1,$2,$3,$4,$5)', [id, b.retiroDiario, b.transferenciaDiaria, b.sobregiro ?? null, b.motivo]),
  );
  res.json(await withTx(null, (c) => one(c, 'SELECT * FROM api.v_saldos WHERE cuenta_id = $1', [id])));
});
