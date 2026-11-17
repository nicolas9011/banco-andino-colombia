import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { config } from '../config';

export interface TokenClaims {
  jti: string;
  typ: 'web' | 'atm';
}

export function hashPassword(plano: string): Promise<string> {
  return bcrypt.hash(plano, config.BCRYPT_ROUNDS);
}

export function verifyPassword(plano: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plano, hash);
}

// Hash ficticio: se compara cuando el usuario no existe para que el tiempo de respuesta no revele que nombres de
// usuario son validos. DEBE tener el mismo coste que los hashes reales (BCRYPT_ROUNDS): con un coste menor, un
// usuario inexistente responde claramente mas rapido y se puede enumerar midiendo la latencia.
export const DUMMY_HASH = bcrypt.hashSync('no-existe-este-usuario', config.BCRYPT_ROUNDS);

/** Politica de contrasena: 10+ caracteres con letras y numeros; 72 bytes maximo (bcrypt trunca lo que exceda). */
export function passwordValida(p: string): boolean {
  return p.length >= 10 && Buffer.byteLength(p, 'utf8') <= 72 && /[A-Za-z]/.test(p) && /\d/.test(p);
}

export function newSession(typ: 'web' | 'atm', minutos: number) {
  const jti = crypto.randomUUID();
  const expira = new Date(Date.now() + minutos * 60_000);
  const token = jwt.sign({ typ }, config.JWT_SECRET, {
    algorithm: 'HS256',
    jwtid: jti,
    expiresIn: minutos * 60,
    issuer: 'banco-andino',
  });
  return { jti, token, expira };
}

export function verifyToken(token: string): TokenClaims | null {
  try {
    const p = jwt.verify(token, config.JWT_SECRET, { algorithms: ['HS256'], issuer: 'banco-andino' }) as jwt.JwtPayload;
    if (typeof p.jti !== 'string' || (p.typ !== 'web' && p.typ !== 'atm')) return null;
    return { jti: p.jti, typ: p.typ };
  } catch {
    return null;
  }
}

/** El numero de tarjeta solo existe como HMAC con pepper del servidor. */
export function hashTarjeta(numero: string): string {
  return crypto.createHmac('sha256', config.CARD_PEPPER).update(numero).digest('hex');
}
