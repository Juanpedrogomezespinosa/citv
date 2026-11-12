// Pruebas de config.ts con entornos de prueba (objetos en memoria, nunca el .env real).

import { describe, expect, it } from 'vitest';
import { leerDatosVehiculo, leerHeadless, leerIntervaloMinutos, leerModoExploracion } from '../src/config.js';

describe('leerModoExploracion', () => {
  it('sin EXPLORAR_HASTA es el flujo normal', () => {
    expect(leerModoExploracion({})).toBeUndefined();
    expect(leerModoExploracion({ EXPLORAR_HASTA: '' })).toBeUndefined();
  });

  it('acepta datos-cita y calendario', () => {
    expect(leerModoExploracion({ EXPLORAR_HASTA: 'datos-cita' })).toBe('datos-cita');
    expect(leerModoExploracion({ EXPLORAR_HASTA: 'calendario' })).toBe('calendario');
  });

  it('rechaza cualquier otro punto', () => {
    expect(() => leerModoExploracion({ EXPLORAR_HASTA: 'dias' })).toThrow(/solo admite: datos-cita, calendario/);
  });
});

describe('leerHeadless', () => {
  it('por defecto, sin ventana', () => {
    expect(leerHeadless({})).toBe(true);
    expect(leerHeadless({ HEADLESS: 'true' })).toBe(true);
  });

  it('HEADLESS=false muestra el navegador', () => {
    expect(leerHeadless({ HEADLESS: 'false' })).toBe(false);
  });

  it('rechaza otros valores', () => {
    expect(() => leerHeadless({ HEADLESS: 'quizá' })).toThrow(/HEADLESS/);
  });
});

describe('leerDatosVehiculo', () => {
  it('lee los tres datos (valores de prueba)', () => {
    expect(
      leerDatosVehiculo({ MATRICULA: '0000-PRUEBA', BASTIDOR: 'BASTIDOR-DE-PRUEBA', LOCALIZADOR: 'LOC-PRUEBA' }),
    ).toEqual({ matricula: '0000-PRUEBA', bastidor: 'BASTIDOR-DE-PRUEBA', localizador: 'LOC-PRUEBA' });
  });

  it('si falta uno, el error nombra la variable y no muestra ningún valor', () => {
    const intento = () => leerDatosVehiculo({ MATRICULA: '0000-PRUEBA', BASTIDOR: 'BASTIDOR-DE-PRUEBA' });
    expect(intento).toThrow(/LOCALIZADOR/);
    expect(intento).not.toThrow(/0000-PRUEBA|BASTIDOR-DE-PRUEBA/);
  });
});

describe('leerIntervaloMinutos', () => {
  it.each(['5', '10', '30'])('acepta %s', (valor) => {
    expect(leerIntervaloMinutos({ INTERVALO_MINUTOS: valor })).toBe(Number(valor));
  });

  it.each(['4', '0', '-5', '4.9', '7.5', 'diez'])('rechaza %s (mínimo 5, número entero)', (valor) => {
    expect(() => leerIntervaloMinutos({ INTERVALO_MINUTOS: valor })).toThrow(/mínimo 5/);
  });

  it('sin la variable, el error la nombra', () => {
    expect(() => leerIntervaloMinutos({})).toThrow(/INTERVALO_MINUTOS/);
  });

  it('.env.example conserva INTERVALO_MINUTOS=5 como ejemplo', async () => {
    const { readFileSync } = await import('node:fs');
    const ejemplo = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
    expect(ejemplo).toMatch(/^INTERVALO_MINUTOS=5$/m);
  });
});
