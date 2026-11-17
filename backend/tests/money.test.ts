import { beforeAll, describe, expect, it } from 'vitest';
import { bearer, clave, http, nuevaCuenta, nuevoCliente, saldoDe, tokenDe } from './helpers';

let admin: string;
let cajero: string;
let auditor: string;

beforeAll(async () => {
  admin = await tokenDe('admin1');
  cajero = await tokenDe('cajero1');
  auditor = await tokenDe('auditor1');
});

const conClave = (t: string, k = clave()) => ({ ...bearer(t), 'Idempotency-Key': k });

async function cuentaConSaldo(saldo: number) {
  return nuevaCuenta(cajero, await nuevoCliente(cajero), saldo);
}

describe('ciclo de vida de la cuenta', () => {
  it('abrir, bloquear, desbloquear y cerrar, con eventos (que no son movimientos)', async () => {
    const cliente = await nuevoCliente(cajero);
    const pendiente = await http().post('/api/accounts').set(bearer(cajero)).send({ clienteId: cliente, activar: false });
    expect(pendiente.status).toBe(201);
    const id = pendiente.body.id;

    expect((await http().get(`/api/accounts/${id}`).set(bearer(cajero))).body.estado).toBe('pendiente');
    expect((await http().post(`/api/accounts/${id}/activate`).set(bearer(cajero)).send({})).body.estado).toBe('activa');

    const sinMotivo = await http().post(`/api/accounts/${id}/block`).set(bearer(cajero)).send({});
    expect(sinMotivo.status).toBe(400);
    expect((await http().post(`/api/accounts/${id}/block`).set(bearer(cajero)).send({ motivo: 'Sospecha de fraude' })).body.estado).toBe('bloqueada');
    expect((await http().post(`/api/accounts/${id}/unblock`).set(bearer(cajero)).send({})).body.estado).toBe('activa');
    expect((await http().post(`/api/accounts/${id}/close`).set(bearer(cajero)).send({ motivo: 'Cierre solicitado' })).body.estado).toBe('cerrada');

    const ev = await http().get(`/api/accounts/${id}/events`).set(bearer(auditor));
    expect(ev.body.items.map((e: any) => e.tipo).reverse()).toEqual(
      ['creacion', 'activacion', 'bloqueo', 'desbloqueo', 'cierre']);
    const mov = await http().get(`/api/accounts/${id}/statement`).set(bearer(cajero));
    expect(mov.body.total).toBe(0);

    const reabrir = await http().post(`/api/accounts/${id}/activate`).set(bearer(cajero)).send({});
    expect(reabrir.status).toBe(409);
  });

  it('no se cierra una cuenta con saldo', async () => {
    const id = await cuentaConSaldo(1000);
    const r = await http().post(`/api/accounts/${id}/close`).set(bearer(cajero)).send({ motivo: 'Cierre solicitado' });
    expect(r.status).toBe(409);
  });

  it('cambio de limites con motivo y efecto inmediato', async () => {
    const id = await cuentaConSaldo(1_000_000);
    const r = await http().put(`/api/accounts/${id}/limits`).set(bearer(admin))
      .send({ retiroDiario: '100000', transferenciaDiaria: '200000', motivo: 'Solicitud del cliente' });
    expect(r.status).toBe(200);
    expect(r.body.limite_retiro_diario).toBe('100000.00');
    const exceso = await http().post('/api/transactions/withdraw').set(conClave(cajero)).send({ cuentaId: id, monto: '100001' });
    expect(exceso.status).toBe(422);
    expect(exceso.body.error.code).toBe('LIMITE_EXCEDIDO');
  });
});

describe('operaciones de dinero', () => {
  it('consignacion, retiro y transferencia con comprobante', async () => {
    const a = await cuentaConSaldo(0);
    const b = await cuentaConSaldo(0);
    const dep = await http().post('/api/transactions/deposit').set(conClave(cajero)).send({ cuentaId: a, monto: '500000.50', concepto: 'Consignacion' });
    expect(dep.status).toBe(201);
    expect(dep.body).toMatchObject({ tipo: 'deposito', estado: 'POSTED', monto: '500000.50', canal: 'cajero' });

    expect((await http().post('/api/transactions/withdraw').set(conClave(cajero)).send({ cuentaId: a, monto: '100000' })).status).toBe(201);
    const tr = await http().post('/api/transactions/transfer').set(conClave(cajero)).send({ origenId: a, destinoId: b, monto: '150000.25' });
    expect(tr.status).toBe(201);
    expect(await saldoDe(cajero, a)).toBe('250000.25');
    expect(await saldoDe(cajero, b)).toBe('150000.25');

    const comp = await http().get(`/api/transactions/${tr.body.id}`).set(bearer(cajero));
    expect(comp.body.numero_debito).toBeTruthy();
  });

  it('REVERSO: compensa, no edita la original, y no se puede repetir', async () => {
    const a = await cuentaConSaldo(1000);
    const b = await cuentaConSaldo(0);
    const tr = await http().post('/api/transactions/transfer').set(conClave(cajero)).send({ origenId: a, destinoId: b, monto: '400' });

    const rev = await http().post('/api/transactions/reverse').set(conClave(admin)).send({ transaccionId: tr.body.id, motivo: 'Transferencia por error' });
    expect(rev.status).toBe(201);
    expect(rev.body.tipo).toBe('reverso');
    expect(rev.body.reversa_de).toBe(tr.body.id);
    expect(await saldoDe(cajero, a)).toBe('1000.00');
    expect(await saldoDe(cajero, b)).toBe('0.00');

    const original = await http().get(`/api/transactions/${tr.body.id}`).set(bearer(admin));
    expect(original.body.tipo).toBe('transferencia'); // sigue intacta

    const otra = await http().post('/api/transactions/reverse').set(conClave(admin)).send({ transaccionId: tr.body.id, motivo: 'Otro intento' });
    expect(otra.status).toBe(409);
    expect(otra.body.error.code).toBe('YA_REVERSADA');
  });

  it('el cajero no puede reversar', async () => {
    const dep = await http().post('/api/transactions/deposit').set(conClave(cajero)).send({ cuentaId: await cuentaConSaldo(0), monto: '10' });
    const r = await http().post('/api/transactions/reverse').set(conClave(cajero)).send({ transaccionId: dep.body.id, motivo: 'No deberia poder' });
    expect(r.status).toBe(403);
  });

  it('ajuste contable exige permiso y concepto', async () => {
    const id = await cuentaConSaldo(100);
    expect((await http().post('/api/transactions/adjust').set(conClave(cajero)).send({ cuentaId: id, sentido: 'credito', monto: '5', concepto: 'Correccion de intereses' })).status).toBe(403);
    expect((await http().post('/api/transactions/adjust').set(conClave(admin)).send({ cuentaId: id, sentido: 'credito', monto: '5', concepto: 'x' })).status).toBe(400);
    expect((await http().post('/api/transactions/adjust').set(conClave(admin)).send({ cuentaId: id, sentido: 'credito', monto: '5', concepto: 'Correccion de intereses' })).status).toBe(201);
    expect(await saldoDe(cajero, id)).toBe('105.00');
  });
});

describe('seguridad financiera', () => {
  it('saldo insuficiente con mensaje claro y sin tocar saldos', async () => {
    const a = await cuentaConSaldo(50);
    const b = await cuentaConSaldo(0);
    const r = await http().post('/api/transactions/transfer').set(conClave(cajero)).send({ origenId: a, destinoId: b, monto: '51' });
    expect(r.status).toBe(422);
    expect(r.body.error.message).toBe('Saldo insuficiente.');
    expect(await saldoDe(cajero, a)).toBe('50.00');
    expect(await saldoDe(cajero, b)).toBe('0.00');
  });

  it('transferencia a la misma cuenta es invalida', async () => {
    const a = await cuentaConSaldo(100);
    const r = await http().post('/api/transactions/transfer').set(conClave(cajero)).send({ origenId: a, destinoId: a, monto: '10' });
    expect(r.status).toBe(400);
  });

  it('cuenta bloqueada no opera (origen ni destino)', async () => {
    const a = await cuentaConSaldo(100);
    const b = await cuentaConSaldo(100);
    await http().post(`/api/accounts/${a}/block`).set(bearer(cajero)).send({ motivo: 'Bloqueo preventivo' });
    const origen = await http().post('/api/transactions/withdraw').set(conClave(cajero)).send({ cuentaId: a, monto: '10' });
    expect(origen.status).toBe(409);
    expect(origen.body.error.code).toBe('CUENTA_NO_ACTIVA');
    const destino = await http().post('/api/transactions/transfer').set(conClave(cajero)).send({ origenId: b, destinoId: a, monto: '1' });
    expect(destino.status).toBe(409);
  });

  it('montos invalidos se rechazan', async () => {
    const a = await cuentaConSaldo(100);
    for (const monto of ['0', '-5', '10.555', 'abc', '', '1e3', 0, -1]) {
      const r = await http().post('/api/transactions/deposit').set(conClave(cajero)).send({ cuentaId: a, monto });
      expect(r.status, `monto ${String(monto)}`).toBe(400);
    }
    expect(await saldoDe(cajero, a)).toBe('100.00');
  });

  it('exige Idempotency-Key en operaciones de dinero', async () => {
    const a = await cuentaConSaldo(0);
    const r = await http().post('/api/transactions/deposit').set(bearer(cajero)).send({ cuentaId: a, monto: '10' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('IDEMPOTENCIA');
  });

  it('IDEMPOTENCIA: la misma solicitud dos veces genera UN solo movimiento', async () => {
    const a = await cuentaConSaldo(0);
    const k = clave();
    const r1 = await http().post('/api/transactions/deposit').set(conClave(cajero, k)).send({ cuentaId: a, monto: '700' });
    const r2 = await http().post('/api/transactions/deposit').set(conClave(cajero, k)).send({ cuentaId: a, monto: '700' });
    expect(r1.body.id).toBe(r2.body.id);
    expect(await saldoDe(cajero, a)).toBe('700.00');
    const mov = await http().get(`/api/accounts/${a}/statement`).set(bearer(cajero));
    expect(mov.body.total).toBe(1);
  });

  it('la misma clave con otro monto es un conflicto, no un segundo cobro', async () => {
    const a = await cuentaConSaldo(0);
    const k = clave();
    await http().post('/api/transactions/deposit').set(conClave(cajero, k)).send({ cuentaId: a, monto: '700' });
    const r = await http().post('/api/transactions/deposit').set(conClave(cajero, k)).send({ cuentaId: a, monto: '701' });
    expect(r.status).toBe(409);
    expect(await saldoDe(cajero, a)).toBe('700.00');
  });

  it('CONCURRENCIA: 8 retiros simultaneos de 30 con saldo 100 -> exactamente 3 pasan', async () => {
    const a = await cuentaConSaldo(100);
    const resp = await Promise.all(
      Array.from({ length: 8 }, () =>
        http().post('/api/transactions/withdraw').set(conClave(cajero)).send({ cuentaId: a, monto: '30' })),
    );
    expect(resp.filter((r) => r.status === 201)).toHaveLength(3);
    expect(resp.filter((r) => r.status === 422)).toHaveLength(5);
    expect(await saldoDe(cajero, a)).toBe('10.00');
  });

  it('CONCURRENCIA: 8 envios de la MISMA solicitud (doble clic) se aplican una vez', async () => {
    const a = await cuentaConSaldo(0);
    const k = clave();
    const resp = await Promise.all(
      Array.from({ length: 8 }, () =>
        http().post('/api/transactions/deposit').set(conClave(cajero, k)).send({ cuentaId: a, monto: '25' })),
    );
    expect(new Set(resp.map((r) => r.body.id)).size).toBe(1);
    expect(await saldoDe(cajero, a)).toBe('25.00');
  });

  it('CONCURRENCIA: transferencias cruzadas simultaneas no se bloquean entre si y conservan el dinero', async () => {
    const a = await cuentaConSaldo(10_000);
    const b = await cuentaConSaldo(10_000);
    const resp = await Promise.all(
      Array.from({ length: 16 }, (_, i) =>
        http().post('/api/transactions/transfer').set(conClave(cajero))
          .send(i % 2 ? { origenId: a, destinoId: b, monto: '10' } : { origenId: b, destinoId: a, monto: '10' })),
    );
    expect(resp.every((r) => r.status === 201)).toBe(true);
    expect(await saldoDe(cajero, a)).toBe('10000.00');
    expect(await saldoDe(cajero, b)).toBe('10000.00');
  });
});

describe('auditoria de operaciones criticas', () => {
  it('registra quien, que, cuando, sobre que registro y los valores antes/despues', async () => {
    const id = await cuentaConSaldo(0);
    const dep = await http().post('/api/transactions/deposit').set(conClave(cajero)).send({ cuentaId: id, monto: '321', concepto: 'Auditoria' });
    const bloq = await http().post(`/api/accounts/${id}/block`).set(bearer(cajero)).send({ motivo: 'Prueba de auditoria' });
    expect(bloq.status).toBe(200);

    const yo = (await http().get('/api/auth/me').set(bearer(cajero))).body;
    const tx = await http().get(`/api/audit?tabla=nucleo.transaccion&registroId=${dep.body.id}`).set(bearer(auditor));
    expect(tx.body.total).toBe(1);
    expect(tx.body.items[0]).toMatchObject({ usuario_app_id: yo.id, rol: 'CAJERO', operacion: 'INSERT', resultado: 'OK', username: 'cajero1' });
    expect(Number(tx.body.items[0].despues.monto)).toBe(321); // JSON de auditoria: numero
    expect(tx.body.items[0].ip).toBeTruthy();
    expect(tx.body.items[0].ocurrido_en).toBeTruthy();

    const cu = await http().get(`/api/audit?tabla=nucleo.cuenta&registroId=${id}&operacion=UPDATE`).set(bearer(auditor));
    const cambio = cu.body.items[0];
    expect(cambio.antes.estado).toBe('activa');
    expect(cambio.despues.estado).toBe('bloqueada');
    expect(cambio.usuario_app_id).toBe(yo.id);
  });

  it('el login exitoso y el fallido quedan registrados', async () => {
    await http().post('/api/auth/login').send({ username: 'admin1', password: 'mala-clave-777' });
    const ok = await http().get('/api/audit?tabla=seguridad.usuario&operacion=LOGIN&resultado=OK&limit=5').set(bearer(auditor));
    const mal = await http().get('/api/audit?tabla=seguridad.usuario&operacion=LOGIN&resultado=DENEGADO&limit=5').set(bearer(auditor));
    expect(ok.body.total).toBeGreaterThan(0);
    expect(mal.body.total).toBeGreaterThan(0);
  });
});
