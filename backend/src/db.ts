import { Pool, PoolClient, types } from 'pg';
import { config } from './config';

// bigint -> number (los ids del laboratorio caben de sobra en 2^53). numeric se deja como
// string a proposito: el dinero nunca pasa por float.
types.setTypeParser(20, (v) => Number(v));

export const pool = new Pool({
  host: config.LAB_DB_HOST,
  port: config.LAB_DB_PORT,
  database: config.LAB_DB_NAME,
  user: 'lab_api', // rol de minimo privilegio: solo funciones y vistas del esquema api
  password: config.LAB_API_PASSWORD,
  max: 10,
  idleTimeoutMillis: 30_000,
  statement_timeout: 15_000,
  // Carga OLTP: consultas cortas. El paralelismo (Gather Merge) cuesta ~50 ms solo en lanzar los workers
  // para devolver unas pocas filas (medido con EXPLAIN en docs/RENDIMIENTO.md). Se desactiva para el
  // backend; el panel analitico lo reactiva localmente con SET LOCAL.
  options: '-c max_parallel_workers_per_gather=0',
});

// Sin este manejador, una conexion ociosa que se cae (reinicio de PostgreSQL, failover, corte de red) emite
// 'error' en el pool y Node lo trata como excepcion no capturada: el proceso muere. Se registra y el pool la repone.
pool.on('error', (err) => {
  console.error(JSON.stringify({ nivel: 'error', msg: 'error en una conexion ociosa del pool', err: String(err) }));
});

/** Actor de negocio que la auditoria de PostgreSQL registra (app.usuario_id / app.rol / app.ip). */
export interface Actor {
  usuarioId?: number | null;
  rol?: string;
  ip?: string;
}

const RETRIABLE = new Set(['40001', '40P01']);

async function ejecutar<T>(actor: Actor | null, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let conexionRota = false;
  try {
    await client.query('BEGIN');
    if (actor) {
      await client.query(
        "SELECT set_config('app.usuario_id', $1, true), set_config('app.rol', $2, true), set_config('app.ip', $3, true)",
        [actor.usuarioId ? String(actor.usuarioId) : '', actor.rol ?? '', actor.ip ?? ''],
      );
    }
    const resultado = await fn(client);
    await client.query('COMMIT');
    return resultado;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      conexionRota = true; // si ni el ROLLBACK funciona, la conexion no vuelve al pool: se descarta
    }
    throw err;
  } finally {
    client.release(conexionRota);
  }
}

/** Ejecuta fn dentro de una transaccion con el actor fijado. Reintenta ante deadlock/serializacion. */
export async function withTx<T>(actor: Actor | null, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  for (let intento = 0; ; intento++) {
    try {
      return await ejecutar(actor, fn);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (intento < 2 && code && RETRIABLE.has(code)) {
        await new Promise((r) => setTimeout(r, 20 * (intento + 1) + Math.random() * 30)); // espera breve con jitter
        continue;
      }
      throw err;
    }
  }
}

export async function rows<T = Record<string, any>>(c: PoolClient | Pool, sql: string, params: unknown[] = []) {
  const r = await c.query(sql, params as any[]);
  return r.rows as T[];
}

export async function one<T = Record<string, any>>(c: PoolClient | Pool, sql: string, params: unknown[] = []) {
  return (await rows<T>(c, sql, params))[0] as T | undefined;
}
