// Pruebas de src/index.ts (bucle en modo solo lectura) con valores de prueba. No se carga
// el .env y no hay navegador real: cicloLectura, los envíos, el reloj y la espera están
// simulados. El registro va a un directorio temporal, nunca a data/ del proyecto.

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NavegadorCiclo, ResultadoLectura } from '../src/lectura.js';

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

const enviarEmail = vi.fn();
vi.mock('../src/email.js', async (original) => ({
  ...(await original<typeof import('../src/email.js')>()),
  enviarEmail,
}));

const cargarNotificados = vi.fn();
const guardarNotificados = vi.fn();
vi.mock('../src/estado.js', async (original) => ({
  ...(await original<typeof import('../src/estado.js')>()),
  cargarNotificados,
  guardarNotificados,
}));

const { main, rastrearNavegadores, TITULO_PARADA } = await import('../src/index.js');
const { TITULO_AVISO } = await import('../src/notificar.js');

/** Valores de prueba: nunca los reales. */
const ENV_PRUEBA = {
  MODO_SOLO_LECTURA: 'true',
  MATRICULA: '0000-PRUEBA',
  BASTIDOR: 'BASTIDOR-DE-PRUEBA',
  LOCALIZADOR: 'LOCALIZADOR-PRUEBA',
  FECHA_LIMITE: '2026-12-10',
  INTERVALO_MINUTOS: '5',
  NTFY_TOPIC: 'topic-de-prueba',
  SMTP_HOST: 'smtp.ejemplo.test',
  SMTP_PORT: '465',
  SMTP_USUARIO: 'usuario-falso',
  SMTP_PASSWORD: 'clave-falsa',
  EMAIL_DESTINO: 'destino@ejemplo.test',
};

const DIAS = [
  { fecha: '2026-11-20', horas: ['09:00', '09:15'] },
  { fecha: '2026-12-05', horas: [] },
];
const COMPLETA_CON_DIAS: ResultadoLectura = {
  estado: 'lectura-completa',
  dias: DIAS,
  meses: [
    { anio: 2026, mes: 11, disponibles: 1 },
    { anio: 2026, mes: 12, disponibles: 1 },
  ],
};
const COMPLETA_SIN_DIAS: ResultadoLectura = {
  estado: 'lectura-completa',
  dias: [],
  meses: [
    { anio: 2026, mes: 11, disponibles: 0 },
    { anio: 2026, mes: 12, disponibles: 0 },
  ],
};
const detenido = (motivo: 'antibots' | 'estacion' | 'pantalla-inesperada'): ResultadoLectura => ({ estado: 'detenido', motivo });

/** Hora de España en noviembre (UTC+1). */
const madrid = (hhmm: string): Date => {
  const [h = 0, m = 0] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(2026, 10, 12, h - 1, m));
};

let dir: string;
let lineas: string[];

interface Ejecucion {
  codigo: number;
  rutaRegistro: string;
}

/**
 * Ejecuta main con un reloj simulado que avanza con cada espera. Tras `vueltas` esperas se
 * aborta la señal (como Ctrl+C), salvo que el bucle termine antes.
 */
async function ejecutarMain(
  env: Record<string, string | undefined>,
  o: { inicio?: Date; vueltas?: number; rutaRegistro?: string } = {},
): Promise<Ejecucion> {
  const controlador = new AbortController();
  let reloj = (o.inicio ?? madrid('10:00')).getTime();
  let esperas = 0;
  const rutaRegistro = o.rutaRegistro ?? join(dir, 'lecturas.log');
  const codigo = await main(env, {
    imprimir: (l) => lineas.push(l),
    ahora: () => new Date(reloj),
    esperar: async (ms) => {
      esperas++;
      reloj += ms;
      if (esperas >= (o.vueltas ?? 1)) controlador.abort();
    },
    senal: controlador.signal,
    rutaRegistro,
  });
  return { codigo, rutaRegistro };
}

/** Comprueba que ninguna salida (terminal o log) contiene datos del vehículo ni del topic. */
function sinDatosPersonales(): void {
  const consola = [console.log, console.warn, console.error].flatMap((f) => vi.mocked(f).mock.calls.flat()).map(String);
  const salida = [...lineas, ...consola].join('\n');
  for (const valor of [ENV_PRUEBA.MATRICULA, ENV_PRUEBA.BASTIDOR, ENV_PRUEBA.LOCALIZADOR, ENV_PRUEBA.NTFY_TOPIC]) {
    expect(salida).not.toContain(valor);
  }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'citv-index-'));
  lineas = [];
  for (const f of [abrirChromium, enviarAviso, enviarEmail, cargarNotificados, guardarNotificados]) f.mockClear();
  cicloLectura.mockReset();
  vi.stubGlobal('fetch', vi.fn());
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

describe('bucle con MODO_SOLO_LECTURA=true', () => {
  it('sin avisos: ni enviarAviso de huecos, ni enviarEmail, ni notificados.json, aunque haya huecos', async () => {
    cicloLectura.mockResolvedValue(COMPLETA_CON_DIAS);
    await ejecutarMain(ENV_PRUEBA, { vueltas: 3 });

    expect(cicloLectura).toHaveBeenCalledTimes(3);
    expect(enviarAviso).not.toHaveBeenCalled(); // de 10:00 a 10:10 no toca latido
    expect(enviarEmail).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(cargarNotificados).not.toHaveBeenCalled();
    expect(guardarNotificados).not.toHaveBeenCalled();
  });

  it('el latido de las 09:00 es lo único que va a ntfy; nunca un aviso de huecos', async () => {
    cicloLectura.mockResolvedValue(COMPLETA_CON_DIAS);
    await ejecutarMain(ENV_PRUEBA, { inicio: madrid('09:00'), vueltas: 3 });

    expect(enviarAviso).toHaveBeenCalledTimes(1);
    expect(enviarAviso.mock.calls.map((c) => (c as unknown[])[0])).toEqual([
      expect.objectContaining({ titulo: 'Vigilante ITV: estado' }),
    ]);
    expect(enviarAviso.mock.calls.flat()).not.toContainEqual(expect.objectContaining({ titulo: TITULO_AVISO }));
    expect(enviarEmail).not.toHaveBeenCalled();
  });

  it('un ciclo cada INTERVALO_MINUTOS', async () => {
    cicloLectura.mockResolvedValue(COMPLETA_SIN_DIAS);
    const esperas: number[] = [];
    const controlador = new AbortController();
    await main(
      { ...ENV_PRUEBA, INTERVALO_MINUTOS: '7' },
      {
        imprimir: (l) => lineas.push(l),
        ahora: () => madrid('10:00'),
        esperar: async (ms) => {
          esperas.push(ms);
          if (esperas.length === 2) controlador.abort();
        },
        senal: controlador.signal,
        rutaRegistro: join(dir, 'lecturas.log'),
      },
    );
    expect(esperas).toEqual([7 * 60_000, 7 * 60_000]);
    expect(cicloLectura).toHaveBeenCalledTimes(2);
  });

  it('INTERVALO_MINUTOS menor que 5 es un error', async () => {
    await expect(ejecutarMain({ ...ENV_PRUEBA, INTERVALO_MINUTOS: '4' })).rejects.toThrow(/mínimo 5/);
    expect(cicloLectura).not.toHaveBeenCalled();
  });

  it('imprime cada ciclo: una línea por mes y los días con sus horas, sin datos del vehículo', async () => {
    cicloLectura.mockResolvedValue(COMPLETA_CON_DIAS);
    await ejecutarMain(ENV_PRUEBA);

    expect(lineas).toEqual([
      '[10:00] Lectura completa:',
      '  Noviembre 2026: 1 día disponible.',
      '  2026-11-20 (viernes 20 de noviembre): 09:00, 09:15',
      '  Diciembre 2026: 1 día disponible antes de 2026-12-10.',
      '  2026-12-05 (sábado 5 de diciembre): (sin horas en el desplegable)',
    ]);
    sinDatosPersonales();
  });

  it('un mes sin días tiene su línea con 0 días; si no es el de FECHA_LIMITE, sin "antes de"', async () => {
    cicloLectura.mockResolvedValue({ estado: 'lectura-completa', dias: [], meses: [{ anio: 2026, mes: 11, disponibles: 0 }] });
    await ejecutarMain(ENV_PRUEBA);

    expect(lineas).toEqual(['[10:00] Lectura completa:', '  Noviembre 2026: 0 días disponibles.']);
    expect(lineas[1]).not.toContain('antes de');
  });

  it('con dos meses leídos sin días aparecen las dos líneas; solo diciembre lleva "antes de"', async () => {
    cicloLectura.mockResolvedValue(COMPLETA_SIN_DIAS);
    await ejecutarMain(ENV_PRUEBA);

    expect(lineas).toEqual([
      '[10:00] Lectura completa:',
      '  Noviembre 2026: 0 días disponibles.',
      '  Diciembre 2026: 0 días disponibles antes de 2026-12-10.',
    ]);
    expect(lineas.filter((l) => l.includes('antes de'))).toEqual(['  Diciembre 2026: 0 días disponibles antes de 2026-12-10.']);
  });

  it('pasa a cicloLectura los datos de config y FECHA_LIMITE', async () => {
    cicloLectura.mockResolvedValue(COMPLETA_SIN_DIAS);
    await ejecutarMain(ENV_PRUEBA);

    expect(cicloLectura).toHaveBeenCalledWith(
      expect.any(Function),
      { matricula: '0000-PRUEBA', bastidor: 'BASTIDOR-DE-PRUEBA', localizador: 'LOCALIZADOR-PRUEBA' },
      { fechaLimite: '2026-12-10' },
    );
  });

  it('registra cada ciclo en el registro, sin datos del vehículo', async () => {
    cicloLectura
      .mockResolvedValueOnce(COMPLETA_CON_DIAS)
      .mockResolvedValueOnce(detenido('antibots'))
      .mockResolvedValueOnce(COMPLETA_SIN_DIAS);
    const { rutaRegistro } = await ejecutarMain(ENV_PRUEBA, { vueltas: 3 });

    const contenido = await readFile(rutaRegistro, 'utf8');
    expect(contenido).toBe(
      [
        '2026-11-12 10:00:00  lectura-completa  dias=2  2026-11-20[09:00,09:15] 2026-12-05[]',
        '2026-11-12 10:05:00  detenido  motivo=antibots',
        '2026-11-12 10:10:00  lectura-completa  dias=0',
        '',
      ].join('\n'),
    );
    for (const valor of [ENV_PRUEBA.MATRICULA, ENV_PRUEBA.BASTIDOR, ENV_PRUEBA.LOCALIZADOR, ENV_PRUEBA.NTFY_TOPIC]) {
      expect(contenido).not.toContain(valor);
    }
  });

  it('si no se puede escribir el registro, el bucle sigue', async () => {
    cicloLectura.mockResolvedValue(COMPLETA_SIN_DIAS);
    const archivo = join(dir, 'no-es-carpeta');
    await writeFile(archivo, 'x');
    await ejecutarMain(ENV_PRUEBA, { vueltas: 3, rutaRegistro: join(archivo, 'lecturas.log') });

    expect(cicloLectura).toHaveBeenCalledTimes(3);
    const errores = vi.mocked(console.error).mock.calls.flat().map(String);
    expect(errores).toHaveLength(3);
    for (const e of errores) expect(e).toMatch(/No se pudo escribir en .*; el bucle sigue\./);
  });
});

describe('parada automática', () => {
  it('dos ciclos seguidos "detenido": se para con el mensaje y código 1', async () => {
    cicloLectura.mockResolvedValueOnce(detenido('estacion')).mockResolvedValueOnce(detenido('antibots'));
    const { codigo } = await ejecutarMain(ENV_PRUEBA, { vueltas: 10 });

    expect(codigo).toBe(1);
    expect(cicloLectura).toHaveBeenCalledTimes(2);
    expect(lineas.at(-1)).toBe('Bucle parado: dos ciclos seguidos detenidos (antibots)');
  });

  it('un "detenido" suelto no para el bucle: una lectura completa reinicia la cuenta', async () => {
    cicloLectura
      .mockResolvedValueOnce(detenido('antibots'))
      .mockResolvedValueOnce(COMPLETA_SIN_DIAS)
      .mockResolvedValueOnce(detenido('antibots'))
      .mockResolvedValueOnce(COMPLETA_SIN_DIAS);
    const { codigo } = await ejecutarMain(ENV_PRUEBA, { vueltas: 4 });

    expect(codigo).toBe(130); // terminó por la señal, no por la parada automática
    expect(cicloLectura).toHaveBeenCalledTimes(4);
    expect(lineas.join('\n')).not.toContain('Bucle parado');
  });
});

describe('aviso de parada a ntfy', () => {
  const avisosDeParada = () =>
    enviarAviso.mock.calls.map((c) => c as unknown[]).filter((c) => (c[0] as { titulo: string }).titulo === TITULO_PARADA);

  /** Ningún aviso (texto, título ni salida) lleva el topic ni datos del vehículo. */
  function avisoSinSecretos(): void {
    for (const [aviso] of enviarAviso.mock.calls.map((c) => c as unknown[])) {
      const texto = JSON.stringify(aviso);
      for (const valor of [ENV_PRUEBA.MATRICULA, ENV_PRUEBA.BASTIDOR, ENV_PRUEBA.LOCALIZADOR, ENV_PRUEBA.NTFY_TOPIC]) {
        expect(texto).not.toContain(valor);
      }
    }
  }

  it('parada por dos detenidos: exactamente un aviso "Vigilante ITV: parado" con el motivo', async () => {
    cicloLectura.mockResolvedValue(detenido('antibots'));
    const { codigo } = await ejecutarMain(ENV_PRUEBA, { vueltas: 10 });

    expect(codigo).toBe(1);
    expect(TITULO_PARADA).toBe('Vigilante ITV: parado');
    expect(enviarAviso).toHaveBeenCalledTimes(1);
    expect(enviarAviso).toHaveBeenCalledWith(
      { titulo: 'Vigilante ITV: parado', mensaje: 'Bucle parado: dos ciclos seguidos detenidos (antibots).' },
      ENV_PRUEBA.NTFY_TOPIC, // el topic solo como destino, nunca en el texto
    );
    expect(enviarEmail).not.toHaveBeenCalled();
    avisoSinSecretos();
  });

  it('error no controlado: exactamente un aviso, sin datos del vehículo, y código 1', async () => {
    cicloLectura
      .mockResolvedValueOnce(COMPLETA_SIN_DIAS)
      .mockRejectedValueOnce(new Error(`Fallo inesperado con ${ENV_PRUEBA.MATRICULA} y ${ENV_PRUEBA.NTFY_TOPIC}\n<html>…</html>`));
    const { codigo } = await ejecutarMain(ENV_PRUEBA, { vueltas: 10 });

    expect(codigo).toBe(1);
    expect(cicloLectura).toHaveBeenCalledTimes(2);
    expect(avisosDeParada()).toHaveLength(1);
    expect(enviarAviso).toHaveBeenCalledTimes(1);
    expect(enviarAviso).toHaveBeenCalledWith(
      { titulo: 'Vigilante ITV: parado', mensaje: 'Bucle parado por un error no controlado: Fallo inesperado con *** y ***' },
      ENV_PRUEBA.NTFY_TOPIC,
    );
    avisoSinSecretos();
    sinDatosPersonales();
  });

  it('Ctrl+C: ningún aviso', async () => {
    cicloLectura.mockResolvedValue(detenido('antibots')); // un detenido y, antes del segundo, Ctrl+C
    const { codigo } = await ejecutarMain(ENV_PRUEBA, { vueltas: 1 });

    expect(codigo).toBe(130);
    expect(enviarAviso).not.toHaveBeenCalled();
  });

  it('Ctrl+C a mitad de ciclo, aunque el ciclo falle al cerrarse el navegador: ningún aviso', async () => {
    const controlador = new AbortController();
    cicloLectura.mockImplementation(async () => {
      controlador.abort();
      throw new Error('Target page, context or browser has been closed');
    });
    const codigo = await main(ENV_PRUEBA, {
      imprimir: (l) => lineas.push(l),
      ahora: () => madrid('10:00'),
      esperar: async () => undefined,
      senal: controlador.signal,
      rutaRegistro: join(dir, 'lecturas.log'),
    });

    expect(codigo).toBe(130);
    expect(enviarAviso).not.toHaveBeenCalled();
  });

  it('si ntfy falla al avisar de la parada, se registra el error y el proceso termina igualmente', async () => {
    cicloLectura.mockResolvedValue(detenido('estacion'));
    enviarAviso.mockRejectedValueOnce(new Error('ntfy respondió 500 al enviar el aviso.'));
    const { codigo } = await ejecutarMain(ENV_PRUEBA, { vueltas: 10 });

    expect(codigo).toBe(1);
    expect(enviarAviso).toHaveBeenCalledTimes(1);
    const errores = vi.mocked(console.error).mock.calls.flat().map(String);
    expect(errores).toHaveLength(1);
    expect(errores[0]).toMatch(/No se pudo enviar el aviso de parada a ntfy \(ntfy respondió 500 al enviar el aviso\.\)\.$/);
    expect(errores[0]).not.toContain(ENV_PRUEBA.NTFY_TOPIC);
  });
});

describe('horario de descanso (23:00–07:00, hora de España)', () => {
  it('a partir de las 23:00 no ejecuta ciclos', async () => {
    cicloLectura.mockResolvedValue(COMPLETA_SIN_DIAS);
    // 22:50 y 22:55 se ejecutan; 23:00, 23:05 y 23:10 no.
    await ejecutarMain(ENV_PRUEBA, { inicio: madrid('22:50'), vueltas: 5 });

    expect(cicloLectura).toHaveBeenCalledTimes(2);
    expect(lineas.filter((l) => l.startsWith('Horario de descanso'))).toHaveLength(1);
  });

  it('antes de las 07:00 no ejecuta; a las 07:00 vuelve a ejecutar', async () => {
    cicloLectura.mockResolvedValue(COMPLETA_SIN_DIAS);
    // 06:50 y 06:55 no; 07:00 y 07:05 sí.
    await ejecutarMain(ENV_PRUEBA, { inicio: madrid('06:50'), vueltas: 4 });

    expect(cicloLectura).toHaveBeenCalledTimes(2);
    expect(lineas[0]).toMatch(/^Horario de descanso/);
    expect(lineas[1]).toBe('[07:00] Lectura completa:');
  });

  it('en descanso no se ejecuta ni se registra nada', async () => {
    cicloLectura.mockResolvedValue(detenido('antibots'));
    const { codigo, rutaRegistro } = await ejecutarMain(ENV_PRUEBA, { inicio: madrid('23:30'), vueltas: 3 });

    expect(codigo).toBe(130);
    expect(cicloLectura).not.toHaveBeenCalled();
    await expect(readFile(rutaRegistro, 'utf8')).rejects.toThrow();
  });
});

describe('Ctrl+C', () => {
  it('cierra el navegador abierto, no registra el ciclo a medias y sale con 130', async () => {
    const cerrar = vi.fn(async () => undefined);
    const abrir = async (): Promise<NavegadorCiclo> => ({
      pagina: {} as NavegadorCiclo['pagina'],
      irA: async () => undefined,
      cerrar,
    });
    const controlador = new AbortController();
    cicloLectura.mockImplementation(async (abrirRastreado: () => Promise<NavegadorCiclo>) => {
      await abrirRastreado();
      controlador.abort(); // Ctrl+C con el navegador abierto, a mitad de ciclo
      await new Promise((r) => setTimeout(r, 0));
      return detenido('pantalla-inesperada');
    });

    const rutaRegistro = join(dir, 'lecturas.log');
    const codigo = await main(ENV_PRUEBA, {
      imprimir: (l) => lineas.push(l),
      ahora: () => madrid('10:00'),
      esperar: async () => undefined,
      senal: controlador.signal,
      rutaRegistro,
      abrir,
    });

    expect(codigo).toBe(130);
    expect(cerrar).toHaveBeenCalledTimes(1);
    await expect(readFile(rutaRegistro, 'utf8')).rejects.toThrow();
  });

  it('rastrearNavegadores cierra todos los abiertos y no cierra dos veces el mismo', async () => {
    const cierres: string[] = [];
    let n = 0;
    const abrir = async (): Promise<NavegadorCiclo> => {
      const id = `nav${++n}`;
      return { pagina: {} as NavegadorCiclo['pagina'], irA: async () => undefined, cerrar: async () => void cierres.push(id) };
    };
    const rastreo = rastrearNavegadores(abrir);
    const a = await rastreo.abrir();
    await rastreo.abrir();
    await a.cerrar();
    expect(rastreo.abiertos()).toBe(1);

    await rastreo.cerrarTodos();
    await rastreo.cerrarTodos();
    expect(cierres).toEqual(['nav1', 'nav2']);
    expect(rastreo.abiertos()).toBe(0);
  });
});

describe('sin MODO_SOLO_LECTURA', () => {
  it.each([undefined, 'false'])('MODO_SOLO_LECTURA=%s: no ejecuta ningún ciclo ni envía nada', async (valor) => {
    const { codigo } = await ejecutarMain({ ...ENV_PRUEBA, MODO_SOLO_LECTURA: valor });
    expect(codigo).toBe(0);
    expect(cicloLectura).not.toHaveBeenCalled();
    expect(abrirChromium).not.toHaveBeenCalled();
    expect(enviarAviso).not.toHaveBeenCalled();
    expect(enviarEmail).not.toHaveBeenCalled();
    expect(lineas).toEqual([]);
  });

  it('un valor no válido es un error', async () => {
    await expect(ejecutarMain({ ...ENV_PRUEBA, MODO_SOLO_LECTURA: 'quizá' })).rejects.toThrow(/MODO_SOLO_LECTURA/);
    expect(cicloLectura).not.toHaveBeenCalled();
  });

  it('si falta una variable, el error la nombra sin mostrar ningún valor', async () => {
    const { LOCALIZADOR: _, ...sinLocalizador } = ENV_PRUEBA;
    await expect(ejecutarMain(sinLocalizador)).rejects.toThrow(/LOCALIZADOR/);
    expect(cicloLectura).not.toHaveBeenCalled();
  });
});
