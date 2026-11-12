// Pruebas de src/registro.ts con archivos en un directorio temporal (nunca data/ del proyecto).

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { leerUltimaEntrada, lineaRegistro, parsearLinea, registrarCiclo } from '../src/registro.js';

/** 2026-11-12 10:00:05 en España (UTC+1 en noviembre). */
const NOV_10H = new Date('2026-11-12T09:00:05Z');

const COMPLETA_SIN_DIAS = { estado: 'lectura-completa', dias: [], meses: [] } as const;
const COMPLETA_CON_DIAS = {
  estado: 'lectura-completa',
  dias: [
    { fecha: '2026-12-11', horas: ['12:14', '12:18'] },
    { fecha: '2026-12-12', horas: ['13:22'] },
  ],
  meses: [{ anio: 2026, mes: 12, disponibles: 2 }],
} as const;
const DETENIDO = { estado: 'detenido', motivo: 'antibots' } as const;

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'citv-registro-'));
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

describe('formato de la línea', () => {
  it('lectura-completa sin días', () => {
    expect(lineaRegistro(NOV_10H, { ...COMPLETA_SIN_DIAS, dias: [], meses: [] })).toBe(
      '2026-11-12 10:00:05  lectura-completa  dias=0',
    );
  });

  it('lectura-completa con días (fecha y horas de cada uno)', () => {
    expect(
      lineaRegistro(NOV_10H, {
        ...COMPLETA_CON_DIAS,
        dias: COMPLETA_CON_DIAS.dias.map((d) => ({ ...d, horas: [...d.horas] })),
        meses: [...COMPLETA_CON_DIAS.meses],
      }),
    ).toBe('2026-11-12 10:00:05  lectura-completa  dias=2  2026-12-11[12:14,12:18] 2026-12-12[13:22]');
  });

  it('detenido', () => {
    expect(lineaRegistro(NOV_10H, DETENIDO)).toBe('2026-11-12 10:00:05  detenido  motivo=antibots');
  });

  it('usa la hora de España también en verano (UTC+2)', () => {
    expect(lineaRegistro(new Date('2026-07-01T10:00:00Z'), DETENIDO)).toBe(
      '2026-07-01 12:00:00  detenido  motivo=antibots',
    );
  });

  it('se puede volver a leer (para el latido)', () => {
    expect(parsearLinea('2026-11-12 10:00:05  lectura-completa  dias=0')).toEqual({
      cuando: '2026-11-12 10:00:05',
      estado: 'lectura-completa',
      dias: 0,
    });
    expect(parsearLinea('2026-11-12 10:00:05  lectura-completa  dias=2  2026-12-11[12:14] 2026-12-12[]')).toEqual({
      cuando: '2026-11-12 10:00:05',
      estado: 'lectura-completa',
      dias: 2,
    });
    expect(parsearLinea('2026-11-12 10:00:05  detenido  motivo=estacion')).toEqual({
      cuando: '2026-11-12 10:00:05',
      estado: 'detenido',
      motivo: 'estacion',
    });
    expect(parsearLinea('basura')).toBeNull();
  });
});

describe('registrarCiclo', () => {
  it('crea la carpeta y el archivo, y añade una línea por ciclo', async () => {
    const ruta = join(dir, 'data', 'lecturas.log');
    expect(await registrarCiclo(DETENIDO, NOV_10H, ruta)).toBe(true);
    expect(await registrarCiclo({ ...COMPLETA_SIN_DIAS, dias: [], meses: [] }, new Date('2026-11-12T09:05:00Z'), ruta)).toBe(true);

    expect(await readFile(ruta, 'utf8')).toBe(
      '2026-11-12 10:00:05  detenido  motivo=antibots\n2026-11-12 10:05:00  lectura-completa  dias=0\n',
    );
    expect(await leerUltimaEntrada(ruta)).toEqual({ cuando: '2026-11-12 10:05:00', estado: 'lectura-completa', dias: 0 });
  });

  it('si no se puede escribir, lo registra en la terminal y no lanza error', async () => {
    const archivo = join(dir, 'no-es-carpeta');
    await writeFile(archivo, 'x');
    const ruta = join(archivo, 'lecturas.log'); // la "carpeta" es un archivo: no se puede crear

    await expect(registrarCiclo(DETENIDO, NOV_10H, ruta)).resolves.toBe(false);
    const errores = vi.mocked(console.error).mock.calls.flat().map(String);
    expect(errores).toHaveLength(1);
    expect(errores[0]).toMatch(/No se pudo escribir en .*lecturas\.log \(E[A-Z]+\); el bucle sigue\./);
  });

  it('sin archivo, no hay última entrada', async () => {
    expect(await leerUltimaEntrada(join(dir, 'no-existe.log'))).toBeNull();
  });
});
