import { Printer } from 'lucide-react';
import { dinero, ETIQUETA_CANAL, ETIQUETA_TIPO, fecha } from '../lib/format';
import { Logo } from './Logo';
import { Boton, Modal } from './ui';

export interface TransaccionVista {
  id: string;
  tipo: string;
  estado: string;
  monto: string;
  canal: string;
  concepto: string | null;
  numero_debito: string;
  numero_credito: string;
  moneda: string;
  creado_en: string;
  reversa_de?: string | null;
}

function Fila({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-baseline justify-between gap-6 py-2 text-sm">
      <dt className="text-slate-500">{k}</dt>
      <dd className="min-w-0 break-words text-right font-medium text-andino-950">{v}</dd>
    </div>
  );
}

/** Comprobante imprimible de una transaccion contabilizada. */
export function Comprobante({ tx, alCerrar }: { tx: TransaccionVista | null; alCerrar: () => void }) {
  if (!tx) return null;
  return (
    <Modal abierto titulo="Comprobante de operación" alCerrar={alCerrar}>
      <div className="rounded-xl border border-slate-200 p-4">
        <Logo />
        <div className="tabular mt-4 text-3xl font-bold text-andino-900">{dinero(tx.monto, tx.moneda)}</div>
        <div className="mt-1 text-sm font-semibold text-ok-700">Operación {tx.estado === 'POSTED' ? 'contabilizada' : tx.estado}</div>
        <dl className="mt-3 divide-y divide-slate-100">
          <Fila k="Tipo" v={ETIQUETA_TIPO[tx.tipo] ?? tx.tipo} />
          <Fila k="Canal" v={ETIQUETA_CANAL[tx.canal] ?? tx.canal} />
          <Fila k="Cuenta origen" v={tx.numero_debito} />
          <Fila k="Cuenta destino" v={tx.numero_credito} />
          <Fila k="Concepto" v={tx.concepto || '—'} />
          <Fila k="Fecha" v={fecha(tx.creado_en)} />
          <Fila k="Referencia" v={tx.id.slice(0, 8).toUpperCase()} />
        </dl>
        <p className="mt-3 text-[11px] text-slate-500">Proyecto académico · datos sintéticos.</p>
      </div>
      <div className="no-print mt-4 flex justify-end gap-2">
        <Boton variante="secundario" onClick={() => window.print()}><Printer className="h-4 w-4" /> Imprimir</Boton>
        <Boton onClick={alCerrar}>Listo</Boton>
      </div>
    </Modal>
  );
}
