import { FlaskConical, KeyRound, Send, Trash2 } from 'lucide-react';
import { FormEvent, useRef, useState } from 'react';
import { Comprobante, TransaccionVista } from '../../components/Comprobante';
import { CuentaVista } from '../../components/CuentaTarjeta';
import { Aviso, Boton, Campo, CampoMonto, Cargando, EncabezadoPagina, ErrorCarga, Etiqueta, EtiquetaEstado, Seleccion, Tabla, Tarjeta } from '../../components/ui';
import { api } from '../../lib/api';
import { dinero, fecha, montoValido } from '../../lib/format';
import { useAccion, useCarga, useClaveIdempotencia } from '../../lib/hooks';

interface Llave { id: number; cuenta_id: number; numero: string; tipo: string; valor: string; estado: string }
interface Envio { id: string; numero_debito: string; numero_credito: string; monto: string; concepto: string | null; creado_en: string; moneda: string }

const TIPOS: Record<string, { texto: string; ejemplo: string }> = {
  celular: { texto: 'Celular', ejemplo: '3001234567' },
  correo: { texto: 'Correo', ejemplo: 'nombre@correo.com' },
  documento: { texto: 'Documento', ejemplo: '1000000001' },
  alfanumerica: { texto: 'Alfanumérica', ejemplo: '@minombre' },
};

export default function BreB() {
  const llaves = useCarga(() => api<{ items: Llave[] }>('/brebe/keys'), []);
  const historial = useCarga(() => api<{ items: Envio[] }>('/brebe/history', { query: { limit: 10 } }), []);
  const cuentas = useCarga(() => api<{ items: CuentaVista[] }>('/accounts', { query: { limit: 100 } }), []);
  const [comprobante, setComprobante] = useState<TransaccionVista | null>(null);

  const fallo = (!cuentas.data && cuentas.error) || (!llaves.data && llaves.error);
  if (fallo) return <ErrorCarga mensaje={fallo} alReintentar={() => { cuentas.recargar(); llaves.recargar(); historial.recargar(); }} />;
  if (!cuentas.data || !llaves.data) return <Cargando />;
  const cop = cuentas.data.items.filter((c) => c.estado === 'activa' && c.moneda === 'COP');
  const activas = llaves.data.items.filter((l) => l.estado === 'activa');

  return (
    <>
      <EncabezadoPagina titulo="Bre-B" descripcion="Envía dinero con una llave, sin digitar números de cuenta." />
      <Aviso tipo="aviso" className="mb-6">
        <span className="inline-flex items-center gap-1.5 font-semibold"><FlaskConical className="h-4 w-4" /> Módulo académico simulado.</span>{' '}
        No existe conexión con la red real de pagos inmediatos; las operaciones usan el mismo motor contable, límites y auditoría del banco.
      </Aviso>

      <div className="grid gap-6 lg:grid-cols-2">
        <EnviarBreB cuentas={cop} alTerminar={(tx) => { setComprobante(tx); cuentas.recargar(); historial.recargar(); }} />
        <MisLlaves cuentas={cop} llaves={activas} alCambiar={llaves.recargar} />
      </div>

      <Tarjeta titulo="Historial Bre-B" className="mt-6">
        {historial.error && <ErrorCarga mensaje={historial.error} alReintentar={historial.recargar} />}
        <Tabla
          filas={historial.data?.items ?? []}
          clave={(e) => e.id}
          vacio="Aún no tienes envíos ni recepciones Bre-B."
          columnas={[
            { titulo: 'Fecha', principal: true, celda: (e) => fecha(e.creado_en) },
            { titulo: 'Origen', celda: (e) => <span className="font-mono text-xs">{e.numero_debito}</span> },
            { titulo: 'Destino', celda: (e) => <span className="font-mono text-xs">{e.numero_credito}</span> },
            { titulo: 'Concepto', celda: (e) => e.concepto || '—' },
            { titulo: 'Valor', alinear: 'der', celda: (e) => dinero(e.monto, e.moneda) },
          ]}
        />
      </Tarjeta>
      <Comprobante tx={comprobante} alCerrar={() => setComprobante(null)} />
    </>
  );
}

function EnviarBreB({ cuentas, alTerminar }: { cuentas: CuentaVista[]; alTerminar: (tx: TransaccionVista) => void }) {
  const [origen, setOrigen] = useState('');
  const [llave, setLlave] = useState('');
  const [titular, setTitular] = useState<string | null>(null);
  const [monto, setMonto] = useState('');
  const [concepto, setConcepto] = useState('');
  const [enviado, setEnviado] = useState(false);
  const clave = useClaveIdempotencia();
  const buscar = useAccion();
  const enviar = useAccion();

  // Llave que el usuario tiene escrita AHORA: una verificacion que llega tarde (ya cambio la llave) se descarta, para que
  // "Destinatario: X" nunca corresponda a una llave distinta de la que se enviara.
  const llaveActual = useRef('');

  async function resolver() {
    const consultada = llave.trim();
    setTitular(null);
    const r = await buscar.ejecutar(() => api<{ titular: string }>('/brebe/resolve', { query: { llave: consultada } }));
    if (r && llaveActual.current.trim() === consultada) setTitular(r.titular);
  }

  async function confirmar(e: FormEvent) {
    e.preventDefault();
    const r = await enviar.ejecutar(() => api<{ comprobante: TransaccionVista }>('/brebe/send', {
      method: 'POST', idempotencyKey: clave.clave(),
      body: { cuentaOrigenId: Number(origen), llave: llave.trim(), monto, concepto: concepto.trim() || undefined },
    }));
    if (r) {
      clave.renovar();
      setEnviado(true);
      setMonto(''); setConcepto(''); setTitular(null); setLlave(''); llaveActual.current = '';
      alTerminar(r.comprobante);
    }
  }

  return (
    <Tarjeta titulo="Enviar con Bre-B">
      <form onSubmit={confirmar} className="space-y-4" noValidate>
        {enviar.error && <Aviso tipo="error">{enviar.error}</Aviso>}
        {enviado && <Aviso tipo="ok">Envío realizado.</Aviso>}
        <Seleccion etiqueta="Desde la cuenta" value={origen} onChange={(e) => { setOrigen(e.target.value); clave.renovar(); }}>
          <option value="">Selecciona una cuenta</option>
          {cuentas.map((c) => <option key={c.cuenta_id} value={c.cuenta_id}>{c.numero} · {dinero(c.saldo_disponible)}</option>)}
        </Seleccion>
        <div className="flex items-end gap-2">
          <div className="flex-1"><Campo etiqueta="Llave del destinatario" placeholder="@usuario, celular, correo…" value={llave} onChange={(e) => { llaveActual.current = e.target.value; setLlave(e.target.value); setTitular(null); setEnviado(false); clave.renovar(); }} /></div>
          <Boton variante="secundario" cargando={buscar.enviando} disabled={llave.trim().length < 3} onClick={() => void resolver()}>Verificar</Boton>
        </div>
        {buscar.error && <Aviso tipo="error">{buscar.error}</Aviso>}
        {titular && <Aviso tipo="ok">Destinatario: <span className="font-semibold">{titular}</span></Aviso>}
        <CampoMonto etiqueta="Monto" valor={monto} alCambiar={(v) => { setMonto(v); clave.renovar(); }} />
        <Campo etiqueta="Concepto (opcional)" maxLength={200} value={concepto} onChange={(e) => { setConcepto(e.target.value); clave.renovar(); }} />
        <Boton type="submit" tamano="lg" className="w-full" cargando={enviar.enviando} disabled={!origen || !titular || !montoValido(monto)}>
          <Send className="h-4 w-4" /> Enviar
        </Boton>
      </form>
    </Tarjeta>
  );
}

function MisLlaves({ cuentas, llaves, alCambiar }: { cuentas: CuentaVista[]; llaves: Llave[]; alCambiar: () => void }) {
  const [cuenta, setCuenta] = useState('');
  const [tipo, setTipo] = useState('alfanumerica');
  const [valor, setValor] = useState('');
  const { enviando, error, ejecutar } = useAccion();

  async function crear(e: FormEvent) {
    e.preventDefault();
    const r = await ejecutar(() => api('/brebe/keys', { method: 'POST', body: { cuentaId: Number(cuenta), tipo, valor: valor.trim() } }));
    if (r) { setValor(''); alCambiar(); }
  }
  async function quitar(id: number) {
    if (!window.confirm('¿Desactivar esta llave? Dejarás de recibir envíos con ella.')) return;
    await ejecutar(() => api(`/brebe/keys/${id}`, { method: 'DELETE' }));
    alCambiar();
  }

  return (
    <Tarjeta titulo="Mis llaves">
      <ul className="mb-5 space-y-2">
        {llaves.map((l) => (
          <li key={l.id} className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 px-4 py-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2"><KeyRound className="h-4 w-4 shrink-0 text-cobre-600" /><span className="truncate font-semibold">{l.valor}</span></div>
              <div className="mt-0.5 flex items-center gap-2 text-xs text-slate-500"><Etiqueta tono="azul">{TIPOS[l.tipo]?.texto}</Etiqueta> <span className="font-mono">{l.numero}</span> <EtiquetaEstado estado={l.estado} /></div>
            </div>
            <button type="button" aria-label={`Desactivar llave ${l.valor}`} onClick={() => void quitar(l.id)} className="rounded-lg p-2 text-slate-500 hover:bg-alerta-100 hover:text-alerta-600">
              <Trash2 className="h-4 w-4" />
            </button>
          </li>
        ))}
        {!llaves.length && <li className="rounded-xl border border-dashed border-slate-300 px-4 py-6 text-center text-sm text-slate-500">Aún no tienes llaves registradas.</li>}
      </ul>

      <form onSubmit={crear} className="space-y-4 border-t border-slate-100 pt-4" noValidate>
        <h3 className="text-sm font-semibold text-andino-900">Registrar una llave</h3>
        {error && <Aviso tipo="error">{error}</Aviso>}
        <Seleccion etiqueta="Cuenta asociada" value={cuenta} onChange={(e) => setCuenta(e.target.value)}>
          <option value="">Selecciona una cuenta</option>
          {cuentas.map((c) => <option key={c.cuenta_id} value={c.cuenta_id}>{c.numero}</option>)}
        </Seleccion>
        <div className="grid gap-3 sm:grid-cols-2">
          <Seleccion etiqueta="Tipo" value={tipo} onChange={(e) => setTipo(e.target.value)}>
            {Object.entries(TIPOS).map(([k, v]) => <option key={k} value={k}>{v.texto}</option>)}
          </Seleccion>
          <Campo etiqueta="Valor" placeholder={TIPOS[tipo].ejemplo} value={valor} onChange={(e) => setValor(e.target.value)} />
        </div>
        <Boton type="submit" cargando={enviando} disabled={!cuenta || valor.trim().length < 3}>Registrar llave</Boton>
      </form>
    </Tarjeta>
  );
}
