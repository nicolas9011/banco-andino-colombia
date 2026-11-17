/** Cliente HTTP del frontend. Nunca habla con PostgreSQL: solo con la API REST. */
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public requestId?: string,
  ) {
    super(message);
  }
}

type TokenKind = 'web' | 'atm';

// El token web vive en sessionStorage (se borra al cerrar la pestana). El del ATM, solo en memoria.
const WEB_KEY = 'andino.token';
let atmToken: string | null = null;
let onUnauthorized: (() => void) | null = null;

export const tokens = {
  getWeb: () => {
    try {
      return sessionStorage.getItem(WEB_KEY);
    } catch {
      return null;
    }
  },
  setWeb: (t: string | null) => {
    try {
      if (t) sessionStorage.setItem(WEB_KEY, t);
      else sessionStorage.removeItem(WEB_KEY);
    } catch {
      /* almacenamiento bloqueado: la sesion durara solo en memoria de la pagina */
    }
  },
  setAtm: (t: string | null) => {
    atmToken = t;
  },
  getAtm: () => atmToken,
};

export function setUnauthorizedHandler(fn: (() => void) | null) {
  onUnauthorized = fn;
}

interface Opciones {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  idempotencyKey?: string;
  kind?: TokenKind;
  anon?: boolean;
}

export async function api<T = any>(path: string, o: Opciones = {}): Promise<T> {
  const url = new URL('/api' + path, window.location.origin);
  for (const [k, v] of Object.entries(o.query ?? {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (o.body !== undefined) headers['Content-Type'] = 'application/json';
  if (o.idempotencyKey) headers['Idempotency-Key'] = o.idempotencyKey;
  const token = o.anon ? null : o.kind === 'atm' ? tokens.getAtm() : tokens.getWeb();
  if (token) headers.Authorization = `Bearer ${token}`;

  let res: Response;
  try {
    res = await fetch(url, { method: o.method ?? 'GET', headers, body: o.body !== undefined ? JSON.stringify(o.body) : undefined });
  } catch {
    throw new ApiError(0, 'RED', 'No hay conexion con el servidor. Verifica tu red e intenta de nuevo.');
  }
  if (res.status === 204) return undefined as T;

  let data: any = null;
  try {
    data = await res.json();
  } catch {
    /* respuesta sin cuerpo JSON */
  }
  if (!res.ok) {
    const e = data?.error;
    // Solo si el token que fallo sigue siendo el vigente: un 401 tardio de una sesion anterior no debe cerrar la nueva.
    if (res.status === 401 && token && e?.code === 'NO_AUTENTICADO' && o.kind !== 'atm' && tokens.getWeb() === token) onUnauthorized?.();
    throw new ApiError(res.status, e?.code ?? 'ERROR', e?.message ?? 'Ocurrio un error inesperado.', data?.requestId);
  }
  return data as T;
}

/** Clave de idempotencia nueva (se conserva para reintentos de la MISMA intencion). */
export function nuevaClave(): string {
  // crypto.randomUUID solo existe en contexto seguro (https/localhost); getRandomValues funciona tambien en http://IP-LAN.
  const b = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}
