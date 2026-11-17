import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { config } from '../config';
import { one, withTx } from '../db';
import { AppError } from '../errors';
import { actorDe, parse } from '../lib/http';
import { DUMMY_HASH, newSession, verifyPassword } from '../lib/security';
import { authenticate, requireWeb } from '../middleware/auth';

export const authRouter = Router();

export const loginLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: config.LOGIN_RATE_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 'DEMASIADAS_SOLICITUDES', message: 'Demasiados intentos. Espera unos minutos.' } },
});

const loginSchema = z.object({
  username: z.string().trim().min(3).max(40),
  password: z.string().min(1).max(200),
});

authRouter.post('/login', loginLimiter, async (req, res) => {
  const { username, password } = parse(loginSchema, req.body);
  const actor = { usuarioId: null, rol: '', ip: req.ip ?? '' };

  const u = await withTx(null, (c) => one(c, 'SELECT * FROM api.auth_usuario($1)', [username]));
  // Siempre se compara un hash, exista o no el usuario (tiempo de respuesta uniforme).
  const ok = await verifyPassword(password, u?.password_hash ?? DUMMY_HASH);

  const auditar = (resultado: 'OK' | 'DENEGADO', motivo: string) =>
    withTx({ ...actor, usuarioId: u?.id ?? null }, (c) =>
      c.query('SELECT api.registrar_auditoria($1, $2, $3, $4, $5::jsonb)', [
        'LOGIN',
        'seguridad.usuario',
        u ? String(u.id) : null,
        resultado,
        JSON.stringify({ username, motivo }),
      ]),
    );

  if (!u) {
    await auditar('DENEGADO', 'usuario_inexistente');
    throw new AppError(401, 'CREDENCIALES', 'Usuario o contrasena incorrectos.');
  }
  const bloqueado = (x: { bloqueado_hasta?: string | null }) => !!x.bloqueado_hasta && new Date(x.bloqueado_hasta) > new Date();

  if (!ok) {
    // Durante un bloqueo temporal la respuesta es identica a la de cualquier contrasena mala (401 generico):
    // asi un 423 no confirma que el usuario existe. Tampoco se siguen contando fallos.
    if (bloqueado(u)) {
      await auditar('DENEGADO', 'intento_durante_bloqueo');
    } else {
      await withTx(null, (c) =>
        c.query('SELECT api.auth_registrar_fallo($1, $2, $3)', [u.id, config.LOGIN_MAX_FAILS, config.LOGIN_LOCK_MINUTES]),
      );
      await auditar('DENEGADO', 'contrasena_incorrecta');
    }
    throw new AppError(401, 'CREDENCIALES', 'Usuario o contrasena incorrectos.');
  }

  // Contrasena correcta: recien ahora se puede revelar el bloqueo. El estado se RELEE despues de bcrypt (cientos de
  // ms): una rafaga de intentos en paralelo habria pasado la comprobacion inicial antes de que se registraran los fallos.
  const actual = (await withTx(null, (c) => one(c, 'SELECT * FROM api.auth_usuario($1)', [username]))) ?? u;
  if (bloqueado(actual)) {
    await auditar('DENEGADO', 'bloqueo_temporal');
    throw new AppError(423, 'BLOQUEO_TEMPORAL', 'Demasiados intentos fallidos. Intenta de nuevo mas tarde.');
  }
  if (actual.estado !== 'activo') {
    await auditar('DENEGADO', `usuario_${actual.estado}`);
    throw new AppError(403, 'USUARIO_BLOQUEADO', 'Tu usuario esta bloqueado. Contacta al banco.');
  }

  const s = newSession('web', config.SESSION_MINUTES);
  const perfil = await withTx({ ...actor, usuarioId: u.id }, async (c) => {
    await c.query('SELECT api.auth_registrar_exito($1)', [u.id]);
    await c.query('SELECT api.crear_sesion($1, $2, $3, NULL, $4, $5)', [s.jti, 'web', u.id, s.expira, req.ip ?? null]);
    await c.query('SELECT api.registrar_auditoria($1, $2, $3, $4, $5::jsonb)', [
      'LOGIN', 'seguridad.usuario', String(u.id), 'OK', JSON.stringify({ username }),
    ]);
    return one(c, 'SELECT * FROM api.cargar_sesion($1)', [s.jti]);
  });

  res.json({ token: s.token, expiraEn: s.expira.toISOString(), usuario: perfilPublico(perfil!) });
});

function perfilPublico(s: any) {
  return {
    id: s.usuario_id,
    username: s.username,
    nombre: s.nombre_completo,
    clienteId: s.cliente_id,
    oficinaId: s.oficina_id,
    roles: s.roles,
    permisos: s.permisos,
  };
}

authRouter.post('/logout', authenticate, async (req, res) => {
  await withTx(actorDe(req), async (c) => {
    await c.query('SELECT api.revocar_sesion($1)', [req.auth!.jti]);
    await c.query('SELECT api.registrar_auditoria($1, $2, $3, $4, NULL)', [
      'LOGOUT', 'seguridad.usuario', String(req.auth!.usuarioId ?? ''), 'OK',
    ]);
  });
  res.status(204).end();
});

authRouter.get('/me', authenticate, requireWeb, (req, res) => {
  const a = req.auth!;
  res.json({
    id: a.usuarioId, username: a.username, nombre: a.nombre, clienteId: a.clienteId,
    oficinaId: a.oficinaId, roles: a.roles, permisos: a.permisos,
  });
});
