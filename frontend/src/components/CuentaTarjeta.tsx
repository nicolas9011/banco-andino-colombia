import { Link } from 'react-router-dom';
import { dinero } from '../lib/format';
import { EtiquetaEstado } from './ui';

export interface CuentaVista {
  cuenta_id: number;
  numero: string;
  moneda: string;
  saldo_contable: string;
  saldo_disponible: string;
  estado: string;
  producto: string;
  tipo_titularidad: string;
  oficina: string;
  nombre: string;
  cliente_id: number;
  limite_retiro_diario: string;
  limite_transferencia_diaria: string;
  sobregiro_autorizado: string;
}

export function CuentaTarjeta({ c, a }: { c: CuentaVista; a: string }) {
  return (
    <Link
      to={a}
      className="block rounded-2xl border border-slate-200 bg-white p-5 shadow-sm transition hover:border-andino-300 hover:shadow-md"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-andino-900">{c.producto}</div>
          <div className="mt-0.5 font-mono text-xs text-slate-500">{c.numero}</div>
        </div>
        <EtiquetaEstado estado={c.estado} />
      </div>
      <div className="mt-4 text-xs uppercase tracking-wide text-slate-500">Saldo disponible</div>
      <div className="tabular break-words text-2xl font-bold text-andino-900">{dinero(c.saldo_disponible, c.moneda)}</div>
      <div className="mt-1 text-xs text-slate-500">
        Contable {dinero(c.saldo_contable, c.moneda)} · {c.tipo_titularidad}
      </div>
    </Link>
  );
}
