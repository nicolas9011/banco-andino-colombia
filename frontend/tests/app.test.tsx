import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Protegida } from '../src/components/Guard';
import { api, ApiError, tokens } from '../src/lib/api';
import { AuthProvider } from '../src/lib/auth';
import Login from '../src/pages/Login';

const json = (status: number, cuerpo: unknown) =>
  Promise.resolve(new Response(JSON.stringify(cuerpo), { status, headers: { 'Content-Type': 'application/json' } }));

const usuario = (permisos: string[]) => ({
  id: 1, username: 'x', nombre: 'Usuario Prueba', clienteId: null, oficinaId: null, roles: ['CAJERO'], permisos,
});

function app(ruta: string) {
  return render(
    <MemoryRouter initialEntries={[ruta]}>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/secreto" element={<Protegida permisos={['audit:read']}><p>CONTENIDO DE AUDITORIA</p></Protegida>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => sessionStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe('cliente HTTP', () => {
  it('envia Authorization e Idempotency-Key y no usa floats para el dinero', async () => {
    tokens.setWeb('tok123');
    const f = vi.spyOn(globalThis, 'fetch').mockImplementation(() => json(201, { ok: true }));
    await api('/transactions/deposit', { method: 'POST', idempotencyKey: 'abc12345', body: { cuentaId: 1, monto: '10.50' } });
    const [, init] = f.mock.calls[0];
    const h = init!.headers as Record<string, string>;
    expect(h.Authorization).toBe('Bearer tok123');
    expect(h['Idempotency-Key']).toBe('abc12345');
    expect(init!.body).toContain('"monto":"10.50"');
  });

  it('convierte errores de la API en ApiError con mensaje legible', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      json(422, { error: { code: 'SALDO_INSUFICIENTE', message: 'Saldo insuficiente.' }, requestId: 'r1' }));
    await expect(api('/x')).rejects.toMatchObject({ status: 422, code: 'SALDO_INSUFICIENTE', message: 'Saldo insuficiente.' });
  });

  it('una caida de red da un mensaje claro y no un stack', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));
    const e = await api('/x').catch((x) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(e.message).toMatch(/conexion/i);
  });
});

describe('proteccion de rutas (comodidad de UX; el backend es la autoridad)', () => {
  it('sin sesion redirige al login', async () => {
    app('/secreto');
    expect(await screen.findByRole('heading', { name: /iniciar sesión/i })).toBeInTheDocument();
    expect(screen.queryByText('CONTENIDO DE AUDITORIA')).not.toBeInTheDocument();
  });

  it('con sesion pero sin el permiso muestra "Sin acceso"', async () => {
    tokens.setWeb('tok');
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => json(200, usuario(['accounts:read'])));
    app('/secreto');
    expect(await screen.findByText('Sin acceso')).toBeInTheDocument();
    expect(screen.queryByText('CONTENIDO DE AUDITORIA')).not.toBeInTheDocument();
  });

  it('con el permiso correcto muestra el contenido', async () => {
    tokens.setWeb('tok');
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => json(200, usuario(['audit:read'])));
    app('/secreto');
    expect(await screen.findByText('CONTENIDO DE AUDITORIA')).toBeInTheDocument();
  });

  it('un token vencido en el servidor expulsa a la pantalla de login', async () => {
    tokens.setWeb('vencido');
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      json(401, { error: { code: 'NO_AUTENTICADO', message: 'Sesion invalida o vencida.' } }));
    app('/secreto');
    expect(await screen.findByRole('heading', { name: /iniciar sesión/i })).toBeInTheDocument();
    expect(tokens.getWeb()).toBeNull();
  });
});

describe('pantalla de login', () => {
  it('credenciales incorrectas muestran un mensaje comprensible, sin detalles tecnicos', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      json(401, { error: { code: 'CREDENCIALES', message: 'Usuario o contrasena incorrectos.' } }));
    app('/login');
    const u = userEvent.setup();
    await u.type(screen.getByLabelText('Usuario'), 'admin1');
    await u.type(screen.getByLabelText('Contraseña'), 'incorrecta');
    await u.click(screen.getByRole('button', { name: 'Entrar' }));
    const alerta = await screen.findByRole('alert');
    expect(alerta).toHaveTextContent('Usuario o contrasena incorrectos.');
    expect(alerta.textContent).not.toMatch(/SQL|stack|exception/i);
    expect(tokens.getWeb()).toBeNull();
  });

  it('el boton Entrar esta deshabilitado hasta completar ambos campos', async () => {
    app('/login');
    const boton = screen.getByRole('button', { name: 'Entrar' });
    expect(boton).toBeDisabled();
    const u = userEvent.setup();
    await u.type(screen.getByLabelText('Usuario'), 'a1');
    expect(boton).toBeDisabled();
    await u.type(screen.getByLabelText('Contraseña'), 'x');
    await waitFor(() => expect(boton).toBeEnabled());
  });
});
