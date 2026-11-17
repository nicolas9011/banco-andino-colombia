import { Router } from 'express';
import { z } from 'zod';
import { rows, one, withTx } from '../db';
import { AppError } from '../errors';
import { actorDe, idParam, listarPaginado, paginar, parse, tienePermiso } from '../lib/http';
import { authenticate, requirePermission } from '../middleware/auth';

export const customersRouter = Router();
customersRouter.use(authenticate);

const listaSchema = z.object({
  q: z.string().trim().max(60).optional(),
  estado: z.enum(['activo', 'inactivo', 'bloqueado']).optional(),
  tipoPersona: z.enum(['natural', 'juridica']).optional(),
  departamento: z.string().trim().max(60).optional(),
});

customersRouter.get('/', requirePermission('customers:read'), async (req, res) => {
  const f = parse(listaSchema, req.query);
  const { limit, offset } = paginar(req);
  const where: string[] = [];
  const p: unknown[] = [];
  if (f.q) {
    p.push(`%${f.q.replace(/[%_\\]/g, '\\$&')}%`);
    where.push(`(nombre ILIKE $${p.length} OR documento ILIKE $${p.length})`);
  }
  if (f.estado) { p.push(f.estado); where.push(`estado = $${p.length}`); }
  if (f.tipoPersona) { p.push(f.tipoPersona); where.push(`tipo_persona = $${p.length}`); }
  if (f.departamento) { p.push(f.departamento); where.push(`departamento = $${p.length}`); }
  res.json(await listarPaginado({ from: 'api.v_clientes', where, params: p, order: 'id DESC', limit, offset }));
});

const crearSchema = z.object({
  tipoPersona: z.enum(['natural', 'juridica']).default('natural'),
  tipoDocumento: z.enum(['CC', 'CE', 'TI', 'PAS', 'NIT']).optional(),
  documento: z.string().trim().regex(/^[0-9A-Za-z-]{3,20}$/, 'documento de 3 a 20 caracteres alfanumericos'),
  nombre: z.string().trim().min(2).max(120),
  correo: z.string().trim().email().max(120).optional(),
  telefono: z.string().trim().regex(/^[0-9+() -]{7,20}$/).optional(),
  departamento: z.string().trim().min(2, 'el departamento es obligatorio').max(60),
  ciudad: z.string().trim().min(2, 'la ciudad es obligatoria').max(60),
  direccion: z.string().trim().max(160).optional(),
});

customersRouter.post('/', requirePermission('customers:write'), async (req, res) => {
  const b = parse(crearSchema, req.body);
  const id = await withTx(actorDe(req), async (c) => {
    // registrar_cliente es idempotente por documento; aqui un documento repetido es un error. El candado por documento
    // evita que dos POST simultaneos pasen ambos la comprobacion y el segundo reciba 201 con el cliente ya existente.
    await c.query("SELECT pg_advisory_xact_lock(hashtext('cliente:' || $1))", [b.documento]);
    if (await one(c, 'SELECT 1 FROM api.v_clientes WHERE documento = $1', [b.documento])) {
      throw new AppError(409, 'DUPLICADO', 'Ya existe un cliente con ese documento.');
    }
    const r = await one(c, 'SELECT api.registrar_cliente($1,$2,$3,$4,$5,$6,$7,$8,$9) AS id', [
      b.documento, b.nombre, b.correo ?? null, b.tipoPersona, b.tipoDocumento ?? null,
      b.telefono ?? null, b.departamento, b.ciudad, b.direccion ?? null,
    ]);
    return r!.id as number;
  });
  res.status(201).json({ id });
});

customersRouter.get('/:id', requirePermission('customers:read'), async (req, res) => {
  const id = idParam(req);
  const out = await withTx(null, async (c) => {
    const cliente = await one(c, 'SELECT * FROM api.v_clientes WHERE id = $1', [id]);
    if (!cliente) throw new AppError(404, 'NO_ENCONTRADO', 'Cliente no encontrado.');
    // Los saldos requieren ademas accounts:read: customers:read solo da los datos del cliente (los roles son editables).
    if (!tienePermiso(req, 'accounts:read')) return { ...cliente, cuentas: [] };
    const cuentas = await rows(
      c,
      `SELECT * FROM api.v_saldos WHERE cuenta_id IN
         (SELECT cuenta_id FROM api.v_titulares WHERE cliente_id = $1) ORDER BY cuenta_id`,
      [id],
    );
    return { ...cliente, cuentas };
  });
  res.json(out);
});
