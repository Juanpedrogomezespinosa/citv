// "npm run ciclo": UNA sola vuelta de solo lectura y termina (para GitHub Actions).
// 1. Entre las 23:00 y las 07:59 (hora de España) sale con 0 sin abrir el navegador.
// 2. Un cicloLectura y su línea en data/lecturas.log (se conservan las últimas 500).
// 3. Parada automática: si las dos últimas líneas son "detenido", avisa por ntfy y email
//    UNA vez (marca en data/estado.json la línea que lo provocó) hasta la próxima lectura
//    completa.
// 4. Latido: de 09:00 a 09:14 y de 20:00 a 20:14, si ese tramo no consta en
//    data/latido.json, envía el estado por ntfy y email y lo marca. El texto se calcula
//    con las líneas que ya había en data/lecturas.log ANTES de añadir la de este ciclo:
//    "Sin actividad reciente" refleja si las ejecuciones anteriores se han parado.
// 5. Código de salida: 0 si la lectura es completa, 1 si termina en "detenido".
// Nunca imprime valores de secretos. No envía avisos de huecos ni toca notificados.json.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parsearFechaLimite } from './calendario.js';
import { leerDatosVehiculo, leerHeadless, variableObligatoria } from './config.js';
import { enviarEmail, leerConfigEmail } from './email.js';
import { partesMadrid } from './hora.js';
import { formatearLectura, TITULO_PARADA } from './index.js';
import { textoLatido, TITULO_LATIDO } from './latido.js';
import { abrirChromium, cicloLectura, type AbrirNavegador, type ResultadoLectura } from './lectura.js';
import { log, ocultarSecretos } from './logger.js';
import { enviarAviso, type Aviso } from './notificar.js';
import { leerUltimaEntrada, leerUltimasLineas, registrarCiclo } from './registro.js';

/** Líneas que se conservan en data/lecturas.log. */
export const MAX_LINEAS_REGISTRO = 500;

/** Minutos sin lecturas a partir de los cuales el latido dice "Sin actividad reciente". */
export const MINUTOS_SIN_ACTIVIDAD_CICLO = 60;

/** Variables cuyo valor nunca debe aparecer en la salida. */
const VARIABLES_SECRETAS = [
  'MATRICULA',
  'BASTIDOR',
  'LOCALIZADOR',
  'NTFY_TOPIC',
  'SMTP_HOST',
  'SMTP_USUARIO',
  'SMTP_PASSWORD',
  'EMAIL_DESTINO',
] as const;

/** Sin ciclos de 23:00 a 07:59 (hora de España). */
export function fueraDeHorario(fecha: Date): boolean {
  const { hora } = partesMadrid(fecha);
  return hora >= 23 || hora < 8;
}

/** Tramo de latido ("AAAA-MM-DD 09" o "AAAA-MM-DD 20") si la hora cae en 09:00–09:14 o 20:00–20:14. */
export function tramoLatido(fecha: Date): string | null {
  const { fecha: dia, hora, minuto } = partesMadrid(fecha);
  if ((hora === 9 || hora === 20) && minuto < 15) return `${dia} ${String(hora).padStart(2, '0')}`;
  return null;
}

export interface DependenciasEjecucion {
  ahora?: () => Date;
  abrir?: AbrirNavegador;
  imprimir?: (linea: string) => void;
  /** Carpeta de estado (por defecto, data/). */
  dirDatos?: string;
}

interface EstadoParada {
  /** Línea de lecturas.log que provocó el último aviso de parada, o null. */
  paradaAvisada: string | null;
}

interface EstadoLatido {
  tramos: string[];
}

async function leerJson<T>(ruta: string, porDefecto: T, valido: (v: unknown) => v is T): Promise<T> {
  let texto: string;
  try {
    texto = await readFile(ruta, 'utf8');
  } catch {
    return porDefecto;
  }
  try {
    const valor: unknown = JSON.parse(texto);
    if (valido(valor)) return valor;
  } catch {
    // corrupto: se trata como vacío
  }
  log.aviso(`${ruta} no tiene el formato esperado; se empieza vacío.`);
  return porDefecto;
}

async function guardarJson(ruta: string, valor: unknown): Promise<void> {
  await mkdir(dirname(ruta), { recursive: true });
  const temporal = `${ruta}.tmp`;
  await writeFile(temporal, `${JSON.stringify(valor, null, 2)}\n`, 'utf8');
  await rename(temporal, ruta);
}

const esEstadoParada = (v: unknown): v is EstadoParada =>
  typeof v === 'object' && v !== null && 'paradaAvisada' in v &&
  (v.paradaAvisada === null || typeof v.paradaAvisada === 'string');

const esEstadoLatido = (v: unknown): v is EstadoLatido =>
  typeof v === 'object' && v !== null && 'tramos' in v &&
  Array.isArray(v.tramos) && v.tramos.every((t) => typeof t === 'string');

/** Devuelve el código de salida del proceso. */
export async function ejecutarUnaVez(env: NodeJS.ProcessEnv = process.env, deps: DependenciasEjecucion = {}): Promise<number> {
  const reloj = deps.ahora ?? (() => new Date());
  const imprimir = deps.imprimir ?? ((linea: string) => console.log(linea));
  const dirDatos = deps.dirDatos ?? 'data';
  const rutas = {
    lecturas: join(dirDatos, 'lecturas.log'),
    latido: join(dirDatos, 'latido.json'),
    estado: join(dirDatos, 'estado.json'),
  };

  const inicio = reloj();
  if (fueraDeHorario(inicio)) {
    log.info('Fuera de horario (23:00–07:59, hora de España): no se ejecuta el ciclo.');
    return 0;
  }

  const datos = leerDatosVehiculo(env);
  const fechaLimite = variableObligatoria('FECHA_LIMITE', env);
  parsearFechaLimite(fechaLimite);
  const topic = variableObligatoria('NTFY_TOPIC', env);

  const secretos = VARIABLES_SECRETAS.map((v) => env[v]?.trim() ?? '').filter((v) => v !== '');
  const textoSeguro = (error: unknown): string =>
    ocultarSecretos((error instanceof Error ? error.message : String(error)).split('\n')[0] ?? '', secretos);

  /** Envía por ntfy y por email. Devuelve si ha llegado por al menos uno. Errores sin valores. */
  const enviarPorAmbos = async (aviso: Aviso, que: string): Promise<boolean> => {
    const canales = [
      { nombre: 'ntfy', enviar: () => enviarAviso(aviso, topic) },
      { nombre: 'email', enviar: () => enviarEmail(leerConfigEmail(env), aviso.titulo, aviso.mensaje) },
    ];
    const resultados = await Promise.allSettled(canales.map((c) => c.enviar()));
    resultados.forEach((r, i) => {
      if (r.status === 'rejected') log.error(`No se pudo enviar ${que} por ${canales[i]?.nombre ?? '?'} (${textoSeguro(r.reason)}).`);
    });
    return resultados.some((r) => r.status === 'fulfilled');
  };

  // 1. Un ciclo de lectura.
  let resultado: ResultadoLectura;
  try {
    resultado = await cicloLectura(deps.abrir ?? abrirChromium(leerHeadless(env)), datos, { fechaLimite });
  } catch (error) {
    log.error(`Ciclo interrumpido: ${textoSeguro(error)}`);
    resultado = { estado: 'detenido', motivo: 'error-inesperado' };
  }
  const fin = reloj();
  const hora = partesMadrid(fin).texto.slice(11, 16);
  if (resultado.estado === 'detenido') {
    imprimir(`[${hora}] Lectura detenida (${resultado.motivo}).`);
  } else {
    imprimir(`[${hora}] Lectura completa:`);
    for (const linea of formatearLectura(resultado.meses, resultado.dias, fechaLimite)) imprimir(`  ${linea}`);
  }

  // Texto del latido, si toca, con el registro tal como estaba ANTES de este ciclo.
  const tramo = tramoLatido(fin);
  let mensajeLatido: string | null = null;
  if (tramo !== null) {
    try {
      const anterior = await leerUltimaEntrada(rutas.lecturas);
      mensajeLatido = textoLatido(anterior, fin, fechaLimite, MINUTOS_SIN_ACTIVIDAD_CICLO);
    } catch (error) {
      log.error(`No se pudo preparar el latido (${textoSeguro(error)}).`);
    }
  }

  // 2. Registro (últimas 500 líneas).
  await registrarCiclo(resultado, fin, rutas.lecturas, MAX_LINEAS_REGISTRO);

  // 3. Parada automática: dos "detenido" seguidos → un único aviso hasta la próxima lectura completa.
  try {
    const estado = await leerJson<EstadoParada>(rutas.estado, { paradaAvisada: null }, esEstadoParada);
    const ultimas = await leerUltimasLineas(2, rutas.lecturas);
    const ultima = ultimas.at(-1);
    if (ultima?.entrada.estado === 'lectura-completa' && estado.paradaAvisada !== null) {
      await guardarJson(rutas.estado, { paradaAvisada: null });
    } else if (
      ultimas.length === 2 &&
      ultimas.every((u) => u.entrada.estado === 'detenido') &&
      ultima !== undefined &&
      ultima.entrada.estado === 'detenido' &&
      estado.paradaAvisada === null
    ) {
      const aviso = { titulo: TITULO_PARADA, mensaje: `Dos ciclos seguidos detenidos (${ultima.entrada.motivo}).` };
      if (await enviarPorAmbos(aviso, 'el aviso de parada')) {
        await guardarJson(rutas.estado, { paradaAvisada: ultima.linea });
        log.info('Aviso de parada enviado.');
      }
    }
  } catch (error) {
    log.error(`No se pudo comprobar la parada automática (${textoSeguro(error)}).`);
  }

  // 4. Latido (09:00–09:14 y 20:00–20:14), una vez por tramo, con el texto calculado antes.
  if (tramo !== null && mensajeLatido !== null) {
    const mensaje = mensajeLatido;
    try {
      const estadoLatido = await leerJson<EstadoLatido>(rutas.latido, { tramos: [] }, esEstadoLatido);
      if (!estadoLatido.tramos.includes(tramo)) {
        if (await enviarPorAmbos({ titulo: TITULO_LATIDO, mensaje }, 'el latido')) {
          await guardarJson(rutas.latido, { tramos: [...estadoLatido.tramos, tramo].slice(-30) });
          log.info(`Latido enviado (${tramo.slice(11)}:00).`);
        }
      }
    } catch (error) {
      log.error(`No se pudo comprobar el latido (${textoSeguro(error)}).`);
    }
  }

  return resultado.estado === 'lectura-completa' ? 0 : 1;
}

// Solo al ejecutarse directamente (npm run ciclo), no al importarlo en tests.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { config } = await import('dotenv');
  config(); // en local; en GitHub Actions las variables ya vienen del workflow
  try {
    process.exitCode = await ejecutarUnaVez(process.env);
  } catch (error) {
    // Errores de configuración: nombran la variable, nunca su valor.
    log.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
