import { Plus, Search } from 'lucide-react';
import { FormEvent, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { CuentaTarjeta, CuentaVista } from '../../components/CuentaTarjeta';
import {
  Aviso, Boton, Campo, Cargando, EncabezadoPagina, Etiqueta, EtiquetaEstado, Indicador, Modal, Paginacion, Seleccion, Tabla, Tarjeta, Vacio,
} from '../../components/ui';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fecha } from '../../lib/format';
import { useAccion, useCarga } from '../../lib/hooks';

interface Cliente {
  id: number; tipo_persona: string; tipo_documento: string; documento: string; nombre: string; correo: string | null;
  telefono: string | null; departamento: string | null; ciudad: string | null; direccion: string | null; estado: string; fecha_vinculacion: string;
}
const LIMITE = 20;

export function ClientesLista({ base }: { base: string }) {
  const { puede } = useAuth();
  const navegar = useNavigate();
  const [q, setQ] = useState('');
  const [tipo, setTipo] = useState('');
  const [desde, setDesde] = useState(0);
  const [nuevo, setNuevo] = useState(false);
  const { data, error, cargando, recargar } = useCarga(
    () => api<{ total: number; totalTruncado?: boolean; items: Cliente[] }>('/customers', { query: { q, tipoPersona: tipo, limit: LIMITE, offset: desde } }),
    [q, tipo, desde],
  );

  return (
    <>
      <EncabezadoPagina
        titulo="Clientes" descripcion="Personas naturales y jurídicas vinculadas al banco."
        acciones={puede('customers:write') && <Boton onClick={() => setNuevo(true)}><Plus className="h-4 w-4" /> Nuevo cliente</Boton>}
      />
      <Tarjeta>
        <div className="mb-4 grid gap-3 sm:grid-cols-3">
          <div className="relative sm:col-span-2">
            <Campo etiqueta="Buscar por nombre o documento" value={q} className="pl-9" onChange={(e) => { setQ(e.target.value); setDesde(0); }} />
            <Search className="pointer-events-none absolute bottom-3 left-3 h-4 w-4 text-slate-400" />
          </div>
          <Seleccion etiqueta="Tipo de persona" value={tipo} onChange={(e) => { setTipo(e.target.value); setDesde(0); }}>
            <option value="">Todas</option><option value="natural">Natural</option><option value="juridica">Jurídica</option>
          </Seleccion>
        </div>
        {error && <Aviso tipo="error">{error}</Aviso>}
        {cargando && !data ? <Cargando /> : data && (
          <>
            <Tabla
              filas={data.items} clave={(c) => c.id} alClic={(c) => navegar(`${base}/${c.id}`)}
              columnas={[
                { titulo: 'Nombre', principal: true, celda: (c) => c.nombre },
                { titulo: 'Documento', celda: (c) => `${c.tipo_documento} ${c.documento}` },
                { titulo: 'Tipo', celda: (c) => <Etiqueta tono={c.tipo_persona === 'juridica' ? 'ambar' : 'azul'}>{c.tipo_persona}</Etiqueta> },
                { titulo: 'Ciudad', celda: (c) => c.ciudad || '—' },
                { titulo: 'Estado', celda: (c) => <EtiquetaEstado estado={c.estado} /> },
              ]}
            />
            <Paginacion truncado={data.totalTruncado} total={data.total} limite={LIMITE} desplazamiento={desde} alCambiar={setDesde} />
          </>
        )}
      </Tarjeta>
      {nuevo && <NuevoCliente alCerrar={() => setNuevo(false)} alCrear={(id) => { setNuevo(false); recargar(); navegar(`${base}/${id}`); }} />}
    </>
  );
}

function NuevoCliente({ alCerrar, alCrear }: { alCerrar: () => void; alCrear: (id: number) => void }) {
  const [f, setF] = useState({ tipoPersona: 'natural', documento: '', nombre: '', correo: '', telefono: '', departamento: '', ciudad: '' });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const { enviando, error, ejecutar } = useAccion();

  async function enviar(e: FormEvent) {
    e.preventDefault();
    const limpio = Object.fromEntries(Object.entries(f).filter(([, v]) => v.trim() !== ''));
    const r = await ejecutar(() => api<{ id: number }>('/customers', { method: 'POST', body: limpio }));
    if (r) alCrear(r.id);
  }
  return (
    <Modal abierto titulo="Nuevo cliente" alCerrar={alCerrar}>
      <form onSubmit={enviar} className="space-y-4" noValidate>
        {error && <Aviso tipo="error">{error}</Aviso>}
        <Seleccion etiqueta="Tipo de persona" value={f.tipoPersona} onChange={set('tipoPersona')}>
          <option value="natural">Natural (cédula)</option><option value="juridica">Jurídica (NIT)</option>
        </Seleccion>
        <Campo etiqueta={f.tipoPersona === 'juridica' ? 'NIT' : 'Documento'} value={f.documento} onChange={set('documento')} required />
        <Campo etiqueta={f.tipoPersona === 'juridica' ? 'Razón social' : 'Nombre completo'} value={f.nombre} onChange={set('nombre')} required />
        <div className="grid gap-3 sm:grid-cols-2">
          <Campo etiqueta="Correo" type="email" value={f.correo} onChange={set('correo')} />
          <Campo etiqueta="Teléfono" inputMode="tel" value={f.telefono} onChange={set('telefono')} />
          <Campo etiqueta="Departamento" value={f.departamento} onChange={set('departamento')} required />
          <Campo etiqueta="Ciudad" value={f.ciudad} onChange={set('ciudad')} required />
        </div>
        <div className="flex justify-end gap-2">
          <Boton variante="secundario" onClick={alCerrar}>Cancelar</Boton>
          <Boton type="submit" cargando={enviando} disabled={f.documento.length < 3 || f.nombre.trim().length < 2 || f.departamento.trim().length < 2 || f.ciudad.trim().length < 2}>Crear cliente</Boton>
        </div>
      </form>
    </Modal>
  );
}

export function ClienteDetalle({ baseCuentas }: { baseCuentas: string }) {
  const id = Number(useParams().id);
  const { puede } = useAuth();
  const { data, error, cargando, recargar } = useCarga(() => api<Cliente & { cuentas: CuentaVista[] }>(`/customers/${id}`), [id]);
  const [abrir, setAbrir] = useState(false);
  if (cargando && !data) return <Cargando />;
  if (error || !data) return <Aviso tipo="error">{error}</Aviso>;

  return (
    <>
      <EncabezadoPagina
        titulo={data.nombre} descripcion={`${data.tipo_documento} ${data.documento} · cliente desde ${fecha(data.fecha_vinculacion, false)}`}
        acciones={puede('accounts:write') && <Boton onClick={() => setAbrir(true)}><Plus className="h-4 w-4" /> Abrir cuenta</Boton>}
      />
      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Indicador etiqueta="Estado" valor={<EtiquetaEstado estado={data.estado} />} />
        <Indicador etiqueta="Tipo" valor={data.tipo_persona === 'juridica' ? 'Jurídica' : 'Natural'} />
        <Indicador etiqueta="Ubicación" valor={<span className="text-lg">{[data.ciudad, data.departamento].filter(Boolean).join(', ') || '—'}</span>} />
        <Indicador etiqueta="Contacto" valor={<span className="block break-all text-base">{data.correo || '—'}</span>} nota={data.telefono ?? undefined} />
      </div>
      <h2 className="mb-3 text-lg font-semibold text-andino-900">Cuentas</h2>
      {data.cuentas.length ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {data.cuentas.map((c) => <CuentaTarjeta key={c.cuenta_id} c={c} a={`${baseCuentas}/${c.cuenta_id}`} />)}
        </div>
      ) : <Vacio>Este cliente aún no tiene cuentas.</Vacio>}
      {abrir && <AbrirCuenta clienteId={id} alCerrar={() => setAbrir(false)} alCrear={() => { setAbrir(false); recargar(); }} />}
    </>
  );
}

function AbrirCuenta({ clienteId, alCerrar, alCrear }: { clienteId: number; alCerrar: () => void; alCrear: () => void }) {
  const productos = useCarga(() => api<{ items: { id: number; nombre: string; tipo: string }[] }>('/catalog/products'), []);
  const oficinas = useCarga(() => api<{ items: { id: number; nombre: string; ciudad: string }[] }>('/catalog/offices'), []);
  const [producto, setProducto] = useState('');
  const [oficina, setOficina] = useState('');
  const [moneda, setMoneda] = useState('COP');
  const { enviando, error, ejecutar } = useAccion();

  async function enviar(e: FormEvent) {
    e.preventDefault();
    const r = await ejecutar(() => api('/accounts', {
      method: 'POST',
      body: { clienteId, moneda, productoId: producto ? Number(producto) : undefined, oficinaId: oficina ? Number(oficina) : undefined },
    }));
    if (r) alCrear();
  }
  return (
    <Modal abierto titulo="Abrir cuenta" alCerrar={alCerrar}>
      <form onSubmit={enviar} className="space-y-4">
        {error && <Aviso tipo="error">{error}</Aviso>}
        <Seleccion etiqueta="Producto" value={producto} onChange={(e) => setProducto(e.target.value)}>
          <option value="">Ahorro (por defecto)</option>
          {productos.data?.items.map((p) => <option key={p.id} value={p.id}>{p.nombre} ({p.tipo})</option>)}
        </Seleccion>
        <Seleccion etiqueta="Oficina" value={oficina} onChange={(e) => setOficina(e.target.value)}>
          <option value="">Primera oficina activa</option>
          {oficinas.data?.items.map((o) => <option key={o.id} value={o.id}>{o.nombre} · {o.ciudad}</option>)}
        </Seleccion>
        <Seleccion etiqueta="Moneda" value={moneda} onChange={(e) => setMoneda(e.target.value)}><option>COP</option><option>USD</option></Seleccion>
        <p className="text-xs text-slate-500">Los clientes jurídicos abren cuentas empresariales automáticamente. La cuenta queda activa al crearse.</p>
        <div className="flex justify-end gap-2">
          <Boton variante="secundario" onClick={alCerrar}>Cancelar</Boton>
          <Boton type="submit" cargando={enviando}>Abrir cuenta</Boton>
        </div>
      </form>
    </Modal>
  );
}
