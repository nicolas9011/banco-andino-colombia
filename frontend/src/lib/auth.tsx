import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, ApiError, setUnauthorizedHandler, tokens } from './api';

export interface Usuario {
  id: number;
  username: string;
  nombre: string;
  clienteId: number | null;
  oficinaId: number | null;
  roles: string[];
  permisos: string[];
}

interface Ctx {
  usuario: Usuario | null;
  cargando: boolean;
  login: (username: string, password: string) => Promise<Usuario>;
  logout: () => Promise<void>;
  puede: (...permisos: string[]) => boolean;
}

const AuthContext = createContext<Ctx | null>(null);

/** Ruta de inicio segun el rol principal. */
export function inicioPara(u: Usuario): string {
  if (u.roles.includes('ADMIN')) return '/admin';
  if (u.roles.includes('AUDITOR')) return '/admin';
  if (u.roles.includes('CAJERO')) return '/ventanilla';
  return '/cliente';
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [usuario, setUsuario] = useState<Usuario | null>(null);
  const [cargando, setCargando] = useState<boolean>(() => !!tokens.getWeb());

  const salirLocal = useCallback(() => {
    tokens.setWeb(null);
    setUsuario(null);
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(salirLocal);
    return () => setUnauthorizedHandler(null);
  }, [salirLocal]);

  // Restaura la sesion al recargar: el servidor es quien confirma que el token sigue vigente.
  useEffect(() => {
    if (!tokens.getWeb()) return;
    api<Usuario>('/auth/me')
      .then(setUsuario)
      // Solo un 401 significa "sesion invalida". Un corte de red o un 5xx transitorio NO debe borrar el token:
      // si el servidor estaba caido al recargar, el usuario perderia una sesion perfectamente valida.
      .catch((e: unknown) => {
        if (e instanceof ApiError && e.status === 401) salirLocal();
      })
      .finally(() => setCargando(false));
  }, [salirLocal]);

  const login = useCallback(async (username: string, password: string) => {
    const r = await api<{ token: string; usuario: Usuario }>('/auth/login', { method: 'POST', body: { username, password }, anon: true });
    tokens.setWeb(r.token);
    setUsuario(r.usuario);
    return r.usuario;
  }, []);

  const logout = useCallback(async () => {
    try {
      await api('/auth/logout', { method: 'POST' });
    } catch {
      /* si el servidor ya cerro la sesion, igual salimos */
    }
    salirLocal();
  }, [salirLocal]);

  // OJO: esto solo decide que MOSTRAR. La autorizacion real la hace el backend en cada peticion.
  const puede = useCallback(
    (...permisos: string[]) => !!usuario && permisos.some((p) => usuario.permisos.includes(p)),
    [usuario],
  );

  const valor = useMemo(() => ({ usuario, cargando, login, logout, puede }), [usuario, cargando, login, logout, puede]);
  return <AuthContext.Provider value={valor}>{children}</AuthContext.Provider>;
}

export function useAuth(): Ctx {
  const c = useContext(AuthContext);
  if (!c) throw new Error('useAuth debe usarse dentro de AuthProvider');
  return c;
}
