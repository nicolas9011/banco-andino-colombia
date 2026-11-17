import { beforeAll, describe, expect, it } from 'vitest';
import { bearer, clave, http, nuevaCuenta, nuevoCliente, saldoDe, sesionDeCliente, tokenDe } from './helpers';

let admin: string;
let cajero: string;

beforeAll(async () => {
  admin = await tokenDe('admin1');
  cajero = await tokenDe('cajero1');
});

const conClave = (t: string, k = clave()) => ({ ...bearer(t), 'Idempotency-Key': k });

async function tarjetaNueva(saldo: number, pin = '2468') {
  const cuenta = await nuevaCuenta(cajero, await nuevoCliente(cajero), saldo);
  const t = await http().post(`/api/accounts/${cuenta}/card`).set(bearer(cajero)).send({ pin });
  expect(t.status).toBe(201);
  return { cuenta, numero: t.body.numeroTarjeta as string, pin };
}

async function entrar(numero: string, pin: string) {
  return http().post('/api/atm/login').send({ numeroTarjeta: numero, pin });
}

describe('ATM', () => {
  it('flujo completo: tarjeta+PIN, saldo, retiro, movimientos, cierre de sesion', async () => {
    const t = await tarjetaNueva(300_000);
    const l = await entrar(t.numero, t.pin);
    expect(l.status).toBe(200);
    const h = bearer(l.body.token);

    const bal = await http().get('/api/atm/balance').set(h);
    expect(bal.body.saldoDisponible).toBe('300000.00');

    const ret = await http().post('/api/atm/withdraw').set({ ...h, 'Idempotency-Key': clave() }).send({ monto: 120000 });
    expect(ret.status).toBe(201);
    expect(ret.body.comprobante).toMatchObject({ tipo: 'retiro', canal: 'atm' });
    expect(ret.body.saldoDisponible).toBe('180000.00');

    const mov = await http().get('/api/atm/movements').set(h);
    expect(mov.body.items[0]).toMatchObject({ tipo: 'retiro', sentido: 'D' });

    expect((await http().post('/api/atm/logout').set(h)).status).toBe(204);
    expect((await http().get('/api/atm/balance').set(h)).status).toBe(401);
  });

  it('el token del ATM no sirve en el portal web y viceversa', async () => {
    const t = await tarjetaNueva(10_000);
    const atm = (await entrar(t.numero, t.pin)).body.token;
    expect((await http().get('/api/accounts').set(bearer(atm))).status).toBe(403);
    expect((await http().get('/api/atm/balance').set(bearer(cajero))).status).toBe(403);
  });

  it('PIN incorrecto: mensaje generico (no confirma la tarjeta) y se bloquea al tercero', async () => {
    const t = await tarjetaNueva(10_000);
    const a = await entrar(t.numero, '0000');
    expect(a.status).toBe(401);
    const inexistente = await entrar('4000009999999998', '0000');
    expect(a.body.error.code).toBe(inexistente.body.error.code);
    expect(a.body.error.message).toBe(inexistente.body.error.message);
    expect((await entrar(t.numero, '1111')).status).toBe(401);
    const c = await entrar(t.numero, '9999');
    expect(c.status).toBe(403);
    expect(c.body.error.code).toBe('TARJETA_BLOQUEADA');
    // Bloqueada: ni el PIN correcto entra
    expect((await entrar(t.numero, t.pin)).status).toBe(403);
  });

  it('tarjeta inexistente: mismo error generico', async () => {
    const r = await entrar('4000009999999999', '1234');
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('TARJETA_O_PIN');
  });

  it('retiro: multiplos de 10.000, sin saldo y sin sobregiro, sin doble retiro', async () => {
    const t = await tarjetaNueva(50_000);
    const h = bearer((await entrar(t.numero, t.pin)).body.token);
    const retiro = (monto: number, k = clave()) =>
      http().post('/api/atm/withdraw').set({ ...h, 'Idempotency-Key': k }).send({ monto });

    expect((await retiro(15_500)).status).toBe(400);      // no es multiplo
    expect((await retiro(0)).status).toBe(400);
    const sinFondos = await retiro(60_000);
    expect(sinFondos.status).toBe(422);
    expect(sinFondos.body.error.message).toBe('Saldo insuficiente.');

    const k = clave();
    const dobles = await Promise.all([retiro(30_000, k), retiro(30_000, k), retiro(30_000, k)]);
    expect(new Set(dobles.map((r) => r.body.comprobante?.id)).size).toBe(1);
    expect(await saldoDe(cajero, t.cuenta)).toBe('20000.00');
  });

  it('no opera con la cuenta bloqueada', async () => {
    const t = await tarjetaNueva(50_000);
    const h = bearer((await entrar(t.numero, t.pin)).body.token);
    await http().post(`/api/accounts/${t.cuenta}/block`).set(bearer(cajero)).send({ motivo: 'Bloqueo por prueba' });
    const r = await http().post('/api/atm/withdraw').set({ ...h, 'Idempotency-Key': clave() }).send({ monto: 10_000 });
    expect(r.status).toBe(409);
    expect((await entrar(t.numero, t.pin)).status).toBe(403);
  });

  it('transferencia desde el ATM y cambio de PIN', async () => {
    const t = await tarjetaNueva(100_000);
    const destino = await nuevaCuenta(cajero, await nuevoCliente(cajero), 0);
    const numDestino = (await http().get(`/api/accounts/${destino}`).set(bearer(cajero))).body.numero;
    const h = bearer((await entrar(t.numero, t.pin)).body.token);

    const tr = await http().post('/api/atm/transfer').set({ ...h, 'Idempotency-Key': clave() }).send({ cuentaDestino: numDestino, monto: '40000' });
    expect(tr.status).toBe(201);
    expect(await saldoDe(cajero, destino)).toBe('40000.00');

    expect((await http().post('/api/atm/change-pin').set(h).send({ pinActual: '0000', pinNuevo: '7391' })).status).toBe(401);
    expect((await http().post('/api/atm/change-pin').set(h).send({ pinActual: t.pin, pinNuevo: '1111' })).status).toBe(400);
    expect((await http().post('/api/atm/change-pin').set(h).send({ pinActual: t.pin, pinNuevo: '7391' })).status).toBe(200);
    expect((await entrar(t.numero, t.pin)).status).toBe(401);
    expect((await entrar(t.numero, '7391')).status).toBe(200);
  });

  it('la auditoria del ATM identifica el canal y no guarda hashes', async () => {
    const t = await tarjetaNueva(50_000);
    const tok = await tokenDe('auditor1');
    const h = bearer((await entrar(t.numero, t.pin)).body.token);
    const r = await http().post('/api/atm/withdraw').set({ ...h, 'Idempotency-Key': clave() }).send({ monto: 10_000 });
    const a = await http().get(`/api/audit?tabla=nucleo.transaccion&registroId=${r.body.comprobante.id}`).set(bearer(tok));
    expect(a.body.items[0].rol).toBe('ATM');
    const t2 = await http().get('/api/audit?tabla=nucleo.tarjeta&limit=20').set(bearer(tok));
    expect(JSON.stringify(t2.body)).not.toMatch(/pin_hash|numero_hash/);
  });
});

describe('Bre-B academico (simulado)', () => {
  async function cliente(saldo: number) {
    const id = await nuevoCliente(cajero);
    const cuenta = await nuevaCuenta(cajero, id, saldo);
    const s = await sesionDeCliente(admin, id);
    return { id, cuenta, token: s.token };
  }

  it('registrar llave, resolver, enviar y ver historial; siempre marcado como simulacion', async () => {
    const a = await cliente(200_000);
    const b = await cliente(0);
    const valor = '@' + clave().slice(1, 11).toLowerCase();

    const k = await http().post('/api/brebe/keys').set(bearer(b.token)).send({ cuentaId: b.cuenta, tipo: 'alfanumerica', valor });
    expect(k.status).toBe(201);
    expect(k.body.simulacion).toBe(true);

    const prev = await http().get(`/api/brebe/resolve?llave=${encodeURIComponent(valor)}`).set(bearer(a.token));
    expect(prev.body.titular).toMatch(/\*/); // nombre parcialmente oculto

    const clv = clave();
    const e1 = await http().post('/api/brebe/send').set(conClave(a.token, clv)).send({ cuentaOrigenId: a.cuenta, llave: valor, monto: '75000', concepto: 'Almuerzo' });
    const e2 = await http().post('/api/brebe/send').set(conClave(a.token, clv)).send({ cuentaOrigenId: a.cuenta, llave: valor, monto: '75000', concepto: 'Almuerzo' });
    expect(e1.status).toBe(201);
    expect(e1.body.comprobante.canal).toBe('brebe');
    expect(e1.body.simulacion).toBe(true);
    expect(e2.body.comprobante.id).toBe(e1.body.comprobante.id);
    expect(await saldoDe(cajero, a.cuenta)).toBe('125000.00');
    expect(await saldoDe(cajero, b.cuenta)).toBe('75000.00');

    const h = await http().get('/api/brebe/history').set(bearer(b.token));
    expect(h.body.total).toBe(1);
  });

  it('validaciones: llave duplicada, formato, cuenta ajena, saldo, llave inexistente', async () => {
    const a = await cliente(1000);
    const b = await cliente(0);
    const valor = '@' + clave().slice(1, 11).toLowerCase();
    await http().post('/api/brebe/keys').set(bearer(b.token)).send({ cuentaId: b.cuenta, tipo: 'alfanumerica', valor });

    expect((await http().post('/api/brebe/keys').set(bearer(a.token)).send({ cuentaId: a.cuenta, tipo: 'alfanumerica', valor })).status).toBe(409);
    expect((await http().post('/api/brebe/keys').set(bearer(a.token)).send({ cuentaId: a.cuenta, tipo: 'celular', valor: '123' })).status).toBe(400);
    // secuestro de llave: documento/celular/correo ajenos (o que no son del cliente) se rechazan
    for (const [tipo, v] of [['documento', '9876543210'], ['celular', '3001234567'], ['correo', 'victima@ejemplo.co']]) {
      expect((await http().post('/api/brebe/keys').set(bearer(a.token)).send({ cuentaId: a.cuenta, tipo, valor: v })).status, tipo).toBe(400);
    }
    expect((await http().post('/api/brebe/keys').set(bearer(a.token)).send({ cuentaId: b.cuenta, tipo: 'alfanumerica', valor: '@ajena' + Date.now().toString(36) })).status).toBe(404);

    const s = (monto: string, llave = valor, cuentaOrigenId = a.cuenta) =>
      http().post('/api/brebe/send').set(conClave(a.token)).send({ cuentaOrigenId, llave, monto });
    expect((await s('5000')).body.error.message).toBe('Saldo insuficiente.');
    expect((await s('10', '@noexiste99')).status).toBe(404);
    expect((await s('10', valor, b.cuenta)).status).toBe(403); // enviar desde cuenta ajena
  });

  it('solo clientes usan Bre-B', async () => {
    expect((await http().get('/api/brebe/keys').set(bearer(cajero))).status).toBe(403);
  });
});

describe('portal del cliente', () => {
  it('dashboard con saldo total, cuentas, movimientos y alertas calculados en el servidor', async () => {
    const id = await nuevoCliente(cajero);
    const c1 = await nuevaCuenta(cajero, id, 100_000);
    const c2 = await nuevaCuenta(cajero, id, 50_000);
    await http().post(`/api/accounts/${c2}/block`).set(bearer(cajero)).send({ motivo: 'Prueba de alertas' });
    const s = await sesionDeCliente(admin, id);
    const d = await http().get('/api/me/dashboard').set(bearer(s.token));
    expect(d.status).toBe(200);
    expect(d.body.saldoTotal.COP).toBe('150000.00');
    expect(d.body.cuentas.map((c: any) => c.cuenta_id)).toEqual([c1, c2]);
    expect(d.body.movimientosRecientes.length).toBeGreaterThan(0);
    expect(d.body.alertas.some((a: any) => a.nivel === 'critico')).toBe(true);
  });

  it('un cliente no entra al dashboard de otro rol y el personal no tiene dashboard de cliente', async () => {
    expect((await http().get('/api/me/dashboard').set(bearer(cajero))).status).toBe(403);
  });
});
