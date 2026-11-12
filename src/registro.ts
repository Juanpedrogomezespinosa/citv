// Registro de ciclos en data/lecturas.log: una línea por ciclo, hora de España.
//   AAAA-MM-DD HH:MM:SS  lectura-completa  dias=<n>  [días si hay]
//   AAAA-MM-DD HH:MM:SS  detenido  motivo=<motivo>
// Nunca contiene datos del vehículo, el topic ni HTML. Si no se puede escribir, se
// registra el error en la terminal y el bucle sigue.

import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { partesMadrid } from './hora.js';
import type { ResultadoLectura } from './lectura.js';
import { log } from './logger.js';

export const RUTA_LECTURAS = 'data/lecturas.log';

const SEPARADOR = '  ';

/** "2026-12-11[12:14,12:18]" por día; sin horas: "2026-12-11[]". */
function textoDias(resultado: Extract<ResultadoLectura, { estado: 'lectura-completa' }>): string {
  return resultado.dias.map(({ fecha, horas }) => `${fecha}[${horas.join(',')}]`).join(' ');
}

export function lineaRegistro(fecha: Date, resultado: ResultadoLectura): string {
  const cuando = partesMadrid(fecha).texto;
  if (resultado.estado === 'detenido') {
    return [cuando, 'detenido', `motivo=${resultado.motivo}`].join(SEPARADOR);
  }
  const partes = [cuando, 'lectura-completa', `dias=${resultado.dias.length}`];
  if (resultado.dias.length > 0) partes.push(textoDias(resultado));
  return partes.join(SEPARADOR);
}

/**
 * Añade la línea del ciclo. Con `maxLineas`, conserva solo las últimas `maxLineas` líneas
 * (reescritura atómica). Devuelve false (y lo registra en la terminal) si no se puede escribir.
 */
export async function registrarCiclo(
  resultado: ResultadoLectura,
  fecha: Date,
  ruta: string = RUTA_LECTURAS,
  maxLineas?: number,
): Promise<boolean> {
  try {
    await mkdir(dirname(ruta), { recursive: true });
    const linea = lineaRegistro(fecha, resultado);
    if (maxLineas === undefined) {
      await appendFile(ruta, `${linea}\n`, 'utf8');
      return true;
    }
    const anteriores = (await leerLineas(ruta)) ?? [];
    const lineas = [...anteriores, linea].slice(-maxLineas);
    const temporal = `${ruta}.tmp`;
    await writeFile(temporal, `${lineas.join('\n')}\n`, 'utf8');
    await rename(temporal, ruta);
    return true;
  } catch (error) {
    const codigo = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'error';
    log.error(`No se pudo escribir en ${ruta} (${codigo}); el bucle sigue.`);
    return false;
  }
}

export type EntradaRegistro =
  | { cuando: string; estado: 'lectura-completa'; dias: number }
  | { cuando: string; estado: 'detenido'; motivo: string };

const FORMATO_LINEA =
  /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) {2}(?:lectura-completa {2}dias=(\d+)(?: {2}.*)?|detenido {2}motivo=(\S+))$/;

export function parsearLinea(linea: string): EntradaRegistro | null {
  const m = FORMATO_LINEA.exec(linea.trim());
  if (m === null || m[1] === undefined) return null;
  if (m[2] !== undefined) return { cuando: m[1], estado: 'lectura-completa', dias: Number(m[2]) };
  if (m[3] !== undefined) return { cuando: m[1], estado: 'detenido', motivo: m[3] };
  return null;
}

/** Líneas no vacías del archivo, o null si no existe. Otros errores se propagan. */
async function leerLineas(ruta: string): Promise<string[] | null> {
  try {
    return (await readFile(ruta, 'utf8')).split('\n').filter((l) => l.trim() !== '');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}

/** Las últimas `n` líneas válidas (en orden), con su texto original. */
export async function leerUltimasLineas(
  n: number,
  ruta: string = RUTA_LECTURAS,
): Promise<Array<{ linea: string; entrada: EntradaRegistro }>> {
  let lineas: string[] | null;
  try {
    lineas = await leerLineas(ruta);
  } catch {
    return [];
  }
  const validas = (lineas ?? []).flatMap((linea) => {
    const entrada = parsearLinea(linea);
    return entrada === null ? [] : [{ linea: linea.trim(), entrada }];
  });
  return validas.slice(-n);
}

/** Última línea válida del registro, o null si no existe o no hay ninguna. */
export async function leerUltimaEntrada(ruta: string = RUTA_LECTURAS): Promise<EntradaRegistro | null> {
  let contenido: string;
  try {
    contenido = await readFile(ruta, 'utf8');
  } catch {
    return null;
  }
  const lineas = contenido.split('\n').filter((l) => l.trim() !== '');
  for (let i = lineas.length - 1; i >= 0; i--) {
    const entrada = parsearLinea(lineas[i] ?? '');
    if (entrada !== null) return entrada;
  }
  return null;
}
