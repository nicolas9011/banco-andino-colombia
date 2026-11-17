/**
 * Latencia de la API sobre la base con 1.000.000 de transacciones, y throughput de escritura con concurrencia.
 *   npm run latencia        -> evidencia/latencia_api.json
 * Requiere los datos de prueba (scripts de preparar_base) y SEED_PASSWORD en .env.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';

// NODE_ENV debe fijarse ANTES de cargar la app (config.ts lo lee al importarse): por eso los imports son dinamicos.
// En modo test el limitador global no frena la prueba de carga (640 peticiones).
process.env.NODE_ENV = process.env.NODE_ENV ?? 'test';

const REPETICIONES = 7;
const percentil = (v: number[], p: number) => [...v].sort((a, b) => a - b)[Math.max(0, Math.ceil(p * v.length) - 1)];

async function main() {
  const { createApp } = await import('../src/app');
  const { pool } = await import('../src/db');
  const server = createApp().listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const pass = process.env.SEED_PASSWORD!;

  const llamar = async (ruta: string, token?: string, opciones: { method?: string; body?: unknown; clave?: boolean } = {}) => {
    const t0 = performance.now();
    const r = await fetch(base + ruta, {
      method: opciones.method ?? 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(opciones.clave ? { 'Idempotency-Key': randomUUID().replace(/-/g, '') } : {}),
      },
      body: opciones.body ? JSON.stringify(opciones.body) : undefined,
    });
    const cuerpo = await r.json().catch(() => null);
    return { ms: performance.now() - t0, status: r.status, cuerpo };
  };
  const login = async (u: string) => (await llamar('/auth/login', undefined, { method: 'POST', body: { username: u, password: pass } })).cuerpo.token as string;

  const admin = await login('admin1');
  const cajero = await login('cajero1');
  const cliente = await login('cliente1');

  // cuenta con mucha actividad para medir el peor caso razonable
  const cuentaActiva = (await pool.query(`SELECT cuenta_id FROM api.v_extracto WHERE cuenta_id > 2 AND creado_en > now() - interval '3 years' GROUP BY 1 ORDER BY count(*) DESC LIMIT 1`)).rows[0]?.cuenta_id;

  const mediana = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)];
  const lecturas: [string, string, string][] = [
    ['GET /stats/overview (panel admin)', '/stats/overview', admin],
    ['GET /customers?limit=25', '/customers?limit=25', cajero],
    ['GET /customers?q=Gomez', '/customers?q=Gomez&limit=25', cajero],
    ['GET /accounts?limit=20', '/accounts?limit=20', cajero],
    ['GET /accounts/:id (cuenta muy activa)', `/accounts/${cuentaActiva}`, cajero],
    ['GET /accounts/:id/statement (cuenta muy activa)', `/accounts/${cuentaActiva}/statement?limit=15`, cajero],
    ['GET /transactions?limit=20', '/transactions?limit=20', admin],
    ['GET /transactions?cuentaId=:id (historial de cuenta)', `/transactions?cuentaId=${cuentaActiva}&limit=20`, admin],
    ['GET /transactions?tipo=retiro&limit=20', '/transactions?tipo=retiro&limit=20', admin],
    ['GET /audit?limit=25', '/audit?limit=25', admin],
    ['GET /users', '/users', admin],
    ['GET /me/dashboard (cliente)', '/me/dashboard', cliente],
    ['GET /transactions (cliente)', '/transactions?limit=20', cliente],
  ];
  const salida: Record<string, unknown> = { lecturas: {}, escrituras: {}, concurrencia: {} };
  console.log('\nLECTURAS (mediana de', REPETICIONES, 'ejecuciones)');
  for (const [nombre, ruta, token] of lecturas) {
    const t: number[] = [];
    let status = 0;
    for (let i = 0; i < REPETICIONES; i++) {
      const r = await llamar(ruta, token);
      t.push(r.ms);
      status = r.status;
    }
    (salida.lecturas as any)[nombre] = { status, mediana_ms: +mediana(t).toFixed(1), max_ms: +Math.max(...t).toFixed(1) };
    console.log(`${nombre.padEnd(56)} ${String(status).padEnd(4)} mediana ${mediana(t).toFixed(1).padStart(8)} ms   max ${Math.max(...t).toFixed(1).padStart(8)} ms`);
  }

  // Escrituras secuenciales: consignacion y transferencia entre dos cuentas de prueba
  const [a, b] = (await pool.query(`SELECT cuenta_id FROM api.v_saldos WHERE moneda='COP' AND estado='activa' AND saldo_disponible > 5000000 ORDER BY cuenta_id LIMIT 2`)).rows.map((r) => r.cuenta_id);
  console.log('\nESCRITURAS secuenciales (20 operaciones)');
  for (const [nombre, ruta, cuerpo] of [
    ['POST /transactions/deposit', '/transactions/deposit', { cuentaId: a, monto: '1000' }],
    ['POST /transactions/transfer', '/transactions/transfer', { origenId: a, destinoId: b, monto: '1000' }],
  ] as const) {
    const t: number[] = [];
    for (let i = 0; i < 20; i++) t.push((await llamar(ruta, cajero, { method: 'POST', body: cuerpo, clave: true })).ms);
    (salida.escrituras as any)[nombre] = { mediana_ms: +mediana(t).toFixed(1), p95_ms: +percentil(t, 0.95).toFixed(1) };
    console.log(`${nombre.padEnd(56)} mediana ${mediana(t).toFixed(1).padStart(8)} ms   p95 ${percentil(t, 0.95).toFixed(1).padStart(8)} ms`);
  }

  // Concurrencia: 8 trabajadores. Las consignaciones comparten la fila de CAJA (cuello de botella esperado);
  // las transferencias solo bloquean las dos cuentas implicadas.
  console.log('\nCONCURRENCIA (8 trabajadores x 40 operaciones)');
  const pares = (await pool.query(`SELECT cuenta_id FROM api.v_saldos WHERE moneda='COP' AND estado='activa' AND saldo_disponible > 5000000 ORDER BY cuenta_id LIMIT 16`)).rows.map((r) => r.cuenta_id);
  for (const tipo of ['deposit', 'transfer'] as const) {
    const t0 = performance.now();
    const lat: number[] = [];
    let errores = 0;
    await Promise.all(Array.from({ length: 8 }, async (_, w) => {
      for (let i = 0; i < 40; i++) {
        const cuerpo = tipo === 'deposit'
          ? { cuentaId: pares[w], monto: '1000' }
          : { origenId: pares[w * 2], destinoId: pares[w * 2 + 1], monto: '1000' };
        const r = await llamar(`/transactions/${tipo}`, cajero, { method: 'POST', body: cuerpo, clave: true });
        if (r.status === 201) lat.push(r.ms); else errores++;
      }
    }));
    const seg = (performance.now() - t0) / 1000;
    if (!lat.length) throw new Error(`todas las operaciones ${tipo} fallaron (${errores} errores): la medicion no es valida`);
    const p50 = percentil(lat, 0.5);
    const p95 = percentil(lat, 0.95);
    (salida.concurrencia as any)[tipo] = { ok: lat.length, errores, tps: +(lat.length / seg).toFixed(1), p50_ms: +p50.toFixed(1), p95_ms: +p95.toFixed(1) };
    console.log(`${(tipo === 'deposit' ? 'consignaciones (comparten caja)' : 'transferencias (cuentas distintas)').padEnd(40)} ${lat.length} ok / ${errores} err  ${(lat.length / seg).toFixed(1)} TPS  p50 ${p50.toFixed(0)} ms  p95 ${p95.toFixed(0)} ms`);
  }

  const destino = path.resolve(__dirname, '../../evidencia');
  fs.mkdirSync(destino, { recursive: true });
  fs.writeFileSync(path.join(destino, 'latencia_api.json'), JSON.stringify(salida, null, 2));
  server.close();
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
