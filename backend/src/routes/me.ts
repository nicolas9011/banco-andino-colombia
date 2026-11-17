import { Router } from 'express';
import { rows, withTx } from '../db';
import { baseTx, CUENTAS_DEL_CLIENTE } from '../lib/access';
import { sumarDecimales } from '../lib/http';
import { authenticate, requirePermission, requireWeb } from '../middleware/auth';

export const meRouter = Router();
meRouter.use(authenticate, requireWeb, requirePermission('accounts:read_own'));

const PROPIAS = `cuenta_id IN (SELECT cuenta_id FROM api.v_titular_base WHERE cliente_id = $1)`;

// Dashboard del cliente: todo se calcula en el servidor a partir de sus propias cuentas.
meRouter.get('/dashboard', async (req, res) => {
  const cliente = req.auth!.clienteId ?? 0;
  const out = await withTx(null, async (c) => {
    const cuentas = await rows(c, `SELECT * FROM api.v_saldos WHERE ${PROPIAS} ORDER BY cuenta_id`, [cliente]);
    const movimientos = await rows(
      c, `SELECT id, numero, tipo, canal, concepto, sentido, monto, saldo_posterior, creado_en
            FROM api.v_extracto WHERE ${PROPIAS} ORDER BY creado_en DESC, id DESC LIMIT 10`, [cliente]);
    const transferencias = await rows(
      c, `SELECT d.* FROM api.v_transacciones d
            JOIN (SELECT id FROM ${baseTx(CUENTAS_DEL_CLIENTE(1))} WHERE tipo = 'transferencia'
                   ORDER BY creado_en DESC, id LIMIT 5) p ON p.id = d.id
           ORDER BY d.creado_en DESC, d.id`, [cliente]);

    const saldoTotal: Record<string, string> = {};
    for (const m of ['COP', 'USD']) {
      // Suma exacta con enteros grandes (centavos): el dinero nunca pasa por float.
      if (cuentas.some((x) => x.moneda === m)) {
        saldoTotal[m] = sumarDecimales(cuentas.filter((x) => x.moneda === m && x.estado !== 'cerrada').map((x) => x.saldo_contable));
      }
    }
    const alertas: { nivel: 'info' | 'aviso' | 'critico'; mensaje: string }[] = [];
    for (const x of cuentas) {
      if (x.estado === 'bloqueada') alertas.push({ nivel: 'critico', mensaje: `La cuenta ${x.numero} esta bloqueada.` });
      if (x.estado === 'pendiente') alertas.push({ nivel: 'aviso', mensaje: `La cuenta ${x.numero} esta pendiente de activacion.` });
      if (Number(x.saldo_contable) < 0) alertas.push({ nivel: 'aviso', mensaje: `La cuenta ${x.numero} esta en sobregiro.` });
    }
    return { saldoTotal, cuentas, movimientosRecientes: movimientos, ultimasTransferencias: transferencias, alertas };
  });
  res.json(out);
});
