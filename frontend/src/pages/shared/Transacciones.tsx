import { Undo2 } from 'lucide-react';
import { FormEvent, useState } from 'react';
import { Comprobante, TransaccionVista } from '../../components/Comprobante';
import { Aviso, AreaTexto, Boton, Campo, Cargando, EncabezadoPagina, Etiqueta, Modal, Paginacion, Seleccion, Tabla, Tarjeta } from '../../components/ui';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { dinero, ETIQUETA_CANAL, ETIQUETA_TIPO, fecha } from '../../lib/format';
import { useAccion, useCarga, useClaveIdempotencia } from '../../lib/hooks';

const LIMITE = 20;

/** Historial de transacciones. Las contabilizadas son inmutables: la correccion es un REVERSO. */
export default function Transacciones({ propias = false }: { propias?: boolean }) {
  const { usuario, puede } = useAuth();
  const [tipo, setTipo] = useState('');
  const [canal, setCanal] = useState('');
  const [desdeFecha, setDesdeFecha] = useState('');
  const [desde, setDesde] = useState(0);
  const [ver, setVer] = useState<TransaccionVista | null>(null);
  const [reversar, setReversar] = useState<TransaccionVista | null>(null);

  const { data, error, cargando, recargar } = useCarga(
    () => api<{ total: number; totalTruncado?: boolean; items: TransaccionVista[] }>('/transactions', {
      query: { tipo, canal, // medianoche de COLOMBIA (-05:00): new Date('2026-10-07') es medianoche UTC = 19:00 del dia anterior en Bogota
      desde: desdeFecha ? `${desdeFecha}T00:00:00-05:00` : undefined, actorId: propias ? usuario?.id : undefined, limit: LIMITE, offset: desde },
    }),
    [tipo, canal, desdeFecha, desde, propias],
  );

  return (
    <>
      <EncabezadoPagina titulo={propias ? 'Mis operaciones' : 'Transacciones'} descripcion="Registro contable inmutable. Una corrección se hace con un reverso, nunca editando." />
      <Tarjeta>
        <div className="mb-4 grid gap-3 sm:grid-cols-3">
          <Seleccion etiqueta="Tipo" value={tipo} onChange={(e) => { setTipo(e.target.value); setDesde(0); }}>
            <option value="">Todos</option>
            {Object.entries(ETIQUETA_TIPO).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Seleccion>
          <Seleccion etiqueta="Canal" value={canal} onChange={(e) => { setCanal(e.target.value); setDesde(0); }}>
            <option value="">Todos</option>
            {Object.entries(ETIQUETA_CANAL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Seleccion>
          <Campo etiqueta="Desde" type="date" value={desdeFecha} onChange={(e) => { setDesdeFecha(e.target.value); setDesde(0); }} />
        </div>
        {error && <Aviso tipo="error">{error}</Aviso>}
        {cargando && !data ? <Cargando /> : data && (
          <>
            <Tabla
              filas={data.items} clave={(t) => t.id} alClic={setVer}
              columnas={[
                { titulo: 'Operación', principal: true, celda: (t) => <span className="inline-flex items-center gap-2">{ETIQUETA_TIPO[t.tipo] ?? t.tipo}{t.reversa_de && <Etiqueta tono="ambar">reverso</Etiqueta>}</span> },
                { titulo: 'Origen', celda: (t) => <span className="font-mono text-xs">{t.numero_debito}</span> },
                { titulo: 'Destino', celda: (t) => <span className="font-mono text-xs">{t.numero_credito}</span> },
                { titulo: 'Canal', celda: (t) => ETIQUETA_CANAL[t.canal] ?? t.canal },
                { titulo: 'Fecha', celda: (t) => fecha(t.creado_en) },
                { titulo: 'Monto', alinear: 'der', celda: (t) => dinero(t.monto, t.moneda) },
                ...(puede('tx:reverse') ? [{
                  titulo: '', celda: (t: TransaccionVista) => t.tipo === 'reverso' ? null : (
                    <Boton variante="fantasma" tamano="sm" onClick={(e) => { e.stopPropagation(); setReversar(t); }}><Undo2 className="h-4 w-4" /> Reversar</Boton>
                  ),
                }] : []),
              ]}
            />
            <Paginacion truncado={data.totalTruncado} total={data.total} limite={LIMITE} desplazamiento={desde} alCambiar={setDesde} />
          </>
        )}
      </Tarjeta>
      <Comprobante tx={ver} alCerrar={() => setVer(null)} />
      {reversar && <Reverso tx={reversar} alCerrar={() => setReversar(null)} alTerminar={() => { setReversar(null); recargar(); }} />}
    </>
  );
}

function Reverso({ tx, alCerrar, alTerminar }: { tx: TransaccionVista; alCerrar: () => void; alTerminar: () => void }) {
  const [motivo, setMotivo] = useState('');
  const clave = useClaveIdempotencia();
  const { enviando, error, ejecutar } = useAccion();
  async function enviar(e: FormEvent) {
    e.preventDefault();
    const r = await ejecutar(() => api('/transactions/reverse', { method: 'POST', idempotencyKey: clave.clave(), body: { transaccionId: tx.id, motivo: motivo.trim() } }));
    if (r) alTerminar();
  }
  return (
    <Modal abierto titulo="Reversar transacción" alCerrar={alCerrar}>
      <form onSubmit={enviar} className="space-y-4">
        {error && <Aviso tipo="error">{error}</Aviso>}
        <Aviso tipo="aviso">
          Se creará una transacción compensatoria por <strong>{dinero(tx.monto, tx.moneda)}</strong> ({tx.numero_credito} → {tx.numero_debito}).
          La original no se modifica y solo puede reversarse una vez. Si el destino ya gastó el dinero, el reverso se rechaza.
        </Aviso>
        <AreaTexto etiqueta="Motivo (obligatorio)" value={motivo} onChange={(e) => setMotivo(e.target.value)} maxLength={200} />
        <div className="flex justify-end gap-2">
          <Boton variante="secundario" onClick={alCerrar}>Cancelar</Boton>
          <Boton type="submit" variante="peligro" cargando={enviando} disabled={motivo.trim().length < 5}>Reversar</Boton>
        </div>
      </form>
    </Modal>
  );
}
