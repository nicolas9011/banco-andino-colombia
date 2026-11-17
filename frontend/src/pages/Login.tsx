import { Landmark, ShieldCheck } from 'lucide-react';
import { FormEvent, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { Logo } from '../components/Logo';
import { Aviso, Boton, Campo } from '../components/ui';
import { inicioPara, useAuth } from '../lib/auth';
import { useAccion } from '../lib/hooks';

export default function Login() {
  const { usuario, login } = useAuth();
  const navegar = useNavigate();
  const ubicacion = useLocation() as { state?: { desde?: string } };
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const { enviando, error, ejecutar } = useAccion();

  if (usuario) return <Navigate to={inicioPara(usuario)} replace />;

  async function enviar(e: FormEvent) {
    e.preventDefault();
    const u = await ejecutar(() => login(username.trim(), password));
    if (u) navegar(ubicacion.state?.desde ?? inicioPara(u), { replace: true });
  }

  return (
    <div className="grid min-h-full lg:grid-cols-[1.05fr_1fr]">
      <aside className="relative hidden overflow-hidden bg-andino-900 p-12 text-white lg:flex lg:flex-col lg:justify-between">
        <Logo claro />
        <div className="relative z-10 max-w-md">
          <h2 className="text-4xl font-bold leading-tight tracking-tight">Tu banco, firme como la cordillera.</h2>
          <p className="mt-4 text-andino-200">
            Plataforma bancaria académica sobre PostgreSQL con doble partida, auditoría completa y control de acceso por roles.
          </p>
        </div>
        <svg viewBox="0 0 600 260" className="pointer-events-none absolute inset-x-0 bottom-0 w-full opacity-90" aria-hidden>
          <circle cx="470" cy="70" r="34" fill="#E39A2D" />
          <path d="M0 260V170l110-110 80 90 70-70 120 120 70-50 150 140z" fill="#123057" />
          <path d="M0 260V210l90-70 70 60 110-90 100 100 80-50 150 100z" fill="#1A4278" />
        </svg>
        <p className="relative z-10 text-xs text-andino-300">Proyecto académico · datos sintéticos · sin valor comercial</p>
      </aside>

      <main className="flex items-center justify-center px-4 py-10 sm:px-8">
        <div className="w-full max-w-sm">
          <div className="mb-8 lg:hidden"><Logo /></div>
          <h1 className="text-2xl font-bold tracking-tight text-andino-900">Iniciar sesión</h1>
          <p className="mt-1 text-sm text-slate-600">Accede a tu portal de cliente o de personal del banco.</p>

          <form onSubmit={enviar} className="mt-6 space-y-4" noValidate>
            {error && <Aviso tipo="error">{error}</Aviso>}
            <Campo etiqueta="Usuario" autoComplete="username" autoCapitalize="none" value={username}
              onChange={(e) => setUsername(e.target.value)} required />
            <Campo etiqueta="Contraseña" type="password" autoComplete="current-password" value={password}
              onChange={(e) => setPassword(e.target.value)} required />
            <Boton type="submit" tamano="lg" className="w-full" cargando={enviando} disabled={!username || !password}>
              Entrar
            </Boton>
          </form>

          <div className="mt-8 space-y-3 border-t border-slate-200 pt-6">
            <Link to="/atm" className="flex min-h-12 items-center gap-3 rounded-xl bg-andino-50 px-4 py-3 text-sm font-semibold text-andino-800 ring-1 ring-inset ring-andino-200 hover:bg-andino-100">
              <Landmark className="h-5 w-5" /> Ir al cajero automático (ATM)
            </Link>
            <p className="flex items-start gap-2 text-xs text-slate-500">
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                Usuarios de demostración sintéticos: <span className="font-mono">admin1, cajero1, auditor1, cliente1, cliente2</span>.
                Su contraseña es la configurada en <span className="font-mono">SEED_PASSWORD</span>.
              </span>
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}
