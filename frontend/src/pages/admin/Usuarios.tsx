import { Plus, ShieldOff, ShieldCheck } from 'lucide-react';
import { FormEvent, useState } from 'react';
import { Aviso, Boton, Campo, Cargando, EncabezadoPagina, Etiqueta, EtiquetaEstado, Modal, Paginacion, Tabla, Tarjeta } from '../../components/ui';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fecha } from '../../lib/format';
import { useAccion, useCarga } from '../../lib/hooks';

interface U { id: number; username: string; nombre_completo: string; correo: string | null; estado: string; roles: string[]; cliente_id: number | null; ultimo_acceso: string | null }
const LIMITE = 20;
const ROLES = ['ADMIN', 'CAJERO', 'AUDITOR', 'CLIENTE'];

export default function Usuarios() {
  const { usuario, puede } = useAuth();
  const [desde, setDesde] = useState(0);
  const [nuevo, setNuevo] = useState(false);
  const { data, error, cargando, recargar } = useCarga(() => api<{ total: number; items: U[] }>('/users', { query: { limit: LIMITE, offset: desde } }), [desde]);
  const accion = useAccion();

  async function cambiarEstado(u: U) {
    const bloquear = u.estado === 'activo';
    if (!window.confirm(bloquear ? `¿Bloquear a ${u.username}? Su sesión se cerrará de inmediato.` : `¿Reactivar a ${u.username}?`)) return;
    const r = await accion.ejecutar(() => api(`/users/${u.id}/status`, { method: 'PATCH', body: { estado: bloquear ? 'bloqueado' : 'activo' } }));
    if (r) recargar();
  }

  return (
    <>
      <EncabezadoPagina
        titulo="Usuarios" descripcion="Personas con acceso a la plataforma y sus roles."
        acciones={puede('users:write') && <Boton onClick={() => setNuevo(true)}><Plus className="h-4 w-4" /> Nuevo usuario</Boton>}
      />
      {accion.error && <Aviso tipo="error" className="mb-4">{accion.error}</Aviso>}
      <Tarjeta>
        {error && <Aviso tipo="error">{error}</Aviso>}
        {cargando && !data ? <Cargando /> : data && (
          <>
            <Tabla
              filas={data.items} clave={(u) => u.id}
              columnas={[
                { titulo: 'Usuario', principal: true, celda: (u) => <span><span className="font-semibold">{u.username}</span><span className="block text-xs text-slate-500">{u.nombre_completo}</span></span> },
                { titulo: 'Roles', celda: (u) => <span className="inline-flex flex-wrap gap-1">{u.roles.map((r) => <Etiqueta key={r} tono="azul">{r}</Etiqueta>)}</span> },
                { titulo: 'Estado', celda: (u) => <EtiquetaEstado estado={u.estado} /> },
                { titulo: 'Último acceso', celda: (u) => fecha(u.ultimo_acceso) },
                ...(puede('users:block') ? [{
                  titulo: '', celda: (u: U) => u.id === usuario?.id ? null : (
                    <Boton variante="fantasma" tamano="sm" onClick={() => void cambiarEstado(u)}>
                      {u.estado === 'activo' ? <><ShieldOff className="h-4 w-4" /> Bloquear</> : <><ShieldCheck className="h-4 w-4" /> Reactivar</>}
                    </Boton>
                  ),
                }] : []),
              ]}
            />
            <Paginacion total={data.total} limite={LIMITE} desplazamiento={desde} alCambiar={setDesde} />
          </>
        )}
      </Tarjeta>
      {nuevo && <NuevoUsuario alCerrar={() => setNuevo(false)} alCrear={() => { setNuevo(false); recargar(); }} />}
    </>
  );
}

function NuevoUsuario({ alCerrar, alCrear }: { alCerrar: () => void; alCrear: () => void }) {
  const [f, setF] = useState({ username: '', password: '', nombreCompleto: '', correo: '', rol: 'CAJERO', clienteId: '' });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const { enviando, error, ejecutar } = useAccion();
  const fuerte = f.password.length >= 10 && /[A-Za-z]/.test(f.password) && /\d/.test(f.password);

  async function enviar(e: FormEvent) {
    e.preventDefault();
    const r = await ejecutar(() => api('/users', {
      method: 'POST',
      body: {
        username: f.username, password: f.password, nombreCompleto: f.nombreCompleto, correo: f.correo || undefined,
        roles: [f.rol], clienteId: f.rol === 'CLIENTE' ? Number(f.clienteId) : undefined,
      },
    }));
    if (r) alCrear();
  }
  return (
    <Modal abierto titulo="Nuevo usuario" alCerrar={alCerrar}>
      <form onSubmit={enviar} className="space-y-4" noValidate>
        {error && <Aviso tipo="error">{error}</Aviso>}
        <Campo etiqueta="Nombre de usuario" autoCapitalize="none" value={f.username} onChange={set('username')} ayuda="3 a 40 caracteres: minúsculas, números . _ -" />
        <Campo etiqueta="Nombre completo" value={f.nombreCompleto} onChange={set('nombreCompleto')} />
        <Campo etiqueta="Correo (opcional)" type="email" value={f.correo} onChange={set('correo')} />
        <Campo etiqueta="Contraseña inicial" type="password" autoComplete="new-password" value={f.password} onChange={set('password')}
          error={f.password && !fuerte ? 'Mínimo 10 caracteres con letras y números.' : undefined} />
        <label className="block text-sm font-medium text-andino-900">Rol
          <select className="mt-1.5 block min-h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-base sm:text-sm" value={f.rol} onChange={set('rol')}>
            {ROLES.map((r) => <option key={r}>{r}</option>)}
          </select>
        </label>
        {f.rol === 'CLIENTE' && <Campo etiqueta="ID del cliente vinculado" inputMode="numeric" value={f.clienteId} onChange={set('clienteId')} ayuda="Se obtiene en Clientes. Un usuario CLIENTE debe estar vinculado a uno." />}
        <div className="flex justify-end gap-2">
          <Boton variante="secundario" onClick={alCerrar}>Cancelar</Boton>
          <Boton type="submit" cargando={enviando} disabled={!f.username || !f.nombreCompleto || !fuerte || (f.rol === 'CLIENTE' && !f.clienteId)}>Crear usuario</Boton>
        </div>
      </form>
    </Modal>
  );
}
