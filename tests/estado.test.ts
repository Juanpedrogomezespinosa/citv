// Pruebas de estado.ts con archivos en un directorio temporal.

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cargarNotificados, guardarNotificados } from '../src/estado.js';

let dir: string;
let ruta: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'citv-estado-'));
  ruta = join(dir, 'data', 'notificados.json');
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

describe('estado', () => {
  it('si el archivo no existe empieza vacío', async () => {
    expect(await cargarNotificados(ruta)).toEqual(new Set());
  });

  it('guarda y vuelve a leer las claves (creando data/ si hace falta)', async () => {
    await guardarNotificados(new Set(['2026-11-15 10:15', '2026-11-15 10:30']), ruta);
    expect(await cargarNotificados(ruta)).toEqual(new Set(['2026-11-15 10:15', '2026-11-15 10:30']));
  });

  it.each([
    ['JSON inválido', '{esto no es json'],
    ['estructura inesperada', '{"a": 1}'],
    ['claves con formato incorrecto', '["mañana a las diez"]'],
  ])('archivo corrupto (%s): no falla, empieza vacío, avisa y no borra el original', async (_, contenido) => {
    const aviso = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await mkdir(join(dir, 'data'), { recursive: true });
    await writeFile(ruta, contenido, 'utf8');

    expect(await cargarNotificados(ruta)).toEqual(new Set());
    expect(await readFile(ruta, 'utf8')).toBe(contenido);
    expect(aviso).toHaveBeenCalledWith(expect.stringContaining('corrupto'));

    const archivos = await readdir(join(dir, 'data'));
    const copia = archivos.find((a) => a.startsWith('notificados.json.corrupto-'));
    expect(copia).toBeDefined();
    expect(await readFile(join(dir, 'data', copia ?? ''), 'utf8')).toBe(contenido);
  });
});
