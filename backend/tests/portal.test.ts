import { beforeAll, describe, expect, it } from 'vitest';
import { bearer, clave, http, nuevaCuenta, nuevoCliente, sesionDeCliente, tokenDe } from './helpers';

let admin: string;
let cajero: string;

beforeAll(async () => {
  admin = await tokenDe('admin1');
  cajero = await tokenDe('cajero1');
});

describe('cierre diario contable', () => {
  it('el administrador lista los cierres; un dia ya cerrado se rechaza con 409', async () => {
    const lista = await http().get('/api/stats/cierres?limit=3').set(bearer(admin));
    expect(lista.status).toBe(200);
    expect(lista.body.items.length).toBeGreaterThan(0);
    const c = lista.body.items[0];
    expect(c.total_debitos).toBe(c.total_creditos); // un cierre siempre cuadra

    const otra = await http().post('/api/stats/cierres').set(bearer(admin)).send({ fecha: String(c.fecha).slice(0, 10) });
    expect(otra.status).toBe(409);
    expect(otra.body.error.message).toMatch(/ya fue cerrado/i);
  });

  it('no se puede cerrar hoy ni usar fechas invalidas', async () => {
    const hoy = new Date().toISOString().slice(0, 10);
    expect((await http().post('/api/stats/cierres').set(bearer(admin)).send({ fecha: hoy })).status).toBe(400);
    expect((await http().post('/api/stats/cierres').set(bearer(admin)).send({ fecha: 'ayer' })).status).toBe(400);
  });

  it('solo el administrador cierra; el auditor puede consultar pero no cerrar; el cajero ni consulta', async () => {
    const auditor = await tokenDe('auditor1');
    expect((await http().get('/api/stats/cierres').set(bearer(auditor))).status).toBe(200);
    expect((await http().post('/api/stats/cierres').set(bearer(auditor)).send({ fecha: '2024-01-10' })).status).toBe(403);
    expect((await http().post('/api/stats/cierres').set(bearer(cajero)).send({ fecha: '2024-01-10' })).status).toBe(403);
    expect((await http().get('/api/stats/cierres').set(bearer(cajero))).status).toBe(403);
  });
});

describe('ubicacion obligatoria del cliente', () => {
  it('rechaza un cliente sin departamento o ciudad con un mensaje claro', async () => {
    const r = await http().post('/api/customers').set(bearer(cajero))
      .send({ documento: '3999999999', nombre: 'Sin Ubicacion Prueba' });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(/departamento/i);
  });

  it('abre la cuenta en la oficina del departamento del cliente', async () => {
    const cli = await nuevoCliente(cajero, { departamento: 'Atlantico', ciudad: 'Barranquilla' });
    const cuenta = await nuevaCuenta(cajero, cli, 0);
    const d = await http().get(`/api/accounts/${cuenta}`).set(bearer(cajero));
    expect(d.body.oficina).toBe('Andino Prado'); // OF-BAQ-01, Barranquilla
  });
});

describe('busqueda de cuenta destino (lookup)', () => {
  it('un cliente ve el titular enmascarado, nunca el nombre completo', async () => {
    const dueno = await nuevoCliente(cajero, { nombre: 'Valentina Rojas Medina' });
    const cuenta = await nuevaCuenta(cajero, dueno, 0);
    const numero = (await http().get(`/api/accounts/${cuenta}`).set(bearer(cajero))).body.numero;
    const s = await sesionDeCliente(admin, await nuevoCliente(cajero));

    const r = await http().get(`/api/accounts/lookup?numero=${numero}`).set(bearer(s.token));
    expect(r.status).toBe(200);
    expect(r.body.id).toBe(cuenta);
    expect(r.body.titular).toMatch(/^V\*+ R\*+ M\*+$/);
    expect(JSON.stringify(r.body)).not.toContain('Valentina');
  });

  it('formato invalido, cuenta inexistente o inactiva -> error claro', async () => {
    const s = await sesionDeCliente(admin, await nuevoCliente(cajero));
    expect((await http().get('/api/accounts/lookup?numero=XYZ').set(bearer(s.token))).status).toBe(400);
    expect((await http().get('/api/accounts/lookup?numero=LB-9999999999').set(bearer(s.token))).status).toBe(404);

    const cuenta = await nuevaCuenta(cajero, await nuevoCliente(cajero), 0);
    const numero = (await http().get(`/api/accounts/${cuenta}`).set(bearer(cajero))).body.numero;
    await http().post(`/api/accounts/${cuenta}/block`).set(bearer(cajero)).send({ motivo: 'Bloqueo de prueba' });
    expect((await http().get(`/api/accounts/lookup?numero=${numero}`).set(bearer(s.token))).status).toBe(404);
  });

  it('sin permiso de transferir no se puede usar (auditor)', async () => {
    const auditor = await tokenDe('auditor1');
    expect((await http().get('/api/accounts/lookup?numero=LB-0000000001').set(bearer(auditor))).status).toBe(403);
  });
});

describe('filtro de transacciones por actor (Mis operaciones del cajero)', () => {
  it('devuelve solo las operaciones registradas por ese usuario', async () => {
    const yo = (await http().get('/api/auth/me').set(bearer(cajero))).body.id;
    const cuenta = await nuevaCuenta(cajero, await nuevoCliente(cajero), 0);
    const dep = await http().post('/api/transactions/deposit').set({ ...bearer(cajero), 'Idempotency-Key': clave() }).send({ cuentaId: cuenta, monto: '123' });

    const mias = await http().get(`/api/transactions?actorId=${yo}&limit=5`).set(bearer(cajero));
    expect(mias.body.items[0].id).toBe(dep.body.id);
    // la vista ya no expone actor_usuario_id (dato interno); el filtro se prueba con un actor inexistente abajo
    expect(mias.body.items[0]).not.toHaveProperty('actor_usuario_id');

    const deAdmin = await http().get('/api/transactions?actorId=999999999&limit=5').set(bearer(cajero));
    expect(deAdmin.body.total).toBe(0);
  });

  it('un cliente no puede ver operaciones ajenas usando actorId', async () => {
    const mio = await nuevoCliente(cajero);
    await nuevaCuenta(cajero, mio, 0);
    const s = await sesionDeCliente(admin, mio);
    const r = await http().get('/api/transactions?actorId=1&limit=50').set(bearer(s.token));
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(0); // el filtro de propiedad se aplica siempre
  });
});
