// Pruebas de src/ejecutar.ts ("npm run ciclo"): una sola vuelta. cicloLectura, ntfy y email
// están simulados; el estado va a un directorio temporal (nunca data/ del proyecto); los
// valores del entorno son de prueba.

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResultadoLectura } from '../src/lectura.js';

const cicloLectura = vi.fn();
const abrirChromium = vi.fn(() => async () => {
  throw new Error('No debe abrirse un navegador real en los tests');
});
vi.mock('../src/lectura.js', () => ({ cicloLectura, abrirChromium }));

const enviarAviso = vi.fn(async () => undefined);
vi.mock('../src/notificar.js', async (original) => ({
  ...(await original<typeof import('../src/notificar.js')>()),
  enviarAviso,
}));

const enviarEmail = vi.fn(async () => undefined);
vi.mock('../src/email.js', async (original) => ({
  ...(await original<typeof import('../src/email.js')>()),
  enviarEmail,
}));

const { ejecutarUnaVez, MAX_LINEAS_REGISTRO, fueraDeHorario, tramoLatido } = await import('../src/ejecutar.js');
const { textoLatido } = await import('../src/latido.js');

/** Valores de prueba: nunca los reales. */
const ENV = {
  MATRICULA: '0000-PRUEBA',
  BASTIDOR: 'BASTIDOR-DE-PRUEBA',
  LOCALIZADOR: 'LOCALIZADOR-PRUEBA',
  NTFY_TOPIC: 'topic-de-prueba',
  FECHA_LIMITE: '2026-12-10',
  SMTP_HOST: 'smtp.ejemplo.test',
  SMTP_PORT: '465',
  SMTP_USUARIO: 'usuario-falso',
  SMTP_PASSWORD: 'clave-falsa',
  EMAIL_DESTINO: 'destino@ejemplo.test',
};
const VALORES_SECRETOS = [
  ENV.MATRICULA, ENV.BASTIDOR, ENV.LOCALIZADOR, ENV.NTFY_TOPIC, ENV.SMTP_HOST,
  ENV.SMTP_USUARIO, ENV.SMTP_PASSWORD, ENV.EMAIL_DESTINO,
];

const COMPLETA: ResultadoLectura = { estado: 'lectura-completa', dias: [], meses: [{ anio: 2026, mes: 11, disponibles: 0 }] };
const DETENIDO: ResultadoLectura = { estado: 'detenido', motivo: 'antibots' };

/** Hora de España en noviembre (UTC+1). */
const madrid = (hhmm: string, dia = 12): Date => {
  const [h = 0, m = 0] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(2026, 10, dia, h - 1, m));
};

let dir: string;
let lineas: string[];

const ejecutar = (hhmm: string, dia = 12) =>
  ejecutarUnaVez(ENV, { ahora: () => madrid(hhmm, dia), imprimir: (l) => lineas.push(l), dirDatos: dir });

const leer = (archivo: string) => readFile(join(dir, archivo), 'utf8');
const lineasRegistro = async () => (await leer('lecturas.log')).split('\n').filter(Boolean);

const avisosCon = (titulo: string) =>
  enviarAviso.mock.calls.map((c) => c as unknown[]).filter((c) => (c[0] as { titulo: string }).titulo === titulo);
const correosCon = (asunto: string) => enviarEmail.mock.calls.map((c) => c as unknown[]).filter((c) => c[1] === asunto);

function sinSecretos(): void {
  const consola = [console.log, console.warn, console.error].flatMap((f) => vi.mocked(f).mock.calls.flat()).map(String);
  // Contenido enviado: el aviso de ntfy (el topic va aparte, como destino) y el asunto y
  // cuerpo del correo (la configuración SMTP va aparte, como destino).
  const ntfy = enviarAviso.mock.calls.map((c) => JSON.stringify((c as unknown[])[0]));
  const correo = enviarEmail.mock.calls.map((c) => `${String((c as unknown[])[1])} ${String((c as unknown[])[2])}`);
  const texto = [...lineas, ...consola, ...ntfy, ...correo].join('\n');
  for (const valor of VALORES_SECRETOS) expect(texto, valor).not.toContain(valor);
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'citv-ejecutar-'));
  lineas = [];
  cicloLectura.mockReset();
  for (const f of [abrirChromium, enviarAviso, enviarEmail]) f.mockClear();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

describe('ventana horaria (23:00–07:59 sin ciclo)', () => {
  it.each(['23:00', '23:59', '02:00', '07:00', '07:59'])('a las %s sale con 0 sin abrir navegador ni escribir nada', async (hora) => {
    expect(await ejecutar(hora)).toBe(0);
    expect(cicloLectura).not.toHaveBeenCalled();
    expect(abrirChromium).not.toHaveBeenCalled();
    await expect(leer('lecturas.log')).rejects.toThrow();
    expect(enviarAviso).not.toHaveBeenCalled();
  });

  it('fueraDeHorario: 08:00 y 22:59 sí ejecutan', () => {
    expect(fueraDeHorario(madrid('08:00'))).toBe(false);
    expect(fueraDeHorario(madrid('22:59'))).toBe(false);
    expect(fueraDeHorario(madrid('07:59'))).toBe(true);
    expect(fueraDeHorario(madrid('23:00'))).toBe(true);
  });
});

describe('dentro de la ventana: una sola vuelta', () => {
  it('lectura completa: un ciclo, una línea en el registro y código 0', async () => {
    cicloLectura.mockResolvedValueOnce(COMPLETA);
    expect(await ejecutar('10:00')).toBe(0);

    expect(cicloLectura).toHaveBeenCalledTimes(1);
    expect(await lineasRegistro()).toEqual(['2026-11-12 10:00:00  lectura-completa  dias=0']);
    expect(lineas).toEqual(['[10:00] Lectura completa:', '  Noviembre 2026: 0 días disponibles.']);
  });

  it('detenido: una línea en el registro y código 1', async () => {
    cicloLectura.mockResolvedValueOnce(DETENIDO);
    expect(await ejecutar('10:00')).toBe(1);
    expect(await lineasRegistro()).toEqual(['2026-11-12 10:00:00  detenido  motivo=antibots']);
  });

  it('un error inesperado del ciclo cuenta como detenido (código 1) y se registra sin secretos', async () => {
    cicloLectura.mockRejectedValueOnce(new Error(`Fallo con ${ENV.MATRICULA} y ${ENV.SMTP_PASSWORD}\n<html>…</html>`));
    expect(await ejecutar('10:00')).toBe(1);
    expect(await lineasRegistro()).toEqual(['2026-11-12 10:00:00  detenido  motivo=error-inesperado']);
    sinSecretos();
  });

  it(`conserva solo las últimas ${MAX_LINEAS_REGISTRO} líneas`, async () => {
    const antiguas = Array.from({ length: 600 }, (_, i) => `2026-11-01 08:${String(i % 60).padStart(2, '0')}:00  lectura-completa  dias=0`);
    await writeFile(join(dir, 'lecturas.log'), `${antiguas.join('\n')}\n`);
    cicloLectura.mockResolvedValueOnce(DETENIDO);
    await ejecutar('10:00');

    const registro = await lineasRegistro();
    expect(registro).toHaveLength(500);
    expect(registro.at(-1)).toBe('2026-11-12 10:00:00  detenido  motivo=antibots');
    expect(registro[0]).toBe(antiguas[101]);
  });
});

describe('latido (09:00–09:14 y 20:00–20:14, ntfy y email)', () => {
  it('solo en los tramos y una vez por tramo', async () => {
    cicloLectura.mockResolvedValue(COMPLETA);
    for (const hora of ['08:59', '09:00', '09:10', '09:14', '09:15', '12:00', '20:00', '20:14', '20:15']) {
      await ejecutar(hora);
    }
    await ejecutar('09:05', 13); // al día siguiente vuelve a tocar

    const latidos = avisosCon('Vigilante ITV: estado');
    expect(latidos).toHaveLength(3); // 12-nov 09, 12-nov 20, 13-nov 09
    expect(correosCon('Vigilante ITV: estado')).toHaveLength(3);
    // El texto sale de la línea ANTERIOR al ciclo de las 09:00 (la de las 08:59).
    expect(latidos[0]?.[0]).toEqual({ titulo: 'Vigilante ITV: estado', mensaje: 'Sin citas antes del 10 de diciembre. Último ciclo: 08:59.' });
    expect(latidos[0]?.[1]).toBe(ENV.NTFY_TOPIC); // el topic solo como destino
    expect(JSON.parse(await leer('latido.json'))).toEqual({ tramos: ['2026-11-12 09', '2026-11-12 20', '2026-11-13 09'] });
    sinSecretos();
  });

  it('tramoLatido', () => {
    expect(tramoLatido(madrid('09:00'))).toBe('2026-11-12 09');
    expect(tramoLatido(madrid('20:14'))).toBe('2026-11-12 20');
    expect(tramoLatido(madrid('09:15'))).toBeNull();
    expect(tramoLatido(madrid('19:59'))).toBeNull();
  });

  it('"Sin actividad reciente" si la última lectura tiene más de 60 minutos', () => {
    const ahora = madrid('09:05');
    const hace = (min: number) => ({ cuando: `2026-11-12 0${8 - Math.floor((min - 5) / 60)}:${String((65 - min) % 60).padStart(2, '0')}:00`, estado: 'lectura-completa' as const, dias: 0 });
    expect(textoLatido(hace(61), ahora, ENV.FECHA_LIMITE, 60)).toBe('Sin actividad reciente. Revisa el proceso.');
    expect(textoLatido(hace(45), ahora, ENV.FECHA_LIMITE, 60)).toMatch(/^Sin citas antes del 10 de diciembre/);
  });

  it('con la última línea previa a 61 minutos dice "Sin actividad reciente" aunque el ciclo actual sea completo', async () => {
    await writeFile(join(dir, 'lecturas.log'), '2026-11-12 08:04:00  lectura-completa  dias=0\n');
    cicloLectura.mockResolvedValueOnce(COMPLETA);
    expect(await ejecutar('09:05')).toBe(0);

    expect(avisosCon('Vigilante ITV: estado').map((c) => c[0])).toEqual([
      { titulo: 'Vigilante ITV: estado', mensaje: 'Sin actividad reciente. Revisa el proceso.' },
    ]);
    expect(correosCon('Vigilante ITV: estado').map((c) => c[2])).toEqual(['Sin actividad reciente. Revisa el proceso.']);
    // La línea del ciclo actual sí se ha añadido, pero después de calcular el latido.
    expect((await lineasRegistro()).at(-1)).toBe('2026-11-12 09:05:00  lectura-completa  dias=0');
  });

  it('con la última línea previa reciente (45 min), el texto usa esa línea y no la del ciclo actual', async () => {
    await writeFile(join(dir, 'lecturas.log'), '2026-11-12 08:20:00  detenido  motivo=antibots\n');
    cicloLectura.mockResolvedValueOnce(COMPLETA);
    await ejecutar('09:05');

    expect(avisosCon('Vigilante ITV: estado')[0]?.[0]).toEqual({
      titulo: 'Vigilante ITV: estado',
      mensaje: 'Lectura detenida (antibots). Último ciclo: 08:20.',
    });
  });

  it('si un canal falla, el otro basta para marcar el tramo (sin repetir)', async () => {
    cicloLectura.mockResolvedValue(COMPLETA);
    enviarEmail.mockRejectedValueOnce(Object.assign(new Error(`Invalid login ${ENV.SMTP_USUARIO}`), { code: 'EAUTH' }));
    await ejecutar('09:00');
    await ejecutar('09:10');

    expect(avisosCon('Vigilante ITV: estado')).toHaveLength(1);
    expect(vi.mocked(console.error).mock.calls.flat().join('\n')).toMatch(/No se pudo enviar el latido por email/);
    sinSecretos();
  });
});

describe('parada automática (dos "detenido" seguidos)', () => {
  it('un único aviso por ntfy y email; el tercero no repite; tras una lectura completa se puede volver a avisar', async () => {
    cicloLectura.mockResolvedValue(DETENIDO);
    await ejecutar('10:00'); // 1.º detenido: nada
    expect(avisosCon('Vigilante ITV: parado')).toHaveLength(0);

    await ejecutar('10:10'); // 2.º seguido: aviso
    expect(avisosCon('Vigilante ITV: parado')).toHaveLength(1);
    expect(correosCon('Vigilante ITV: parado')).toHaveLength(1);
    expect(avisosCon('Vigilante ITV: parado')[0]?.[0]).toEqual({
      titulo: 'Vigilante ITV: parado',
      mensaje: 'Dos ciclos seguidos detenidos (antibots).',
    });
    expect(JSON.parse(await leer('estado.json'))).toEqual({ paradaAvisada: '2026-11-12 10:10:00  detenido  motivo=antibots' });

    await ejecutar('10:20'); // 3.º: no se repite
    expect(avisosCon('Vigilante ITV: parado')).toHaveLength(1);
    expect(correosCon('Vigilante ITV: parado')).toHaveLength(1);

    cicloLectura.mockResolvedValueOnce(COMPLETA);
    await ejecutar('10:30'); // lectura completa: se rearma
    expect(JSON.parse(await leer('estado.json'))).toEqual({ paradaAvisada: null });

    await ejecutar('10:40');
    expect(avisosCon('Vigilante ITV: parado')).toHaveLength(1); // solo uno detenido tras la completa
    await ejecutar('10:50');
    expect(avisosCon('Vigilante ITV: parado')).toHaveLength(2); // vuelve a avisar
    expect(correosCon('Vigilante ITV: parado')).toHaveLength(2);
    sinSecretos();
  });

  it('si fallan los dos canales, no se marca y se reintenta en la siguiente ejecución', async () => {
    cicloLectura.mockResolvedValue(DETENIDO);
    await ejecutar('10:00');
    enviarAviso.mockRejectedValueOnce(new Error('ntfy respondió 500 al enviar el aviso.'));
    enviarEmail.mockRejectedValueOnce(new Error('caído'));
    await ejecutar('10:10');
    await expect(leer('estado.json')).rejects.toThrow();

    await ejecutar('10:20');
    expect(avisosCon('Vigilante ITV: parado')).toHaveLength(2); // el fallido y el bueno
    expect(JSON.parse(await leer('estado.json')).paradaAvisada).toMatch(/10:20:00 {2}detenido/);
  });
});

describe('secretos', () => {
  it('ninguna salida, log ni aviso contiene valores de secretos', async () => {
    cicloLectura.mockResolvedValue(DETENIDO);
    await ejecutar('09:00');
    await ejecutar('09:05');
    for (const archivo of ['lecturas.log', 'estado.json', 'latido.json']) {
      const contenido = await leer(archivo);
      for (const valor of VALORES_SECRETOS) expect(contenido, `${archivo}: ${valor}`).not.toContain(valor);
    }
    sinSecretos();
  });

  it('si falta una variable, el error la nombra sin mostrar valores', async () => {
    const { NTFY_TOPIC: _, ...sinTopic } = ENV;
    await expect(ejecutarUnaVez(sinTopic, { ahora: () => madrid('10:00'), dirDatos: dir })).rejects.toThrow(/NTFY_TOPIC/);
    expect(cicloLectura).not.toHaveBeenCalled();
  });
});
