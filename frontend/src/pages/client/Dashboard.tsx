import { ArrowDownLeft, ArrowUpRight } from 'lucide-react';
import { CuentaTarjeta, CuentaVista } from '../../components/CuentaTarjeta';
import { Aviso, Cargando, EncabezadoPagina, Tabla, Tarjeta, Vacio } from '../../components/ui';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { dinero, ETIQUETA_CANAL, ETIQUETA_TIPO, fecha } from '../../lib/format';
import { useCarga } from '../../lib/hooks';

interface Dash {
  saldoTotal: Record<string, string>;
  cuentas: CuentaVista[];
  movimientosRecientes: { id: number; numero: string; tipo: string; canal: string; concepto: string | null; sentido: 'D' | 'C'; monto: string; creado_en: string }[];
  ultimasTransferencias: { id: string; numero_debito: string; numero_credito: string; monto: string; creado_en: string; canal: string; moneda: string }[];
  alertas: { nivel: 'info' | 'aviso' | 'critico'; mensaje: string }[];
}

export default function DashboardCliente() {
  const { usuario } = useAuth();
  const { data, error, cargando } = useCarga(() => api<Dash>('/me/dashboard'), []);
  if (cargando) return <Cargando />;
  if (error || !data) return <Aviso tipo="error">{error}</Aviso>;

  return (
    <>
      <EncabezadoPagina titulo={`Hola, ${usuario?.nombre.split(' ')[0] ?? ''}`} descripcion="Este es el resumen de tus productos." />

      {data.alertas.length > 0 && (
        <div className="mb-6 space-y-2">
          {data.alertas.map((a, i) => (
            <Aviso key={i} tipo={a.nivel === 'critico' ? 'error' : a.nivel === 'aviso' ? 'aviso' : 'info'}>{a.mensaje}</Aviso>
          ))}
        </div>
      )}

      <section className="mb-8 grid gap-4 sm:grid-cols-2" aria-label="Saldo total">
        {Object.entries(data.saldoTotal).map(([moneda, valor]) => (
          <div key={moneda} className="rounded-2xl bg-gradient-to-br from-andino-800 to-andino-600 p-6 text-white shadow-md">
            <div className="text-xs font-semibold uppercase tracking-widest text-andino-200">Saldo total · {moneda}</div>
            <div className="tabular mt-2 break-words text-3xl font-bold sm:text-4xl">{dinero(valor, moneda)}</div>
            <div className="mt-2 text-xs text-andino-200">{data.cuentas.filter((c) => c.moneda === moneda).length} cuenta(s)</div>
          </div>
        ))}
      </section>

      <h2 className="mb-3 text-lg font-semibold text-andino-900">Mis cuentas</h2>
      {data.cuentas.length ? (
        <div className="mb-8 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {data.cuentas.map((c) => <CuentaTarjeta key={c.cuenta_id} c={c} a={`/cliente/cuentas/${c.cuenta_id}`} />)}
        </div>
      ) : <Vacio>Aún no tienes cuentas.</Vacio>}

      <div className="grid gap-6 lg:grid-cols-5">
        <Tarjeta titulo="Movimientos recientes" className="lg:col-span-3">
          <Tabla
            filas={data.movimientosRecientes}
            clave={(m) => m.id}
            vacio="Todavía no tienes movimientos."
            columnas={[
              {
                titulo: 'Detalle', principal: true,
                celda: (m) => (
                  <span className="inline-flex items-center gap-2">
                    {m.sentido === 'C' ? <ArrowDownLeft className="h-4 w-4 text-ok-600" aria-label="Entrada" /> : <ArrowUpRight className="h-4 w-4 text-alerta-600" aria-label="Salida" />}
                    {ETIQUETA_TIPO[m.tipo] ?? m.tipo}
                  </span>
                ),
              },
              { titulo: 'Canal', celda: (m) => ETIQUETA_CANAL[m.canal] ?? m.canal },
              { titulo: 'Fecha', celda: (m) => fecha(m.creado_en) },
              { titulo: 'Valor', alinear: 'der', celda: (m) => <span className={m.sentido === 'C' ? 'text-ok-700' : 'text-alerta-700'}>{m.sentido === 'C' ? '+' : '−'}{dinero(m.monto)}</span> },
            ]}
          />
        </Tarjeta>

        <Tarjeta titulo="Últimas transferencias" className="lg:col-span-2">
          {data.ultimasTransferencias.length ? (
            <ul className="divide-y divide-slate-100">
              {data.ultimasTransferencias.map((t) => (
                <li key={t.id} className="py-3 text-sm">
                  <div className="flex justify-between gap-3">
                    <span className="font-medium text-andino-900">{t.canal === 'brebe' ? 'Bre-B' : 'Transferencia'}</span>
                    <span className="tabular font-semibold">{dinero(t.monto, t.moneda)}</span>
                  </div>
                  <div className="mt-0.5 break-all font-mono text-xs text-slate-500">{t.numero_debito} → {t.numero_credito}</div>
                  <div className="text-xs text-slate-500">{fecha(t.creado_en)}</div>
                </li>
              ))}
            </ul>
          ) : <Vacio>Sin transferencias recientes.</Vacio>}
        </Tarjeta>
      </div>
    </>
  );
}
