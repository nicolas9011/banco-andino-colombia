import { DependencyList, useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, nuevaClave } from './api';

export interface Carga<T> {
  data: T | null;
  error: string | null;
  cargando: boolean;
  recargar: () => void;
}

/** Carga datos del servidor con estados de carga y error; ignora respuestas obsoletas. */
export function useCarga<T>(fn: () => Promise<T>, deps: DependencyList): Carga<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cargando, setCargando] = useState(true);
  const [version, setVersion] = useState(0);
  const ultimo = useRef(0);

  useEffect(() => {
    const id = ++ultimo.current;
    setCargando(true);
    fn()
      .then((d) => {
        if (id === ultimo.current) {
          setData(d);
          setError(null);
        }
      })
      .catch((e: unknown) => {
        if (id === ultimo.current) setError(mensajeDe(e));
      })
      .finally(() => {
        if (id === ultimo.current) setCargando(false);
      });
    // `fn` cambia en cada render (es una funcion en linea): las dependencias reales son `deps`, que el llamador
    // declara explicitamente; por eso se omite `fn` a proposito.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, version]);

  return { data, error, cargando, recargar: useCallback(() => setVersion((v) => v + 1), []) };
}

export function mensajeDe(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  return 'Ocurrio un error inesperado. Intenta de nuevo.';
}

/**
 * Clave de idempotencia por INTENCION: un reintento (por ejemplo tras perder la red) reutiliza
 * la misma clave y por tanto no duplica el movimiento. Tras un exito se renueva.
 */
export function useClaveIdempotencia() {
  const ref = useRef<string | null>(null);
  if (ref.current === null) ref.current = nuevaClave(); // una sola vez (useRef(nuevaClave()) la generaria en cada render)
  return { clave: () => ref.current as string, renovar: () => (ref.current = nuevaClave()) };
}

/** Envio de formulario con estado de "enviando" y error. */
export function useAccion() {
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Candado SINCRONO: el estado `enviando` solo se actualiza en el siguiente render y dos clics seguidos lo atraviesan.
  const ocupado = useRef(false);
  const ejecutar = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    if (ocupado.current) return undefined;
    ocupado.current = true;
    setEnviando(true);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(mensajeDe(e));
      return undefined;
    } finally {
      ocupado.current = false;
      setEnviando(false);
    }
  }, []);
  return { enviando, error, setError, ejecutar };
}
