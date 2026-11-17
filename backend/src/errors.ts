/** Error de aplicacion con mensaje seguro para el usuario final. */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

interface PgLike {
  code?: string;
  message?: string;
}

// Codigos de aplicacion definidos en sql/05_operaciones.sql. Los mensajes de los RAISE de nuestras funciones son
// seguros de mostrar (se verifica en mapPgError que provengan de una funcion PL/pgSQL). Cualquier otro error de
// PostgreSQL se enmascara.
const APP_CODES: Record<string, { status: number; code: string }> = {
  '22023': { status: 400, code: 'PARAMETRO_INVALIDO' },
  P0002: { status: 404, code: 'NO_ENCONTRADO' },
  P0003: { status: 409, code: 'CLAVE_REUTILIZADA' },
  P0004: { status: 422, code: 'SALDO_INSUFICIENTE' },
  P0005: { status: 422, code: 'LIMITE_EXCEDIDO' },
  P0006: { status: 409, code: 'ESTADO_INVALIDO' },
  P0007: { status: 409, code: 'YA_REVERSADA' },
  P0008: { status: 409, code: 'LLAVE_DUPLICADA' },
};

const SAFE_MESSAGES: Record<string, string> = {
  P0004: 'Saldo insuficiente.',
  P0005: 'Se excede el limite diario de la operacion.',
};

function capitalizar(texto: string): string {
  return texto.charAt(0).toUpperCase() + texto.slice(1) + (texto.endsWith('.') ? '' : '.');
}

/** Traduce un error de pg a un AppError; devuelve null si no es un error de base de datos conocido. */
export function mapPgError(err: unknown): AppError | null {
  const e = err as PgLike;
  if (!e || typeof e.code !== 'string') return null;

  const app = APP_CODES[e.code];
  // Los mensajes solo se muestran tal cual si los escribio UNA DE NUESTRAS funciones PL/pgSQL (RAISE EXCEPTION).
  // PostgreSQL tambien emite 22023 o P0002 de forma nativa (p. ej. STRICT, parametros de funciones del sistema) con
  // texto interno que no debe llegar al usuario.
  // El contexto viene localizado ("PL/pgSQL function" / "funcion PL/pgSQL"): se busca solo el marcador invariable.
  const nuestro = /PL\/pgSQL/.test((err as { where?: string }).where ?? '');
  // "cuenta no activa" es un conflicto de estado, no un recurso inexistente.
  if (nuestro && e.code === 'P0002' && /cuenta de (origen|destino) no esta activa/.test(e.message ?? '')) {
    return new AppError(409, 'CUENTA_NO_ACTIVA', capitalizar(e.message ?? 'La cuenta no esta activa'));
  }
  if (app) {
    const mensaje = SAFE_MESSAGES[e.code] ?? (nuestro ? capitalizar(e.message ?? 'Solicitud no valida') : 'La solicitud no es valida.');
    return new AppError(app.status, app.code, mensaje);
  }
  switch (e.code) {
    case '23505':
      return new AppError(409, 'DUPLICADO', 'Ya existe un registro con esos datos.');
    case '23503':
      return new AppError(409, 'REFERENCIA_INVALIDA', 'El registro referenciado no existe o esta en uso.');
    case '23514':
    case '23502':
      return new AppError(422, 'OPERACION_NO_PERMITIDA', 'La operacion no cumple las reglas del banco.');
    case '22P02':
    case '22003':
    case '22007': // fecha/hora con formato invalido
    case '22008': // fecha fuera de rango
      return new AppError(400, 'DATO_INVALIDO', 'Alguno de los datos enviados no es valido.');
    case '55000':
      return new AppError(409, 'REGISTRO_INMUTABLE', 'Los registros contabilizados no se pueden modificar.');
    case '40001':
    case '40P01':
      return new AppError(503, 'REINTENTAR', 'El sistema esta ocupado. Intenta de nuevo.');
    case '42501':
      return new AppError(403, 'SIN_PERMISO', 'No tienes permiso para realizar esta accion.');
    default:
      return null;
  }
}
