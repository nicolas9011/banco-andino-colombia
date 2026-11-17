import { Search } from 'lucide-react';
import { useRef, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { mensajeDe } from '../lib/hooks';
import { Aviso, Boton, Campo } from './ui';

export interface CuentaEncontrada {
  id: number;
  numero: string;
  moneda: string;
  titular: string;
}

/**
 * Busca una cuenta por su numero. El personal ve el titular completo; los clientes, enmascarado.
 * Una respuesta que llega TARDE (el usuario ya escribio otro numero) se descarta: nunca puede quedar seleccionada
 * una cuenta distinta de la que muestra el campo. El padre debe montarlo con `key` para reiniciarlo.
 */
export function BuscadorCuenta({ etiqueta, alEncontrar, deshabilitado }: {
  etiqueta: string;
  alEncontrar: (c: CuentaEncontrada | null) => void;
  deshabilitado?: boolean;
}) {
  const { puede } = useAuth();
  const [numero, setNumero] = useState('');
  const [hallada, setHallada] = useState<CuentaEncontrada | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [buscando, setBuscando] = useState(false);
  const ultimaBusqueda = useRef(0); // numero de secuencia: solo la busqueda mas reciente puede aplicar su resultado

  function cambia(valor: string) {
    ultimaBusqueda.current++; // invalida cualquier busqueda en curso
    setNumero(valor);
    setHallada(null);
    setError(null);
    setBuscando(false);
    alEncontrar(null);
  }

  async function buscar() {
    const n = numero.trim().toUpperCase();
    const mia = ++ultimaBusqueda.current;
    setHallada(null);
    setError(null);
    alEncontrar(null);
    if (!/^LB-\d{10}$/.test(n)) {
      setError('El número de cuenta tiene el formato LB-0000000000.');
      return;
    }
    setBuscando(true);
    try {
      let r: CuentaEncontrada;
      if (puede('accounts:read')) {
        const l = await api<{ items: { cuenta_id: number; numero: string; moneda: string; nombre: string }[] }>('/accounts', { query: { q: n, limit: 1 } });
        const c = l.items.find((x) => x.numero === n);
        if (!c) throw new ApiError(404, 'NO_ENCONTRADO', 'No encontramos esa cuenta.');
        r = { id: c.cuenta_id, numero: c.numero, moneda: c.moneda, titular: c.nombre };
      } else {
        r = await api<CuentaEncontrada>('/accounts/lookup', { query: { numero: n } });
      }
      if (mia !== ultimaBusqueda.current) return; // llego tarde: el usuario ya cambio el numero
      setHallada(r);
      alEncontrar(r);
    } catch (e) {
      if (mia === ultimaBusqueda.current) setError(mensajeDe(e));
    } finally {
      if (mia === ultimaBusqueda.current) setBuscando(false);
    }
  }

  return (
    // Un <div>, no un <form>: este componente vive dentro de formularios de operacion.
    <div className="space-y-2">
      <div className="flex items-end gap-2">
        <div className="flex-1">
          <Campo etiqueta={etiqueta} placeholder="LB-0000000001" value={numero} disabled={deshabilitado}
            onChange={(e) => cambia(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void buscar(); } }} />
        </div>
        <Boton variante="secundario" cargando={buscando} disabled={deshabilitado || !numero} onClick={() => void buscar()}><Search className="h-4 w-4" /> Buscar</Boton>
      </div>
      {error && <Aviso tipo="error">{error}</Aviso>}
      {hallada && <Aviso tipo="ok"><span className="font-semibold">{hallada.titular}</span> · {hallada.numero} · {hallada.moneda}</Aviso>}
    </div>
  );
}
