// Prepara y envía el aviso de huecos nuevos a ntfy (https://ntfy.sh/<NTFY_TOPIC>).
// El topic nunca se escribe en los logs ni en los mensajes de error.

import { MESES } from './calendario.js';

export interface Hueco {
  /** Fecha en formato AAAA-MM-DD. */
  fecha: string;
  /** Hora tal como la muestra la web, p. ej. "10:15". */
  hora: string;
}

/** Un día disponible y las horas leídas de su desplegable #horasCita. */
export interface DiaConHoras {
  /** Fecha en formato AAAA-MM-DD. */
  fecha: string;
  /** Texto de cada opción de #horasCita (sin la de value="-1"). */
  horas: string[];
}

export interface Aviso {
  titulo: string;
  mensaje: string;
}

export const TITULO_AVISO = 'Cita ITV Estepona disponible';

const DIAS_SEMANA = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'] as const;

/** Clave única de un hueco: "AAAA-MM-DD HH:MM". */
export function claveHueco(hueco: Hueco): string {
  return `${hueco.fecha} ${hueco.hora}`;
}

function partesFecha(fecha: string): { anio: number; mes: number; dia: number; diaSemana: number } {
  const partes = /^(\d{4})-(\d{2})-(\d{2})$/.exec(fecha);
  if (partes === null) throw new Error(`Fecha de hueco con formato inválido: "${fecha}".`);
  const anio = Number(partes[1]);
  const mes = Number(partes[2]);
  const dia = Number(partes[3]);
  const d = new Date(Date.UTC(anio, mes - 1, dia));
  if (d.getUTCFullYear() !== anio || d.getUTCMonth() !== mes - 1 || d.getUTCDate() !== dia) {
    throw new Error(`Fecha de hueco inválida: "${fecha}".`);
  }
  return { anio, mes, dia, diaSemana: d.getUTCDay() };
}

/** "domingo 15 de noviembre" */
export function describirFecha(fecha: string): string {
  const { mes, dia, diaSemana } = partesFecha(fecha);
  return `${DIAS_SEMANA[diaSemana] ?? ''} ${dia} de ${MESES[mes - 1] ?? ''}`;
}

function minutos(hora: string): number {
  const [h, m] = hora.split(':');
  return Number(h) * 60 + Number(m);
}

/**
 * Una línea por día, con las horas de ese día agrupadas y ordenadas:
 * "Nueva cita: domingo 15 de noviembre a las 10:15, 10:30, 11:00"
 */
export function formatearAviso(huecos: readonly Hueco[]): Aviso {
  if (huecos.length === 0) throw new Error('No hay huecos para formatear.');

  const porFecha = new Map<string, Set<string>>();
  for (const { fecha, hora } of huecos) {
    const horas = porFecha.get(fecha) ?? new Set<string>();
    horas.add(hora);
    porFecha.set(fecha, horas);
  }

  const lineas = [...porFecha.keys()].sort().map((fecha) => {
    const horas = [...(porFecha.get(fecha) ?? [])].sort((a, b) => minutos(a) - minutos(b));
    return `Nueva cita: ${describirFecha(fecha)} a las ${horas.join(', ')}`;
  });

  return { titulo: TITULO_AVISO, mensaje: lineas.join('\n') };
}

/** Huecos cuya clave no está en `notificados` (sin duplicados). */
export function filtrarNuevos(huecos: readonly Hueco[], notificados: ReadonlySet<string>): Hueco[] {
  const vistos = new Set<string>();
  return huecos.filter((hueco) => {
    const clave = claveHueco(hueco);
    if (notificados.has(clave) || vistos.has(clave)) return false;
    vistos.add(clave);
    return true;
  });
}

/** POST a ntfy: título en la cabecera Title, mensaje en el cuerpo. */
export async function enviarAviso(aviso: Aviso, topic: string): Promise<void> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(topic)) {
    throw new Error('NTFY_TOPIC vacío o con caracteres no permitidos.');
  }

  const respuesta = await fetch(`https://ntfy.sh/${topic}`, {
    method: 'POST',
    headers: { Title: aviso.titulo, 'Content-Type': 'text/plain; charset=utf-8' },
    body: aviso.mensaje,
  });

  if (!respuesta.ok) {
    throw new Error(`ntfy respondió ${respuesta.status} al enviar el aviso.`);
  }
}
