// Latido: a las 09:00 y a las 20:00 (hora de España) envía SOLO a ntfy (mismo topic) un
// resumen del estado según la última línea de data/lecturas.log. Nunca usa el correo.

import { MESES, parsearFechaLimite } from './calendario.js';
import { minutosEntre, partesMadrid } from './hora.js';
import { log } from './logger.js';
import { enviarAviso, type Aviso } from './notificar.js';
import { leerUltimaEntrada, RUTA_LECTURAS, type EntradaRegistro } from './registro.js';

export const TITULO_LATIDO = 'Vigilante ITV: estado';

/** Horas (España) a las que se envía el latido. */
export const HORAS_LATIDO = [9, 20] as const;

/** El latido se envía en los primeros 30 minutos de cada hora de latido. */
const VENTANA_MINUTOS = 30;

/** Si la última línea es más antigua que esto, el proceso no está funcionando bien. */
export const MINUTOS_SIN_ACTIVIDAD = 30;

const SIN_ACTIVIDAD = 'Sin actividad reciente. Revisa el proceso.';

/** "10 de diciembre" a partir de FECHA_LIMITE. */
function diaYMes(fechaLimite: string): string {
  const { dia, mes } = parsearFechaLimite(fechaLimite);
  return `${dia} de ${MESES[mes - 1] ?? ''}`;
}

export function textoLatido(entrada: EntradaRegistro | null, ahora: Date, fechaLimite: string): string {
  if (entrada === null) return SIN_ACTIVIDAD;
  if (minutosEntre(entrada.cuando, partesMadrid(ahora).texto) > MINUTOS_SIN_ACTIVIDAD) return SIN_ACTIVIDAD;

  const hhmm = entrada.cuando.slice(11, 16);
  if (entrada.estado === 'detenido') return `Lectura detenida (${entrada.motivo}). Último ciclo: ${hhmm}.`;
  const limite = diaYMes(fechaLimite);
  return entrada.dias === 0
    ? `Sin citas antes del ${limite}. Último ciclo: ${hhmm}.`
    : `Hay citas disponibles antes del ${limite}. Último ciclo: ${hhmm}.`;
}

export interface OpcionesLatido {
  topic: string;
  fechaLimite: string;
  rutaRegistro?: string;
  /** Envío a ntfy (por defecto, enviarAviso de notificar.ts). */
  enviar?: (aviso: Aviso, topic: string) => Promise<void>;
}

export interface Latido {
  /** Envía el latido si toca (09:00 o 20:00, una vez por día y hora). Devuelve si lo ha enviado. */
  comprobar(ahora: Date): Promise<boolean>;
}

export function crearLatido(opciones: OpcionesLatido): Latido {
  const enviados = new Set<string>();
  const enviar = opciones.enviar ?? enviarAviso;

  return {
    async comprobar(ahora: Date): Promise<boolean> {
      const { fecha, hora, minuto } = partesMadrid(ahora);
      const toca = HORAS_LATIDO.find((h) => h === hora && minuto < VENTANA_MINUTOS);
      if (toca === undefined) return false;
      const clave = `${fecha} ${toca}`;
      if (enviados.has(clave)) return false;

      const entrada = await leerUltimaEntrada(opciones.rutaRegistro ?? RUTA_LECTURAS);
      const mensaje = textoLatido(entrada, ahora, opciones.fechaLimite);
      try {
        await enviar({ titulo: TITULO_LATIDO, mensaje }, opciones.topic);
        enviados.add(clave);
        return true;
      } catch (error) {
        // Sin el topic: el error de enviarAviso tampoco lo incluye. Se reintenta en la ventana.
        log.error(`No se pudo enviar el latido de las ${String(toca).padStart(2, '0')}:00 (${error instanceof Error ? error.message : 'error'}).`);
        return false;
      }
    },
  };
}
