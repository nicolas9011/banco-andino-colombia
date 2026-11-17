import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../src/app';

export const app = createApp();
export const http = () => request(app);

export const password = () => process.env.SEED_PASSWORD as string;
export const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
export const clave = () => 'k' + randomUUID().replace(/-/g, '').slice(0, 30);

const cache = new Map<string, string>();

export async function tokenDe(username: string): Promise<string> {
  const hit = cache.get(username);
  if (hit) return hit;
  const r = await http().post('/api/auth/login').send({ username, password: password() });
  if (r.status !== 200) {
    throw new Error(`No se pudo iniciar sesion como ${username} (${r.status}). Ejecuta "npm run seed" primero.`);
  }
  cache.set(username, r.body.token);
  return r.body.token;
}

let contador = Date.now() % 1_000_000_000;
export const documentoNuevo = () => String(2_000_000_000 + (contador++ % 900_000_000));

export async function nuevoCliente(tokenStaff: string, extra: Record<string, unknown> = {}): Promise<number> {
  const doc = documentoNuevo();
  const r = await http().post('/api/customers').set(bearer(tokenStaff))
    .send({ documento: doc, nombre: 'Cliente Sintetico Prueba', correo: `${doc}@t.test`, departamento: 'Antioquia', ciudad: 'Medellin', ...extra });
  if (r.status !== 201) throw new Error(`crear cliente: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.id;
}

/** Abre una cuenta COP activa y, si se pide, la fondea con una consignacion de cajero. */
export async function nuevaCuenta(tokenStaff: string, clienteId: number, saldo = 0, extra: Record<string, unknown> = {}): Promise<number> {
  const r = await http().post('/api/accounts').set(bearer(tokenStaff)).send({ clienteId, moneda: 'COP', ...extra });
  if (r.status !== 201) throw new Error(`abrir cuenta: ${r.status} ${JSON.stringify(r.body)}`);
  if (saldo > 0) {
    const d = await http().post('/api/transactions/deposit').set({ ...bearer(tokenStaff), 'Idempotency-Key': clave() })
      .send({ cuentaId: r.body.id, monto: String(saldo) });
    if (d.status !== 201) throw new Error(`fondear: ${d.status} ${JSON.stringify(d.body)}`);
  }
  return r.body.id;
}

/** Crea un usuario CLIENTE ligado al cliente y devuelve su token. */
export async function sesionDeCliente(tokenAdmin: string, clienteId: number): Promise<{ username: string; token: string; userId: number }> {
  const username = 'u' + randomUUID().replace(/-/g, '').slice(0, 14);
  const c = await http().post('/api/users').set(bearer(tokenAdmin))
    .send({ username, password: password(), nombreCompleto: 'Usuario Cliente Prueba', clienteId, roles: ['CLIENTE'] });
  if (c.status !== 201) throw new Error(`crear usuario: ${c.status} ${JSON.stringify(c.body)}`);
  const l = await http().post('/api/auth/login').send({ username, password: password() });
  return { username, token: l.body.token, userId: c.body.id };
}

export async function saldoDe(tokenStaff: string, cuentaId: number): Promise<string> {
  const r = await http().get(`/api/accounts/${cuentaId}`).set(bearer(tokenStaff));
  return r.body.saldo_contable;
}
