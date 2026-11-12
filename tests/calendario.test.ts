// Pruebas de calendario.ts usando el HTML guardado en tests/fixtures/ (sin datos personales).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { load } from 'cheerio';
import { describe, expect, it } from 'vitest';
import { CalendarioError, huecosAntesDe, leerCalendario } from '../src/calendario.js';

const html = readFileSync(
  fileURLToPath(new URL('./fixtures/calendario-diciembre.html', import.meta.url)),
  'utf8',
);

/** Marca el día indicado como disponible (`special`), solo en memoria. */
function conDiaDisponible(original: string, dia: number): string {
  const $ = load(original);
  const celda = $('td')
    .filter((_, el) => $(el).text().trim() === String(dia))
    .first();
  expect(celda.length, `el fixture debe tener una celda para el día ${dia}`).toBe(1);
  celda.removeClass('disabled').addClass('special');
  return $.html();
}

describe('leerCalendario', () => {
  const estado = leerCalendario(html);

  it('lee el título como diciembre de 2026', () => {
    expect(estado.mes).toBe(12);
    expect(estado.anio).toBe(2026);
  });

  it('no cuenta el día 10 (cita actual, clase selected)', () => {
    expect(estado.diasDisponibles).not.toContain(10);
  });

  it('incluye los días 11 y 12 como disponibles', () => {
    expect(estado.diasDisponibles).toContain(11);
    expect(estado.diasDisponibles).toContain(12);
  });

  it('lee las horas del fixture (texto de cada opción, sin value="-1")', () => {
    expect(estado.horas).toEqual([
      '12:14', '12:18', '12:40', '12:48', '12:57', '13:22', '13:39', '14:21', '14:38', '14:55', '15:12',
    ]);
  });

  it('descarta la opción "Seleccione una hora" (value -1)', () => {
    expect(estado.horas).not.toContain('Seleccione una hora');
    for (const hora of estado.horas) expect(hora).toMatch(/^\d{1,2}:\d{2}$/);
  });

  it('lanza un error claro si el HTML no tiene calendario', () => {
    expect(() => leerCalendario('<html><body><p>Sin calendario</p></body></html>')).toThrow(
      CalendarioError,
    );
    expect(() => leerCalendario('<html><body></body></html>')).toThrow(/No se encontró el calendario/);
  });
});

describe('huecosAntesDe', () => {
  const estado = leerCalendario(html);

  it('con FECHA_LIMITE=2026-12-10 devuelve lista vacía', () => {
    expect(huecosAntesDe(estado, '2026-12-10')).toEqual([]);
  });

  it('con FECHA_LIMITE=2026-12-13 devuelve [11, 12]', () => {
    expect(huecosAntesDe(estado, '2026-12-13')).toEqual([11, 12]);
  });

  it('con un día 5 disponible añadido en memoria y FECHA_LIMITE=2026-12-10 devuelve [5]', () => {
    const modificado = leerCalendario(conDiaDisponible(html, 5));
    expect(huecosAntesDe(modificado, '2026-12-10')).toEqual([5]);
  });

  it('si el mes del calendario es posterior a la fecha límite devuelve lista vacía', () => {
    expect(huecosAntesDe(estado, '2026-11-30')).toEqual([]);
  });
});
