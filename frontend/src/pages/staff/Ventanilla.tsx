import { ArrowDownToLine, ArrowRightLeft, ArrowUpFromLine } from 'lucide-react';
import { FormEvent, useState } from 'react';
import { Link } from 'react-router-dom';
import { BuscadorCuenta, CuentaEncontrada } from '../../components/BuscadorCuenta';
import { Comprobante, TransaccionVista } from '../../components/Comprobante';
import { Aviso, Boton, Campo, CampoMonto, EncabezadoPagina, ErrorCarga, Tabla, Tarjeta } from '../../components/ui';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { dinero, ETIQUETA_TIPO, fecha, montoValido } from '../../lib/format';
import { useAccion, useCarga, useClaveIdempotencia } from '../../lib/hooks';

type Operacion = 'deposit' | 'withdraw' | 'transfer';

const OPS: { id: Operacion; texto: string; icono: typeof ArrowDownToLine; permiso: string }[] = [
  { id: 'deposit', texto: 'Consignar', icono: ArrowDownToLine, permiso: 'tx:deposit' },
  { id: 'withdraw', texto: 'Retirar', icono: ArrowUpFromLine, permiso: 'tx:withdraw' },
  { id: 'transfer', texto: 'Transferir', icono: ArrowRightLeft, permiso: 'tx:transfer' },
];

interface Mia { id: string; tipo: string; monto: string; numero_debito: string; numero_credito: string; creado_en: string; moneda: string; canal: string }

/** Operaciones rapidas de ventanilla: una cuenta, una operacion, comprobante. */
export default function Ventanilla() {
  const { usuario, puede } = useAuth();
  const ops = OPS.filter((o) => puede(o.permiso));
  const [op, setOp] = useState<Operacion>(ops[0]?.id ?? 'deposit');
  const [cuenta, setCuenta] = useState<CuentaEncontrada | null>(null);
  const [destino, setDestino] = useState<CuentaEncontrada | null>(null);
  const [monto, setMonto] = useState('');
  const [concepto, setConcepto] = useState('');
  const [comprobante, setComprobante] = useState<TransaccionVista | null>(null);
  const [ok, setOk] = useState(false);
  const clave = useClaveIdempotencia();
  const { enviando, error, setError, ejecutar } = useAccion();

  const mias = useCarga(
    () => api<{ total: number; items: Mia[] }>('/transactions', { query: { actorId: usuario?.id, limit: 8 } }),
    [usuario?.id],
  );

  const necesitaDestino = op === 'transfer';
  const listo = !!cuenta && montoValido(monto) && (!necesitaDestino || (!!destino && destino.id !== cuenta.id));

  async function enviar(e: FormEvent) {
    e.preventDefault();
    setOk(false);
    const cuerpo = op === 'transfer'
      ? { origenId: cuenta!.id, destinoId: destino!.id, monto, concepto: concepto.trim() || undefined }
      : { cuentaId: cuenta!.id, monto, concepto: concepto.trim() || undefined };
    const tx = await ejecutar(() => api<TransaccionVista>(`/transactions/${op}`, { method: 'POST', body: cuerpo, idempotencyKey: clave.clave() }));
    if (tx) {
      clave.renovar();
      setComprobante(tx);
      setOk(true);
      setMonto(''); setConcepto('');
      mias.recargar();
    }
  }

  return (
    <>
      <EncabezadoPagina titulo="Ventanilla" descripcion="Operaciones rápidas sobre cuentas de clientes." />
      <div className="grid gap-6 xl:grid-cols-5">
        <Tarjeta className="xl:col-span-3">
          <div role="tablist" aria-label="Tipo de operación" className="mb-5 grid grid-cols-3 gap-2">
            {ops.map((o) => (
              <button
                key={o.id} type="button" role="tab" aria-selected={op === o.id}
                // El buscador de destino se desmonta al salir de "Transferir": su cuenta no debe quedar seleccionada en secreto.
                onClick={() => { setOp(o.id); setDestino(null); setError(null); setOk(false); clave.renovar(); }}
                className={`flex min-h-14 flex-col items-center justify-center gap-1 rounded-xl px-2 py-2 text-sm font-semibold ring-1 ring-inset transition-colors ${
                  op === o.id ? 'bg-andino-700 text-white ring-andino-700' : 'bg-white text-andino-800 ring-andino-200 hover:bg-andino-50'}`}
              >
                <o.icono className="h-5 w-5" /> {o.texto}
              </button>
            ))}
          </div>

          <form onSubmit={enviar} className="space-y-4" noValidate>
            {error && <Aviso tipo="error">{error}</Aviso>}
            {ok && <Aviso tipo="ok">Operación contabilizada. Puedes imprimir el comprobante.</Aviso>}
            <BuscadorCuenta etiqueta={op === 'transfer' ? 'Cuenta de origen' : 'Cuenta'} alEncontrar={(c) => { setCuenta(c); clave.renovar(); }} />
            {necesitaDestino && <BuscadorCuenta etiqueta="Cuenta de destino" alEncontrar={(c) => { setDestino(c); clave.renovar(); }} />}
            {necesitaDestino && cuenta && destino?.id === cuenta.id && <Aviso tipo="error">Origen y destino deben ser distintos.</Aviso>}
            <CampoMonto etiqueta="Monto" valor={monto} alCambiar={(v) => { setMonto(v); clave.renovar(); }} />
            <Campo etiqueta="Concepto (opcional)" maxLength={200} value={concepto} onChange={(e) => { setConcepto(e.target.value); clave.renovar(); }} />
            <Boton type="submit" tamano="lg" className="w-full" cargando={enviando} disabled={!listo}>
              {{ deposit: 'Confirmar consignación', withdraw: 'Confirmar retiro', transfer: 'Confirmar transferencia' }[op]}
              {monto && montoValido(monto) ? ` ${dinero(monto, cuenta?.moneda)}` : ''}
            </Boton>
          </form>
        </Tarjeta>

        <Tarjeta titulo="Mis últimas operaciones" className="xl:col-span-2">
          {mias.error && <ErrorCarga mensaje={mias.error} alReintentar={mias.recargar} />}
          <Tabla
            filas={mias.data?.items ?? []}
            clave={(t) => t.id}
            vacio="Aún no has registrado operaciones."
            columnas={[
              { titulo: 'Operación', principal: true, celda: (t) => ETIQUETA_TIPO[t.tipo] ?? t.tipo },
              { titulo: 'Fecha', celda: (t) => fecha(t.creado_en) },
              { titulo: 'Valor', alinear: 'der', celda: (t) => dinero(t.monto, t.moneda) },
            ]}
          />
          <div className="mt-4 text-right text-sm"><Link className="font-semibold text-andino-700 hover:underline" to="/ventanilla/movimientos">Ver todas →</Link></div>
        </Tarjeta>
      </div>
      <Comprobante tx={comprobante} alCerrar={() => setComprobante(null)} />
    </>
  );
}
