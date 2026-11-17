import { ArrowDownLeft, ArrowUpRight, CreditCard, Lock, SlidersHorizontal, Unlock } from 'lucide-react';
import { FormEvent, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Comprobante, TransaccionVista } from '../../components/Comprobante';
import { CuentaVista } from '../../components/CuentaTarjeta';
import {
  Aviso, AreaTexto, Boton, Campo, CampoMonto, Cargando, EncabezadoPagina, ErrorCarga, Etiqueta, EtiquetaEstado, Indicador, Modal, Paginacion, Tabla, Tarjeta,
} from '../../components/ui';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { dinero, ETIQUETA_CANAL, ETIQUETA_TIPO, fecha, montoValido } from '../../lib/format';
import { mensajeDe, useAccion, useCarga } from '../../lib/hooks';

interface Detalle extends CuentaVista {
  titulares: { cliente_id: number; nombre: string; documento: string; rol: string }[];
}
interface Mov { id: number; transaccion_id: string; tipo: string; canal: string; concepto: string | null; sentido: 'D' | 'C'; monto: string; saldo_posterior: string; creado_en: string }
interface Evento { id: number; tipo: string; motivo: string | null; creado_en: string; datos: Record<string, unknown> | null }

const POR_PAGINA = 15;

export default function CuentaDetalle() {
  const id = Number(useParams().id);
  const { puede } = useAuth();
  const cuenta = useCarga(() => api<Detalle>(`/accounts/${id}`), [id]);
  const [desde, setDesde] = useState(0);
  const movs = useCarga(() => api<{ total: number; totalTruncado?: boolean; items: Mov[] }>(`/accounts/${id}/statement`, { query: { limit: POR_PAGINA, offset: desde } }), [id, desde]);
  const eventos = useCarga(
    () => (puede('accounts:read') ? api<{ items: Evento[] }>(`/accounts/${id}/events`) : Promise.resolve({ items: [] as Evento[] })),
    [id],
  );

  const [modal, setModal] = useState<null | 'estado' | 'limites' | 'tarjeta'>(null);
  const [comprobante, setComprobante] = useState<TransaccionVista | null>(null);
  const [errorComprobante, setErrorComprobante] = useState<string | null>(null);

  if (cuenta.cargando && !cuenta.data) return <Cargando />;
  if (cuenta.error || !cuenta.data) return <Aviso tipo="error">{cuenta.error ?? 'Cuenta no encontrada.'}</Aviso>;
  const c = cuenta.data;
  const cierraYRecarga = () => { setModal(null); cuenta.recargar(); movs.recargar(); eventos.recargar(); };

  async function verComprobante(txId: string) {
    setErrorComprobante(null);
    try {
      setComprobante(await api<TransaccionVista>(`/transactions/${txId}`));
    } catch (e) {
      setErrorComprobante(mensajeDe(e));
    }
  }

  return (
    <>
      <EncabezadoPagina
        titulo={c.producto}
        descripcion={`${c.numero} · ${c.oficina} · ${c.tipo_titularidad}`}
        acciones={
          <>
            {puede('accounts:state') && c.estado !== 'cerrada' && (
              <Boton variante="secundario" onClick={() => setModal('estado')}>
                {c.estado === 'bloqueada' ? <Unlock className="h-4 w-4" /> : <Lock className="h-4 w-4" />} Cambiar estado
              </Boton>
            )}
            {puede('accounts:limits') && c.estado !== 'cerrada' && (
              <Boton variante="secundario" onClick={() => setModal('limites')}><SlidersHorizontal className="h-4 w-4" /> Límites</Boton>
            )}
            {puede('accounts:write') && c.estado === 'activa' && (
              <Boton variante="secundario" onClick={() => setModal('tarjeta')}><CreditCard className="h-4 w-4" /> Emitir tarjeta</Boton>
            )}
          </>
        }
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Indicador etiqueta="Saldo disponible" valor={dinero(c.saldo_disponible, c.moneda)} />
        <Indicador etiqueta="Saldo contable" valor={dinero(c.saldo_contable, c.moneda)} />
        <Indicador etiqueta="Límite retiro diario" valor={dinero(c.limite_retiro_diario, c.moneda)} />
        <Indicador etiqueta="Límite transferencia diaria" valor={dinero(c.limite_transferencia_diaria, c.moneda)} nota={Number(c.sobregiro_autorizado) > 0 ? `Sobregiro autorizado ${dinero(c.sobregiro_autorizado, c.moneda)}` : undefined} />
      </div>

      <div className="mb-6 flex flex-wrap items-center gap-3 text-sm">
        <EtiquetaEstado estado={c.estado} />
        {c.titulares.map((t) => <Etiqueta key={t.cliente_id} tono="azul">{t.rol}: {t.nombre}</Etiqueta>)}
      </div>

      <Tarjeta titulo="Movimientos" className="mb-6">
        {errorComprobante && <Aviso tipo="error" className="mb-3">{errorComprobante}</Aviso>}
        {movs.cargando && !movs.data && <Cargando texto="Cargando movimientos…" />}
        {movs.error && <ErrorCarga mensaje={movs.error} alReintentar={movs.recargar} />}
        {movs.data && (
          <>
            <Tabla
              filas={movs.data.items}
              clave={(m) => m.id}
              vacio="Esta cuenta aún no tiene movimientos."
              alClic={(m) => void verComprobante(m.transaccion_id)}
              columnas={[
                {
                  titulo: 'Operación', principal: true,
                  celda: (m) => (
                    <span className="inline-flex items-center gap-2">
                      {m.sentido === 'C' ? <ArrowDownLeft className="h-4 w-4 text-ok-600" aria-label="Entrada" /> : <ArrowUpRight className="h-4 w-4 text-alerta-600" aria-label="Salida" />}
                      {ETIQUETA_TIPO[m.tipo] ?? m.tipo}
                    </span>
                  ),
                },
                { titulo: 'Canal', celda: (m) => ETIQUETA_CANAL[m.canal] ?? m.canal },
                { titulo: 'Concepto', celda: (m) => m.concepto || '—' },
                { titulo: 'Fecha', celda: (m) => fecha(m.creado_en) },
                { titulo: 'Valor', alinear: 'der', celda: (m) => <span className={m.sentido === 'C' ? 'text-ok-700' : 'text-alerta-700'}>{m.sentido === 'C' ? '+' : '−'}{dinero(m.monto, c.moneda)}</span> },
                { titulo: 'Saldo', alinear: 'der', celda: (m) => dinero(m.saldo_posterior, c.moneda) },
              ]}
            />
            <Paginacion truncado={movs.data.totalTruncado} total={movs.data.total} limite={POR_PAGINA} desplazamiento={desde} alCambiar={setDesde} />
          </>
        )}
      </Tarjeta>

      {puede('accounts:read') && (
        <Tarjeta titulo="Eventos de la cuenta" accion={<span className="text-xs text-slate-500">No son movimientos de dinero</span>}>
          <Tabla
            filas={eventos.data?.items ?? []}
            clave={(e) => e.id}
            vacio="Sin eventos."
            columnas={[
              { titulo: 'Evento', principal: true, celda: (e) => <Etiqueta tono="azul">{e.tipo}</Etiqueta> },
              { titulo: 'Motivo', celda: (e) => e.motivo || '—' },
              { titulo: 'Fecha', celda: (e) => fecha(e.creado_en) },
            ]}
          />
        </Tarjeta>
      )}

      {modal === 'estado' && <CambioEstado cuenta={c} alCerrar={() => setModal(null)} alTerminar={cierraYRecarga} />}
      {modal === 'limites' && <Limites cuenta={c} alCerrar={() => setModal(null)} alTerminar={cierraYRecarga} />}
      {modal === 'tarjeta' && <EmitirTarjeta cuenta={c} alCerrar={() => setModal(null)} />}
      <Comprobante tx={comprobante} alCerrar={() => setComprobante(null)} />
    </>
  );
}

function CambioEstado({ cuenta, alCerrar, alTerminar }: { cuenta: Detalle; alCerrar: () => void; alTerminar: () => void }) {
  const opciones = {
    pendiente: [['activate', 'Activar cuenta', false]],
    activa: [['block', 'Bloquear cuenta', true], ['close', 'Cerrar cuenta', true]],
    bloqueada: [['unblock', 'Desbloquear cuenta', false], ['close', 'Cerrar cuenta', true]],
    cerrada: [],
  }[cuenta.estado] as [string, string, boolean][];
  const [accion, setAccion] = useState(opciones[0]?.[0] ?? '');
  const [motivo, setMotivo] = useState('');
  const { enviando, error, ejecutar } = useAccion();
  const sel = opciones.find((o) => o[0] === accion);
  const requiere = sel?.[2] ?? false;

  async function enviar(e: FormEvent) {
    e.preventDefault();
    const r = await ejecutar(() => api(`/accounts/${cuenta.cuenta_id}/${accion}`, { method: 'POST', body: { motivo: motivo.trim() || undefined } }));
    if (r) alTerminar();
  }
  return (
    <Modal abierto titulo="Cambiar estado de la cuenta" alCerrar={alCerrar}>
      <form onSubmit={enviar} className="space-y-4">
        {error && <Aviso tipo="error">{error}</Aviso>}
        <div className="space-y-2">
          {opciones.map(([v, t]) => (
            <label key={v} className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border border-slate-200 px-3 py-2 text-sm has-[:checked]:border-andino-500 has-[:checked]:bg-andino-50">
              <input type="radio" name="accion" checked={accion === v} onChange={() => setAccion(v)} /> {t}
            </label>
          ))}
        </div>
        <AreaTexto etiqueta={requiere ? 'Motivo (obligatorio)' : 'Motivo (opcional)'} value={motivo} onChange={(e) => setMotivo(e.target.value)} maxLength={200} />
        {accion === 'close' && <Aviso tipo="aviso">El cierre es definitivo y exige saldo cero.</Aviso>}
        <div className="flex justify-end gap-2">
          <Boton variante="secundario" onClick={alCerrar}>Cancelar</Boton>
          <Boton type="submit" variante={accion === 'close' || accion === 'block' ? 'peligro' : 'primario'} cargando={enviando} disabled={!accion || (requiere && motivo.trim().length < 5)}>
            Confirmar
          </Boton>
        </div>
      </form>
    </Modal>
  );
}

function Limites({ cuenta, alCerrar, alTerminar }: { cuenta: Detalle; alCerrar: () => void; alTerminar: () => void }) {
  // Los limites viajan como texto decimal exacto ("2000000.00"): no se pasan por Number.
  const [retiro, setRetiro] = useState(cuenta.limite_retiro_diario);
  const [transf, setTransf] = useState(cuenta.limite_transferencia_diaria);
  const [motivo, setMotivo] = useState('');
  const { enviando, error, ejecutar } = useAccion();
  async function enviar(e: FormEvent) {
    e.preventDefault();
    const r = await ejecutar(() => api(`/accounts/${cuenta.cuenta_id}/limits`, {
      method: 'PUT', body: { retiroDiario: retiro, transferenciaDiaria: transf, motivo: motivo.trim() },
    }));
    if (r) alTerminar();
  }
  return (
    <Modal abierto titulo="Cambiar límites" alCerrar={alCerrar}>
      <form onSubmit={enviar} className="space-y-4">
        {error && <Aviso tipo="error">{error}</Aviso>}
        <CampoMonto etiqueta="Límite de retiro diario" valor={retiro} alCambiar={setRetiro} />
        <CampoMonto etiqueta="Límite de transferencia diaria" valor={transf} alCambiar={setTransf} />
        <AreaTexto etiqueta="Motivo (obligatorio)" value={motivo} onChange={(e) => setMotivo(e.target.value)} maxLength={200} />
        <div className="flex justify-end gap-2">
          <Boton variante="secundario" onClick={alCerrar}>Cancelar</Boton>
          <Boton type="submit" cargando={enviando} disabled={!montoValido(retiro) || !montoValido(transf) || motivo.trim().length < 5}>Guardar</Boton>
        </div>
      </form>
    </Modal>
  );
}

function EmitirTarjeta({ cuenta, alCerrar }: { cuenta: Detalle; alCerrar: () => void }) {
  const [pin, setPin] = useState('');
  const [numero, setNumero] = useState<string | null>(null);
  const { enviando, error, ejecutar } = useAccion();
  async function enviar(e: FormEvent) {
    e.preventDefault();
    const r = await ejecutar(() => api<{ numeroTarjeta: string }>(`/accounts/${cuenta.cuenta_id}/card`, { method: 'POST', body: { pin } }));
    if (r) setNumero(r.numeroTarjeta);
  }
  return (
    // Bloqueado mientras se emite y mientras se muestra el numero: cerrarlo con Esc o un clic fuera lo perderia para siempre.
    <Modal abierto titulo="Emitir tarjeta débito" alCerrar={alCerrar} bloqueado={enviando || !!numero}>
      {numero ? (
        <div className="space-y-4">
          <Aviso tipo="ok">Tarjeta emitida. Entrega este número al cliente: no se vuelve a mostrar.</Aviso>
          <div className="tabular rounded-xl bg-andino-900 p-5 text-center font-mono text-xl tracking-widest text-white">
            {numero.replace(/(\d{4})(?=\d)/g, '$1 ')}
          </div>
          <div className="flex justify-end"><Boton onClick={alCerrar}>Listo</Boton></div>
        </div>
      ) : (
        <form onSubmit={enviar} className="space-y-4">
          {error && <Aviso tipo="error">{error}</Aviso>}
          <Campo etiqueta="PIN inicial (4 dígitos)" inputMode="numeric" maxLength={4} type="password" autoComplete="off" value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} ayuda="El PIN se guarda solo como hash." />
          <div className="flex justify-end gap-2">
            <Boton variante="secundario" onClick={alCerrar}>Cancelar</Boton>
            <Boton type="submit" cargando={enviando} disabled={pin.length !== 4}>Emitir</Boton>
          </div>
        </form>
      )}
    </Modal>
  );
}
