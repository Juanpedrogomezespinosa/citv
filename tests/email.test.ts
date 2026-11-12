// Pruebas del envío por correo y del ciclo con email. nodemailer y fetch están simulados.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sendMail = vi.fn(async () => ({}));
const createTransport = vi.fn(() => ({ sendMail }));
vi.mock('nodemailer', () => ({ default: { createTransport } }));

const { ejecutarCiclo } = await import('../src/ciclo.js');
const { cargarNotificados } = await import('../src/estado.js');
const { leerConfigEmail } = await import('../src/email.js');
const { ocultarSecretos } = await import('../src/logger.js');

const config = {
  host: 'smtp.ejemplo.test',
  puerto: 465,
  usuario: 'usuario-falso',
  password: 'clave-falsa',
  destino: 'destino@ejemplo.test',
};

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'citv-email-'));
  sendMail.mockClear();
  createTransport.mockClear();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response('', { status: 200 })));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

const opciones = () => ({
  topic: 'topic-de-prueba',
  fechaLimite: '2026-12-10',
  hoy: '2026-11-12',
  rutaNotificados: join(dir, 'notificados.json'),
  email: config,
});

describe('leerConfigEmail', () => {
  it('el error nombra la variable que falta, nunca un valor', () => {
    expect(() => leerConfigEmail({ SMTP_PORT: '465', SMTP_HOST: 'h', SMTP_USUARIO: 'u', EMAIL_DESTINO: 'd' })).toThrow(
      /SMTP_PASSWORD/,
    );
  });
});

describe('ciclo con email', () => {
  it('envía el mismo aviso por ntfy y por email, y no lo repite', async () => {
    const huecos = [{ fecha: '2026-11-15', hora: '10:15' }];
    const primero = await ejecutarCiclo(huecos, opciones());
    expect(primero.enviadoPor).toEqual(['ntfy', 'email']);
    expect(sendMail).toHaveBeenCalledWith({
      from: config.usuario,
      to: config.destino,
      subject: 'Cita ITV Estepona disponible',
      text: 'Nueva cita: domingo 15 de noviembre a las 10:15',
    });

    const segundo = await ejecutarCiclo(huecos, opciones());
    expect(segundo.enviadoPor).toEqual([]);
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('si falla el email pero ntfy funciona, se guarda y el log no lleva secretos', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    sendMail.mockRejectedValueOnce(
      Object.assign(new Error(`Invalid login for ${config.usuario} / ${config.password}`), { code: 'EAUTH' }),
    );

    const resultado = await ejecutarCiclo([{ fecha: '2026-11-15', hora: '10:15' }], opciones());
    expect(resultado.enviadoPor).toEqual(['ntfy']);
    expect(await cargarNotificados(join(dir, 'notificados.json'))).toEqual(new Set(['2026-11-15 10:15']));

    const salida = error.mock.calls.flat().join('\n');
    expect(salida).toContain('EAUTH');
    for (const secreto of [config.password, config.usuario, config.destino]) expect(salida).not.toContain(secreto);
  });

  it('si fallan los dos canales, lanza error y no guarda', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response('', { status: 500 })));
    sendMail.mockRejectedValueOnce(new Error('caído'));
    await expect(ejecutarCiclo([{ fecha: '2026-11-15', hora: '10:15' }], opciones())).rejects.toThrow(/ningún canal/);
    expect(await cargarNotificados(join(dir, 'notificados.json'))).toEqual(new Set());
  });
});

describe('ocultarSecretos', () => {
  it('sustituye cada secreto por ***', () => {
    expect(ocultarSecretos('fallo de usuario-falso con clave-falsa', ['clave-falsa', 'usuario-falso', ''])).toBe(
      'fallo de *** con ***',
    );
  });
});
