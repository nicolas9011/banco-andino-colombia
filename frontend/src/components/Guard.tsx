import { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { inicioPara, useAuth } from '../lib/auth';
import { Boton403 } from './Shell';
import { Cargando } from './ui';

/**
 * Protege una zona de la interfaz. Es comodidad de UX: el backend rechaza igualmente
 * cualquier peticion sin permiso, aunque alguien salte esta barrera.
 */
export function Protegida({ permisos, children }: { permisos?: string[]; children: ReactNode }) {
  const { usuario, cargando, puede } = useAuth();
  const ubicacion = useLocation();
  if (cargando) return <Cargando texto="Verificando sesión…" />;
  if (!usuario) return <Navigate to="/login" replace state={{ desde: ubicacion.pathname }} />;
  if (permisos && !puede(...permisos)) return <Boton403 />;
  return <>{children}</>;
}

export function Inicio() {
  const { usuario, cargando } = useAuth();
  if (cargando) return <Cargando />;
  return <Navigate to={usuario ? inicioPara(usuario) : '/login'} replace />;
}
