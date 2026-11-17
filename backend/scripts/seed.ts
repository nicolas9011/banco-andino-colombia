/**
 * Datos de prueba SINTETICOS. Idempotente. Las contrasenas/PIN salen de SEED_PASSWORD /
 * SEED_PIN (.env), nunca del codigo.
 *
 *   npm run seed -- usuarios   personal: admin1, auditor1, cajero1..cajero6   (ANTES de la carga masiva)
 *   npm run seed -- demo       clientes de demostracion cliente1/cliente2      (DESPUES de la carga masiva)
 *   npm run seed               ambos, en ese orden (base vacia)
 *
 * El orden importa: la carga masiva escribe el historial 2023-2026 con los cajeros como actor, y la
 * demo escribe movimientos con la fecha de hoy, que deben quedar al final del libro mayor.
 * Tarjeta ATM de cliente1: 4000 0000 0000 0010
 */
import type { PoolClient } from 'pg';
import { config } from '../src/config';
import { one, pool, withTx } from '../src/db';
import { hashPassword, hashTarjeta } from '../src/lib/security';

const NUMERO_TARJETA = '4000000000000010';
const ACTOR = { usuarioId: null, rol: 'SEED', ip: '127.0.0.1' };

async function crearUsuario(c: PoolClient, hash: string, username: string, nombre: string, roles: string[], clienteId?: number, oficinaId?: number) {
  if (await one(c, 'SELECT 1 FROM api.v_usuarios WHERE username = $1', [username])) return;
  await c.query('SELECT api.crear_usuario($1,$2,$3,$4,$5,$6,$7::text[])', [
    username, hash, nombre, `${username}@demo.banco-andino.test`, clienteId ?? null, oficinaId ?? null, roles,
  ]);
}

async function usuarios(hash: string) {
  await withTx(ACTOR, async (c) => {
    await crearUsuario(c, hash, 'admin1', 'Administrador Demo', ['ADMIN']);
    await crearUsuario(c, hash, 'auditor1', 'Auditor Demo', ['AUDITOR']);
    const oficinas = await c.query('SELECT id FROM api.v_oficinas ORDER BY id LIMIT 6');
    for (let i = 0; i < 6; i++) {
      await crearUsuario(c, hash, `cajero${i + 1}`, `Cajero Demo ${i + 1}`, ['CAJERO'], undefined, oficinas.rows[i]?.id ?? 1);
    }
  });
  console.log('Personal listo: admin1, auditor1, cajero1..cajero6.');
}

async function demo(hash: string, pin: string) {
  await withTx(ACTOR, async (c) => {
    const cliente = async (doc: string, nombre: string, depto: string, ciudad: string) =>
      (await one(c, 'SELECT api.registrar_cliente($1,$2,$3,$4,NULL,$5,$6,$7,$8) AS id', [
        doc, nombre, `${doc}@demo.banco-andino.test`, 'natural', '3001234567', depto, ciudad, 'Calle 1 # 2-3',
      ]))!.id as number;
    const cuentasDe = async (id: number) =>
      (await one(c, 'SELECT count(*)::int AS n FROM api.v_titulares WHERE cliente_id = $1', [id]))!.n as number;

    const c1 = await cliente('1000000001', 'Camila Gomez Rojas', 'Antioquia', 'Medellin');
    const c2 = await cliente('1000000002', 'Mateo Vargas Ortiz', 'Bogota D.C.', 'Bogota');

    if ((await cuentasDe(c1)) === 0) {
      const a1 = (await one(c, "SELECT api.abrir_cuenta($1,'COP') AS id", [c1]))!.id;
      const a2 = (await one(c, "SELECT api.abrir_cuenta($1,'COP',(SELECT id FROM api.v_productos WHERE codigo='CTE-EMPRE')) AS id", [c1]))!.id;
      await c.query("SELECT api.registrar_transaccion('seed-c1-a1','deposito',NULL,$1,5000000,'sistema','Saldo inicial sintetico')", [a1]);
      await c.query("SELECT api.registrar_transaccion('seed-c1-a2','deposito',NULL,$1,1200000,'sistema','Saldo inicial sintetico')", [a2]);
      await c.query('SELECT api.emitir_tarjeta($1,$2,$3,$4,(current_date + 1460))', [
        a1, hashTarjeta(NUMERO_TARJETA), NUMERO_TARJETA.slice(-4), await hashPassword(pin),
      ]);
    }
    if ((await cuentasDe(c2)) === 0) {
      const b1 = (await one(c, "SELECT api.abrir_cuenta($1,'COP') AS id", [c2]))!.id;
      await c.query("SELECT api.registrar_transaccion('seed-c2-b1','deposito',NULL,$1,800000,'sistema','Saldo inicial sintetico')", [b1]);
    }
    await crearUsuario(c, hash, 'cliente1', 'Camila Gomez Rojas', ['CLIENTE'], c1);
    await crearUsuario(c, hash, 'cliente2', 'Mateo Vargas Ortiz', ['CLIENTE'], c2);
  });
  console.log('Clientes de demostracion listos: cliente1, cliente2. Tarjeta ATM de cliente1: 4000 0000 0000 0010');
}

async function main() {
  const modo = process.argv[2];
  if (modo && modo !== 'usuarios' && modo !== 'demo') throw new Error('Uso: npm run seed -- [usuarios|demo]');
  const password = process.env.SEED_PASSWORD;
  const pin = process.env.SEED_PIN;
  if (!password || password.length < 10 || !pin || !/^\d{4}$/.test(pin)) {
    throw new Error('Define SEED_PASSWORD (10+ caracteres) y SEED_PIN (4 digitos) en .env');
  }
  const hash = await hashPassword(password);
  if (!modo || modo === 'usuarios') await usuarios(hash);
  if (!modo || modo === 'demo') await demo(hash, pin);
  console.log(`Base ${config.LAB_DB_NAME}. La contrasena y el PIN son SEED_PASSWORD y SEED_PIN de tu .env.`);
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
