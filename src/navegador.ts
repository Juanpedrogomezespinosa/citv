// Navegación con Playwright, SOLO LECTURA de la cita. Esta capa garantiza que:
// - Todo clic pasa por clic(), que se niega a pulsar nada con texto aceptar/confirmar/enviar
//   y se detiene si el localizador encuentra 0 o más de 1 elemento.
// - Solo se pulsan: botones de flujo por texto exacto, días disponibles del calendario
//   (pulsarDia) y la flecha de mes de la cabecera del calendario (cambiarMes).
// - Solo se escribe en: matrícula, bastidor y localizador (rellenarCampo) y en el
//   select #tipoAcceso con el valor grabado (elegirTipoAcceso). Nada más: en particular,
//   el desplegable #horasCita nunca se modifica.
// - La estación se verifica en la pantalla de datos de la cita ("Estación elegida:" debe
//   ser "ITV ESTEPONA") antes de rellenar el localizador, y por tanto antes de llegar al
//   calendario y de leer días u horas.
// - Ante captcha, operación matemática o pantalla inesperada, se detiene (DetencionError).
//   Excepción: en la pantalla "cita propuesta" no se detecta, no se lee ni se resuelve la
//   operación; solo se pulsa una vez el enlace "Cambiar fecha y hora".
// - Los valores de matrícula, bastidor y localizador nunca se registran.

import type { Page } from 'playwright';
import {
  CalendarioError,
  huecosAntesDe,
  leerCalendario,
  MESES,
  parsearFechaLimite,
  type EstadoCalendario,
} from './calendario.js';
import { hoyEnMadrid } from './ciclo.js';
import type { DatosVehiculo, PuntoExploracion } from './config.js';
import { log } from './logger.js';
import type { DiaConHoras } from './notificar.js';

// ---------------------------------------------------------------------------
// Interfaz mínima de Playwright que usa este módulo (la Page real la cumple).
// ---------------------------------------------------------------------------

export interface Localizador {
  count(): Promise<number>;
  textContent(): Promise<string | null>;
  innerText(): Promise<string>;
  getAttribute(nombre: string): Promise<string | null>;
  inputValue(): Promise<string>;
  waitFor(opciones: { state: 'visible' | 'hidden'; timeout?: number }): Promise<void>;
  click(opciones?: { timeout?: number }): Promise<void>;
  fill(valor: string): Promise<void>;
  selectOption(valor: string): Promise<unknown>;
  locator(selector: string): Localizador;
  filter(opciones: { hasText?: RegExp; visible?: boolean }): Localizador;
}

export interface Pagina {
  locator(selector: string): Localizador;
  getByRole(rol: 'button' | 'link' | 'textbox', opciones: { name: string; exact: true }): Localizador;
  content(): Promise<string>;
  waitForEvent(evento: 'load', opciones?: { timeout?: number }): Promise<unknown>;
  keyboard: { press(tecla: string): Promise<void> };
}

/** Página de inicio de la cita previa. */
export const URL_INICIO = 'https://www.itvcita.com/';

/** Comprobación en compilación de que la Page real de Playwright cumple `Pagina`. */
export const comoPagina = (page: Page): Pagina => page;

// ---------------------------------------------------------------------------
// Constantes de seguridad
// ---------------------------------------------------------------------------

export const ESTACION_PERMITIDA = 'ITV ESTEPONA';

/** Textos que nunca se pulsan. */
export const TEXTO_PROHIBIDO = /aceptar|confirmar|enviar|cancelar|cambiar estaci[oó]n|volver/i;

/** Tiempo máximo de espera de cargas y elementos. */
export const TIEMPO_ESPERA_MS = 15_000;

/**
 * Tiempo máximo para que un elemento sea pulsable (visible, sin nada encima). Sustituye a
 * los 30 s por defecto de Playwright: si algo lo tapa, se detiene enseguida.
 */
export const TIEMPO_CLIC_MS = 5_000;

/** Tiempo máximo para que desaparezca un aviso tras pulsar "Entendido". */
export const TIEMPO_DIALOGO_MS = 5_000;

/**
 * Únicos botones de flujo que se pueden pulsar, con su rol ARIA y si el clic carga una
 * página nueva (entonces se espera al evento "load"). La clave es el texto EXACTO del
 * HTML de la web (getByRole con exact: true distingue mayúsculas): cada pantalla usa el
 * suyo, sin normalizar.
 */
export const BOTONES_FLUJO = {
  Entendido: { rol: 'button', navega: false },
  /** Pantalla matrícula y bastidor: <input type="button" value="SIGUIENTE">. */
  SIGUIENTE: { rol: 'button', navega: true },
  /**
   * Pantalla tipo de inspección y pantalla intermedia tras "Modificar cita":
   * <input type="submit" value="Siguiente">.
   */
  Siguiente: { rol: 'button', navega: true },
  /** Datos de la cita: <input type="button" value="Modificar cita">. */
  'Modificar cita': { rol: 'button', navega: true },
  /** Cita propuesta: <a href="#">Cambiar fecha y hora</a>. */
  'Cambiar fecha y hora': { rol: 'link', navega: true },
} as const satisfies Record<string, { rol: 'button' | 'link'; navega: boolean }>;

export type TextoBotonFlujo = keyof typeof BOTONES_FLUJO;

/** Únicos campos de texto que se rellenan (selectores grabados con codegen). */
const CAMPOS = {
  matricula: {
    descripcion: 'el campo de matrícula',
    localizar: (page: Pagina) => page.getByRole('textbox', { name: 'Matrícula:', exact: true }),
  },
  bastidor: { descripcion: 'el campo de bastidor', localizar: (page: Pagina) => page.locator('#bastidor') },
  localizador: { descripcion: 'el campo de localizador', localizar: (page: Pagina) => page.locator('#localizador') },
} as const;

export type Campo = keyof typeof CAMPOS;

/** Valor de #tipoAcceso grabado con codegen. */
export const TIPO_ACCESO = '2';

/** Etiqueta exacta de la tabla de datos de la cita. */
export const ETIQUETA_ESTACION = 'Estación elegida:';

export const SELECTORES = {
  tipoAcceso: '#tipoAcceso',
  /** Diálogos/avisos modales (solo cuentan los visibles). */
  dialogo: '[role="dialog"], [role="alertdialog"], dialog[open]',
  celdasTabla: 'td, th',
  /** La celda inmediatamente siguiente (hermana) a la etiqueta. */
  celdaSiguiente: 'xpath=following-sibling::*[1]',
  desplegableAbierto: '[aria-expanded="true"]',
  tituloCalendario: '#calendar-container table thead tr.headrow > td.title',
  /** Flechas: dentro de la fila de cabecera, la celda .nav justo antes / justo después del título. */
  flechaMesAnterior: '#calendar-container table thead tr.headrow > td.nav:has(+ td.title)',
  flechaMesSiguiente: '#calendar-container table thead tr.headrow > td.title + td.nav',
  celdasDia: '#calendar-container table tbody td',
  fechaSeleccionada: '#fechaSeleccionada',
  captcha: [
    'iframe[src*="captcha"]',
    'img[src*="captcha"]',
    '[id*="captcha"]',
    '[class*="captcha"]',
    '[name*="captcha"]',
    '.g-recaptcha',
    '.h-captcha',
    '.cf-turnstile',
  ].join(', '),
} as const;

/** Máximo de días que se pulsan por ciclo (cada uno es una petición a la web). */
export const MAX_DIAS_POR_CICLO = 10;

// ---------------------------------------------------------------------------
// Detención
// ---------------------------------------------------------------------------

export type MotivoDetencion =
  | 'clic-prohibido'
  | 'estacion'
  | 'antibots'
  | 'pantalla-inesperada'
  | 'mes-inesperado'
  | 'datos-incompletos';

/** El script debe detenerse y avisar al usuario. No se reintenta. */
export class DetencionError extends Error {
  constructor(
    readonly motivo: MotivoDetencion,
    mensaje: string,
  ) {
    super(mensaje);
    this.name = 'DetencionError';
  }
}

/** Registra (sin datos personales) y lanza DetencionError. */
function detener(motivo: MotivoDetencion, mensaje: string): never {
  log.error(`Detenido (${motivo}): ${mensaje}`);
  throw new DetencionError(motivo, mensaje);
}

// ---------------------------------------------------------------------------
// Clic seguro: ÚNICO sitio del código que pulsa elementos
// ---------------------------------------------------------------------------

/**
 * Pulsa `localizador` solo si identifica exactamente un elemento y ni su texto, ni su
 * value, ni su aria-label, ni su title coinciden con TEXTO_PROHIBIDO.
 */
export async function clic(localizador: Localizador, nombre: string): Promise<void> {
  if (TEXTO_PROHIBIDO.test(nombre)) {
    detener('clic-prohibido', `Se ha intentado pulsar "${nombre}".`);
  }

  const total = await localizador.count();
  if (total !== 1) {
    detener('pantalla-inesperada', `"${nombre}": se esperaba 1 elemento y hay ${total}.`);
  }

  const textos = [
    await localizador.textContent(),
    await localizador.getAttribute('value'),
    await localizador.getAttribute('aria-label'),
    await localizador.getAttribute('title'),
  ];
  const prohibido = textos.find((t) => t !== null && TEXTO_PROHIBIDO.test(t));
  if (prohibido !== undefined && prohibido !== null) {
    detener('clic-prohibido', `"${nombre}" tiene el texto "${prohibido.trim()}"; no se pulsa.`);
  }

  try {
    await localizador.click({ timeout: TIEMPO_CLIC_MS });
  } catch {
    // Tapado por otro elemento (p. ej. un aviso), oculto o deshabilitado: no se reintenta.
    detener('pantalla-inesperada', `"${nombre}" no se puede pulsar (tapado o no disponible).`);
  }
}

/** clic() y espera a que cargue la página nueva (los formularios de la web recargan). */
async function clicConCarga(page: Pagina, localizador: Localizador, nombre: string): Promise<void> {
  const carga = page.waitForEvent('load', { timeout: TIEMPO_ESPERA_MS });
  // Si clic() se detiene antes de pulsar, la espera queda sin usar: evita un rechazo sin gestionar.
  carga.catch(() => undefined);
  await clic(localizador, nombre);
  try {
    await carga;
  } catch {
    detener('pantalla-inesperada', `Tras pulsar "${nombre}" no ha cargado ninguna página.`);
  }
}

async function esperarVisible(localizador: Localizador, descripcion: string): Promise<void> {
  try {
    await localizador.waitFor({ state: 'visible', timeout: TIEMPO_ESPERA_MS });
  } catch {
    detener('pantalla-inesperada', `No se encuentra ${descripcion} (o hay más de uno).`);
  }
}

// ---------------------------------------------------------------------------
// Comprobaciones de pantalla
// ---------------------------------------------------------------------------

const OPERACION_MATEMATICA = /\d{1,3}\s*[+\-−x×*]\s*\d{1,3}\s*=/;
const TEXTO_CAPTCHA = /captcha|no soy un robot|not a robot/i;

/** Nombre de cada pantalla del flujo (lo único que se registra si aparece un control antibots). */
export type Pantalla =
  | 'aviso inicial'
  | 'matrícula y bastidor'
  | 'tipo de inspección'
  | 'datos de la cita'
  | 'intermedia tras Modificar cita'
  | 'cita propuesta'
  | 'calendario';

/**
 * Pantallas en las que NO se ejecuta la detección antibots. En "cita propuesta" la web
 * muestra siempre una operación matemática: no se lee la página (ni la operación), no se
 * escribe nada y lo único que se hace es pulsar "Cambiar fecha y hora".
 */
export const PANTALLAS_SIN_DETECCION_ANTIBOTS: readonly Pantalla[] = ['cita propuesta'];

/**
 * Se detiene si hay operación matemática o captcha. Solo registra el nombre de la
 * pantalla: nunca la operación, el texto de la página ni el HTML.
 * La operación se comprueba primero: su campo de respuesta suele llamarse "captcha"
 * (id/name), y si se mirase antes el captcha se etiquetaría mal.
 */
export async function comprobarAntibots(page: Pagina, pantalla: Pantalla): Promise<void> {
  if (PANTALLAS_SIN_DETECCION_ANTIBOTS.includes(pantalla)) return;

  const control = await detectarAntibots(page);
  if (control === 'operación matemática') {
    detener('antibots', `Operación matemática en la pantalla "${pantalla}".`);
  }
  if (control === 'captcha') {
    detener('antibots', `Captcha en la pantalla "${pantalla}".`);
  }
}

export type ControlAntibots = 'operación matemática' | 'captcha';

/** Solo detecta (no registra ni lanza). La operación se mira antes que el captcha. */
async function detectarAntibots(page: Pagina): Promise<ControlAntibots | null> {
  const texto = await page.locator('body').innerText();
  if (OPERACION_MATEMATICA.test(texto)) return 'operación matemática';
  if (TEXTO_CAPTCHA.test(texto) || (await page.locator(SELECTORES.captcha).count()) > 0) return 'captcha';
  return null;
}

/**
 * Pantalla de datos de la cita: la celda con el texto exacto "Estación elegida:" debe
 * existir una sola vez y la celda siguiente debe ser exactamente ESTACION_PERMITIDA.
 */
export async function verificarEstacionElegida(page: Pagina): Promise<void> {
  const etiqueta = page
    .locator(SELECTORES.celdasTabla)
    .filter({ hasText: new RegExp(`^\\s*${ETIQUETA_ESTACION}\\s*$`) });
  const total = await etiqueta.count();
  if (total !== 1) {
    detener(
      'estacion',
      total === 0 ? `No aparece "${ETIQUETA_ESTACION}" en la página.` : `"${ETIQUETA_ESTACION}" aparece ${total} veces.`,
    );
  }

  const celda = etiqueta.locator(SELECTORES.celdaSiguiente);
  if ((await celda.count()) !== 1) detener('estacion', `No hay celda con el valor de "${ETIQUETA_ESTACION}".`);

  const valor = ((await celda.textContent()) ?? '').replace(/\s+/g, ' ').trim();
  if (valor === '') detener('estacion', 'La estación elegida está vacía.');
  // No se registra el valor leído: solo que no es la esperada.
  if (valor !== ESTACION_PERMITIDA) detener('estacion', `La estación elegida no es "${ESTACION_PERMITIDA}".`);
}

/** Antibots + calendario visible; después lee días y horas. */
export async function leerVistaCalendario(page: Pagina): Promise<EstadoCalendario> {
  await comprobarAntibots(page, 'calendario');
  if ((await page.locator(SELECTORES.tituloCalendario).count()) !== 1) {
    detener('pantalla-inesperada', 'No se ve el calendario.');
  }
  try {
    return leerCalendario(await page.content());
  } catch (error) {
    if (error instanceof CalendarioError) detener('pantalla-inesperada', error.message);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Acciones permitidas: botones de flujo y formulario
// ---------------------------------------------------------------------------

/** Pantalla en la que se pulsa un botón y pantalla a la que lleva. */
export interface Transicion {
  en: Pantalla;
  hacia: Pantalla;
}

/** Pulsa un botón de flujo por su texto exacto, con comprobación antibots antes y después. */
export async function pulsarBotonFlujo(page: Pagina, texto: TextoBotonFlujo, transicion: Transicion): Promise<void> {
  const { rol, navega } = BOTONES_FLUJO[texto];
  await comprobarAntibots(page, transicion.en);
  const boton = page.getByRole(rol, { name: texto, exact: true });

  if (navega) {
    await clicConCarga(page, boton, texto);
  } else {
    await clic(boton, texto);
    try {
      await boton.waitFor({ state: 'hidden', timeout: TIEMPO_ESPERA_MS });
    } catch {
      detener('pantalla-inesperada', `"${texto}" sigue visible tras pulsarlo.`);
    }
  }

  await comprobarAntibots(page, transicion.hacia);
}

/**
 * Descarta, como máximo, UN aviso informativo de la pantalla pulsando su botón
 * "Entendido" (texto exacto, con clic()) y espera a que desaparezca.
 * - Sin "Entendido" pero con un diálogo visible: no se cierra (nunca con Aceptar,
 *   Cancelar ni Cambiar estación) y se detiene.
 * - Si tras descartarlo sigue habiendo un aviso u otro diálogo: se detiene sin pulsar más.
 * No lee el texto de la página (en "cita propuesta" no se lee la operación).
 */
export async function descartarAvisoInformativo(page: Pagina, pantalla: Pantalla): Promise<boolean> {
  const entendido = page.getByRole('button', { name: 'Entendido', exact: true });
  const dialogos = page.locator(SELECTORES.dialogo).filter({ visible: true });

  if ((await entendido.count()) === 0) {
    if ((await dialogos.count()) > 0) {
      detener('pantalla-inesperada', `Diálogo sin "Entendido" en la pantalla "${pantalla}"; no se cierra.`);
    }
    return false;
  }

  await clic(entendido, 'Entendido');
  try {
    await entendido.waitFor({ state: 'hidden', timeout: TIEMPO_DIALOGO_MS });
  } catch {
    detener('pantalla-inesperada', `Sigue habiendo un aviso en la pantalla "${pantalla}" tras pulsar "Entendido"; solo se descarta uno.`);
  }
  if ((await dialogos.count()) > 0) {
    detener('pantalla-inesperada', `Otro diálogo en la pantalla "${pantalla}" tras pulsar "Entendido"; solo se descarta uno.`);
  }
  return true;
}

/** Cierra el aviso inicial ("Entendido") si aparece. Devuelve si lo ha cerrado. */
export async function cerrarAvisoInicial(page: Pagina): Promise<boolean> {
  const boton = page.getByRole(BOTONES_FLUJO.Entendido.rol, { name: 'Entendido', exact: true });
  if ((await boton.count()) === 0) return false;
  await pulsarBotonFlujo(page, 'Entendido', { en: 'aviso inicial', hacia: 'matrícula y bastidor' });
  return true;
}

/** Rellena uno de los campos permitidos. El valor nunca se registra. */
export async function rellenarCampo(page: Pagina, campo: Campo, valor: string): Promise<void> {
  const { descripcion, localizar } = CAMPOS[campo];
  const localizador = localizar(page);
  await esperarVisible(localizador, descripcion);
  await localizador.fill(valor);
}

/** Elige en #tipoAcceso el valor grabado con codegen. */
export async function elegirTipoAcceso(page: Pagina): Promise<void> {
  const selector = page.locator(SELECTORES.tipoAcceso);
  await esperarVisible(selector, 'el selector de tipo de acceso');
  await selector.selectOption(TIPO_ACCESO);
}

/** Si ha quedado un desplegable abierto, lo cierra con Escape (nunca con un clic). */
export async function cerrarDesplegableSiAbierto(page: Pagina): Promise<boolean> {
  if ((await page.locator(SELECTORES.desplegableAbierto).count()) === 0) return false;
  await page.keyboard.press('Escape');
  return true;
}

/** Antes de "Modificar cita": el campo localizador no puede estar vacío. */
export async function comprobarLocalizadorRelleno(page: Pagina): Promise<void> {
  const valor = await CAMPOS.localizador.localizar(page).inputValue();
  if (valor.trim() === '') detener('datos-incompletos', 'El localizador está vacío.');
}

// ---------------------------------------------------------------------------
// Acciones permitidas: calendario
// ---------------------------------------------------------------------------

interface MesAnio {
  mes: number;
  anio: number;
}

const nombreMes = ({ mes, anio }: MesAnio): string => `${MESES[mes - 1] ?? `mes ${mes}`} ${anio}`;
const indiceMes = ({ mes, anio }: MesAnio): number => anio * 12 + (mes - 1);
const deIndice = (i: number): MesAnio => ({ anio: Math.floor(i / 12), mes: (i % 12) + 1 });
const aFecha = ({ mes, anio }: MesAnio, dia: number): string =>
  `${anio}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;

/** Pulsa la flecha de mes y comprueba que el título pasa a ser `esperado`. */
export async function cambiarMes(
  page: Pagina,
  direccion: 'anterior' | 'siguiente',
  esperado: MesAnio,
): Promise<EstadoCalendario> {
  const selector = direccion === 'anterior' ? SELECTORES.flechaMesAnterior : SELECTORES.flechaMesSiguiente;
  await clicConCarga(page, page.locator(selector), `flecha de mes ${direccion}`);

  const vista = await leerVistaCalendario(page);
  if (indiceMes(vista) !== indiceMes(esperado)) {
    detener('mes-inesperado', `Se esperaba ${nombreMes(esperado)} y se ve ${nombreMes(vista)}.`);
  }
  return vista;
}

/** Tras pulsar un día, #fechaSeleccionada debe mostrar ese día (dd/mm/aaaa); si no, se detiene. */
async function comprobarFechaSeleccionada(page: Pagina, mesVisible: MesAnio, dia: number): Promise<void> {
  const seleccion = page.locator(SELECTORES.fechaSeleccionada);
  const valor = (await seleccion.count()) === 1 ? await seleccion.getAttribute('value') : null;
  const partes = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(valor ?? '');
  if (
    partes === null ||
    Number(partes[1]) !== dia ||
    Number(partes[2]) !== mesVisible.mes ||
    Number(partes[3]) !== mesVisible.anio
  ) {
    detener('pantalla-inesperada', `Tras pulsar el día ${dia}, la fecha seleccionada no coincide.`);
  }
}

/**
 * Pulsa un día disponible del mes visible (td con special o special_sabado, sin
 * disabled, selected ni emptycell). Solo lo selecciona: no confirma nada.
 * Tras la recarga, comprueba #fechaSeleccionada ANTES de leer nada del calendario y
 * después devuelve la vista (días y horas de #horasCita), comprobando el mes.
 */
export async function pulsarDia(page: Pagina, mesVisible: MesAnio, dia: number): Promise<EstadoCalendario> {
  const celda = page.locator(SELECTORES.celdasDia).filter({ hasText: new RegExp(`^\\s*${dia}\\s*$`) });
  if ((await celda.count()) !== 1) {
    detener('pantalla-inesperada', `No hay una única celda para el día ${dia}.`);
  }

  const clases = new Set((await celda.getAttribute('class') ?? '').split(/\s+/));
  const disponible = clases.has('special') || clases.has('special_sabado');
  if (!disponible || clases.has('disabled') || clases.has('selected') || clases.has('emptycell')) {
    detener('pantalla-inesperada', `El día ${dia} no está disponible; no se pulsa.`);
  }

  await clicConCarga(page, celda, `día ${dia}`);
  await comprobarAntibots(page, 'calendario');
  await comprobarFechaSeleccionada(page, mesVisible, dia);

  const vista = await leerVistaCalendario(page);
  if (indiceMes(vista) !== indiceMes(mesVisible)) {
    detener('mes-inesperado', `Tras pulsar el día ${dia} se ve ${nombreMes(vista)}.`);
  }
  return vista;
}

// ---------------------------------------------------------------------------
// Flujo y recorrido del calendario
// ---------------------------------------------------------------------------

export interface OpcionesFlujo {
  /**
   * Modo exploración (EXPLORAR_HASTA):
   * - 'datos-cita': se detiene justo después de verificar "Estación elegida:", sin
   *   rellenar el localizador ni pulsar nada más.
   * - 'calendario': recorre el flujo completo y se detiene en la pantalla del
   *   calendario, sin pulsar ningún día, flecha ni "Aceptar".
   */
  explorarHasta?: PuntoExploracion;
}

/** Dónde ha terminado recorrerFlujo. */
export type FinFlujo = 'calendario' | PuntoExploracion;

export const MENSAJE_EXPLORACION_DATOS_CITA = 'Exploración detenida en datos-cita. Estación OK';
export const MENSAJE_EXPLORACION_CALENDARIO = 'Exploración detenida en calendario. Estación OK';

/**
 * Desde la página inicial ya abierta hasta la pantalla del calendario (flujo grabado con
 * codegen). Al llegar al calendario devuelve el control sin pulsar ningún día:
 * la lectura la hace el ciclo con leerHuecos() (pulsarDia + cambiarMes).
 * En modo exploración se detiene antes (ver OpcionesFlujo).
 */
export async function recorrerFlujo(
  page: Pagina,
  datos: DatosVehiculo,
  opciones: OpcionesFlujo = {},
): Promise<FinFlujo> {
  await cerrarAvisoInicial(page); // clic: Entendido
  await comprobarAntibots(page, 'matrícula y bastidor');
  await rellenarCampo(page, 'matricula', datos.matricula);
  await elegirTipoAcceso(page);
  await rellenarCampo(page, 'bastidor', datos.bastidor);
  await cerrarDesplegableSiAbierto(page); // tecla Escape, solo si hace falta
  // clic: SIGUIENTE (pantalla matrícula y bastidor)
  await pulsarBotonFlujo(page, 'SIGUIENTE', { en: 'matrícula y bastidor', hacia: 'tipo de inspección' });
  // clic: Siguiente (pantalla tipo de inspección)
  await pulsarBotonFlujo(page, 'Siguiente', { en: 'tipo de inspección', hacia: 'datos de la cita' });
  await verificarEstacionElegida(page); // pantalla de datos de la cita, antes del localizador
  if (opciones.explorarHasta === 'datos-cita') {
    log.info(MENSAJE_EXPLORACION_DATOS_CITA);
    return 'datos-cita';
  }
  await rellenarCampo(page, 'localizador', datos.localizador);
  await comprobarLocalizadorRelleno(page);
  // clic: Modificar cita (datos de la cita)
  await pulsarBotonFlujo(page, 'Modificar cita', { en: 'datos de la cita', hacia: 'intermedia tras Modificar cita' });
  // clic: Siguiente (pantalla intermedia tras Modificar cita)
  await pulsarBotonFlujo(page, 'Siguiente', { en: 'intermedia tras Modificar cita', hacia: 'cita propuesta' });
  // Cita propuesta: si un aviso con "Entendido" tapa el enlace, se descarta (uno como máximo).
  // clic: Entendido (solo si aparece)
  await descartarAvisoInformativo(page, 'cita propuesta');
  // clic: Cambiar fecha y hora (enlace). No se lee ni se resuelve la operación matemática y
  // no se escribe ni se selecciona nada.
  await pulsarBotonFlujo(page, 'Cambiar fecha y hora', { en: 'cita propuesta', hacia: 'calendario' });
  await esperarVisible(page.locator(SELECTORES.tituloCalendario), 'el calendario');
  if (opciones.explorarHasta === 'calendario') {
    // Se detiene aquí: no se pulsa ningún día, ni flecha de mes, ni "Aceptar".
    log.info(MENSAJE_EXPLORACION_CALENDARIO);
  }
  return 'calendario';
}

/** Un mes del calendario leído y cuántos días disponibles tenía dentro del rango. */
export interface MesLeido {
  anio: number;
  /** 1 (enero) a 12 (diciembre). */
  mes: number;
  /** Días disponibles en [hoy, FECHA_LIMITE) de ese mes (antes de aplicar el límite por ciclo). */
  disponibles: number;
}

export interface OpcionesLectura {
  /** Hoy, AAAA-MM-DD (incluido). Por defecto, hoy en España (hoyEnMadrid, como ciclo.ts). */
  hoy?: string;
  /** FECHA_LIMITE, AAAA-MM-DD (excluida). */
  fechaLimite: string;
  maxDiasPorCiclo?: number;
  /** Se llama una vez por cada mes leído, aunque no tenga días disponibles. */
  alLeerMes?: (mes: MesLeido) => void;
}

/**
 * Desde la pantalla del calendario, recorre los meses entre hoy y FECHA_LIMITE (excluida),
 * pulsa cada día disponible del rango con pulsarDia() y lee sus horas de #horasCita.
 * Devuelve [{ fecha, horas }] en orden de fecha; lista vacía si no hay ninguno.
 * Como máximo pulsa `maxDiasPorCiclo` días (los primeros por fecha) y registra un aviso.
 * Nunca cambia el valor del desplegable ni escribe en ningún campo.
 */
export async function leerHuecos(page: Pagina, opciones: OpcionesLectura): Promise<DiaConHoras[]> {
  const textoHoy = opciones.hoy ?? hoyEnMadrid();
  const hoy = parsearFechaLimite(textoHoy);
  const limite = parsearFechaLimite(opciones.fechaLimite);
  const maxDias = opciones.maxDiasPorCiclo ?? MAX_DIAS_POR_CICLO;
  const primerMes = indiceMes(hoy);
  const ultimoMes = indiceMes(limite) - (limite.dia === 1 ? 1 : 0);
  const resultado: DiaConHoras[] = [];

  let vista = await leerVistaCalendario(page);
  if (primerMes > ultimoMes) return resultado;

  while (indiceMes(vista) > primerMes) {
    vista = await cambiarMes(page, 'anterior', deIndice(indiceMes(vista) - 1));
  }
  while (indiceMes(vista) < primerMes) {
    vista = await cambiarMes(page, 'siguiente', deIndice(indiceMes(vista) + 1));
  }

  let diasPulsados = 0;
  for (;;) {
    const mes: MesAnio = { mes: vista.mes, anio: vista.anio };
    const dias = huecosAntesDe(vista, opciones.fechaLimite).filter((d) => aFecha(mes, d) >= textoHoy);
    opciones.alLeerMes?.({ ...mes, disponibles: dias.length });

    for (const dia of dias) {
      if (diasPulsados >= maxDias) {
        log.aviso(`Hay más días disponibles que el límite de ${maxDias} por ciclo; solo se han leído los ${maxDias} primeros.`);
        return resultado;
      }
      diasPulsados++;
      vista = await pulsarDia(page, mes, dia);
      resultado.push({ fecha: aFecha(mes, dia), horas: [...vista.horas] });
    }

    if (indiceMes(vista) >= ultimoMes) return resultado;
    vista = await cambiarMes(page, 'siguiente', deIndice(indiceMes(vista) + 1));
  }
}
