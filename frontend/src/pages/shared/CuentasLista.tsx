import { Search } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CuentaVista } from '../../components/CuentaTarjeta';
import { Aviso, Campo, Cargando, EncabezadoPagina, EtiquetaEstado, Paginacion, Seleccion, Tabla, Tarjeta } from '../../components/ui';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { dinero } from '../../lib/format';
import { useCarga } from '../../lib/hooks';

const LIMITE = 20;

/** Lista de cuentas. El servidor decide el alcance: el personal ve todas, el cliente solo las suyas. */
export default function CuentasLista({ base }: { base: string }) {
  const { puede } = useAuth();
  const personal = puede('accounts:read');
  const navegar = useNavigate();
  const [q, setQ] = useState('');
  const [estado, setEstado] = useState('');
  const [moneda, setMoneda] = useState('');
  const [desde, setDesde] = useState(0);

  const { data, error, cargando } = useCarga(
    () => api<{ total: number; totalTruncado?: boolean; items: CuentaVista[] }>('/accounts', { query: { q, estado, moneda, limit: LIMITE, offset: desde } }),
    [q, estado, moneda, desde],
  );

  return (
    <>
      <EncabezadoPagina titulo={personal ? 'Cuentas' : 'Mis cuentas'} descripcion={personal ? 'Consulta cualquier cuenta del banco.' : 'Tus productos de ahorro, corriente y nómina.'} />
      <Tarjeta>
        <div className="mb-4 grid gap-3 sm:grid-cols-3">
          <div className="relative">
            <Campo etiqueta="Número de cuenta" placeholder="LB-0000000001" value={q} onChange={(e) => { setQ(e.target.value); setDesde(0); }} className="pl-9" />
            <Search className="pointer-events-none absolute bottom-3 left-3 h-4 w-4 text-slate-400" />
          </div>
          <Seleccion etiqueta="Estado" value={estado} onChange={(e) => { setEstado(e.target.value); setDesde(0); }}>
            <option value="">Todos</option>
            {['pendiente', 'activa', 'bloqueada', 'cerrada'].map((s) => <option key={s} value={s}>{s}</option>)}
          </Seleccion>
          <Seleccion etiqueta="Moneda" value={moneda} onChange={(e) => { setMoneda(e.target.value); setDesde(0); }}>
            <option value="">Todas</option><option>COP</option><option>USD</option>
          </Seleccion>
        </div>
        {error && <Aviso tipo="error">{error}</Aviso>}
        {cargando && !data ? <Cargando /> : data && (
          <>
            <Tabla
              filas={data.items}
              clave={(c) => c.cuenta_id}
              alClic={(c) => navegar(`${base}/${c.cuenta_id}`)}
              columnas={[
                { titulo: 'Cuenta', principal: true, celda: (c) => <span className="font-mono">{c.numero}</span> },
                { titulo: 'Producto', celda: (c) => c.producto },
                ...(personal ? [{ titulo: 'Titular', celda: (c: CuentaVista) => c.nombre }] : []),
                { titulo: 'Estado', celda: (c) => <EtiquetaEstado estado={c.estado} /> },
                { titulo: 'Disponible', alinear: 'der' as const, celda: (c) => dinero(c.saldo_disponible, c.moneda) },
              ]}
            />
            <Paginacion truncado={data.totalTruncado} total={data.total} limite={LIMITE} desplazamiento={desde} alCambiar={setDesde} />
          </>
        )}
      </Tarjeta>
    </>
  );
}
