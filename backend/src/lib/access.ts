import type { Request } from 'express';
import type { PoolClient } from 'pg';
import { one } from '../db';
import { AppError } from '../errors';
import { tienePermiso } from './http';

export async function esTitular(c: PoolClient, clienteId: number | null, cuentaId: number): Promise<boolean> {
  if (!clienteId) return false;
  const r = await one(c, 'SELECT api.es_titular($1, $2) AS ok', [clienteId, cuentaId]);
  return r?.ok === true;
}

/**
 * Control de propiedad en el servidor: el personal con `accounts:read` ve cualquier cuenta;
 * un cliente solo las suyas. Para el resto se responde 404 (no se revela que la cuenta existe).
 */
export async function assertPuedeVerCuenta(req: Request, c: PoolClient, cuentaId: number): Promise<void> {
  if (tienePermiso(req, 'accounts:read')) return;
  if (tienePermiso(req, 'accounts:read_own') && (await esTitular(c, req.auth!.clienteId, cuentaId))) return;
  throw new AppError(404, 'NO_ENCONTRADO', 'Cuenta no encontrada.');
}

/**
 * Origen de filas "transacciones de estas cuentas (como origen o destino)" SIN usar OR.
 * `A OR B ... ORDER BY fecha LIMIT n` hace que PostgreSQL elija un barrido completo (~400 ms sobre 1 M de
 * filas); dos busquedas por indice unidas con UNION ALL, sobre una vista delgada sin joins, tardan ~0,2 ms
 * (experimento E08, docs/RENDIMIENTO.md). Devuelve una subconsulta CON ALIAS para usar como `base` en
 * listarPaginado. `listaSql` devuelve ids de cuenta, p. ej. `SELECT $1::bigint`.
 */
export function baseTx(listaSql: string): string {
  const cols = 'id, tipo, canal, actor_usuario_id, cuenta_debito, cuenta_credito, creado_en';
  return `(SELECT ${cols} FROM api.v_tx_base WHERE cuenta_debito IN (${listaSql})
           UNION ALL
           SELECT ${cols} FROM api.v_tx_base WHERE cuenta_credito IN (${listaSql})
              AND cuenta_debito NOT IN (${listaSql})) b`;
  // La segunda rama excluye lo ya incluido por la primera: una transferencia entre dos cuentas del MISMO cliente
  // tiene origen y destino en la lista y, sin este filtro, apareceria dos veces (y inflaria el total).
}

/** Cuentas del cliente (titular o cotitular), para usar dentro de baseTx. */
export const CUENTAS_DEL_CLIENTE = (n: number) => `SELECT cuenta_id FROM api.v_titular_base WHERE cliente_id = $${n}`;

/** Cuentas visibles para la sesion: null = todas, lista = solo esas (via titularidad). */
export function filtroTitular(req: Request, paramIndex: number): { sql: string; params: unknown[] } | null {
  if (tienePermiso(req, 'accounts:read')) return null;
  if (!tienePermiso(req, 'accounts:read_own')) throw new AppError(403, 'SIN_PERMISO', 'No tienes permiso para realizar esta accion.');
  return {
    sql: `cuenta_id IN (SELECT cuenta_id FROM api.v_titular_base WHERE cliente_id = $${paramIndex})`,
    params: [req.auth!.clienteId ?? 0],
  };
}
