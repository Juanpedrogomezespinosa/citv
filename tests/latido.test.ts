// Pruebas de src/latido.ts. fetch está simulado: no se envía nada real a ntfy.

import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const createTransport = vi.fn();
vi.mock('nodemailer', () => ({ default: { createTransport } }));

const { crearLatido, textoLatido, TITULO_LATIDO } = await import('../src/latido.js');

const TOPIC = 'topic-de-prueba';
const FECHA_LIMITE = '2026-12-10';
/** Hora de España en noviembre (UTC+1). */
const madrid = (hhmm: string, dia = '2026-11-12'): Date => {
  const [h = 0, m = 0] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(Number(dia.slice(0, 4)), Number(dia.slice(5, 7)) - 1, Number(dia.slice(8, 10)), h - 1, m));
};

describe('textoLatido', () => {
  const ahora = madrid('09:10');

  it('lectura-completa sin días', () => {
    expect(textoLatido({ cuando: '2026-11-12 09:05:12', estado: 'lectura-completa', dias: 0 }, ahora, FECHA_LIMITE)).toBe(
      'Sin citas antes del 10 de diciembre. Último ciclo: 09:05.',
    );
  });

  it('lectura-completa con días', () => {
    expect(textoLatido({ cuando: '2026-11-12 09:05:12', estado: 'lectura-completa', dias: 2 }, ahora, FECHA_LIMITE)).toBe(
      'Hay citas disponibles antes del 10 de diciembre. Último ciclo: 09:05.',
    );
  });

  it('detenido', () => {
    expect(textoLatido({ cuando: '2026-11-12 09:05:12', estado: 'detenido', motivo: 'antibots' }, ahora, FECHA_LIMITE)).toBe(
      'Lectura detenida (antibots). Último ciclo: 09:05.',
    );
  });

  it('última línea de hace más de 30 minutos (o ninguna): sin actividad reciente', () => {
    const sinActividad = 'Sin actividad reciente. Revisa el proceso.';
    expect(textoLatido({ cuando: '2026-11-12 08:39:59', estado: 'lectura-completa', dias: 0 }, ahora, FECHA_LIMITE)).toBe(sinActividad);
    expect(textoLatido({ cuando: '2026-11-12 08:30:00', estado: 'detenido', motivo: 'antibots' }, ahora, FECHA_LIMITE)).toBe(sinActividad);
    expect(textoLatido(null, ahora, FECHA_LIMITE)).toBe(sinActividad);
    // Justo 30 minutos todavía cuenta como reciente.
    expect(textoLatido({ cuando: '2026-11-12 08:40:00', estado: 'lectura-completa', dias: 0 }, ahora, FECHA_LIMITE)).toBe(
      'Sin citas antes del 10 de diciembre. Último ciclo: 08:40.',
    );
  });
});

describe('crearLatido: cuándo y por dónde se envía', () => {
  let dir: string;
  let ruta: string;
  let fetchSimulado: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'citv-latido-'));
    ruta = join(dir, 'lecturas.log');
    await writeFile(ruta, '2026-11-12 09:00:00  lectura-completa  dias=0\n');
    fetchSimulado = vi.fn<typeof fetch>(async () => new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchSimulado);
    createTransport.mockClear();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it('a las 09:00 envía solo a ntfy (POST, Title, texto según el registro) y no repite', async () => {
    const latido = crearLatido({ topic: TOPIC, fechaLimite: FECHA_LIMITE, rutaRegistro: ruta });
    expect(await latido.comprobar(madrid('09:03'))).toBe(true);
    expect(await latido.comprobar(madrid('09:08'))).toBe(false); // ya enviado

    expect(fetchSimulado).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSimulado.mock.calls[0] ?? [];
    expect(url).toBe(`https://ntfy.sh/${TOPIC}`);
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('Title')).toBe(TITULO_LATIDO);
    expect(TITULO_LATIDO).toBe('Vigilante ITV: estado');
    expect(init?.body).toBe('Sin citas antes del 10 de diciembre. Último ciclo: 09:00.');
    expect(createTransport).not.toHaveBeenCalled(); // nada de email
  });

  it('a las 20:00 también; fuera de 09:00–09:29 y 20:00–20:29, no', async () => {
    const latido = crearLatido({ topic: TOPIC, fechaLimite: FECHA_LIMITE, rutaRegistro: ruta });
    for (const hora of ['08:59', '09:30', '12:00', '19:59', '20:30', '23:00']) {
      expect(await latido.comprobar(madrid(hora)), hora).toBe(false);
    }
    expect(await latido.comprobar(madrid('20:01'))).toBe(true);
    expect(fetchSimulado).toHaveBeenCalledTimes(1);
    // Al día siguiente vuelve a tocar.
    expect(await latido.comprobar(madrid('09:00', '2026-11-13'))).toBe(true);
  });

  it('si ntfy falla, registra el error sin el topic y reintenta dentro de la ventana', async () => {
    fetchSimulado.mockResolvedValueOnce(new Response('', { status: 500 }));
    const latido = crearLatido({ topic: TOPIC, fechaLimite: FECHA_LIMITE, rutaRegistro: ruta });

    expect(await latido.comprobar(madrid('09:00'))).toBe(false);
    const errores = vi.mocked(console.error).mock.calls.flat().map(String);
    expect(errores.join('\n')).toMatch(/No se pudo enviar el latido de las 09:00/);
    expect(errores.join('\n')).not.toContain(TOPIC);

    expect(await latido.comprobar(madrid('09:05'))).toBe(true);
  });

  it('latido.ts no usa el correo', () => {
    const codigo = readFileSync(fileURLToPath(new URL('../src/latido.ts', import.meta.url)), 'utf8');
    expect(codigo).not.toMatch(/email\.js|nodemailer|enviarEmail/);
  });
});
