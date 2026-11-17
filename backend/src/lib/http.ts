import type { Request } from 'express';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { AppError } from '../errors';
import { one, rows, withTx } from '../db';
import type { Actor } from '../db';

/** Valida con zod y devuelve solo mensajes seguros (sin eco de valores). */
export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) {
    const detalle = r.error.issues
      .slice(0, 5)
      .map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message))
      .join('; ');
    throw new AppError(400, 'VALIDACION', `Datos invalidos: ${detalle}`);
  }
  return r.data;
}

/** Identificador numerico de la ruta: solo digitos (Number() aceptaria "0x10" o "1e3"). */
export function idParam(req: Request, nombre = 'id'): number {
  const crudo = String(req.params[nombre]);
  const n = Number(crudo);
  if (!/^\d{1,15}$/.test(crudo) || !Number.isSafeInteger(n) || n <= 0) throw new AppError(400, 'VALIDACION', 'Identificador invalido.');
  return n;
}

/** Monto en pesos/dolares como texto con maximo 2 decimales, estrictamente positivo. Nunca float. */
export const montoSchema = z
  .union([z.string(), z.number()])
  .transform((v) => String(v).trim())
  .pipe(
    z
      .string()
      .regex(/^\d{1,13}(\.\d{1,2})?$/, 'monto con maximo 2 decimales')
      .refine((s) => Number(s) > 0, 'el monto debe ser mayor que cero'),
  );

/** Suma exacta de importes decimales ("-12.30", "1000.00") con BigInt sobre centavos. Devuelve "n.dd". */
export function sumarDecimales(valores: string[]): string {
  let centavos = 0n;
  for (const v of valores) {
    const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(String(v));
    if (!m) throw new Error(`importe no numerico: ${v}`);
    const c = BigInt(m[2]) * 100n + BigInt((m[3] ?? '').padEnd(2, '0') || '0');
    centavos += m[1] ? -c : c;
  }
  const neg = centavos < 0n;
  const abs = neg ? -centavos : centavos;
  return `${neg ? '-' : ''}${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`;
}

/** Monto >= 0 (para limites y sobregiro, donde cero es un valor legitimo). */
export const montoNoNegativoSchema = z
  .union([z.string(), z.number()])
  .transform((v) => String(v).trim())
  .pipe(z.string().regex(/^\d{1,13}(\.\d{1,2})?$/, 'monto con maximo 2 decimales'));

/**
 * Identificador: entero positivo como numero JSON o como texto de solo digitos. NO se usa z.coerce: coerce aceptaria
 * `true` (como 1), `[5]` o "0x10" y una operacion podria apuntar a una cuenta que nadie escribio.
 */
export const idSchema = z
  .union([z.number().int(), z.string().regex(/^\d{1,15}$/, 'identificador numerico')])
  .transform((v) => Number(v))
  .pipe(z.number().int().positive().max(Number.MAX_SAFE_INTEGER));

/** PIN de 4 digitos que no sea trivial (repetido o secuencia). Una sola regla para emitir y para cambiar. */
export const pinSchema = z
  .string()
  .regex(/^\d{4}$/, 'el PIN tiene 4 digitos')
  .refine((p) => !/^(\d)\1{3}$/.test(p) && !'01234567890'.includes(p) && !'09876543210'.includes(p), 'PIN demasiado simple');

export const conceptoSchema = z.string().trim().max(200).optional();

const paginacion = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});

export function paginar(req: Request) {
  return parse(paginacion, req.query);
}

/**
 * Conteo para paginar. Un `count(*) OVER ()` obliga a recorrer TODAS las filas que cumplen el filtro en
 * cada pagina (3,7 s sobre 1 M de transacciones). Se cuenta aparte y con tope: exacto hasta TOPE_CONTEO;
 * mas alla se informa `totalTruncado` y la interfaz muestra "10.000+".
 */
export const TOPE_CONTEO = 10_000;

export async function contarTope(c: PoolClient, from: string, where: string, params: unknown[]) {
  const r = await one<{ n: number }>(c, `SELECT count(*)::int AS n FROM (SELECT 1 FROM ${from} ${where} LIMIT ${TOPE_CONTEO + 1}) x`, params);
  const n = r!.n;
  return { total: Math.min(n, TOPE_CONTEO), totalTruncado: n > TOPE_CONTEO };
}

/**
 * Lista paginada: pagina ordenada + conteo con tope, en una sola transaccion.
 * Con `base` (vista delgada sin joins) el filtro, el orden, el conteo y el corte de pagina se hacen sobre
 * `base` y el detalle de `from` se une solo a las filas de la pagina. `base` debe tener `id` y `creado_en`.
 */
export async function listarPaginado(o: {
  from: string; select?: string; where: string[]; params: unknown[]; order: string; limit: number; offset: number;
  base?: string; orderDetalle?: string;
}) {
  const w = o.where.length ? 'WHERE ' + o.where.join(' AND ') : '';
  const n = o.params.length;
  return withTx(null, async (c) => {
    const conteo = await contarTope(c, o.base ?? o.from, w, o.params);
    const items = o.base
      ? await rows(
          c, `SELECT d.* FROM ${o.from} d
                JOIN (SELECT id FROM ${o.base} ${w} ORDER BY ${o.order} LIMIT $${n + 1} OFFSET $${n + 2}) p ON p.id = d.id
               ORDER BY ${o.orderDetalle ?? o.order}`,
          [...o.params, o.limit, o.offset])
      : await rows(
          c, `SELECT ${o.select ?? '*'} FROM ${o.from} ${w} ORDER BY ${o.order} LIMIT $${n + 1} OFFSET $${n + 2}`,
          [...o.params, o.limit, o.offset]);
    return { ...conteo, items };
  });
}

/** AAAA-MM-DD que exista de verdad en el calendario (rechaza 2024-02-30 y 2024-13-45). */
export function esFechaReal(texto: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(texto);
  if (!m) return false;
  const [a, mes, dia] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const d = new Date(Date.UTC(a, mes - 1, dia));
  return d.getUTCFullYear() === a && d.getUTCMonth() === mes - 1 && d.getUTCDate() === dia;
}

export const fechaDiaSchema = z.string().refine(esFechaReal, 'fecha AAAA-MM-DD valida');

/**
 * Fecha o instante ISO 8601 estricto. Date.parse acepta formatos ("1", "2024") que PostgreSQL rechaza despues con un
 * error 500; aqui se rechazan de entrada con un 400 claro.
 */
export const fechaSchema = z
  .string()
  .refine((s) => /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})?)?$/.test(s)
    && esFechaReal(s.slice(0, 10)) && !Number.isNaN(Date.parse(s)), 'fecha ISO 8601 valida (AAAA-MM-DD o con hora)');

/**
 * Clave de idempotencia obligatoria en operaciones de dinero. Se prefija con el sujeto
 * autenticado para que dos usuarios nunca colisionen ni puedan adivinar claves ajenas.
 */
export function claveIdempotencia(req: Request): string {
  const h = req.header('Idempotency-Key');
  if (!h || !/^[A-Za-z0-9_-]{8,64}$/.test(h)) {
    throw new AppError(400, 'IDEMPOTENCIA', 'Falta el encabezado Idempotency-Key (8 a 64 caracteres alfanumericos).');
  }
  const a = req.auth!;
  const sujeto = a.kind === 'atm' ? `t${a.tarjetaId}` : `u${a.usuarioId}`;
  return `${sujeto}:${h}`;
}

export function actorDe(req: Request): Actor {
  const a = req.auth;
  return {
    usuarioId: a?.kind === 'web' ? a.usuarioId : null,
    rol: a ? (a.kind === 'atm' ? 'ATM' : (a.roles[0] ?? '')) : '',
    ip: req.ip ?? '',
  };
}

export function tienePermiso(req: Request, permiso: string): boolean {
  return req.auth?.permisos.includes(permiso) ?? false;
}
