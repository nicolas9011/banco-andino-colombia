import { beforeAll, describe, expect, it } from 'vitest';
import { bearer, clave, http, nuevaCuenta, nuevoCliente, password, sesionDeCliente, tokenDe } from './helpers';

let admin: string;
let cajero: string;
let auditor: string;

beforeAll(async () => {
  admin = await tokenDe('admin1');
  cajero = await tokenDe('cajero1');
  auditor = await tokenDe('auditor1');
});

describe('autenticacion', () => {
  it('login correcto devuelve token, roles y permisos', async () => {
    const r = await http().post('/api/auth/login').send({ username: 'admin1', password: password() });
    expect(r.status).toBe(200);
    expect(r.body.token).toBeTruthy();
    expect(r.body.usuario.roles).toEqual(['ADMIN']);
    expect(r.body.usuario.permisos).toContain('users:write');
    expect(JSON.stringify(r.body)).not.toMatch(/password|hash/i);
  });

  it('login incorrecto: mismo mensaje para usuario inexistente y contrasena mala', async () => {
    const mala = await http().post('/api/auth/login').send({ username: 'admin1', password: 'incorrecta-123' });
    const noExiste = await http().post('/api/auth/login').send({ username: 'nadie_aqui', password: 'incorrecta-123' });
    expect(mala.status).toBe(401);
    expect(noExiste.status).toBe(401);
    expect(mala.body.error.message).toBe(noExiste.body.error.message);
  });

  it('sin token o con token basura: 401', async () => {
    expect((await http().get('/api/auth/me')).status).toBe(401);
    expect((await http().get('/api/auth/me').set(bearer('no.es.un.jwt'))).status).toBe(401);
  });

  it('logout revoca la sesion de inmediato', async () => {
    const l = await http().post('/api/auth/login').send({ username: 'auditor1', password: password() });
    const t = l.body.token;
    expect((await http().get('/api/auth/me').set(bearer(t))).status).toBe(200);
    expect((await http().post('/api/auth/logout').set(bearer(t))).status).toBe(204);
    expect((await http().get('/api/auth/me').set(bearer(t))).status).toBe(401);
  });

  it('un usuario bloqueado no puede entrar y su sesion activa deja de valer', async () => {
    const u = await sesionDeCliente(admin, await nuevoCliente(cajero));
    expect((await http().get('/api/auth/me').set(bearer(u.token))).status).toBe(200);

    const b = await http().patch(`/api/users/${u.userId}/status`).set(bearer(admin)).send({ estado: 'bloqueado' });
    expect(b.status).toBe(200);
    expect((await http().get('/api/auth/me').set(bearer(u.token))).status).toBe(401);

    const intento = await http().post('/api/auth/login').send({ username: u.username, password: password() });
    expect(intento.status).toBe(403);
    expect(intento.body.error.code).toBe('USUARIO_BLOQUEADO');
  });

  it('5 contrasenas erroneas bloquean temporalmente aunque luego se use la correcta', async () => {
    const u = await sesionDeCliente(admin, await nuevoCliente(cajero));
    for (let i = 0; i < 5; i++) {
      await http().post('/api/auth/login').send({ username: u.username, password: 'mala-clave-999' });
    }
    const r = await http().post('/api/auth/login').send({ username: u.username, password: password() });
    expect(r.status).toBe(423);
  });

  it('el administrador no puede bloquearse a si mismo', async () => {
    const me = await http().get('/api/auth/me').set(bearer(admin));
    const r = await http().patch(`/api/users/${me.body.id}/status`).set(bearer(admin)).send({ estado: 'bloqueado' });
    expect(r.status).toBe(409);
  });
});

describe('autorizacion RBAC (el backend decide, no el frontend)', () => {
  it('PERMITIDO: auditor consulta la auditoria global', async () => {
    const r = await http().get('/api/audit?limit=5').set(bearer(auditor));
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.items)).toBe(true);
  });

  it('PERMITIDO: administrador administra usuarios', async () => {
    expect((await http().get('/api/users').set(bearer(admin))).status).toBe(200);
  });

  it('DENEGADO: cliente no consulta auditoria global', async () => {
    const u = await sesionDeCliente(admin, await nuevoCliente(cajero));
    const r = await http().get('/api/audit').set(bearer(u.token));
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('SIN_PERMISO');
  });

  it('DENEGADO: cajero no administra roles ni usuarios', async () => {
    expect((await http().put('/api/roles/CAJERO/permissions').set(bearer(cajero)).send({ permisos: [] })).status).toBe(403);
    expect((await http().get('/api/users').set(bearer(cajero))).status).toBe(403);
    expect((await http().get('/api/roles').set(bearer(cajero))).status).toBe(403);
  });

  it('DENEGADO: auditor y administrador no mueven dinero de ventanilla', async () => {
    const cuenta = await nuevaCuenta(cajero, await nuevoCliente(cajero));
    const cuerpo = { cuentaId: cuenta, monto: '1000' };
    expect((await http().post('/api/transactions/deposit').set({ ...bearer(auditor), 'Idempotency-Key': clave() }).send(cuerpo)).status).toBe(403);
    expect((await http().post('/api/transactions/deposit').set({ ...bearer(admin), 'Idempotency-Key': clave() }).send(cuerpo)).status).toBe(403);
  });

  it('DENEGADO: el cliente solo ve sus cuentas y no mueve dinero ajeno', async () => {
    const mio = await nuevoCliente(cajero);
    const otro = await nuevoCliente(cajero);
    const miCuenta = await nuevaCuenta(cajero, mio, 50_000);
    const ajena = await nuevaCuenta(cajero, otro, 50_000);
    const s = await sesionDeCliente(admin, mio);

    const lista = await http().get('/api/accounts').set(bearer(s.token));
    expect(lista.status).toBe(200);
    expect(lista.body.items.map((x: any) => x.cuenta_id)).toEqual([miCuenta]);

    expect((await http().get(`/api/accounts/${ajena}`).set(bearer(s.token))).status).toBe(404);
    expect((await http().get(`/api/accounts/${miCuenta}`).set(bearer(s.token))).status).toBe(200);

    const robo = await http().post('/api/transactions/transfer').set({ ...bearer(s.token), 'Idempotency-Key': clave() })
      .send({ origenId: ajena, destinoId: miCuenta, monto: '1000' });
    expect(robo.status).toBe(403);
    expect((await http().post('/api/transactions/deposit').set({ ...bearer(s.token), 'Idempotency-Key': clave() })
      .send({ cuentaId: miCuenta, monto: '1000' })).status).toBe(403);
  });

  it('los accesos denegados quedan en la auditoria con el usuario', async () => {
    const u = await sesionDeCliente(admin, await nuevoCliente(cajero));
    await http().get('/api/audit').set(bearer(u.token));
    const r = await http().get(`/api/audit?usuarioId=${u.userId}&resultado=DENEGADO`).set(bearer(auditor));
    expect(r.body.total).toBeGreaterThan(0);
    expect(r.body.items[0].detalle ?? r.body.items[0].despues).toMatchObject({ ruta: '/api/audit' });
    expect(r.body.items[0].rol).toBe('CLIENTE');
  });

  it('un cambio de permisos aplica en la siguiente peticion, sin reiniciar sesion', async () => {
    // Quita y devuelve un permiso al AUDITOR sin dejar rastro funcional.
    const antes = await http().get('/api/roles').set(bearer(admin));
    const permisos: string[] = antes.body.items.find((r: any) => r.codigo === 'AUDITOR').permisos;
    const sin = permisos.filter((p) => p !== 'stats:read');
    expect((await http().put('/api/roles/AUDITOR/permissions').set(bearer(admin)).send({ permisos: sin })).status).toBe(200);
    expect((await http().get('/api/stats/overview').set(bearer(auditor))).status).toBe(403);
    expect((await http().put('/api/roles/AUDITOR/permissions').set(bearer(admin)).send({ permisos })).status).toBe(200);
    expect((await http().get('/api/stats/overview').set(bearer(auditor))).status).toBe(200);
  });

  it('ADMIN no puede quitarse a si mismo la gestion de roles', async () => {
    const r = await http().put('/api/roles/ADMIN/permissions').set(bearer(admin)).send({ permisos: ['audit:read'] });
    expect(r.status).toBe(409);
  });
});

describe('manejo de errores', () => {
  it('no filtra detalles tecnicos de PostgreSQL ni trazas', async () => {
    const respuestas = [
      await http().post('/api/transactions/deposit').set({ ...bearer(cajero), 'Idempotency-Key': clave() }).send({ cuentaId: 99999999, monto: '10' }),
      await http().get('/api/customers/abc').set(bearer(cajero)),
      await http().post('/api/auth/login').set('Content-Type', 'application/json').send('{no es json'),
      await http().get('/api/ruta/inexistente'),
    ];
    for (const r of respuestas) {
      const texto = JSON.stringify(r.body);
      expect(texto).not.toMatch(/SQLSTATE|psql|PSQL|stack|at Object|node_modules|ERRCODE|pg_|relation "/);
      expect(r.body.error.message).toBeTruthy();
      expect(r.body.requestId).toBeTruthy();
    }
    expect(respuestas[0].status).toBe(404);
  });

  it('inyeccion SQL en filtros se trata como texto', async () => {
    const r = await http().get("/api/customers?q=' OR 1=1; DROP TABLE nucleo.cliente;--").set(bearer(cajero));
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(0);
    expect((await http().get('/api/customers?limit=1').set(bearer(cajero))).status).toBe(200);
  });
});
