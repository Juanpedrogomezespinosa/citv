// Un ciclo de lectura completo contra la web, SOLO LECTURA:
// navegador nuevo → https://www.itvcita.com/ → recorrerFlujo → leerHuecos → cerrar.
// - Cada ciclo abre un navegador nuevo (sin cookies ni sesión del anterior) y empieza
//   siempre desde URL_INICIO. No se reutilizan sesiones entre ciclos.
// - Al terminar la lectura NO se pulsa nada más (tampoco "Volver"): se cierra el navegador.
// - Solo hay dos estados de salida: 'lectura-completa' o 'detenido'.

import { chromium } from 'playwright';
import type { DatosVehiculo } from './config.js';
import { log, ocultarSecretos } from './logger.js';
import {
  comoPagina,
  DetencionError,
  leerHuecos,
  recorrerFlujo,
  URL_INICIO,
  type MesLeido,
  type MotivoDetencion,
  type OpcionesLectura,
  type Pagina,
} from './navegador.js';
import type { DiaConHoras } from './notificar.js';

/** Un navegador recién abierto para un solo ciclo. */
export interface NavegadorCiclo {
  pagina: Pagina;
  /** Navega a `url` y espera a que cargue. */
  irA(url: string): Promise<void>;
  /** Cierra el navegador entero (y con él la sesión). */
  cerrar(): Promise<void>;
}

export type AbrirNavegador = () => Promise<NavegadorCiclo>;

export type ResultadoLectura =
  | { estado: 'lectura-completa'; dias: DiaConHoras[]; meses: MesLeido[] }
  | { estado: 'detenido'; motivo: MotivoDetencion | 'error-inesperado' };

/** Chromium nuevo en cada llamada: navegador y contexto propios, sin estado previo. */
export function abrirChromium(headless: boolean): AbrirNavegador {
  return async () => {
    const navegador = await chromium.launch({ headless });
    try {
      const contexto = await navegador.newContext();
      const page = await contexto.newPage();
      return {
        pagina: comoPagina(page),
        irA: async (url) => {
          await page.goto(url, { waitUntil: 'load' });
        },
        cerrar: () => navegador.close(),
      };
    } catch (error) {
      await navegador.close();
      throw error;
    }
  };
}

/** Primera línea del error, sin datos del vehículo (Playwright puede añadir trozos de HTML). */
function errorSeguro(error: unknown, datos: DatosVehiculo): string {
  const mensaje = (error instanceof Error ? error.message : String(error)).split('\n')[0] ?? '';
  return ocultarSecretos(mensaje, Object.values(datos));
}

/**
 * Un ciclo de lectura: abre un navegador nuevo, entra por URL_INICIO, recorre el flujo
 * hasta el calendario, lee los días y sus horas y cierra el navegador sin pulsar nada más.
 * Las detenciones (antibots, estación, pantalla o mes inesperados...) ya se han
 * registrado al lanzarse; cualquier otro error se registra sin datos del vehículo.
 */
export async function cicloLectura(
  abrir: AbrirNavegador,
  datos: DatosVehiculo,
  opciones: OpcionesLectura,
): Promise<ResultadoLectura> {
  let navegador: NavegadorCiclo | undefined;
  try {
    navegador = await abrir();
    await navegador.irA(URL_INICIO);
    await recorrerFlujo(navegador.pagina, datos);
    const meses: MesLeido[] = [];
    const dias = await leerHuecos(navegador.pagina, {
      ...opciones,
      alLeerMes: (mes) => {
        meses.push(mes);
        opciones.alLeerMes?.(mes);
      },
    });
    return { estado: 'lectura-completa', dias, meses };
  } catch (error) {
    if (error instanceof DetencionError) return { estado: 'detenido', motivo: error.motivo };
    log.error(`Ciclo interrumpido: ${errorSeguro(error, datos)}`);
    return { estado: 'detenido', motivo: 'error-inesperado' };
  } finally {
    if (navegador !== undefined) {
      try {
        await navegador.cerrar();
      } catch (error) {
        log.aviso(`No se pudo cerrar el navegador: ${errorSeguro(error, datos)}`);
      }
    }
  }
}
