import { BarChart3, ExternalLink, Link2 } from 'lucide-react';
import { FormEvent, useState } from 'react';
import { Aviso, Boton, Campo, Cargando, EncabezadoPagina, Indicador, Tabla, Tarjeta } from '../../components/ui';
import { api } from '../../lib/api';
import { dinero, ETIQUETA_TIPO } from '../../lib/format';
import { useCarga } from '../../lib/hooks';

interface Stats {
  clientes: number;
  cuentas: { estado: string; moneda: string; cuentas: number; saldo: string }[];
  operacionesHoy: { tipo: string; operaciones: number; monto: string }[];
  usuarios: { estado: string; usuarios: number }[];
  eventosDenegadosUltimas24h: number;
  cuentasDescuadradas: number;
}

const STORAGE_KEY_PBI = 'banco_andino_powerbi_url';

export default function Panel() {
  const { data, error, cargando } = useCarga(() => api<Stats>('/stats/overview'), []);
  const envUrl = import.meta.env.VITE_POWERBI_EMBED_URL ?? '';
  const [pbiUrl, setPbiUrl] = useState<string>(() => localStorage.getItem(STORAGE_KEY_PBI) || envUrl);
  const [inputUrl, setInputUrl] = useState<string>(pbiUrl);
  const [editandoUrl, setEditandoUrl] = useState<boolean>(!pbiUrl);

  if (cargando) return <Cargando />;
  if (error || !data) return <Aviso tipo="error">{error}</Aviso>;

  const totalCuentas = data.cuentas.reduce((a, c) => a + c.cuentas, 0);
  const activas = data.cuentas.filter((c) => c.estado === 'activa').reduce((a, c) => a + c.cuentas, 0);
  const opsHoy = data.operacionesHoy.reduce((a, o) => a + o.operaciones, 0);
  const usuariosActivos = data.usuarios.find((u) => u.estado === 'activo')?.usuarios ?? 0;
  const maxBarra = Math.max(1, ...data.operacionesHoy.map((o) => o.operaciones));

  function guardarUrlPbi(e: FormEvent) {
    e.preventDefault();
    const limpia = inputUrl.trim();
    setPbiUrl(limpia);
    localStorage.setItem(STORAGE_KEY_PBI, limpia);
    setEditandoUrl(false);
  }

  return (
    <>
      <EncabezadoPagina
        titulo="Panel de gestión e Inteligencia de Negocios"
        descripcion="Indicadores OLTP en vivo desde PostgreSQL e integración analítica DWH con Microsoft Power BI."
      />
      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Indicador etiqueta="Clientes" valor={data.clientes.toLocaleString('es-CO')} />
        <Indicador etiqueta="Cuentas" valor={totalCuentas.toLocaleString('es-CO')} nota={`${activas.toLocaleString('es-CO')} activas`} />
        <Indicador etiqueta="Operaciones hoy" valor={opsHoy.toLocaleString('es-CO')} />
        <Indicador etiqueta="Usuarios activos" valor={usuariosActivos} />
      </div>
      <div className="mb-6 grid gap-4 sm:grid-cols-2">
        <Indicador
          etiqueta="Conciliación de saldos" tono={data.cuentasDescuadradas === 0 ? 'ok' : 'alerta'}
          valor={data.cuentasDescuadradas === 0 ? 'Cuadrada' : `${data.cuentasDescuadradas} descuadre(s)`}
          nota="Saldo de cada cuenta = suma de sus movimientos"
        />
        <Indicador
          etiqueta="Accesos denegados (24 h)" tono={data.eventosDenegadosUltimas24h > 20 ? 'alerta' : 'normal'}
          valor={data.eventosDenegadosUltimas24h} nota="Logins fallidos y accesos sin permiso"
        />
      </div>

      <div className="mb-6 grid gap-6 lg:grid-cols-2">
        <Tarjeta titulo="Actividad de hoy por tipo">
          {data.operacionesHoy.length === 0 ? <p className="text-sm text-slate-500">Sin operaciones hoy.</p> : (
            <ul className="space-y-3">
              {data.operacionesHoy.map((o) => (
                <li key={o.tipo}>
                  <div className="mb-1 flex justify-between text-sm"><span className="font-medium">{ETIQUETA_TIPO[o.tipo] ?? o.tipo}</span><span className="tabular text-slate-600">{o.operaciones} · {dinero(o.monto)}</span></div>
                  <div className="h-2 overflow-hidden rounded-full bg-andino-100"><div className="h-full rounded-full bg-andino-600" style={{ width: `${(o.operaciones / maxBarra) * 100}%` }} /></div>
                </li>
              ))}
            </ul>
          )}
        </Tarjeta>
        <Tarjeta titulo="Saldos por estado y moneda">
          <Tabla
            filas={data.cuentas} clave={(c) => `${c.estado}-${c.moneda}`}
            columnas={[
              { titulo: 'Estado', principal: true, celda: (c) => c.estado },
              { titulo: 'Moneda', celda: (c) => c.moneda },
              { titulo: 'Cuentas', alinear: 'der', celda: (c) => c.cuentas.toLocaleString('es-CO') },
              { titulo: 'Saldo contable', alinear: 'der', celda: (c) => dinero(c.saldo, c.moneda) },
            ]}
          />
        </Tarjeta>
      </div>

      <Tarjeta
        titulo="Tablero Analítico Power BI — Data Warehouse (Esquema dwh)"
        accion={
          <div className="flex items-center gap-2">
            {pbiUrl && (
              <a
                href={pbiUrl} target="_blank" rel="noreferrer"
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
              >
                <ExternalLink className="h-3.5 w-3.5" /> Abrir en Power BI
              </a>
            )}
            <Boton variante="secundario" tamano="sm" onClick={() => setEditandoUrl(!editandoUrl)}>
              <Link2 className="h-4 w-4" /> {editandoUrl ? 'Ocultar' : 'Vincular URL Power BI'}
            </Boton>
          </div>
        }
      >
        {editandoUrl && (
          <form onSubmit={guardarUrlPbi} className="mb-4 flex flex-col gap-3 rounded-xl bg-slate-50 p-4 sm:flex-row sm:items-end">
            <div className="flex-1">
              <Campo
                etiqueta="URL de inserción de Power BI Service (https://app.powerbi.com/reportEmbed... o view?r=...)"
                value={inputUrl}
                onChange={(e) => setInputUrl(e.target.value)}
                placeholder="https://app.powerbi.com/reportEmbed?reportId=..."
              />
            </div>
            <Boton type="submit">Guardar y mostrar</Boton>
          </form>
        )}

        {pbiUrl ? (
          <div className="overflow-hidden rounded-xl border border-slate-200 bg-slate-100 shadow-inner">
            <iframe
              title="Dashboard Power BI Banco Andino"
              src={pbiUrl}
              className="h-[680px] w-full border-0"
              allowFullScreen
            />
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center rounded-xl border-2 border-dashed border-slate-200 py-12 text-center">
            <BarChart3 className="h-10 w-10 text-andino-600" />
            <h3 className="mt-3 text-base font-semibold text-andino-900">Dashboard de Power BI listo para vincular</h3>
            <p className="mt-1 max-w-md text-xs text-slate-500">
              Pega arriba el enlace de tu reporte publicado en Power BI Service para visualizar el modelo estrella (<code>dwh</code>) integrado en el portal bancario.
            </p>
          </div>
        )}
      </Tarjeta>
    </>
  );
}