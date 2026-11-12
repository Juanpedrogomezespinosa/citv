// Un ciclo de comprobación sin navegador: recibe los huecos leídos, filtra los que están
// en el rango [hoy, FECHA_LIMITE) y aún no se han notificado, envía un único aviso con
// todos (ntfy y, si está configurado, email) y los guarda en data/notificados.json.
// Si no hay nuevos, no envía nada.

import { enviarEmail, type ConfigEmail } from './email.js';
import { cargarNotificados, guardarNotificados, RUTA_NOTIFICADOS } from './estado.js';
import { log } from './logger.js';
import {
  claveHueco,
  enviarAviso,
  filtrarNuevos,
  formatearAviso,
  type Aviso,
  type DiaConHoras,
  type Hueco,
} from './notificar.js';

export interface OpcionesCiclo {
  /** NTFY_TOPIC. */
  topic: string;
  /** FECHA_LIMITE (AAAA-MM-DD), excluida. */
  fechaLimite: string;
  /** Fecha de hoy (AAAA-MM-DD). Por defecto, hoy en Europe/Madrid. */
  hoy?: string;
  /** Ruta de notificados.json. Por defecto data/notificados.json. */
  rutaNotificados?: string;
  /** Si se indica, el aviso se envía también por correo. */
  email?: ConfigEmail;
}

export type Canal = 'ntfy' | 'email';

export interface ResultadoCiclo {
  nuevos: Hueco[];
  aviso: Aviso | null;
  /** Canales por los que el aviso se envió correctamente. */
  enviadoPor: Canal[];
}

/** Descripción del error sin su mensaje completo (puede traer datos del servidor). */
function describirError(error: unknown): string {
  if (error instanceof Error) {
    const codigo = 'code' in error && typeof error.code === 'string' ? error.code : undefined;
    return codigo ?? error.name;
  }
  return 'error desconocido';
}

/** Fecha de hoy en España, AAAA-MM-DD. */
export function hoyEnMadrid(ahora: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Madrid',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(ahora);
}

/** Convierte lo leído del calendario ({ fecha, horas }) en huecos día+hora. */
export function aplanarDias(dias: readonly DiaConHoras[]): Hueco[] {
  return dias.flatMap(({ fecha, horas }) => horas.map((hora) => ({ fecha, hora })));
}

/** Huecos con fecha en [hoy, fechaLimite). Las fechas AAAA-MM-DD se comparan como texto. */
export function enRango(huecos: readonly Hueco[], hoy: string, fechaLimite: string): Hueco[] {
  return huecos.filter((h) => h.fecha >= hoy && h.fecha < fechaLimite);
}

export async function ejecutarCiclo(huecos: readonly Hueco[], opciones: OpcionesCiclo): Promise<ResultadoCiclo> {
  const ruta = opciones.rutaNotificados ?? RUTA_NOTIFICADOS;
  const hoy = opciones.hoy ?? hoyEnMadrid();

  const notificados = await cargarNotificados(ruta);
  const nuevos = filtrarNuevos(enRango(huecos, hoy, opciones.fechaLimite), notificados);

  if (nuevos.length === 0) {
    log.info(`Comprobación: ${huecos.length} hueco(s) leídos, ninguno nuevo.`);
    return { nuevos, aviso: null, enviadoPor: [] };
  }

  const aviso = formatearAviso(nuevos);
  const envios: Array<{ canal: Canal; enviar: () => Promise<void> }> = [
    { canal: 'ntfy', enviar: () => enviarAviso(aviso, opciones.topic) },
  ];
  const email = opciones.email;
  if (email !== undefined) {
    envios.push({ canal: 'email', enviar: () => enviarEmail(email, aviso.titulo, aviso.mensaje) });
  }

  const resultados = await Promise.allSettled(envios.map((e) => e.enviar()));
  const enviadoPor: Canal[] = [];
  resultados.forEach((resultado, i) => {
    const canal = envios[i]?.canal;
    if (canal === undefined) return;
    if (resultado.status === 'fulfilled') enviadoPor.push(canal);
    else log.error(`Fallo al enviar el aviso por ${canal} (${describirError(resultado.reason)}).`);
  });

  // Si no ha llegado por ningún canal, no se guarda: se reintentará en el siguiente ciclo.
  // Si ha llegado por al menos uno, se guarda para no repetir el aviso en ese canal.
  if (enviadoPor.length === 0) {
    throw new Error('No se pudo enviar el aviso por ningún canal.');
  }
  for (const hueco of nuevos) notificados.add(claveHueco(hueco));
  await guardarNotificados(notificados, ruta);

  log.info(`Comprobación: ${nuevos.length} hueco(s) nuevo(s) notificado(s) por ${enviadoPor.join(' y ')}.`);
  return { nuevos, aviso, enviadoPor };
}
