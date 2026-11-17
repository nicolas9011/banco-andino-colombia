// Los montos llegan del servidor como texto decimal exacto; aqui solo se PRESENTAN.
const cop = new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', minimumFractionDigits: 2 });
const usd = new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 });

export function dinero(valor: string | number | null | undefined, moneda: string = 'COP'): string {
  if (valor === null || valor === undefined || valor === '') return '—';
  const n = Number(valor);
  if (!Number.isFinite(n)) return '—';
  return (moneda === 'USD' ? usd : cop).format(n);
}

const fechaHora = new Intl.DateTimeFormat('es-CO', {
  day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'America/Bogota',
});
const soloFecha = new Intl.DateTimeFormat('es-CO', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'America/Bogota' });

export function fecha(v: string | null | undefined, conHora = true): string {
  if (!v) return '—';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '—';
  return (conHora ? fechaHora : soloFecha).format(d);
}

export const ETIQUETA_TIPO: Record<string, string> = {
  deposito: 'Consignación', retiro: 'Retiro', transferencia: 'Transferencia', debito: 'Débito',
  credito: 'Crédito', ajuste: 'Ajuste', reverso: 'Reverso',
};

export const ETIQUETA_CANAL: Record<string, string> = {
  web: 'Portal web', cajero: 'Ventanilla', atm: 'Cajero automático', brebe: 'Bre-B', sistema: 'Sistema',
};

export function enmascarar(numero: string): string {
  return numero.length > 4 ? `•••• ${numero.slice(-4)}` : numero;
}

/**
 * Texto -> solo digitos y un punto con maximo 2 decimales (para campos de monto).
 * Entiende el formato es-CO al pegar: "1.500.000" son un millon quinientos mil (separadores de miles), no 1,50.
 * Regla: si el ultimo grupo tras un separador tiene exactamente 3 digitos, todos los separadores son de miles;
 * en otro caso, el ultimo separador es el decimal (con 2 digitos como maximo) y los anteriores son de miles.
 */
export function limpiarMonto(texto: string): string {
  const t = texto.replace(/[^\d.,]/g, '');
  const partes = t.split(/[.,]/);
  if (partes.length === 1) return t;
  // "1.500.000": varios separadores y todos los grupos tras el primero de 3 digitos => separadores de MILES.
  if (partes.length > 2 && partes.slice(1).every((p) => p.length === 3)) return partes.join('');
  // En cualquier otro caso el ultimo separador es el DECIMAL. Se evalua tecla a tecla: "12.50" + "0" no puede
  // convertirse en 12500 (un monto 1000 veces mayor); se trunca a 2 decimales.
  const ultimo = partes[partes.length - 1];
  return `${partes.slice(0, -1).join('')}.${ultimo.slice(0, 2)}`;
}

export function montoValido(texto: string): boolean {
  return /^\d{1,13}(\.\d{1,2})?$/.test(texto) && Number(texto) > 0;
}
