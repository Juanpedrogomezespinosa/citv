// Punto de entrada.
// - MODO_SOLO_LECTURA=true: bucle de lectura. Un cicloLectura cada INTERVALO_MINUTOS
//   (mínimo 5), salvo de 23:00 a 07:00 (hora de España). Cada ciclo se imprime y se
//   registra en data/lecturas.log. Sin avisos de huecos ni email: no lee ni escribe
//   data/notificados.json. Solo el latido de las 09:00 y las 20:00 va a ntfy.
//   Se para solo tras dos ciclos seguidos "detenido" o por un error no controlado; en
//   ambos casos envía a ntfy "Vigilante ITV: parado" con el motivo. Ctrl+C cierra sin
//   dejar navegadores abiertos y no envía nada.
// - Sin MODO_SOLO_LECTURA: no hace nada todavía (el bucle con avisos no está conectado).

import { pathToFileURL } from 'node:url';
import { MESES, parsearFechaLimite } from './calendario.js';
import {
  leerDatosVehiculo,
  leerHeadless,
  leerIntervaloMinutos,
  leerModoSoloLectura,
  variableObligatoria,
} from './config.js';
import { enHorarioDeDescanso, partesMadrid } from './hora.js';
import { crearLatido } from './latido.js';
import { abrirChromium, cicloLectura, type AbrirNavegador, type NavegadorCiclo, type ResultadoLectura } from './lectura.js';
import { log, ocultarSecretos } from './logger.js';
import type { MesLeido } from './navegador.js';
import { describirFecha, enviarAviso, type DiaConHoras } from './notificar.js';
import { registrarCiclo, RUTA_LECTURAS } from './registro.js';

export interface Dependencias {
  /** Navegador para cada ciclo (por defecto, Chromium nuevo según HEADLESS). */
  abrir?: AbrirNavegador;
  /** Salida por terminal (por defecto, console.log). */
  imprimir?: (linea: string) => void;
  /** Reloj (por defecto, new Date()). */
  ahora?: () => Date;
  /** Espera entre ciclos; debe terminar antes si se aborta la señal. */
  esperar?: (ms: number, senal: AbortSignal) => Promise<void>;
  /** Señal de parada (Ctrl+C). */
  senal?: AbortSignal;
  /** Ruta del registro (por defecto, data/lecturas.log). */
  rutaRegistro?: string;
}

/** "2026-12-11 (viernes 11 de diciembre): 12:14, 12:18". */
function lineaDia({ fecha, horas }: DiaConHoras): string {
  const textoHoras = horas.length === 0 ? '(sin horas en el desplegable)' : horas.join(', ');
  return `${fecha} (${describirFecha(fecha)}): ${textoHoras}`;
}

/**
 * "Noviembre 2026: 0 días disponibles." o, en el mes de FECHA_LIMITE,
 * "Diciembre 2026: 0 días disponibles antes de 2026-12-10."
 */
function lineaMes({ anio, mes, disponibles }: MesLeido, fechaLimite: string): string {
  const nombre = MESES[mes - 1] ?? `mes ${mes}`;
  const mesTexto = `${nombre.charAt(0).toUpperCase()}${nombre.slice(1)} ${anio}`;
  const dias = disponibles === 1 ? '1 día disponible' : `${disponibles} días disponibles`;
  const limite = parsearFechaLimite(fechaLimite);
  const esMesLimite = limite.anio === anio && limite.mes === mes;
  return `${mesTexto}: ${dias}${esMesLimite ? ` antes de ${fechaLimite}` : ''}.`;
}

/** Una línea por mes leído (aunque tenga 0 días) y, debajo, una línea por día con sus horas. */
export function formatearLectura(
  meses: readonly MesLeido[],
  dias: readonly DiaConHoras[],
  fechaLimite: string,
): string[] {
  if (meses.length === 0) return ['Ningún mes en el rango.'];
  return meses.flatMap((m) => {
    const prefijo = `${m.anio}-${String(m.mes).padStart(2, '0')}-`;
    return [lineaMes(m, fechaLimite), ...dias.filter((d) => d.fecha.startsWith(prefijo)).map(lineaDia)];
  });
}

/** Espera `ms` o hasta que se aborte la señal. */
export function esperarInterrumpible(ms: number, senal: AbortSignal): Promise<void> {
  return new Promise((resolver) => {
    if (senal.aborted) return resolver();
    const fin = () => {
      clearTimeout(temporizador);
      senal.removeEventListener('abort', fin);
      resolver();
    };
    const temporizador = setTimeout(fin, ms);
    senal.addEventListener('abort', fin, { once: true });
  });
}

/**
 * Envuelve `abrir` para llevar la cuenta de los navegadores abiertos y poder cerrarlos
 * todos al instante (Ctrl+C). Si la señal ya está abortada al abrir, lo cierra y falla.
 */
export function rastrearNavegadores(abrir: AbrirNavegador, senal?: AbortSignal) {
  const abiertos = new Set<NavegadorCiclo>();
  const cerrar = async (n: NavegadorCiclo, original: () => Promise<void>) => {
    if (!abiertos.delete(n)) return; // ya cerrado
    await original();
  };
  return {
    abrir: async (): Promise<NavegadorCiclo> => {
      const navegador = await abrir();
      const rastreado: NavegadorCiclo = { ...navegador, cerrar: () => cerrar(rastreado, navegador.cerrar) };
      abiertos.add(rastreado);
      if (senal?.aborted === true) {
        await rastreado.cerrar();
        throw new Error('Proceso interrumpido');
      }
      return rastreado;
    },
    abiertos: (): number => abiertos.size,
    cerrarTodos: async (): Promise<void> => {
      await Promise.allSettled([...abiertos].map((n) => n.cerrar()));
    },
  };
}

export interface DependenciasBucle {
  ejecutarCiclo: () => Promise<ResultadoLectura>;
  registrar: (resultado: ResultadoLectura, fecha: Date) => Promise<unknown>;
  latido: (fecha: Date) => Promise<unknown>;
  ahora: () => Date;
  esperar: (ms: number, senal: AbortSignal) => Promise<void>;
  imprimir: (linea: string) => void;
  senal: AbortSignal;
}

export type FinBucle = { fin: 'dos-detenidos'; motivo: string } | { fin: 'interrumpido' };

/** Bucle de solo lectura (ver cabecera). No envía avisos de huecos ni email. */
export async function bucleSoloLectura(
  deps: DependenciasBucle,
  opciones: { intervaloMinutos: number; fechaLimite: string },
): Promise<FinBucle> {
  let detenidosSeguidos = 0;
  let enDescansoAntes = false;

  while (!deps.senal.aborted) {
    const inicio = deps.ahora();
    await deps.latido(inicio);

    if (enHorarioDeDescanso(inicio)) {
      if (!enDescansoAntes) deps.imprimir('Horario de descanso (23:00–07:00, hora de España): no se ejecutan ciclos.');
      enDescansoAntes = true;
    } else {
      enDescansoAntes = false;
      const resultado = await deps.ejecutarCiclo();
      if (deps.senal.aborted) break; // Ctrl+C durante el ciclo: no se registra un ciclo a medias
      const fin = deps.ahora();
      await deps.registrar(resultado, fin);

      const hora = partesMadrid(fin).texto.slice(11, 16);
      if (resultado.estado === 'detenido') {
        deps.imprimir(`[${hora}] Lectura detenida (${resultado.motivo}).`);
        detenidosSeguidos++;
        if (detenidosSeguidos >= 2) {
          deps.imprimir(`Bucle parado: dos ciclos seguidos detenidos (${resultado.motivo})`);
          return { fin: 'dos-detenidos', motivo: resultado.motivo };
        }
      } else {
        detenidosSeguidos = 0;
        deps.imprimir(`[${hora}] Lectura completa:`);
        for (const linea of formatearLectura(resultado.meses, resultado.dias, opciones.fechaLimite)) {
          deps.imprimir(`  ${linea}`);
        }
      }
    }

    if (deps.senal.aborted) break;
    await deps.esperar(opciones.intervaloMinutos * 60_000, deps.senal);
  }
  return { fin: 'interrumpido' };
}

export const TITULO_PARADA = 'Vigilante ITV: parado';

/** Devuelve el código de salida del proceso. */
export async function main(env: NodeJS.ProcessEnv = process.env, deps: Dependencias = {}): Promise<number> {
  const imprimir = deps.imprimir ?? ((linea: string) => console.log(linea));

  if (!leerModoSoloLectura(env)) {
    log.info('MODO_SOLO_LECTURA no está activado: no se hace nada (el bucle con avisos aún no está conectado).');
    return 0;
  }

  const datos = leerDatosVehiculo(env);
  const fechaLimite = variableObligatoria('FECHA_LIMITE', env);
  parsearFechaLimite(fechaLimite);
  const intervaloMinutos = leerIntervaloMinutos(env);
  const topic = variableObligatoria('NTFY_TOPIC', env);
  const senal = deps.senal ?? new AbortController().signal;
  const rutaRegistro = deps.rutaRegistro ?? RUTA_LECTURAS;

  const navegadores = rastrearNavegadores(deps.abrir ?? abrirChromium(leerHeadless(env)), senal);
  const alAbortar = () => void navegadores.cerrarTodos();
  senal.addEventListener('abort', alAbortar, { once: true });
  const latido = crearLatido({ topic, fechaLimite, rutaRegistro });

  // Nunca el topic ni datos del vehículo en los textos (los errores pueden traerlos).
  const secretos = [...Object.values(datos), topic];
  const textoSeguro = (error: unknown): string =>
    ocultarSecretos((error instanceof Error ? error.message : String(error)).split('\n')[0] ?? '', secretos);

  /** Aviso de parada a ntfy. Si falla, se registra el error y se termina igualmente. */
  const avisarParada = async (mensaje: string): Promise<void> => {
    try {
      await enviarAviso({ titulo: TITULO_PARADA, mensaje }, topic);
    } catch (error) {
      log.error(`No se pudo enviar el aviso de parada a ntfy (${textoSeguro(error)}).`);
    }
  };

  log.info(`Modo solo lectura: un ciclo cada ${intervaloMinutos} min, días anteriores a ${fechaLimite}. Sin avisos de huecos.`);
  try {
    const fin = await bucleSoloLectura(
      {
        ejecutarCiclo: () => cicloLectura(navegadores.abrir, datos, { fechaLimite }),
        registrar: (resultado, fecha) => registrarCiclo(resultado, fecha, rutaRegistro),
        latido: (fecha) => latido.comprobar(fecha),
        ahora: deps.ahora ?? (() => new Date()),
        esperar: deps.esperar ?? esperarInterrumpible,
        imprimir,
        senal,
      },
      { intervaloMinutos, fechaLimite },
    );
    if (fin.fin === 'dos-detenidos') {
      await avisarParada(`Bucle parado: dos ciclos seguidos detenidos (${fin.motivo}).`);
      return 1;
    }
    return 130; // Ctrl+C: no se envía nada
  } catch (error) {
    if (senal.aborted) return 130; // un error mientras se cerraba por Ctrl+C: tampoco se avisa
    const mensaje = `Bucle parado por un error no controlado: ${textoSeguro(error)}`;
    log.error(mensaje);
    await avisarParada(mensaje);
    return 1;
  } finally {
    senal.removeEventListener('abort', alAbortar);
    await navegadores.cerrarTodos();
  }
}

// Solo al ejecutarse directamente (npm run dev / npm start), no al importarlo en tests:
// así los tests nunca cargan el .env.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { config } = await import('dotenv');
  config();
  const controlador = new AbortController();
  let interrupciones = 0;
  process.on('SIGINT', () => {
    interrupciones++;
    if (interrupciones === 1) {
      log.aviso('Ctrl+C: cerrando el navegador y saliendo…');
      controlador.abort();
    } else {
      process.exit(130); // segundo Ctrl+C: salida inmediata
    }
  });
  try {
    process.exitCode = await main(process.env, { senal: controlador.signal });
  } catch (error) {
    // Errores de configuración: nombran la variable, nunca su valor.
    log.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
