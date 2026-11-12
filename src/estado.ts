// Lee y guarda los huecos ya notificados en data/notificados.json.
// Cada hueco se identifica por la clave "AAAA-MM-DD HH:MM" (p. ej. "2026-11-15 10:15").

import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { log } from './logger.js';

export const RUTA_NOTIFICADOS = 'data/notificados.json';

const FORMATO_CLAVE = /^\d{4}-\d{2}-\d{2} \d{1,2}:\d{2}$/;

function esListaDeClaves(valor: unknown): valor is string[] {
  return Array.isArray(valor) && valor.every((v) => typeof v === 'string' && FORMATO_CLAVE.test(v));
}

function esNoExiste(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

/**
 * Carga las claves notificadas. Si el archivo no existe, empieza vacío.
 * Si está corrupto, avisa en el log, deja el archivo intacto, guarda una copia
 * `<ruta>.corrupto-<fecha>` (para no perderlo cuando se guarde el siguiente estado)
 * y empieza vacío.
 */
export async function cargarNotificados(ruta: string = RUTA_NOTIFICADOS): Promise<Set<string>> {
  let contenido: string;
  try {
    contenido = await readFile(ruta, 'utf8');
  } catch (error) {
    if (esNoExiste(error)) return new Set();
    throw error;
  }

  let datos: unknown;
  try {
    datos = JSON.parse(contenido);
  } catch {
    datos = undefined;
  }

  if (!esListaDeClaves(datos)) {
    const copia = `${ruta}.corrupto-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    try {
      await copyFile(ruta, copia);
      log.aviso(`${ruta} está corrupto; se empieza vacío. Copia del original en ${copia}.`);
    } catch {
      log.aviso(`${ruta} está corrupto; se empieza vacío. No se pudo crear la copia ${copia}.`);
    }
    return new Set();
  }

  return new Set(datos);
}

/** Guarda las claves notificadas (escritura atómica: archivo temporal + renombrado). */
export async function guardarNotificados(
  notificados: ReadonlySet<string>,
  ruta: string = RUTA_NOTIFICADOS,
): Promise<void> {
  await mkdir(dirname(ruta), { recursive: true });
  const temporal = `${ruta}.tmp`;
  const claves = [...notificados].sort();
  await writeFile(temporal, `${JSON.stringify(claves, null, 2)}\n`, 'utf8');
  await rename(temporal, ruta);
}
