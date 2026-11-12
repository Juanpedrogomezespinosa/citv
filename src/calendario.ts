// Lee el calendario de cita previa de Veiasa a partir de su HTML (solo lectura).
// Funciones puras: no hay navegador, ni clics, ni registro del HTML.

import { load, type CheerioAPI } from 'cheerio';

export interface EstadoCalendario {
  /** Mes visible, de 1 (enero) a 12 (diciembre). */
  mes: number;
  /** Año visible, p. ej. 2026. */
  anio: number;
  /** Días con hueco libre, ordenados. Excluye la cita actual (`selected`). */
  diasDisponibles: number[];
  /** Horas del desplegable `#horasCita`, p. ej. ["12:14"]. */
  horas: string[];
}

export class CalendarioError extends Error {
  constructor(mensaje: string) {
    super(mensaje);
    this.name = 'CalendarioError';
  }
}

/** Nombres de los meses en español, en minúsculas (ninguno lleva tilde). */
export const MESES = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'diciembre',
] as const;

/** Minúsculas y sin tildes, para comparar textos en español. */
function normalizar(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

function leerTitulo($: CheerioAPI): { mes: number; anio: number } {
  const celda = $('td.title').first();
  if (celda.length === 0) {
    throw new CalendarioError('No se encontró el calendario en el HTML (falta td.title).');
  }

  const texto = normalizar(celda.text());
  const coincidencia = /([a-z]+)\s*,?\s*(\d{4})/.exec(texto);
  const nombreMes = coincidencia?.[1];
  const anioTexto = coincidencia?.[2];
  if (nombreMes === undefined || anioTexto === undefined) {
    throw new CalendarioError(`Título del calendario con formato inesperado: "${texto}".`);
  }

  const indice = MESES.findIndex((m) => m === nombreMes);
  if (indice === -1) {
    throw new CalendarioError(`Mes desconocido en el título del calendario: "${nombreMes}".`);
  }

  return { mes: indice + 1, anio: Number(anioTexto) };
}

function leerDiasDisponibles($: CheerioAPI): number[] {
  const dias = new Set<number>();

  $('td.special, td.special_sabado').each((_, el) => {
    const celda = $(el);
    if (celda.hasClass('disabled') || celda.hasClass('selected') || celda.hasClass('emptycell')) {
      return;
    }

    const texto = celda.text().trim();
    const dia = Number(texto);
    if (!/^\d{1,2}$/.test(texto) || dia < 1 || dia > 31) {
      throw new CalendarioError(`Celda de día disponible con texto inesperado: "${texto}".`);
    }
    dias.add(dia);
  });

  return [...dias].sort((a, b) => a - b);
}

function leerHoras($: CheerioAPI): string[] {
  return $('select#horasCita option')
    .toArray()
    .filter((op) => $(op).attr('value') !== '-1')
    .map((op) => $(op).text().trim())
    .filter((hora) => hora.length > 0);
}

/** Lee mes, año, días disponibles y horas del HTML del calendario. */
export function leerCalendario(html: string): EstadoCalendario {
  const $ = load(html);
  const { mes, anio } = leerTitulo($);
  return {
    mes,
    anio,
    diasDisponibles: leerDiasDisponibles($),
    horas: leerHoras($),
  };
}

/** Valida y descompone una fecha AAAA-MM-DD (p. ej. FECHA_LIMITE). */
export function parsearFechaLimite(fechaLimite: string): { anio: number; mes: number; dia: number } {
  const partes = /^(\d{4})-(\d{2})-(\d{2})$/.exec(fechaLimite.trim());
  if (partes === null) {
    throw new CalendarioError(`FECHA_LIMITE debe tener formato AAAA-MM-DD: "${fechaLimite}".`);
  }
  const anio = Number(partes[1]);
  const mes = Number(partes[2]);
  const dia = Number(partes[3]);
  const fecha = new Date(Date.UTC(anio, mes - 1, dia));
  if (fecha.getUTCFullYear() !== anio || fecha.getUTCMonth() !== mes - 1 || fecha.getUTCDate() !== dia) {
    throw new CalendarioError(`FECHA_LIMITE no es una fecha válida: "${fechaLimite}".`);
  }
  return { anio, mes, dia };
}

/** Días disponibles estrictamente anteriores a `fechaLimite` (AAAA-MM-DD). */
export function huecosAntesDe(estado: EstadoCalendario, fechaLimite: string): number[] {
  const limite = parsearFechaLimite(fechaLimite);
  const mesCalendario = estado.anio * 12 + estado.mes;
  const mesLimite = limite.anio * 12 + limite.mes;

  if (mesCalendario < mesLimite) return [...estado.diasDisponibles];
  if (mesCalendario > mesLimite) return [];
  return estado.diasDisponibles.filter((dia) => dia < limite.dia);
}
