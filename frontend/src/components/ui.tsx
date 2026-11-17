import { AlertTriangle, CheckCircle2, Info, Loader2, X } from 'lucide-react';
import {
  ButtonHTMLAttributes, InputHTMLAttributes, KeyboardEvent, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes, useEffect, useId, useRef,
} from 'react';
import { limpiarMonto } from '../lib/format';

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

// ---------------------------------------------------------------- botones
type Variante = 'primario' | 'secundario' | 'peligro' | 'fantasma' | 'acento';
const VARIANTES: Record<Variante, string> = {
  primario: 'bg-andino-700 text-white hover:bg-andino-800 disabled:bg-andino-300',
  secundario: 'bg-white text-andino-800 ring-1 ring-inset ring-andino-200 hover:bg-andino-50 disabled:text-slate-400',
  peligro: 'bg-alerta-600 text-white hover:bg-alerta-700 disabled:opacity-50',
  fantasma: 'text-andino-700 hover:bg-andino-100 disabled:text-slate-400',
  acento: 'bg-cobre-500 text-andino-950 hover:bg-cobre-400 disabled:opacity-50',
};

interface BotonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variante?: Variante;
  cargando?: boolean;
  tamano?: 'sm' | 'md' | 'lg';
}

export function Boton({ variante = 'primario', cargando, tamano = 'md', className, children, disabled, ...p }: BotonProps) {
  const t = { sm: 'px-3 py-1.5 text-sm', md: 'px-4 py-2.5 text-sm', lg: 'px-6 py-3.5 text-base' }[tamano];
  return (
    <button
      type="button"
      {...p}
      disabled={disabled || cargando}
      className={cx(
        'inline-flex min-h-10 items-center justify-center gap-2 rounded-lg font-semibold transition-colors disabled:cursor-not-allowed',
        t, VARIANTES[variante], className,
      )}
    >
      {cargando && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
      {children}
    </button>
  );
}

// ------------------------------------------------------------- contenedores
export function Tarjeta({ children, className, titulo, accion }: { children: ReactNode; className?: string; titulo?: string; accion?: ReactNode }) {
  return (
    <section className={cx('rounded-2xl border border-slate-200 bg-white shadow-sm', className)}>
      {(titulo || accion) && (
        <header className="flex items-center justify-between gap-3 border-b border-slate-100 px-5 py-4">
          {titulo && <h2 className="text-base font-semibold text-andino-900">{titulo}</h2>}
          {accion}
        </header>
      )}
      <div className="p-5">{children}</div>
    </section>
  );
}

export function EncabezadoPagina({ titulo, descripcion, acciones }: { titulo: string; descripcion?: string; acciones?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-andino-900">{titulo}</h1>
        {descripcion && <p className="mt-1 text-sm text-slate-600">{descripcion}</p>}
      </div>
      {acciones && <div className="flex flex-wrap gap-2">{acciones}</div>}
    </div>
  );
}

export function Indicador({ etiqueta, valor, nota, tono = 'normal' }: { etiqueta: string; valor: ReactNode; nota?: ReactNode; tono?: 'normal' | 'ok' | 'alerta' }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{etiqueta}</div>
      <div className={cx('tabular mt-2 break-words text-2xl font-bold', tono === 'alerta' ? 'text-alerta-600' : tono === 'ok' ? 'text-ok-600' : 'text-andino-900')}>
        {valor}
      </div>
      {nota && <div className="mt-1 text-xs text-slate-500">{nota}</div>}
    </div>
  );
}

// ---------------------------------------------------------------- estados
const TONOS = {
  gris: 'bg-slate-100 text-slate-700',
  azul: 'bg-andino-100 text-andino-800',
  verde: 'bg-ok-100 text-ok-700',
  rojo: 'bg-alerta-100 text-alerta-700',
  ambar: 'bg-aviso-100 text-aviso-700',
};

export function Etiqueta({ children, tono = 'gris' }: { children: ReactNode; tono?: keyof typeof TONOS }) {
  return <span className={cx('inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold', TONOS[tono])}>{children}</span>;
}

const ESTADOS: Record<string, keyof typeof TONOS> = {
  activa: 'verde', activo: 'verde', OK: 'verde', POSTED: 'verde',
  pendiente: 'ambar', DENEGADO: 'rojo', bloqueada: 'rojo', bloqueado: 'rojo', ERROR: 'rojo',
  cerrada: 'gris', inactivo: 'gris', inactiva: 'gris',
};

export function EtiquetaEstado({ estado }: { estado: string }) {
  return <Etiqueta tono={ESTADOS[estado] ?? 'gris'}>{estado}</Etiqueta>;
}

export function Aviso({ tipo = 'info', children, className }: { tipo?: 'info' | 'ok' | 'error' | 'aviso'; children: ReactNode; className?: string }) {
  const est = {
    info: ['bg-andino-50 text-andino-900 ring-andino-200', Info],
    ok: ['bg-ok-100 text-ok-700 ring-ok-600/30', CheckCircle2],
    error: ['bg-alerta-100 text-alerta-700 ring-alerta-600/30', AlertTriangle],
    aviso: ['bg-aviso-100 text-aviso-700 ring-cobre-500/40', AlertTriangle],
  }[tipo] as [string, typeof Info];
  const Icono = est[1];
  return (
    <div role={tipo === 'error' ? 'alert' : 'status'} className={cx('flex items-start gap-3 rounded-xl px-4 py-3 text-sm ring-1 ring-inset', est[0], className)}>
      <Icono className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1 break-words">{children}</div>
    </div>
  );
}

export function Cargando({ texto = 'Cargando…' }: { texto?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-12 text-sm text-slate-500" role="status">
      <Loader2 className="h-5 w-5 animate-spin" aria-hidden /> {texto}
    </div>
  );
}

/** Error al cargar datos: dice que paso y deja reintentar (nunca un spinner infinito ni un "no hay datos" falso). */
export function ErrorCarga({ mensaje, alReintentar }: { mensaje: string; alReintentar: () => void }) {
  return (
    <Aviso tipo="error">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span>{mensaje}</span>
        <Boton variante="secundario" tamano="sm" onClick={alReintentar}>Reintentar</Boton>
      </div>
    </Aviso>
  );
}

export function Vacio({ children }: { children: ReactNode }) {
  return <div className="rounded-xl border border-dashed border-slate-300 px-4 py-10 text-center text-sm text-slate-500">{children}</div>;
}

// ------------------------------------------------------------- formularios
interface CampoBase {
  etiqueta: string;
  ayuda?: string;
  error?: string;
}

function Envoltura({ etiqueta, ayuda, error, id, children }: CampoBase & { id: string; children: ReactNode }) {
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-andino-900">{etiqueta}</label>
      {children}
      {error ? <p id={`${id}-msg`} className="mt-1 text-xs text-alerta-600">{error}</p> : ayuda ? <p id={`${id}-msg`} className="mt-1 text-xs text-slate-500">{ayuda}</p> : null}
    </div>
  );
}

const CONTROL =
  'block w-full min-h-11 rounded-lg border border-slate-300 bg-white px-3 py-2 text-base text-andino-950 placeholder:text-slate-400 focus:border-andino-500 disabled:bg-slate-100 sm:text-sm';

export function Campo({ etiqueta, ayuda, error, className, ...p }: CampoBase & InputHTMLAttributes<HTMLInputElement>) {
  const id = useId();
  return (
    <Envoltura etiqueta={etiqueta} ayuda={ayuda} error={error} id={id}>
      <input id={id} aria-invalid={!!error} aria-describedby={error || ayuda ? `${id}-msg` : undefined} className={cx(CONTROL, error && 'border-alerta-600', className)} {...p} />
    </Envoltura>
  );
}

export function CampoMonto({ etiqueta, ayuda, error, valor, alCambiar, className, ...p }: CampoBase & { valor: string; alCambiar: (v: string) => void } & Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>) {
  const id = useId();
  return (
    <Envoltura etiqueta={etiqueta} ayuda={ayuda} error={error} id={id}>
      <div className="relative">
        <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-slate-500" aria-hidden>$</span>
        <input
          inputMode="decimal" autoComplete="off" placeholder="0.00" {...p}
          id={id} aria-invalid={!!error} aria-describedby={error || ayuda ? `${id}-msg` : undefined}
          value={valor} onChange={(e) => alCambiar(limpiarMonto(e.target.value))}
          className={cx(CONTROL, 'tabular pl-7', error && 'border-alerta-600', className)}
        />
      </div>
    </Envoltura>
  );
}
export function Seleccion({ etiqueta, ayuda, error, children, ...p }: CampoBase & SelectHTMLAttributes<HTMLSelectElement>) {
  const id = useId();
  return (
    <Envoltura etiqueta={etiqueta} ayuda={ayuda} error={error} id={id}>
      <select id={id} aria-describedby={error || ayuda ? `${id}-msg` : undefined} className={CONTROL} {...p}>{children}</select>
    </Envoltura>
  );
}

export function AreaTexto({ etiqueta, ayuda, error, ...p }: CampoBase & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const id = useId();
  return (
    <Envoltura etiqueta={etiqueta} ayuda={ayuda} error={error} id={id}>
      <textarea id={id} rows={3} aria-describedby={error || ayuda ? `${id}-msg` : undefined} className={CONTROL} {...p} />
    </Envoltura>
  );
}

// ------------------------------------------------------------------ modal
const FOCALIZABLES = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Dialogo modal. `bloqueado` impide cerrarlo (Escape o clic fuera) mientras hay una operacion en vuelo o un dato que
 * se muestra una sola vez (p. ej. el numero de una tarjeta recien emitida): cerrarlo perderia el resultado.
 * Atrapa el foco con Tab y bloquea el desplazamiento de la pagina de fondo.
 */
export function Modal({ abierto, titulo, alCerrar, bloqueado = false, children }: {
  abierto: boolean; titulo: string; alCerrar: () => void; bloqueado?: boolean; children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Se guardan en refs para que el efecto dependa SOLO de `abierto`: con funciones en linea (alCerrar={() => ...})
  // cada re-render del padre reiniciaria el efecto y le quitaria el foco al usuario.
  const cerrar = useRef(alCerrar);
  const impedido = useRef(bloqueado);
  cerrar.current = alCerrar;
  impedido.current = bloqueado;

  useEffect(() => {
    if (!abierto) return;
    const previo = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const overflowPrevio = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const teclado = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape' && !impedido.current) {
        cerrar.current();
        return;
      }
      if (e.key !== 'Tab' || !ref.current) return;
      const f = [...ref.current.querySelectorAll<HTMLElement>(FOCALIZABLES)];
      if (!f.length) {
        e.preventDefault();
        return;
      }
      const primero = f[0];
      const ultimo = f[f.length - 1];
      const activo = document.activeElement;
      if (e.shiftKey && (activo === primero || activo === ref.current)) {
        e.preventDefault();
        ultimo.focus();
      } else if (!e.shiftKey && activo === ultimo) {
        e.preventDefault();
        primero.focus();
      }
    };
    document.addEventListener('keydown', teclado);
    return () => {
      document.removeEventListener('keydown', teclado);
      document.body.style.overflow = overflowPrevio;
      previo?.focus();
    };
  }, [abierto]);
  if (!abierto) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-andino-950/60 p-0 sm:items-center sm:p-4" onMouseDown={() => { if (!bloqueado) alCerrar(); }}>
      <div
        ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label={titulo}
        onMouseDown={(e) => e.stopPropagation()}
        className="max-h-[92vh] w-full overflow-y-auto rounded-t-2xl bg-white p-5 shadow-xl sm:max-w-lg sm:rounded-2xl"
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <h2 className="text-lg font-semibold text-andino-900">{titulo}</h2>
          <button type="button" onClick={alCerrar} disabled={bloqueado} aria-label="Cerrar" className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 disabled:opacity-30">
            <X className="h-5 w-5" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ tabla
export interface Columna<T> {
  titulo: string;
  celda: (fila: T) => ReactNode;
  alinear?: 'der';
  /** En movil la columna "principal" encabeza la tarjeta y no muestra etiqueta. */
  principal?: boolean;
}

/** Tabla en escritorio; lista de tarjetas en movil (sin desbordes horizontales). */
export function Tabla<T>({ columnas, filas, clave, alClic, vacio = 'Sin resultados.' }: {
  columnas: Columna<T>[];
  filas: T[];
  clave: (f: T) => string | number;
  alClic?: (f: T) => void;
  vacio?: string;
}) {
  if (!filas.length) return <Vacio>{vacio}</Vacio>;
  const principal = columnas.find((c) => c.principal) ?? columnas[0];
  // Una fila con accion debe poder usarse con teclado: foco con Tab, Enter o Espacio. (Solo si el evento nace en la
  // propia fila: un boton interno, p. ej. "Reversar", conserva su propio comportamiento.)
  const accion = (f: T) => (alClic ? {
    onClick: () => alClic(f),
    tabIndex: 0,
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      if (e.target !== e.currentTarget) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        alClic(f);
      }
    },
  } : {});
  return (
    <>
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
              {columnas.map((c) => (
                <th key={c.titulo} scope="col" className={cx('px-3 py-2.5 font-semibold', c.alinear === 'der' && 'text-right')}>{c.titulo}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {filas.map((f) => (
              <tr
                key={clave(f)}
                {...accion(f)}
                className={cx(alClic && 'cursor-pointer hover:bg-andino-50')}
              >
                {columnas.map((c) => (
                  <td key={c.titulo} className={cx('px-3 py-3 align-middle', c.alinear === 'der' && 'tabular text-right')}>{c.celda(f)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="space-y-3 md:hidden">
        {filas.map((f) => (
          <li
            key={clave(f)}
            {...accion(f)}
            className={cx('rounded-xl border border-slate-200 p-4', alClic && 'cursor-pointer active:bg-andino-50')}
          >
            <div className="mb-2 font-semibold text-andino-900">{principal.celda(f)}</div>
            <dl className="space-y-1.5">
              {columnas.filter((c) => c !== principal).map((c) => (
                <div key={c.titulo} className="flex items-baseline justify-between gap-4 text-sm">
                  <dt className="shrink-0 text-slate-500">{c.titulo}</dt>
                  <dd className="tabular min-w-0 break-words text-right text-andino-950">{c.celda(f)}</dd>
                </div>
              ))}
            </dl>
          </li>
        ))}
      </ul>
    </>
  );
}

/** `truncado`: el servidor solo cuenta con exactitud hasta un tope (10.000) y muestra "10.000+". */
export function Paginacion({ total, limite, desplazamiento, alCambiar, truncado = false }: {
  total: number; limite: number; desplazamiento: number; alCambiar: (nuevo: number) => void; truncado?: boolean;
}) {
  if (total <= limite) return null;
  const desde = desplazamiento + 1;
  const hasta = Math.min(desplazamiento + limite, total);
  const siguiente = hasta < total || truncado;
  return (
    <nav className="mt-4 flex items-center justify-between gap-3 text-sm" aria-label="Paginacion">
      <span className="text-slate-600">{desde}–{hasta} de {total.toLocaleString('es-CO')}{truncado ? '+' : ''}</span>
      <div className="flex gap-2">
        <Boton variante="secundario" tamano="sm" disabled={desplazamiento === 0} onClick={() => alCambiar(Math.max(0, desplazamiento - limite))}>Anterior</Boton>
        <Boton variante="secundario" tamano="sm" disabled={!siguiente} onClick={() => alCambiar(desplazamiento + limite)}>Siguiente</Boton>
      </div>
    </nav>
  );
}
