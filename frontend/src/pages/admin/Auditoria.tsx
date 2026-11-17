import { ChevronDown, ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { Aviso, Campo, Cargando, EncabezadoPagina, EtiquetaEstado, Paginacion, Seleccion, Tarjeta, Vacio } from '../../components/ui';
import { api } from '../../lib/api';
import { fecha } from '../../lib/format';
import { useCarga } from '../../lib/hooks';

interface Evento {
  id: number; tabla: string; operacion: string; usuario: string; usuario_app_id: number | null; username: string | null;
  rol: string | null; ip: string | null; registro_id: string | null; resultado: string;
  antes: Record<string, unknown> | null; despues: Record<string, unknown> | null; ocurrido_en: string;
}
const LIMITE = 25;

/** Responde: ¿quién lo hizo?, ¿qué cambió?, ¿cuándo?, ¿sobre qué registro?, ¿qué había antes y qué quedó? */
export default function Auditoria() {
  const [tabla, setTabla] = useState('');
  const [registroId, setRegistroId] = useState('');
  const [resultado, setResultado] = useState('');
  const [operacion, setOperacion] = useState('');
  const [desde, setDesde] = useState(0);
  const [abierta, setAbierta] = useState<number | null>(null);

  const { data, error, cargando } = useCarga(
    () => api<{ total: number; totalTruncado?: boolean; items: Evento[] }>('/audit', { query: { tabla, registroId, resultado, operacion, limit: LIMITE, offset: desde } }),
    [tabla, registroId, resultado, operacion, desde],
  );
  const reinicia = <T,>(f: (v: T) => void) => (v: T) => { f(v); setDesde(0); };

  return (
    <>
      <EncabezadoPagina titulo="Auditoría" descripcion="Bitácora inmutable de operaciones críticas, accesos y cambios." />
      <Tarjeta>
        <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Seleccion etiqueta="Tabla" value={tabla} onChange={(e) => reinicia(setTabla)(e.target.value)}>
            <option value="">Todas</option>
            {['nucleo.transaccion', 'nucleo.cuenta', 'nucleo.cliente', 'nucleo.tarjeta', 'nucleo.llave_brebe', 'seguridad.usuario', 'seguridad.usuario_rol', 'seguridad.rol_permiso', 'api.ruta'].map((t) => <option key={t}>{t}</option>)}
          </Seleccion>
          <Campo etiqueta="ID del registro" value={registroId} onChange={(e) => reinicia(setRegistroId)(e.target.value)} placeholder="id o uuid" />
          <Seleccion etiqueta="Operación" value={operacion} onChange={(e) => reinicia(setOperacion)(e.target.value)}>
            <option value="">Todas</option>
            {['INSERT', 'UPDATE', 'DELETE', 'LOGIN', 'LOGOUT', 'ACCESO', 'ATM_LOGIN'].map((t) => <option key={t}>{t}</option>)}
          </Seleccion>
          <Seleccion etiqueta="Resultado" value={resultado} onChange={(e) => reinicia(setResultado)(e.target.value)}>
            <option value="">Todos</option><option>OK</option><option>DENEGADO</option><option>ERROR</option>
          </Seleccion>
        </div>
        {error && <Aviso tipo="error">{error}</Aviso>}
        {cargando && !data ? <Cargando /> : data && (data.items.length === 0 ? <Vacio>Sin eventos para estos filtros.</Vacio> : (
          <>
            <ul className="divide-y divide-slate-100">
              {data.items.map((e) => {
                const abre = abierta === e.id;
                return (
                  <li key={e.id} className="py-3">
                    <button type="button" aria-expanded={abre} onClick={() => setAbierta(abre ? null : e.id)} className="flex w-full items-start gap-3 text-left">
                      {abre ? <ChevronDown className="mt-1 h-4 w-4 shrink-0" /> : <ChevronRight className="mt-1 h-4 w-4 shrink-0" />}
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                          <span className="font-semibold text-andino-900">{e.operacion}</span>
                          <span className="font-mono text-xs text-slate-600">{e.tabla}{e.registro_id ? ` #${e.registro_id.slice(0, 13)}` : ''}</span>
                          <EtiquetaEstado estado={e.resultado} />
                        </div>
                        <div className="mt-0.5 text-xs text-slate-500">
                          {fecha(e.ocurrido_en)} · {e.username ?? e.usuario}{e.rol ? ` (${e.rol})` : ''}{e.ip ? ` · ${e.ip}` : ''}
                        </div>
                      </div>
                    </button>
                    {abre && (
                      <div className="mt-3 grid gap-3 pl-7 md:grid-cols-2">
                        <Bloque titulo="Antes" valor={e.antes} />
                        <Bloque titulo="Después / detalle" valor={e.despues} />
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
            <Paginacion truncado={data.totalTruncado} total={data.total} limite={LIMITE} desplazamiento={desde} alCambiar={setDesde} />
          </>
        ))}
      </Tarjeta>
    </>
  );
}

function Bloque({ titulo, valor }: { titulo: string; valor: Record<string, unknown> | null }) {
  return (
    <div className="min-w-0">
      <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">{titulo}</div>
      <pre className="max-h-64 overflow-auto rounded-lg bg-andino-950 p-3 text-xs leading-relaxed text-andino-100">
        {valor ? JSON.stringify(valor, null, 2) : '—'}
      </pre>
    </div>
  );
}
