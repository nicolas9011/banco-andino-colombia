import { describe, expect, it } from 'vitest';
import { dinero, enmascarar, limpiarMonto, montoValido } from '../src/lib/format';

describe('formato de dinero', () => {
  it('formatea COP y USD con 2 decimales', () => {
    expect(dinero('1234567.5')).toMatch(/1\.234\.567,50/);
    expect(dinero('10', 'USD')).toMatch(/US\$|USD/);
  });
  it('valores vacios o invalidos no rompen la pantalla', () => {
    expect(dinero(null)).toBe('—');
    expect(dinero('abc')).toBe('—');
  });
  it('enmascara numeros largos', () => {
    expect(enmascarar('4000000000000010')).toBe('•••• 0010');
  });
});

describe('campo de monto', () => {
  it('solo deja digitos y maximo 2 decimales', () => {
    expect(limpiarMonto('12a3,45')).toBe('123.45');
    expect(limpiarMonto('$ 1.5')).toBe('1.5');
    // es-CO: un grupo de 3 digitos tras el separador es de MILES, no decimales
    expect(limpiarMonto('1.500.000')).toBe('1500000');
    // tecla a tecla: un tercer decimal se descarta, nunca multiplica el monto
    expect(limpiarMonto('12.50')).toBe('12.50');
    expect(limpiarMonto('12.500')).toBe('12.50');
    expect(limpiarMonto('1.234')).toBe('1.23');
    expect(limpiarMonto('')).toBe('');
  });
  it('valida montos positivos', () => {
    for (const ok of ['1', '0.01', '999999.99']) expect(montoValido(ok)).toBe(true);
    for (const mal of ['', '0', '0.00', '-5', '10.555', 'abc']) expect(montoValido(mal)).toBe(false);
  });
});
