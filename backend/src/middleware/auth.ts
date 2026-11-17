import type { NextFunction, Request, Response } from 'express';
import { withTx, one } from '../db';
import { AppError } from '../errors';
import { actorDe } from '../lib/http';
import { verifyToken } from '../lib/security';

export interface AuthContext {
  kind: 'web' | 'atm';
  jti: string;
  usuarioId: number | null;
  username: string | null;
  nombre: string | null;
  clienteId: number | null;
  oficinaId: number | null;
  roles: string[];
  permisos: string[];
  tarjetaId: number | null;
  cuentaId: number | null;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      id: string;
      auth?: AuthContext;
    }
  }
}

/**
 * Valida el JWT y despues la sesion en PostgreSQL (revocacion, estado del usuario, roles y
 * permisos VIGENTES). Asi un bloqueo o un cambio de rol surte efecto en la siguiente peticion.
 */
export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  const cab = req.header('Authorization');
  const token = cab?.startsWith('Bearer ') ? cab.slice(7).trim() : '';
  const claims = token ? verifyToken(token) : null;
  if (!claims) throw new AppError(401, 'NO_AUTENTICADO', 'Sesion invalida o vencida. Inicia sesion de nuevo.');

  const s = await withTx(null, (c) => one(c, 'SELECT * FROM api.cargar_sesion($1)', [claims.jti]));
  if (!s || !s.valida) throw new AppError(401, 'NO_AUTENTICADO', 'Sesion invalida o vencida. Inicia sesion de nuevo.');

  req.auth = {
    kind: claims.typ,
    jti: claims.jti,
    usuarioId: s.usuario_id,
    username: s.username,
    nombre: s.nombre_completo,
    clienteId: s.cliente_id,
    oficinaId: s.oficina_id,
    roles: s.roles ?? [],
    permisos: s.permisos ?? [],
    tarjetaId: s.tarjeta_id,
    cuentaId: s.cuenta_id,
  };
  next();
}

/** Solo sesiones de personas (no ATM). */
export function requireWeb(req: Request, _res: Response, next: NextFunction) {
  if (req.auth?.kind !== 'web') throw new AppError(403, 'SIN_PERMISO', 'Esta sesion no puede usar este recurso.');
  next();
}

export function requireAtm(req: Request, _res: Response, next: NextFunction) {
  if (req.auth?.kind !== 'atm') throw new AppError(403, 'SIN_PERMISO', 'Se requiere una sesion de cajero automatico.');
  next();
}

/** Exige AL MENOS UNO de los permisos. Los accesos denegados quedan en la auditoria. */
export function requirePermission(...permisos: string[]) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    if (req.auth?.kind !== 'web' || !permisos.some((p) => req.auth!.permisos.includes(p))) {
      await denegar(req, permisos);
      throw new AppError(403, 'SIN_PERMISO', 'No tienes permiso para realizar esta accion.');
    }
    next();
  };
}

export async function denegar(req: Request, requeridos: string[] = []) {
  try {
    await withTx(actorDe(req), (c) =>
      c.query('SELECT api.registrar_auditoria($1, $2, NULL, $3, $4::jsonb)', [
        'ACCESO',
        'api.ruta',
        'DENEGADO',
        JSON.stringify({ metodo: req.method, ruta: req.originalUrl.split('?')[0], requiere: requeridos }),
      ]),
    );
  } catch (e) {
    console.error(JSON.stringify({ nivel: 'error', msg: 'no se pudo auditar acceso denegado', req: req.id, err: String(e) }));
  }
}
