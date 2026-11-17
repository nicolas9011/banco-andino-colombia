import {
  Activity, ArrowLeftRight, Banknote, CreditCard, Home, KeyRound, LayoutDashboard, Receipt, ScrollText, ShieldCheck, Users, UserCog, Wallet,
} from 'lucide-react';
import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { Inicio, Protegida } from './components/Guard';
import { ItemNav, Shell } from './components/Shell';
import { Cargando } from './components/ui';

const Login = lazy(() => import('./pages/Login'));
const Atm = lazy(() => import('./pages/atm/Atm'));
const DashboardCliente = lazy(() => import('./pages/client/Dashboard'));
const Transferir = lazy(() => import('./pages/client/Transferir'));
const BreB = lazy(() => import('./pages/client/BreB'));
const CuentasLista = lazy(() => import('./pages/shared/CuentasLista'));
const CuentaDetalle = lazy(() => import('./pages/shared/CuentaDetalle'));
const Transacciones = lazy(() => import('./pages/shared/Transacciones'));
const Clientes = lazy(() => import('./pages/shared/Clientes').then((m) => ({ default: m.ClientesLista })));
const ClienteDetalle = lazy(() => import('./pages/shared/Clientes').then((m) => ({ default: m.ClienteDetalle })));
const Ventanilla = lazy(() => import('./pages/staff/Ventanilla'));
const Panel = lazy(() => import('./pages/admin/Panel'));
const Usuarios = lazy(() => import('./pages/admin/Usuarios'));
const Roles = lazy(() => import('./pages/admin/Roles'));
const Auditoria = lazy(() => import('./pages/admin/Auditoria'));

const NAV_CLIENTE: ItemNav[] = [
  { a: '/cliente', texto: 'Inicio', icono: Home, fin: true },
  { a: '/cliente/cuentas', texto: 'Mis cuentas', icono: Wallet },
  { a: '/cliente/transferir', texto: 'Transferir', icono: ArrowLeftRight, permisos: ['tx:transfer_own'] },
  { a: '/cliente/brebe', texto: 'Bre-B', icono: KeyRound, permisos: ['brebe:use'] },
];
const NAV_VENTANILLA: ItemNav[] = [
  { a: '/ventanilla', texto: 'Operaciones', icono: Banknote, fin: true },
  { a: '/ventanilla/clientes', texto: 'Clientes', icono: Users, permisos: ['customers:read'] },
  { a: '/ventanilla/cuentas', texto: 'Cuentas', icono: CreditCard, permisos: ['accounts:read'] },
  { a: '/ventanilla/movimientos', texto: 'Mis operaciones', icono: Receipt },
];
const NAV_ADMIN: ItemNav[] = [
  { a: '/admin', texto: 'Panel', icono: LayoutDashboard, fin: true, permisos: ['stats:read'] },
  { a: '/admin/clientes', texto: 'Clientes', icono: Users, permisos: ['customers:read'] },
  { a: '/admin/cuentas', texto: 'Cuentas', icono: Wallet, permisos: ['accounts:read'] },
  { a: '/admin/transacciones', texto: 'Transacciones', icono: Activity, permisos: ['tx:read'] },
  { a: '/admin/usuarios', texto: 'Usuarios', icono: UserCog, permisos: ['users:read'] },
  { a: '/admin/roles', texto: 'Roles y permisos', icono: ShieldCheck, permisos: ['roles:read'] },
  { a: '/admin/auditoria', texto: 'Auditoría', icono: ScrollText, permisos: ['audit:read'] },
];

export default function App() {
  return (
    <Suspense fallback={<Cargando />}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/atm" element={<Atm />} />
        <Route path="/" element={<Inicio />} />

        <Route path="/cliente" element={<Protegida permisos={['accounts:read_own']}><Shell area="Portal del cliente" items={NAV_CLIENTE} /></Protegida>}>
          <Route index element={<DashboardCliente />} />
          <Route path="cuentas" element={<CuentasLista base="/cliente/cuentas" />} />
          <Route path="cuentas/:id" element={<CuentaDetalle />} />
          <Route path="transferir" element={<Protegida permisos={['tx:transfer_own']}><Transferir /></Protegida>} />
          <Route path="brebe" element={<Protegida permisos={['brebe:use']}><BreB /></Protegida>} />
        </Route>

        <Route path="/ventanilla" element={<Protegida permisos={['tx:deposit', 'tx:withdraw', 'tx:transfer']}><Shell area="Ventanilla" items={NAV_VENTANILLA} /></Protegida>}>
          <Route index element={<Ventanilla />} />
          <Route path="clientes" element={<Clientes base="/ventanilla/clientes" />} />
          <Route path="clientes/:id" element={<ClienteDetalle baseCuentas="/ventanilla/cuentas" />} />
          <Route path="cuentas" element={<CuentasLista base="/ventanilla/cuentas" />} />
          <Route path="cuentas/:id" element={<CuentaDetalle />} />
          <Route path="movimientos" element={<Transacciones propias />} />
        </Route>

        <Route path="/admin" element={<Protegida permisos={['stats:read', 'audit:read', 'users:read']}><Shell area="Administración" items={NAV_ADMIN} /></Protegida>}>
          <Route index element={<Protegida permisos={['stats:read']}><Panel /></Protegida>} />
          <Route path="clientes" element={<Clientes base="/admin/clientes" />} />
          <Route path="clientes/:id" element={<ClienteDetalle baseCuentas="/admin/cuentas" />} />
          <Route path="cuentas" element={<CuentasLista base="/admin/cuentas" />} />
          <Route path="cuentas/:id" element={<CuentaDetalle />} />
          <Route path="transacciones" element={<Protegida permisos={['tx:read']}><Transacciones /></Protegida>} />
          <Route path="usuarios" element={<Protegida permisos={['users:read']}><Usuarios /></Protegida>} />
          <Route path="roles" element={<Protegida permisos={['roles:read']}><Roles /></Protegida>} />
          <Route path="auditoria" element={<Protegida permisos={['audit:read']}><Auditoria /></Protegida>} />
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}
