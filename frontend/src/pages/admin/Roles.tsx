import { useState } from 'react';
import { Aviso, Boton, Cargando, EncabezadoPagina, ErrorCarga, Tarjeta } from '../../components/ui';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useAccion, useCarga } from '../../lib/hooks';

interface Rol { id: number; codigo: string; nombre: string; descripcion: string; permisos: string[] }
interface Permiso { id: number; codigo: string; descripcion: string }

/** Matriz rol x permiso. Editar aqui cambia lo que el BACKEND permite en la siguiente peticion. */
export default function Roles() {
  const { puede } = useAuth();
  const editable = puede('roles:write');
  const roles = useCarga(() => api<{ items: Rol[] }>('/roles'), []);
  const permisos = useCarga(() => api<{ items: Permiso[] }>('/permissions'), []);
  const [borrador, setBorrador] = useState<Record<string, Set<string>>>({});
  const [guardado, setGuardado] = useState<string | null>(null);
  const accion = useAccion();

  const fallo = (!roles.data && roles.error) || (!permisos.data && permisos.error);
  if (fallo) return <ErrorCarga mensaje={fallo} alReintentar={() => { roles.recargar(); permisos.recargar(); }} />;
  if (!roles.data || !permisos.data) return <Cargando />;

  const actual = (r: Rol) => borrador[r.codigo] ?? new Set(r.permisos);
  const cambiado = (r: Rol) => {
    const a = actual(r);
    return a.size !== r.permisos.length || r.permisos.some((p) => !a.has(p));
  };
  const alternar = (r: Rol, p: string) => {
    const a = new Set(actual(r));
    if (a.has(p)) a.delete(p); else a.add(p);
    setBorrador((b) => ({ ...b, [r.codigo]: a }));
    setGuardado(null);
  };
  async function guardar(r: Rol) {
    const res = await accion.ejecutar(() => api(`/roles/${r.codigo}/permissions`, { method: 'PUT', body: { permisos: [...actual(r)] } }));
    if (res) {
      setBorrador((b) => { const n = { ...b }; delete n[r.codigo]; return n; });
      setGuardado(r.codigo);
      roles.recargar();
    }
  }

  return (
    <>
      <EncabezadoPagina titulo="Roles y permisos" descripcion="Los permisos determinan qué puede hacer cada usuario. El servidor los valida en cada petición." />
      {accion.error && <Aviso tipo="error" className="mb-4">{accion.error}</Aviso>}
      {guardado && <Aviso tipo="ok" className="mb-4">Permisos de {guardado} actualizados. Aplican desde la siguiente petición de sus usuarios.</Aviso>}
      <div className="grid gap-6 xl:grid-cols-2">
        {roles.data.items.map((r) => (
          <Tarjeta key={r.codigo} titulo={`${r.nombre} (${r.codigo})`}
            accion={editable && cambiado(r) ? <Boton tamano="sm" cargando={accion.enviando} onClick={() => void guardar(r)}>Guardar</Boton> : undefined}>
            <p className="mb-3 text-sm text-slate-600">{r.descripcion}</p>
            <ul className="grid gap-1 sm:grid-cols-2">
              {permisos.data!.items.map((p) => (
                <li key={p.codigo}>
                  <label className="flex min-h-9 cursor-pointer items-start gap-2 rounded-md px-1.5 py-1 text-sm hover:bg-andino-50">
                    <input type="checkbox" className="mt-1" disabled={!editable} checked={actual(r).has(p.codigo)} onChange={() => alternar(r, p.codigo)} />
                    <span><span className="font-mono text-xs text-andino-800">{p.codigo}</span><span className="block text-xs text-slate-500">{p.descripcion}</span></span>
                  </label>
                </li>
              ))}
            </ul>
          </Tarjeta>
        ))}
      </div>
    </>
  );
}
