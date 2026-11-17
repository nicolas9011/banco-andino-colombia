import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config';
import { one, rows, withTx } from '../db';
import { AppError } from '../errors';
import { actorDe, claveIdempotencia, montoSchema, parse, pinSchema } from '../lib/http';
import { DUMMY_HASH, hashPassword, hashTarjeta, newSession, verifyPassword } from '../lib/security';
import { authenticate, requireAtm } from '../middleware/auth';
import { loginLimiter } from './auth';

export const atmRouter = Router();

const RETIRO_MINIMO = 10_000;
const RETIRO_MAXIMO_POR_OPERACION = 1_500_000;
const MULTIPLO = 10_000; // denominacion minima del dispensador

const loginSchema = z.object({
  numeroTarjeta: z.string().transform((s) => s.replace(/[\s-]/g, '')).pipe(z.string().regex(/^\d{13,19}$/)),
  pin: z.string().regex(/^\d{4}$/, 'el PIN tiene 4 digitos'),
});

// Insertar tarjeta + PIN. Los fallos de PIN se confirman en base de datos ANTES de responder.
atmRouter.post('/login', loginLimiter, async (req, res) => {
  const { numeroTarjeta, pin } = parse(loginSchema, req.body);
  const actor = { usuarioId: null, rol: 'ATM', ip: req.ip ?? '' };
  const t = await withTx(null, (c) => one(c, 'SELECT * FROM api.obtener_tarjeta($1)', [hashTarjeta(numeroTarjeta)]));
  const pinOk = await verifyPassword(pin, t?.pin_hash ?? DUMMY_HASH);

  const invalida = new AppError(401, 'TARJETA_O_PIN', 'Tarjeta o PIN incorrectos.');
  if (!t) {
    await withTx(actor, (c) =>
      c.query("SELECT api.registrar_auditoria('ATM_LOGIN','nucleo.tarjeta',NULL,'DENEGADO','{\"motivo\":\"tarjeta_desconocida\"}'::jsonb)"));
    throw invalida;
  }
  // El PIN se verifica PRIMERO: el estado de la tarjeta (bloqueada, vencida, cuenta inactiva) solo se revela a quien
  // acierta el PIN; a los demas se les responde igual que a una tarjeta o PIN incorrectos (sin oraculo de estado).
  const impedimento = t.estado !== 'activa'
    ? new AppError(403, 'TARJETA_BLOQUEADA', 'Tarjeta bloqueada. Comunicate con el banco.')
    : new Date(t.vence) < new Date(new Date().toDateString())
      ? new AppError(403, 'TARJETA_VENCIDA', 'Tarjeta vencida.')
      : t.estado_cuenta !== 'activa'
        ? new AppError(403, 'CUENTA_NO_DISPONIBLE', 'La cuenta no esta disponible para operar.')
        : null;
  if (impedimento) throw pinOk ? impedimento : invalida;

  const r = await withTx({ ...actor }, async (c) => {
    const res1 = await one(c, 'SELECT * FROM api.registrar_resultado_pin($1,$2)', [t.tarjeta_id, pinOk]);
    await c.query('SELECT api.registrar_auditoria($1,$2,$3,$4,$5::jsonb)', [
      'ATM_LOGIN', 'nucleo.tarjeta', String(t.tarjeta_id), pinOk ? 'OK' : 'DENEGADO', JSON.stringify({ intentos: res1!.intentos_fallidos }),
    ]);
    return res1!;
  });
  // La base serializa los intentos por tarjeta: si, mientras se calculaba el bcrypt, otras peticiones en paralelo ya
  // bloquearon la tarjeta, aqui r.estado lo refleja. Aunque el PIN sea correcto NO se emite sesion (y la respuesta es
  // la misma que con PIN incorrecto: una rafaga no puede usarse para descubrir el PIN por la diferencia 200/403).
  if (r.estado !== 'activa') {
    throw new AppError(403, 'TARJETA_BLOQUEADA', pinOk ? 'Tarjeta bloqueada. Comunicate con el banco.' : 'PIN incorrecto. Tarjeta bloqueada por intentos fallidos.');
  }
  // Mismo mensaje que "tarjeta inexistente": no confirma que el numero de tarjeta existe.
  if (!pinOk) throw invalida;

  const s = newSession('atm', config.ATM_SESSION_MINUTES);
  await withTx(actor, (c) =>
    c.query('SELECT api.crear_sesion($1,$2,NULL,$3,$4,$5)', [s.jti, 'atm', t.tarjeta_id, s.expira, req.ip ?? null]));
  res.json({ token: s.token, expiraEn: s.expira.toISOString() });
});

atmRouter.use(authenticate, requireAtm);

const CUENTA = 'SELECT * FROM api.v_saldos WHERE cuenta_id = $1';

atmRouter.get('/balance', async (req, res) => {
  const cuenta = await withTx(null, (c) => one(c, CUENTA, [req.auth!.cuentaId]));
  if (!cuenta) throw new AppError(404, 'NO_ENCONTRADO', 'La cuenta de la tarjeta no esta disponible.');
  res.json({
    cuenta: cuenta.numero, moneda: cuenta.moneda,
    saldoContable: cuenta.saldo_contable, saldoDisponible: cuenta.saldo_disponible,
  });
});

atmRouter.get('/movements', async (req, res) => {
  const items = await withTx(null, (c) =>
    rows(c, `SELECT id, tipo, canal, concepto, sentido, monto, saldo_posterior, creado_en
               FROM api.v_extracto WHERE cuenta_id = $1 ORDER BY creado_en DESC, id DESC LIMIT 10`, [req.auth!.cuentaId]));
  res.json({ items });
});

// Monto entero en pesos: numero JSON o texto de solo digitos (z.coerce aceptaria "0x2710" o [10000]).
const retiroSchema = z.object({
  monto: z.union([z.number().int(), z.string().regex(/^\d{1,8}$/, 'monto entero en pesos')]).transform(Number),
});

atmRouter.post('/withdraw', async (req, res) => {
  const { monto } = parse(retiroSchema, req.body);
  if (monto < RETIRO_MINIMO || monto > RETIRO_MAXIMO_POR_OPERACION || monto % MULTIPLO !== 0) {
    throw new AppError(400, 'MONTO_INVALIDO',
      `El monto debe ser multiplo de $${MULTIPLO.toLocaleString('es-CO')} entre $${RETIRO_MINIMO.toLocaleString('es-CO')} y $${RETIRO_MAXIMO_POR_OPERACION.toLocaleString('es-CO')}.`);
  }
  const clave = claveIdempotencia(req);
  const a = req.auth!;
  const out = await withTx(actorDe(req), async (c) => {
    const cta = await one(c, CUENTA, [a.cuentaId]);
    if (!cta) throw new AppError(404, 'NO_ENCONTRADO', 'La cuenta de la tarjeta no esta disponible.');
    if (cta.moneda !== 'COP') throw new AppError(422, 'MONEDA_NO_SOPORTADA', 'Este cajero solo dispensa pesos colombianos.');
    const r = await one(c, "SELECT api.registrar_transaccion($1,'retiro',$2,NULL,$3,'atm',$4) AS id",
      [clave, a.cuentaId, String(monto), `Retiro ATM tarjeta #${a.tarjetaId}`]);
    const tx = await one(c, 'SELECT * FROM api.v_transacciones WHERE id = $1', [r!.id]);
    const nueva = await one(c, CUENTA, [a.cuentaId]);
    return { comprobante: tx, saldoDisponible: nueva!.saldo_disponible, saldoContable: nueva!.saldo_contable };
  });
  res.status(201).json(out);
});

const transferSchema = z.object({
  cuentaDestino: z.string().regex(/^LB-\d{10}$/, 'numero de cuenta con formato LB-0000000000'),
  monto: montoSchema,
});

atmRouter.post('/transfer', async (req, res) => {
  const b = parse(transferSchema, req.body);
  const clave = claveIdempotencia(req);
  const a = req.auth!;
  const out = await withTx(actorDe(req), async (c) => {
    const dest = await one(c, 'SELECT cuenta_id, nombre FROM api.v_saldos WHERE numero = $1', [b.cuentaDestino]);
    if (!dest) throw new AppError(404, 'NO_ENCONTRADO', 'La cuenta destino no existe.');
    const r = await one(c, "SELECT api.registrar_transaccion($1,'transferencia',$2,$3,$4,'atm',$5) AS id",
      [clave, a.cuentaId, dest.cuenta_id, b.monto, `Transferencia ATM tarjeta #${a.tarjetaId}`]);
    const tx = await one(c, 'SELECT * FROM api.v_transacciones WHERE id = $1', [r!.id]);
    const nueva = await one(c, CUENTA, [a.cuentaId]);
    return { comprobante: tx, saldoDisponible: nueva!.saldo_disponible };
  });
  res.status(201).json(out);
});

const cambioPinSchema = z.object({ pinActual: z.string().regex(/^\d{4}$/, 'el PIN tiene 4 digitos'), pinNuevo: pinSchema });

atmRouter.post('/change-pin', async (req, res) => {
  const b = parse(cambioPinSchema, req.body);
  const a = req.auth!;
  if (b.pinActual === b.pinNuevo) throw new AppError(400, 'PIN_IGUAL', 'El PIN nuevo debe ser distinto al actual.');
  const actor = actorDe(req);

  const vigente = await withTx(null, (c) => one(c, 'SELECT api.obtener_pin_hash($1) AS h', [a.tarjetaId]));
  if (!vigente?.h) throw new AppError(403, 'TARJETA_BLOQUEADA', 'Tarjeta bloqueada. Comunicate con el banco.');
  const ok = await verifyPassword(b.pinActual, vigente.h);
  const hashNuevo = ok ? await hashPassword(b.pinNuevo) : null;

  // El resultado del PIN actual se confirma siempre (cuenta intentos); el cambio solo si fue correcto.
  const r = await withTx(actor, async (c) => {
    const estado = await one(c, 'SELECT * FROM api.registrar_resultado_pin($1,$2)', [a.tarjetaId, ok]);
    if (ok) await c.query('SELECT api.cambiar_pin($1,$2)', [a.tarjetaId, hashNuevo]);
    return estado!;
  });
  if (!ok) {
    if (r.estado === 'bloqueada') throw new AppError(403, 'TARJETA_BLOQUEADA', 'PIN incorrecto. Tarjeta bloqueada por intentos fallidos.');
    throw new AppError(401, 'PIN_INCORRECTO', `PIN actual incorrecto. Intentos restantes: ${3 - r.intentos_fallidos}.`);
  }
  res.json({ mensaje: 'PIN actualizado.' });
});

atmRouter.post('/logout', async (req, res) => {
  await withTx(actorDe(req), (c) => c.query('SELECT api.revocar_sesion($1)', [req.auth!.jti]));
  res.status(204).end();
});
