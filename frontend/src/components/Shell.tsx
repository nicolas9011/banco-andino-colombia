import { LogOut, Menu, X } from 'lucide-react';
import { ComponentType, ReactNode, useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { Logo } from './Logo';
import { Boton } from './ui';

export interface ItemNav {
  a: string;
  texto: string;
  icono: ComponentType<{ className?: string }>;
  fin?: boolean;
  /** Solo se muestra si el usuario tiene alguno de estos permisos (el backend vuelve a validar). */
  permisos?: string[];
}

export function Shell({ area, items, pie }: { area: string; items: ItemNav[]; pie?: ReactNode }) {
  const { usuario, logout, puede } = useAuth();
  const [abierto, setAbierto] = useState(false);
  const ubicacion = useLocation();
  useEffect(() => setAbierto(false), [ubicacion.pathname]);
  useEffect(() => {
    if (!abierto) return;
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') setAbierto(false); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [abierto]);

  const visibles = items.filter((i) => !i.permisos || puede(...i.permisos));

  const menu = (
    <nav aria-label="Navegacion principal" className="flex-1 space-y-1 px-3 py-4">
      {visibles.map((i) => (
        <NavLink
          key={i.a} to={i.a} end={i.fin}
          className={({ isActive }) =>
            `flex min-h-11 items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors ${
              isActive ? 'bg-white/15 text-white' : 'text-andino-200 hover:bg-white/10 hover:text-white'
            }`}
        >
          <i.icono className="h-5 w-5 shrink-0" />
          {i.texto}
        </NavLink>
      ))}
    </nav>
  );

  const usuarioBloque = (
    <div className="border-t border-white/10 p-4">
      <div className="mb-3 min-w-0">
        <div className="truncate text-sm font-semibold text-white">{usuario?.nombre}</div>
        <div className="truncate text-xs text-andino-300">{usuario?.roles.join(' · ')}</div>
      </div>
      <button
        type="button" onClick={() => void logout()}
        className="flex min-h-10 w-full items-center justify-center gap-2 rounded-lg bg-white/10 px-3 py-2 text-sm font-semibold text-white hover:bg-white/20"
      >
        <LogOut className="h-4 w-4" /> Cerrar sesión
      </button>
      {pie}
    </div>
  );

  return (
    <div className="min-h-full lg:flex">
      <aside className="no-print hidden w-64 shrink-0 flex-col bg-andino-900 lg:fixed lg:inset-y-0 lg:flex">
        <div className="border-b border-white/10 px-5 py-5"><Logo claro /></div>
        <div className="px-5 pt-4 text-[11px] font-semibold uppercase tracking-widest text-andino-300">{area}</div>
        {menu}
        {usuarioBloque}
      </aside>

      <div className="no-print sticky top-0 z-30 flex items-center justify-between bg-andino-900 px-4 py-3 lg:hidden">
        <Logo claro />
        <button type="button" aria-label="Abrir menu" onClick={() => setAbierto(true)} className="rounded-lg p-2 text-white hover:bg-white/10">
          <Menu className="h-6 w-6" />
        </button>
      </div>

      {abierto && (
        <div className="no-print fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Menu">
          <div className="absolute inset-0 bg-andino-950/60" onClick={() => setAbierto(false)} />
          <div className="absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col bg-andino-900">
            <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
              <Logo claro />
              <button type="button" aria-label="Cerrar menu" onClick={() => setAbierto(false)} className="rounded-lg p-2 text-white hover:bg-white/10">
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="px-5 pt-4 text-[11px] font-semibold uppercase tracking-widest text-andino-300">{area}</div>
            {menu}
            {usuarioBloque}
          </div>
        </div>
      )}

      <main className="min-w-0 flex-1 lg:pl-64">
        <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
          <Outlet />
        </div>
        <footer className="no-print mx-auto max-w-6xl px-4 pb-8 text-center text-xs text-slate-500 sm:px-6 lg:px-8">
          Proyecto académico · datos sintéticos · sin valor comercial
        </footer>
      </main>
    </div>
  );
}

export function Boton403() {
  const { logout } = useAuth();
  return (
    <div className="mx-auto max-w-md py-16 text-center">
      <h1 className="text-2xl font-bold text-andino-900">Sin acceso</h1>
      <p className="mt-2 text-slate-600">Tu usuario no tiene permiso para ver esta sección.</p>
      <Boton className="mt-6" variante="secundario" onClick={() => void logout()}>Cambiar de usuario</Boton>
    </div>
  );
}
