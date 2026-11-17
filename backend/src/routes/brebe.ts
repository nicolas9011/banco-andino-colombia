import { Router } from 'express';
import { z } from 'zod';
import { one, rows, withTx } from '../db';
import { AppError } from '../errors';
import { baseTx, CUENTAS_DEL_CLIENTE, esTitular } from '../lib/access';
import { actorDe, claveIdempotencia, conceptoSchema, idParam, idSchema, listarPaginado, montoSchema, paginar, parse } from '../lib/http';
import { authenticate, requirePermission, requireWeb } from '../middleware/auth';

/**
 * Bre-B ACADEMICO: simulacion. No existe conexion con la red real de pagos inmediatos.
 * Usa el mismo motor contable (transferencia con canal 'brebe'), limites y auditoria.
 */
export const brebeRouter = Router();
brebeRouter.use(authenticate, requireWeb, requirePermission('brebe:use'));

function clienteDe(req: import('express').Request): number {
  const id = req.auth!.clienteId;
  if (!id) throw new AppError(403, 'SIN_PERMISO', 'Bre-B solo esta disponible para clientes.');
  return id;
}

const ETIQUETA = { simulacion: true, aviso: 'Bre-B academico: operacion simulada, sin red de pagos real.' };

brebeRouter.get('/keys', async (req, res) => {
  const cliente = clienteDe(req);
  const items = await withTx(null, (c) =>
    rows(c, 'SELECT * FROM api.v_llaves_brebe WHERE cliente_id = $1 ORDER BY id DESC', [cliente]));
  res.json({ ...ETIQUETA, items });
});

const llaveSchema = z.object({
  cuentaId: idSchema,
  tipo: z.enum(['celular', 'correo', 'documento', 'alfanumerica']),
  valor: z.string().trim().min(3).max(80),
});

brebeRouter.post('/keys', async (req, res) => {
  const cliente = clienteDe(req);
  const b = parse(llaveSchema, req.body);
  const id = await withTx(actorDe(req), async (c) => {
    const r = await one(c, 'SELECT api.registrar_llave_brebe($1,$2,$3,$4) AS id', [cliente, b.cuentaId, b.tipo, b.valor]);
    return r!.id as number;
  });
  res.status(201).json({ ...ETIQUETA, id });
});

brebeRouter.delete('/keys/:id', async (req, res) => {
  const cliente = clienteDe(req);
  const id = idParam(req);
  await withTx(actorDe(req), (c) => c.query('SELECT api.desactivar_llave_brebe($1,$2)', [id, cliente]));
  res.status(204).end();
});

// Vista previa para confirmar el destinatario (nombre parcialmente oculto).
brebeRouter.get('/resolve', async (req, res) => {
  const { llave } = parse(z.object({ llave: z.string().trim().min(3).max(80) }), req.query);
  const r = await withTx(null, (c) => one(c, 'SELECT * FROM api.resolver_llave_brebe($1)', [llave]));
  if (!r) throw new AppError(404, 'NO_ENCONTRADO', 'No encontramos esa llave Bre-B.');
  res.json({ ...ETIQUETA, titular: r.titular });
});

const envioSchema = z.object({
  cuentaOrigenId: idSchema,
  llave: z.string().trim().min(3).max(80),
  monto: montoSchema,
  concepto: conceptoSchema,
});

brebeRouter.post('/send', async (req, res) => {
  const cliente = clienteDe(req);
  const b = parse(envioSchema, req.body);
  const clave = claveIdempotencia(req);
  const id = await withTx(actorDe(req), async (c) => {
    if (!(await esTitular(c, cliente, b.cuentaOrigenId))) {
      throw new AppError(403, 'SIN_PERMISO', 'Solo puedes enviar desde tus propias cuentas.');
    }
    const r = await one(c, 'SELECT api.enviar_brebe($1,$2,$3,$4,$5) AS id', [clave, b.cuentaOrigenId, b.llave, b.monto, b.concepto ?? null]);
    return r!.id as string;
  });
  const comprobante = await withTx(null, (c) => one(c, 'SELECT * FROM api.v_transacciones WHERE id = $1', [id]));
  res.status(201).json({ ...ETIQUETA, comprobante });
});

brebeRouter.get('/history', async (req, res) => {
  const cliente = clienteDe(req);
  const { limit, offset } = paginar(req);
  const r = await listarPaginado({
    from: 'api.v_transacciones', base: baseTx(CUENTAS_DEL_CLIENTE(1)), where: ["canal = 'brebe'"], params: [cliente],
    order: 'creado_en DESC, id', orderDetalle: 'd.creado_en DESC, d.id', limit, offset,
  });
  res.json({ ...ETIQUETA, ...r });
});
