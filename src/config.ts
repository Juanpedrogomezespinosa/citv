// Lee las variables de entorno (dotenv) y valida que existan: MATRICULA, BASTIDOR, LOCALIZADOR,
// NTFY_TOPIC, FECHA_LIMITE (YYYY-MM-DD) e INTERVALO_MINUTOS (>= 5). HEADLESS opcional.
// (La lectura completa se implementará junto con index.ts.)

/** Devuelve la variable o lanza un error que nombra la variable, nunca su valor. */
export function variableObligatoria(nombre: string, env: NodeJS.ProcessEnv = process.env): string {
  const valor = env[nombre]?.trim();
  if (valor === undefined || valor === '') {
    throw new Error(`Falta la variable de entorno ${nombre} en el .env.`);
  }
  return valor;
}

/** Datos del vehículo para el formulario. Solo viven en el .env; nunca se registran. */
export interface DatosVehiculo {
  matricula: string;
  bastidor: string;
  localizador: string;
}

/** Lee MATRICULA, BASTIDOR y LOCALIZADOR del entorno (cargado desde el .env). */
export function leerDatosVehiculo(env: NodeJS.ProcessEnv = process.env): DatosVehiculo {
  return {
    matricula: variableObligatoria('MATRICULA', env),
    bastidor: variableObligatoria('BASTIDOR', env),
    localizador: variableObligatoria('LOCALIZADOR', env),
  };
}

/** Puntos en los que el modo exploración puede detener el flujo. */
export const PUNTOS_EXPLORACION = ['datos-cita', 'calendario'] as const;
export type PuntoExploracion = (typeof PUNTOS_EXPLORACION)[number];

/** EXPLORAR_HASTA: sin definir → undefined (flujo normal); valor desconocido → error. */
export function leerModoExploracion(env: NodeJS.ProcessEnv = process.env): PuntoExploracion | undefined {
  const valor = env.EXPLORAR_HASTA?.trim();
  if (valor === undefined || valor === '') return undefined;
  const punto = PUNTOS_EXPLORACION.find((p) => p === valor);
  if (punto === undefined) {
    throw new Error(`EXPLORAR_HASTA solo admite: ${PUNTOS_EXPLORACION.join(', ')}.`);
  }
  return punto;
}

/** HEADLESS: "false" muestra el navegador; sin definir o "true" → sin ventana. */
export function leerHeadless(env: NodeJS.ProcessEnv = process.env): boolean {
  const valor = env.HEADLESS?.trim().toLowerCase();
  if (valor === undefined || valor === '' || valor === 'true') return true;
  if (valor === 'false') return false;
  throw new Error('HEADLESS solo admite "true" o "false".');
}

/** MODO_SOLO_LECTURA: "true" activa el modo; sin definir o "false" → desactivado; otro valor → error. */
export function leerModoSoloLectura(env: NodeJS.ProcessEnv = process.env): boolean {
  const valor = env.MODO_SOLO_LECTURA?.trim().toLowerCase();
  if (valor === undefined || valor === '' || valor === 'false') return false;
  if (valor === 'true') return true;
  throw new Error('MODO_SOLO_LECTURA solo admite "true" o "false".');
}

/** INTERVALO_MINUTOS: número entero de minutos entre ciclos, mínimo 5 (regla de CLAUDE.md). */
export function leerIntervaloMinutos(env: NodeJS.ProcessEnv = process.env): number {
  const texto = variableObligatoria('INTERVALO_MINUTOS', env);
  const minutos = Number(texto);
  if (!Number.isInteger(minutos) || minutos < 5) {
    throw new Error('INTERVALO_MINUTOS debe ser un número entero de minutos, mínimo 5.');
  }
  return minutos;
}
