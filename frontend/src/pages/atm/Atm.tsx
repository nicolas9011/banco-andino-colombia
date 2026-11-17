import { ArrowLeft, Banknote, CreditCard, Delete, History, KeyRound, Landmark, Send, Wallet, X } from 'lucide-react';
import { ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { LogoMark } from '../../components/Logo';
import { api, ApiError, nuevaClave, tokens } from '../../lib/api';
import { dinero, ETIQUETA_TIPO, fecha } from '../../lib/format';
import { mensajeDe } from '../../lib/hooks';

type Pantalla = 'inicio' | 'pin' | 'menu' | 'saldo' | 'retiro' | 'movimientos' | 'transferir' | 'cambiopin' | 'recibo' | 'adios';
const INACTIVIDAD_MS = 60_000;
const MONTOS = [50_000, 100_000, 200_000, 300_000, 500_000, 1_000_000];

interface Recibo { titulo: string; lineas: [string, string][] }

/** Cajero automatico: interfaz independiente. Usa la MISMA base de datos y reglas del banco. */
export default function Atm() {
  const [pantalla, setPantalla] = useState<Pantalla>('inicio');
  const [tarjeta, setTarjeta] = useState('');
  const [mensaje, setMensaje] = useState<{ tipo: 'error' | 'ok'; texto: string } | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const [recibo, setRecibo] = useState<Recibo | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const despedida = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const terminar = useCallback(async (aviso?: string) => {
    // Primero se limpia la pantalla (saldo, recibo, token) y el logout viaja SIN esperarlo: con la red colgada no
    // puede quedar el saldo de un cliente a la vista. api() lee el token de forma sincrona, antes de borrarlo.
    if (tokens.getAtm()) void api('/atm/logout', { method: 'POST', kind: 'atm' }).catch(() => undefined);
    tokens.setAtm(null);
    setTarjeta(''); setRecibo(null);
    setMensaje(aviso ? { tipo: 'ok', texto: aviso } : null);
    setPantalla('adios');
    clearTimeout(despedida.current);
    despedida.current = setTimeout(() => setPantalla('inicio'), 3500);
  }, []);

  // Cierre automatico por inactividad (como un cajero real). Tambien aplica ANTES de entrar: un numero de tarjeta
  // escrito y abandonado no debe quedar a la vista indefinidamente.
  useEffect(() => {
    const reinicia = () => {
      clearTimeout(timer.current);
      if (tokens.getAtm()) {
        timer.current = setTimeout(() => void terminar('Sesión cerrada por inactividad.'), INACTIVIDAD_MS);
      } else if (tarjeta) {
        timer.current = setTimeout(() => { setTarjeta(''); setMensaje({ tipo: 'ok', texto: 'Tarjeta retirada por inactividad.' }); setPantalla('inicio'); }, INACTIVIDAD_MS);
      }
    };
    reinicia();
    window.addEventListener('pointerdown', reinicia);
    window.addEventListener('keydown', reinicia);
    return () => { clearTimeout(timer.current); window.removeEventListener('pointerdown', reinicia); window.removeEventListener('keydown', reinicia); };
  }, [pantalla, tarjeta, terminar]);

  useEffect(() => () => { tokens.setAtm(null); clearTimeout(despedida.current); }, []);

  // "Salir al portal" tambien cierra la sesion en el SERVIDOR (no solo olvida el token en memoria).
  function salirAlPortal() {
    if (tokens.getAtm()) void api('/atm/logout', { method: 'POST', kind: 'atm' }).catch(() => undefined);
    tokens.setAtm(null);
  }

  async function conAtm<T>(fn: () => Promise<T>): Promise<T | undefined> {
    setOcupado(true); setMensaje(null);
    try {
      return await fn();
    } catch (e) {
      if (e instanceof ApiError && e.status === 401 && e.code === 'NO_AUTENTICADO') { await terminar('Tu sesión expiró.'); return undefined; }
      if (e instanceof ApiError && e.code === 'TARJETA_BLOQUEADA') { tokens.setAtm(null); setMensaje({ tipo: 'error', texto: e.message }); setPantalla('inicio'); setTarjeta(''); return undefined; }
      setMensaje({ tipo: 'error', texto: mensajeDe(e) });
      return undefined;
    } finally {
      setOcupado(false);
    }
  }

  const ir = (p: Pantalla) => { setMensaje(null); setPantalla(p); };

  let contenido: ReactNode;
  switch (pantalla) {
    case 'inicio':
      contenido = (
        <Inicio tarjeta={tarjeta} setTarjeta={setTarjeta} mensaje={mensaje}
          alInsertar={() => { setMensaje(null); setPantalla('pin'); }} />
      );
      break;
    case 'pin':
      contenido = (
        <IngresoPin ocupado={ocupado} mensaje={mensaje} alCancelar={() => { setTarjeta(''); ir('inicio'); }}
          alConfirmar={async (pin) => {
            const r = await conAtm(() => api<{ token: string }>('/atm/login', { method: 'POST', anon: true, body: { numeroTarjeta: tarjeta, pin } }));
            if (r) { tokens.setAtm(r.token); ir('menu'); }
            // Si falla, conAtm ya muestra el error y se permanece en la pantalla de PIN.
          }} />
      );
      break;
    case 'menu':
      contenido = <Menu ir={ir} salir={() => void terminar()} />;
      break;
    case 'saldo':
      contenido = <Saldo conAtm={conAtm} volver={() => ir('menu')} mensaje={mensaje} />;
      break;
    case 'movimientos':
      contenido = <Movimientos conAtm={conAtm} volver={() => ir('menu')} mensaje={mensaje} />;
      break;
    case 'retiro':
      contenido = <Retiro conAtm={conAtm} ocupado={ocupado} mensaje={mensaje} volver={() => ir('menu')}
        alExito={(r) => { setRecibo(r); ir('recibo'); }} />;
      break;
    case 'transferir':
      contenido = <Transferir conAtm={conAtm} ocupado={ocupado} mensaje={mensaje} volver={() => ir('menu')}
        alExito={(r) => { setRecibo(r); ir('recibo'); }} />;
      break;
    case 'cambiopin':
      contenido = <CambioPin conAtm={conAtm} ocupado={ocupado} mensaje={mensaje} volver={() => ir('menu')}
        alExito={() => { setMensaje({ tipo: 'ok', texto: 'PIN actualizado correctamente.' }); setPantalla('menu'); }} />;
      break;
    case 'recibo':
      contenido = recibo && <ReciboPantalla r={recibo} volver={() => ir('menu')} salir={() => void terminar()} />;
      break;
    case 'adios':
      contenido = (
        <Centro>
          <Landmark className="h-16 w-16 text-cobre-400" />
          <h2 className="mt-4 text-3xl font-bold">Gracias por usar Banco Andino</h2>
          <p className="mt-2 text-andino-200">{mensaje?.texto ?? 'Retira tu tarjeta.'}</p>
        </Centro>
      );
      break;
  }

  return (
    <div className="flex min-h-full items-center justify-center bg-gradient-to-b from-slate-800 to-slate-950 p-3 sm:p-6">
      <div className="w-full max-w-3xl rounded-[2rem] bg-slate-700 p-3 shadow-2xl ring-1 ring-white/10 sm:p-5">
        <div className="mb-3 flex items-center justify-between px-2 text-white">
          <div className="flex items-center gap-2"><LogoMark className="h-8 w-8" /><span className="text-sm font-bold tracking-wide">CAJERO AUTOMÁTICO</span></div>
          <Link to="/login" onClick={salirAlPortal} className="rounded-md px-2 py-1 text-xs text-slate-300 hover:bg-white/10">Salir al portal</Link>
        </div>
        <div className="min-h-[28rem] overflow-hidden rounded-2xl bg-andino-900 p-4 text-white ring-4 ring-slate-900 sm:min-h-[32rem] sm:p-8">
          {contenido}
        </div>
        <div className="mt-3 flex items-center justify-center gap-6 text-[11px] uppercase tracking-widest text-slate-400">
          <span className="flex items-center gap-1"><CreditCard className="h-3.5 w-3.5" /> Ranura de tarjeta</span>
          <span className="flex items-center gap-1"><Banknote className="h-3.5 w-3.5" /> Dispensador</span>
        </div>
        <p className="mt-2 text-center text-[10px] text-slate-400">Simulación académica · datos sintéticos</p>
      </div>
    </div>
  );
}

const Centro = ({ children }: { children: ReactNode }) => (
  <div className="flex h-full min-h-[24rem] flex-col items-center justify-center text-center">{children}</div>
);

function Mensaje({ m }: { m: { tipo: 'error' | 'ok'; texto: string } | null }) {
  if (!m) return null;
  return (
    <div role={m.tipo === 'error' ? 'alert' : 'status'}
      className={`mb-4 rounded-xl px-4 py-3 text-center text-base font-semibold ${m.tipo === 'error' ? 'bg-alerta-600 text-white' : 'bg-ok-600 text-white'}`}>
      {m.texto}
    </div>
  );
}

function BotonAtm({ children, onClick, disabled, tono = 'normal', className = '' }: { children: ReactNode; onClick: () => void; disabled?: boolean; tono?: 'normal' | 'acento' | 'peligro'; className?: string }) {
  const t = { normal: 'bg-andino-700 hover:bg-andino-600', acento: 'bg-cobre-500 text-andino-950 hover:bg-cobre-400', peligro: 'bg-alerta-600 hover:bg-alerta-700' }[tono];
  return (
    <button type="button" onClick={onClick} disabled={disabled}
      className={`flex min-h-14 items-center justify-center gap-2 rounded-xl px-4 py-3 text-base font-bold text-white transition-colors disabled:opacity-40 sm:text-lg ${t} ${className}`}>
      {children}
    </button>
  );
}

function Teclado({ alDigito, alBorrar, alAceptar, aceptarOk }: { alDigito: (d: string) => void; alBorrar: () => void; alAceptar: () => void; aceptarOk: boolean }) {
  return (
    <div className="mx-auto grid w-full max-w-xs grid-cols-3 gap-2" role="group" aria-label="Teclado numérico">
      {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
        <button key={d} type="button" onClick={() => alDigito(d)} className="min-h-14 rounded-xl bg-slate-100 text-2xl font-bold text-andino-900 active:bg-slate-300">{d}</button>
      ))}
      <button type="button" onClick={alBorrar} aria-label="Borrar" className="flex min-h-14 items-center justify-center rounded-xl bg-cobre-500 text-andino-950"><Delete className="h-6 w-6" /></button>
      <button type="button" onClick={() => alDigito('0')} className="min-h-14 rounded-xl bg-slate-100 text-2xl font-bold text-andino-900 active:bg-slate-300">0</button>
      <button type="button" onClick={alAceptar} disabled={!aceptarOk} className="min-h-14 rounded-xl bg-ok-600 text-lg font-bold text-white disabled:opacity-40">OK</button>
    </div>
  );
}

function Inicio({ tarjeta, setTarjeta, mensaje, alInsertar }: { tarjeta: string; setTarjeta: (v: string) => void; mensaje: { tipo: 'error' | 'ok'; texto: string } | null; alInsertar: () => void }) {
  const valida = /^\d{13,19}$/.test(tarjeta);
  return (
    <Centro>
      <Landmark className="h-14 w-14 text-cobre-400" />
      <h1 className="mt-3 text-3xl font-bold sm:text-4xl">Bienvenido</h1>
      <p className="mt-2 text-andino-200">Inserta tu tarjeta para comenzar</p>
      <div className="mt-6 w-full max-w-sm text-left">
        <Mensaje m={mensaje} />
        <label htmlFor="tarjeta" className="mb-1.5 flex items-center gap-2 text-sm font-semibold text-andino-100"><CreditCard className="h-4 w-4" /> Número de tarjeta</label>
        <input id="tarjeta" inputMode="numeric" autoComplete="off" maxLength={19} value={tarjeta}
          onChange={(e) => setTarjeta(e.target.value.replace(/\D/g, ''))}
          onKeyDown={(e) => e.key === 'Enter' && valida && alInsertar()}
          placeholder="16 dígitos" className="tabular block min-h-14 w-full rounded-xl bg-white px-4 text-center text-xl tracking-widest text-andino-950 placeholder:text-slate-400" />
        <BotonAtm tono="acento" className="mt-4 w-full" disabled={!valida} onClick={alInsertar}>Insertar tarjeta</BotonAtm>
      </div>
    </Centro>
  );
}

function IngresoPin({ ocupado, mensaje, alCancelar, alConfirmar }: { ocupado: boolean; mensaje: { tipo: 'error' | 'ok'; texto: string } | null; alCancelar: () => void; alConfirmar: (pin: string) => Promise<void> }) {
  const [pin, setPin] = useState('');
  const enviar = async () => { await alConfirmar(pin); setPin(''); };
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (/^\d$/.test(e.key)) setPin((p) => (p.length < 4 ? p + e.key : p));
      else if (e.key === 'Backspace') setPin((p) => p.slice(0, -1));
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);
  return (
    <div className="flex flex-col items-center">
      <KeyRound className="h-10 w-10 text-cobre-400" />
      <h2 className="mt-2 text-2xl font-bold">Ingresa tu PIN</h2>
      <div className="my-5 flex gap-3" role="img" aria-label={`${pin.length} de 4 dígitos ingresados`}>
        {[0, 1, 2, 3].map((i) => <span key={i} className={`h-4 w-4 rounded-full ${i < pin.length ? 'bg-cobre-400' : 'bg-white/25'}`} />)}
      </div>
      <div className="w-full max-w-xs"><Mensaje m={mensaje} /></div>
      <Teclado alDigito={(d) => setPin((p) => (p.length < 4 ? p + d : p))} alBorrar={() => setPin((p) => p.slice(0, -1))} alAceptar={() => void enviar()} aceptarOk={pin.length === 4 && !ocupado} />
      <BotonAtm tono="peligro" className="mt-4 w-full max-w-xs" onClick={alCancelar}><X className="h-5 w-5" /> Cancelar</BotonAtm>
    </div>
  );
}

function Menu({ ir, salir }: { ir: (p: Pantalla) => void; salir: () => void }) {
  const op = (p: Pantalla, t: string, I: typeof Wallet) => (
    <BotonAtm key={p} onClick={() => ir(p)} className="min-h-20 flex-col sm:min-h-24"><I className="h-7 w-7" />{t}</BotonAtm>
  );
  return (
    <div>
      <h2 className="mb-6 text-center text-2xl font-bold">¿Qué deseas hacer?</h2>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {op('saldo', 'Consultar saldo', Wallet)}
        {op('retiro', 'Retirar dinero', Banknote)}
        {op('movimientos', 'Últimos movimientos', History)}
        {op('transferir', 'Transferir', Send)}
        {op('cambiopin', 'Cambiar PIN', KeyRound)}
        <BotonAtm tono="peligro" onClick={salir} className="min-h-20 flex-col sm:min-h-24"><X className="h-7 w-7" />Finalizar sesión</BotonAtm>
      </div>
    </div>
  );
}

const Volver = ({ onClick }: { onClick: () => void }) => (
  <BotonAtm onClick={onClick} className="mt-6 w-full bg-slate-600 hover:bg-slate-500"><ArrowLeft className="h-5 w-5" /> Volver al menú</BotonAtm>
);

type ConAtm = <T>(fn: () => Promise<T>) => Promise<T | undefined>;

function Saldo({ conAtm, volver, mensaje }: { conAtm: ConAtm; volver: () => void; mensaje: { tipo: 'error' | 'ok'; texto: string } | null }) {
  const [d, setD] = useState<{ cuenta: string; moneda: string; saldoContable: string; saldoDisponible: string } | null>(null);
  useEffect(() => { void conAtm(() => api('/atm/balance', { kind: 'atm' })).then((r) => r && setD(r)); /* eslint-disable-next-line */ }, []);
  return (
    <Centro>
      <Mensaje m={mensaje} />
      {d && (
        <>
          <p className="text-andino-200">Saldo disponible</p>
          <p className="tabular mt-1 break-words text-4xl font-bold text-cobre-400 sm:text-5xl">{dinero(d.saldoDisponible, d.moneda)}</p>
          <p className="mt-4 text-sm text-andino-200">Saldo contable {dinero(d.saldoContable, d.moneda)}</p>
          <p className="font-mono text-xs text-andino-300">Cuenta {d.cuenta}</p>
        </>
      )}
      <div className="w-full max-w-sm"><Volver onClick={volver} /></div>
    </Centro>
  );
}

function Movimientos({ conAtm, volver, mensaje }: { conAtm: ConAtm; volver: () => void; mensaje: { tipo: 'error' | 'ok'; texto: string } | null }) {
  const [items, setItems] = useState<{ id: number; tipo: string; sentido: 'D' | 'C'; monto: string; creado_en: string }[] | null>(null);
  useEffect(() => { void conAtm(() => api<{ items: any[] }>('/atm/movements', { kind: 'atm' })).then((r) => r && setItems(r.items)); /* eslint-disable-next-line */ }, []);
  return (
    <div>
      <h2 className="mb-4 text-center text-2xl font-bold">Últimos movimientos</h2>
      <Mensaje m={mensaje} />
      {items && (items.length ? (
        <ul className="divide-y divide-white/10 rounded-xl bg-white/5">
          {items.map((m) => (
            <li key={m.id} className="flex items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0"><div className="font-semibold">{ETIQUETA_TIPO[m.tipo] ?? m.tipo}</div><div className="text-xs text-andino-200">{fecha(m.creado_en)}</div></div>
              <div className={`tabular shrink-0 font-bold ${m.sentido === 'C' ? 'text-emerald-300' : 'text-red-300'}`}>{m.sentido === 'C' ? '+' : '−'}{dinero(m.monto)}</div>
            </li>
          ))}
        </ul>
      ) : <p className="py-10 text-center text-andino-200">Sin movimientos.</p>)}
      <Volver onClick={volver} />
    </div>
  );
}

function Retiro({ conAtm, ocupado, mensaje, volver, alExito }: { conAtm: ConAtm; ocupado: boolean; mensaje: { tipo: 'error' | 'ok'; texto: string } | null; volver: () => void; alExito: (r: Recibo) => void }) {
  const [otro, setOtro] = useState(false);
  const [texto, setTexto] = useState('');
  // Una clave por intento de retiro: un reintento por falla de red no puede dispensar dos veces.
  const clave = useRef(nuevaClave());
  const [pend, setPend] = useState<number | null>(null);

  async function retirar(monto: number) {
    const r = await conAtm(() => api<{ comprobante: { id: string; creado_en: string }; saldoDisponible: string }>('/atm/withdraw', {
      method: 'POST', kind: 'atm', idempotencyKey: clave.current, body: { monto },
    }));
    if (r) {
      clave.current = nuevaClave();
      setPend(null);
      alExito({ titulo: 'Retiro exitoso', lineas: [['Valor retirado', dinero(monto)], ['Saldo disponible', dinero(r.saldoDisponible)], ['Referencia', r.comprobante.id.slice(0, 8).toUpperCase()], ['Fecha', fecha(r.comprobante.creado_en)]] });
    }
    // Si fallo (red, 5xx) NO se limpia `pend`: el usuario sigue en la confirmacion y reintenta con la MISMA clave,
    // de modo que un retiro que el servidor si proceso no se dispensa dos veces.
  }

  const monto = Number(texto);
  const valido = monto >= 10_000 && monto <= 1_500_000 && monto % 10_000 === 0;

  if (pend !== null) {
    return (
      <Centro>
        <p className="text-andino-200">¿Confirmas el retiro de</p>
        <p className="tabular my-3 text-5xl font-bold text-cobre-400">{dinero(pend)}</p>
        <Mensaje m={mensaje} />
        <div className="grid w-full max-w-sm grid-cols-2 gap-3">
          <BotonAtm tono="acento" disabled={ocupado} onClick={() => void retirar(pend)}>Confirmar</BotonAtm>
          <BotonAtm tono="peligro" disabled={ocupado} onClick={() => setPend(null)}>Cancelar</BotonAtm>
        </div>
      </Centro>
    );
  }

  return (
    <div>
      <h2 className="mb-1 text-center text-2xl font-bold">Retirar dinero</h2>
      <p className="mb-5 text-center text-sm text-andino-200">Múltiplos de $10.000 · máximo $1.500.000 por operación</p>
      <Mensaje m={mensaje} />
      {!otro ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {MONTOS.map((m) => <BotonAtm key={m} disabled={ocupado} onClick={() => { clave.current = nuevaClave(); setPend(m); }}>{dinero(m).replace(',00', '')}</BotonAtm>)}
          <BotonAtm tono="acento" className="col-span-2 sm:col-span-3" onClick={() => setOtro(true)}>Otro valor</BotonAtm>
        </div>
      ) : (
        <div className="flex flex-col items-center">
          <div className="tabular mb-4 min-h-12 w-full max-w-xs rounded-xl bg-white px-4 py-2 text-center text-3xl font-bold text-andino-900">{texto ? dinero(texto).replace(',00', '') : '$ 0'}</div>
          <Teclado alDigito={(d) => setTexto((t) => (t.length < 8 ? (t + d).replace(/^0+/, '') : t))} alBorrar={() => setTexto((t) => t.slice(0, -1))}
            alAceptar={() => { clave.current = nuevaClave(); setPend(monto); }} aceptarOk={valido && !ocupado} />
          {texto && !valido && <p className="mt-3 text-sm text-red-300">Ingresa un múltiplo de $10.000.</p>}
        </div>
      )}
      <Volver onClick={volver} />
    </div>
  );
}

function Transferir({ conAtm, ocupado, mensaje, volver, alExito }: { conAtm: ConAtm; ocupado: boolean; mensaje: { tipo: 'error' | 'ok'; texto: string } | null; volver: () => void; alExito: (r: Recibo) => void }) {
  const [cuenta, setCuenta] = useState('');
  const [monto, setMonto] = useState('');
  const clave = useRef(nuevaClave());
  const valida = /^LB-\d{10}$/.test(cuenta.toUpperCase()) && /^\d{1,10}$/.test(monto) && Number(monto) > 0;

  async function enviar() {
    const r = await conAtm(() => api<{ comprobante: { id: string; creado_en: string }; saldoDisponible: string }>('/atm/transfer', {
      method: 'POST', kind: 'atm', idempotencyKey: clave.current, body: { cuentaDestino: cuenta.toUpperCase(), monto },
    }));
    if (r) {
      clave.current = nuevaClave();
      alExito({ titulo: 'Transferencia exitosa', lineas: [['Cuenta destino', cuenta.toUpperCase()], ['Valor', dinero(monto)], ['Saldo disponible', dinero(r.saldoDisponible)], ['Referencia', r.comprobante.id.slice(0, 8).toUpperCase()]] });
    }
  }
  const inp = 'tabular mt-1 block min-h-12 w-full rounded-xl bg-white px-4 text-lg text-andino-950';
  return (
    <div className="mx-auto max-w-sm">
      <h2 className="mb-5 text-center text-2xl font-bold">Transferir</h2>
      <Mensaje m={mensaje} />
      <label className="block text-sm font-semibold">Cuenta destino
        <input className={inp} value={cuenta} onChange={(e) => { setCuenta(e.target.value); clave.current = nuevaClave(); }} placeholder="LB-0000000001" autoComplete="off" />
      </label>
      <label className="mt-4 block text-sm font-semibold">Valor (COP)
        <input className={inp} inputMode="numeric" value={monto} onChange={(e) => { setMonto(e.target.value.replace(/\D/g, '')); clave.current = nuevaClave(); }} placeholder="0" autoComplete="off" />
      </label>
      <BotonAtm tono="acento" className="mt-5 w-full" disabled={!valida || ocupado} onClick={() => void enviar()}>Confirmar transferencia</BotonAtm>
      <Volver onClick={volver} />
    </div>
  );
}

function CambioPin({ conAtm, ocupado, mensaje, volver, alExito }: { conAtm: ConAtm; ocupado: boolean; mensaje: { tipo: 'error' | 'ok'; texto: string } | null; volver: () => void; alExito: () => void }) {
  const [actual, setActual] = useState('');
  const [nuevo, setNuevo] = useState('');
  const [repite, setRepite] = useState('');
  const solo4 = (set: (v: string) => void) => (e: { target: { value: string } }) => set(e.target.value.replace(/\D/g, '').slice(0, 4));
  const valido = actual.length === 4 && nuevo.length === 4 && nuevo === repite;
  const inp = 'tabular mt-1 block min-h-12 w-full rounded-xl bg-white px-4 text-center text-xl tracking-[0.5em] text-andino-950';
  return (
    <div className="mx-auto max-w-sm">
      <h2 className="mb-5 text-center text-2xl font-bold">Cambiar PIN</h2>
      <Mensaje m={mensaje} />
      <label className="block text-sm font-semibold">PIN actual<input className={inp} type="password" inputMode="numeric" value={actual} onChange={solo4(setActual)} autoComplete="off" /></label>
      <label className="mt-3 block text-sm font-semibold">PIN nuevo<input className={inp} type="password" inputMode="numeric" value={nuevo} onChange={solo4(setNuevo)} autoComplete="off" /></label>
      <label className="mt-3 block text-sm font-semibold">Repite el PIN nuevo<input className={inp} type="password" inputMode="numeric" value={repite} onChange={solo4(setRepite)} autoComplete="off" /></label>
      {repite && nuevo !== repite && <p className="mt-2 text-sm text-red-300">Los PIN no coinciden.</p>}
      <BotonAtm tono="acento" className="mt-5 w-full" disabled={!valido || ocupado}
        onClick={() => void conAtm(() => api('/atm/change-pin', { method: 'POST', kind: 'atm', body: { pinActual: actual, pinNuevo: nuevo } })).then((r) => r && alExito())}>
        Cambiar PIN
      </BotonAtm>
      <Volver onClick={volver} />
    </div>
  );
}

function ReciboPantalla({ r, volver, salir }: { r: Recibo; volver: () => void; salir: () => void }) {
  return (
    <Centro>
      <div className="w-full max-w-sm rounded-xl bg-white p-5 text-left font-mono text-sm text-slate-800 shadow-lg">
        <div className="mb-3 text-center font-sans text-base font-bold text-andino-900">{r.titulo}</div>
        <dl className="space-y-1.5">
          {r.lineas.map(([k, v]) => <div key={k} className="flex justify-between gap-3"><dt className="text-slate-500">{k}</dt><dd className="break-all text-right font-semibold">{v}</dd></div>)}
        </dl>
        <p className="mt-3 border-t border-dashed border-slate-300 pt-2 text-center text-[10px] text-slate-500">Banco Andino · simulación académica</p>
      </div>
      <div className="mt-5 grid w-full max-w-sm grid-cols-2 gap-3">
        <BotonAtm onClick={volver}>Otra operación</BotonAtm>
        <BotonAtm tono="peligro" onClick={salir}>Finalizar</BotonAtm>
      </div>
    </Centro>
  );
}
