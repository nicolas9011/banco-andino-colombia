import { ArrowRight, CheckCircle2 } from 'lucide-react';
import { useState } from 'react';
import { BuscadorCuenta, CuentaEncontrada } from '../../components/BuscadorCuenta';
import { Comprobante, TransaccionVista } from '../../components/Comprobante';
import { CuentaVista } from '../../components/CuentaTarjeta';
import { Aviso, Boton, Campo, CampoMonto, Cargando, EncabezadoPagina, ErrorCarga, Seleccion, Tarjeta } from '../../components/ui';
import { api } from '../../lib/api';
import { dinero, montoValido } from '../../lib/format';
import { useAccion, useCarga, useClaveIdempotencia } from '../../lib/hooks';

type Paso = 'datos' | 'confirmar' | 'listo';

export default function Transferir() {
  const cuentas = useCarga(() => api<{ items: CuentaVista[] }>('/accounts', { query: { limit: 100 } }), []);
  const [origenId, setOrigenId] = useState('');
  const [destino, setDestino] = useState<CuentaEncontrada | null>(null);
  const [monto, setMonto] = useState('');
  const [concepto, setConcepto] = useState('');
  const [paso, setPaso] = useState<Paso>('datos');
  const [resultado, setResultado] = useState<TransaccionVista | null>(null);
  const [verComp, setVerComp] = useState(false);
  const clave = useClaveIdempotencia();
  const { enviando, error, setError, ejecutar } = useAccion();

  if (cuentas.cargando && !cuentas.data) return <Cargando />;
  if (cuentas.error && !cuentas.data) return <ErrorCarga mensaje={cuentas.error} alReintentar={cuentas.recargar} />;
  const propias = (cuentas.data?.items ?? []).filter((c) => c.estado === 'activa');
  const origen = propias.find((c) => String(c.cuenta_id) === origenId);

  const errorMonto = monto && !montoValido(monto) ? 'Ingresa un monto válido, mayor que cero.' : undefined;
  const mismaCuenta = !!origen && destino?.id === origen.cuenta_id;
  const otraMoneda = !!origen && !!destino && destino.moneda !== origen.moneda;
  const listoParaRevisar = !!origen && !!destino && montoValido(monto) && !mismaCuenta && !otraMoneda;

  async function confirmar() {
    const tx = await ejecutar(() => api<TransaccionVista>('/transactions/transfer', {
      method: 'POST', idempotencyKey: clave.clave(),
      body: { origenId: origen!.cuenta_id, destinoId: destino!.id, monto, concepto: concepto.trim() || undefined },
    }));
    if (tx) {
      setResultado(tx);
      setPaso('listo');
      clave.renovar();
    }
  }

  function otra() {
    setPaso('datos'); setMonto(''); setConcepto(''); setDestino(null); setResultado(null); setError(null); cuentas.recargar();
  }

  if (paso === 'listo' && resultado) {
    return (
      <>
        <EncabezadoPagina titulo="Transferencia realizada" />
        <Tarjeta className="mx-auto max-w-lg text-center">
          <CheckCircle2 className="mx-auto h-12 w-12 text-ok-600" aria-hidden />
          <p className="mt-3 text-sm text-slate-600">Enviaste</p>
          <p className="tabular text-3xl font-bold text-andino-900">{dinero(resultado.monto, resultado.moneda)}</p>
          <p className="mt-1 break-all font-mono text-xs text-slate-500">{resultado.numero_debito} → {resultado.numero_credito}</p>
          <div className="mt-6 flex flex-col justify-center gap-2 sm:flex-row">
            <Boton variante="secundario" onClick={() => setVerComp(true)}>Ver comprobante</Boton>
            <Boton onClick={otra}>Hacer otra transferencia</Boton>
          </div>
        </Tarjeta>
        {verComp && <Comprobante tx={resultado} alCerrar={() => setVerComp(false)} />}
      </>
    );
  }

  return (
    <>
      <EncabezadoPagina titulo="Transferir" descripcion="Entre cuentas de Banco Andino. Verás un resumen antes de confirmar." />
      <div className="mx-auto max-w-xl">
        <Tarjeta>
          {error && <Aviso tipo="error" className="mb-4">{error}</Aviso>}

          {/* El formulario se OCULTA (no se desmonta) al pasar a confirmar: asi la cuenta destino buscada sigue siendo
              la que se ve al volver (si se desmontara, el campo quedaria vacio pero el destino seguiria seleccionado). */}
          {paso !== 'listo' && (
            <form hidden={paso !== 'datos'} className="space-y-5" onSubmit={(e) => { e.preventDefault(); if (listoParaRevisar) { clave.renovar(); setPaso('confirmar'); } }} noValidate>
              <Seleccion etiqueta="Desde la cuenta" value={origenId} onChange={(e) => setOrigenId(e.target.value)}>
                <option value="">Selecciona una cuenta</option>
                {propias.map((c) => (
                  <option key={c.cuenta_id} value={c.cuenta_id}>{c.numero} · {c.producto} · {dinero(c.saldo_disponible, c.moneda)}</option>
                ))}
              </Seleccion>
              {!propias.length && <Aviso tipo="aviso">No tienes cuentas activas desde las que transferir.</Aviso>}

              <BuscadorCuenta etiqueta="Cuenta destino" alEncontrar={setDestino} />
              {mismaCuenta && <Aviso tipo="error">La cuenta destino debe ser distinta de la de origen.</Aviso>}
              {otraMoneda && <Aviso tipo="error">Las cuentas deben estar en la misma moneda.</Aviso>}

              <CampoMonto etiqueta="Monto" valor={monto} alCambiar={setMonto} error={errorMonto}
                ayuda={origen ? `Disponible: ${dinero(origen.saldo_disponible, origen.moneda)}` : undefined} />
              <Campo etiqueta="Concepto (opcional)" maxLength={200} value={concepto} onChange={(e) => setConcepto(e.target.value)} />
              {/* (la clave de idempotencia se renueva al pulsar "Revisar": cubre tambien un concepto editado) */}
              <Boton type="submit" tamano="lg" className="w-full" disabled={!listoParaRevisar}>Revisar <ArrowRight className="h-4 w-4" /></Boton>
            </form>
          )}

          {paso === 'confirmar' && origen && destino && (
            <div className="space-y-5">
              <h2 className="text-lg font-semibold text-andino-900">Confirma tu transferencia</h2>
              <dl className="divide-y divide-slate-100 rounded-xl border border-slate-200 px-4 text-sm">
                {[
                  ['Desde', `${origen.numero} · ${origen.producto}`],
                  ['Para', `${destino.titular} · ${destino.numero}`],
                  ['Monto', dinero(monto, origen.moneda)],
                  ['Concepto', concepto || '—'],
                ].map(([k, v]) => (
                  <div key={k} className="flex justify-between gap-4 py-3"><dt className="text-slate-500">{k}</dt><dd className="break-all text-right font-medium">{v}</dd></div>
                ))}
              </dl>
              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <Boton variante="secundario" onClick={() => setPaso('datos')} disabled={enviando}>Volver</Boton>
                <Boton tamano="lg" cargando={enviando} onClick={() => void confirmar()}>Confirmar y enviar</Boton>
              </div>
              <p className="text-xs text-slate-500">Si pierdes la conexión, puedes reintentar: la operación no se duplicará.</p>
            </div>
          )}
        </Tarjeta>
      </div>
    </>
  );
}
