// Pruebas de notificar.ts y del ciclo. fetch está simulado: no hay llamadas reales a ntfy.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { aplanarDias, ejecutarCiclo } from '../src/ciclo.js';
import { cargarNotificados } from '../src/estado.js';
import { describirFecha, enviarAviso, filtrarNuevos, formatearAviso, TITULO_AVISO } from '../src/notificar.js';

const TOPIC = 'topic-de-prueba';

function fetchSimulado(status = 200) {
  const simulado = vi.fn<typeof fetch>(async () => new Response('', { status }));
  vi.stubGlobal('fetch', simulado);
  return simulado;
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('describirFecha', () => {
  it('calcula el día de la semana en español', () => {
    expect(describirFecha('2026-11-15')).toBe('domingo 15 de noviembre');
    expect(describirFecha('2026-12-10')).toBe('jueves 10 de diciembre');
    expect(describirFecha('2026-12-02')).toBe('miércoles 2 de diciembre');
    expect(describirFecha('2026-11-21')).toBe('sábado 21 de noviembre');
  });
});

describe('formatearAviso', () => {
  it('con un hueco', () => {
    expect(formatearAviso([{ fecha: '2026-11-15', hora: '10:15' }])).toEqual({
      titulo: 'Cita ITV Estepona disponible',
      mensaje: 'Nueva cita: domingo 15 de noviembre a las 10:15',
    });
  });

  it('agrupa y ordena varias horas del mismo día', () => {
    const aviso = formatearAviso([
      { fecha: '2026-11-15', hora: '11:00' },
      { fecha: '2026-11-15', hora: '10:15' },
      { fecha: '2026-11-15', hora: '10:30' },
    ]);
    expect(aviso.mensaje).toBe('Nueva cita: domingo 15 de noviembre a las 10:15, 10:30, 11:00');
  });

  it('pone una línea por día cuando hay varios días', () => {
    const aviso = formatearAviso([
      { fecha: '2026-12-11', hora: '12:14' },
      { fecha: '2026-11-15', hora: '10:15' },
    ]);
    expect(aviso.mensaje).toBe(
      'Nueva cita: domingo 15 de noviembre a las 10:15\nNueva cita: viernes 11 de diciembre a las 12:14',
    );
  });
});

describe('filtrarNuevos', () => {
  it('no devuelve los huecos ya guardados', () => {
    const notificados = new Set(['2026-11-15 10:15']);
    const nuevos = filtrarNuevos(
      [
        { fecha: '2026-11-15', hora: '10:15' },
        { fecha: '2026-11-15', hora: '10:30' },
        { fecha: '2026-11-15', hora: '10:30' },
      ],
      notificados,
    );
    expect(nuevos).toEqual([{ fecha: '2026-11-15', hora: '10:30' }]);
  });
});

describe('enviarAviso', () => {
  it('hace POST a ntfy con el título en la cabecera Title y el mensaje en el cuerpo', async () => {
    const simulado = fetchSimulado();
    await enviarAviso({ titulo: TITULO_AVISO, mensaje: 'Nueva cita: x' }, TOPIC);

    expect(simulado).toHaveBeenCalledTimes(1);
    const [url, init] = simulado.mock.calls[0] ?? [];
    expect(url).toBe(`https://ntfy.sh/${TOPIC}`);
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('Title')).toBe(TITULO_AVISO);
    expect(init?.body).toBe('Nueva cita: x');
  });

  it('si ntfy falla, el error no incluye el topic', async () => {
    fetchSimulado(500);
    const promesa = enviarAviso({ titulo: TITULO_AVISO, mensaje: 'x' }, TOPIC);
    await expect(promesa).rejects.toThrow(/500/);
    await expect(promesa).rejects.not.toThrow(new RegExp(TOPIC));
  });
});

describe('aplanarDias', () => {
  it('convierte [{ fecha, horas }] en huecos día+hora (un día sin horas no genera huecos)', () => {
    expect(
      aplanarDias([
        { fecha: '2026-12-11', horas: ['12:14', '12:18'] },
        { fecha: '2026-12-12', horas: [] },
      ]),
    ).toEqual([
      { fecha: '2026-12-11', hora: '12:14' },
      { fecha: '2026-12-11', hora: '12:18' },
    ]);
  });
});

describe('ejecutarCiclo', () => {
  let dir: string;
  let ruta: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'citv-ciclo-'));
    ruta = join(dir, 'data', 'notificados.json');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const opciones = () => ({ topic: TOPIC, fechaLimite: '2026-12-10', hoy: '2026-11-12', rutaNotificados: ruta });

  it('envía un único aviso con todos los nuevos y no repite en el siguiente ciclo', async () => {
    const simulado = fetchSimulado();
    const huecos = [
      { fecha: '2026-11-15', hora: '10:15' },
      { fecha: '2026-11-15', hora: '10:30' },
    ];

    const primero = await ejecutarCiclo(huecos, opciones());
    expect(simulado).toHaveBeenCalledTimes(1);
    expect(primero.nuevos).toHaveLength(2);
    expect(await cargarNotificados(ruta)).toEqual(new Set(['2026-11-15 10:15', '2026-11-15 10:30']));

    const segundo = await ejecutarCiclo(huecos, opciones());
    expect(simulado).toHaveBeenCalledTimes(1);
    expect(segundo).toEqual({ nuevos: [], aviso: null, enviadoPor: [] });
  });

  it('en el siguiente ciclo solo avisa de la hora nueva', async () => {
    const simulado = fetchSimulado();
    await ejecutarCiclo([{ fecha: '2026-11-15', hora: '10:15' }], opciones());
    const segundo = await ejecutarCiclo(
      [
        { fecha: '2026-11-15', hora: '10:15' },
        { fecha: '2026-11-15', hora: '11:00' },
      ],
      opciones(),
    );
    expect(simulado).toHaveBeenCalledTimes(2);
    expect(segundo.aviso?.mensaje).toBe('Nueva cita: domingo 15 de noviembre a las 11:00');
  });

  it('ignora huecos anteriores a hoy o desde FECHA_LIMITE (excluida)', async () => {
    const simulado = fetchSimulado();
    const resultado = await ejecutarCiclo(
      [
        { fecha: '2026-11-11', hora: '10:00' },
        { fecha: '2026-11-12', hora: '10:00' },
        { fecha: '2026-12-09', hora: '10:00' },
        { fecha: '2026-12-10', hora: '10:00' },
      ],
      opciones(),
    );
    expect(resultado.nuevos.map((h) => h.fecha)).toEqual(['2026-11-12', '2026-12-09']);
    expect(simulado).toHaveBeenCalledTimes(1);
  });

  it('sin huecos nuevos no envía nada', async () => {
    const simulado = fetchSimulado();
    await ejecutarCiclo([], opciones());
    expect(simulado).not.toHaveBeenCalled();
  });

  it('si el envío falla no guarda, para reintentar en el siguiente ciclo', async () => {
    fetchSimulado(500);
    await expect(ejecutarCiclo([{ fecha: '2026-11-15', hora: '10:15' }], opciones())).rejects.toThrow();
    expect(await cargarNotificados(ruta)).toEqual(new Set());
  });
});
