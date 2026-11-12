// Pruebas de la capa de seguridad y del flujo de navegador.ts con un page falso (sin web real).
// Los datos del vehículo son SIEMPRE valores de prueba; los tests no cargan el .env.

import { readFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { load } from 'cheerio';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatosVehiculo } from '../src/config.js';
import {
  BOTONES_FLUJO,
  clic,
  DetencionError,
  leerHuecos,
  MENSAJE_EXPLORACION_CALENDARIO,
  MENSAJE_EXPLORACION_DATOS_CITA,
  SELECTORES,
  pulsarBotonFlujo,
  pulsarDia,
  recorrerFlujo,
  type MotivoDetencion,
} from '../src/navegador.js';
import { cicloLectura, type NavegadorCiclo } from '../src/lectura.js';
import { PaginaFalsa, tipoDeClic } from './helpers/paginaFalsa.js';

const leer = (ruta: string): string => readFileSync(fileURLToPath(new URL(ruta, import.meta.url)), 'utf8');
const fixture = leer('./fixtures/calendario-diciembre.html');

/** Valores de prueba: nunca los reales. */
const DATOS_PRUEBA: DatosVehiculo = {
  matricula: '0000-PRUEBA',
  bastidor: 'BASTIDOR-DE-PRUEBA',
  localizador: 'LOCALIZADOR-PRUEBA',
};

interface OpcionesPantalla {
  titulo?: string;
  disponibles?: number[];
  seleccionado?: number;
  fechaSeleccionada?: string;
  horas?: string[];
  extra?: string;
}

const VOLVER_CALENDARIO = '<input type="button" name="Volver" value="Volver" onclick="volver();" class="boton izq">';

/** Pantalla de calendario a partir del fixture, modificada en memoria. */
function pantallaCalendario(o: OpcionesPantalla = {}): string {
  const $ = load(fixture);
  if (o.titulo !== undefined) $('td.title').text(o.titulo);
  if (o.disponibles !== undefined) {
    $('tbody td.day').each((_, el) => {
      const dia = Number($(el).text().trim());
      let clases = 'day disabled';
      if (o.disponibles?.includes(dia)) clases = 'day special';
      if (o.seleccionado === dia) clases = 'day special_sabado selected';
      $(el).attr('class', clases);
    });
  }
  if (o.fechaSeleccionada !== undefined) $('#fechaSeleccionada').attr('value', o.fechaSeleccionada);
  if (o.horas !== undefined) {
    $('#horasCita option:not([value="-1"])').remove();
    for (const hora of o.horas) $('#horasCita').append(`<option value="${hora}:00">${hora}</option>`);
  }
  // Etiqueta real del botón en la pantalla del calendario (está en la web; nunca se pulsa).
  $('body').append(VOLVER_CALENDARIO);
  if (o.extra !== undefined) $('body').append(o.extra);
  return $.html();
}

interface OpcionesFlujo {
  /** Valor de "Estación elegida:" en la pantalla de datos de la cita; null = sin la etiqueta. */
  estacion?: string | null;
  /** La etiqueta "Estación elegida:" aparece dos veces. */
  estacionDuplicada?: boolean;
  /** El campo bastidor queda con un desplegable abierto (aria-expanded="true"). */
  bastidorAbierto?: boolean;
  /** Sin el campo #bastidor. */
  sinBastidor?: boolean;
  /** Dos botones "SIGUIENTE" visibles a la vez en la primera pantalla. */
  dosSiguientes?: boolean;
  /** Texto del botón de la primera pantalla (por defecto, el de la web real: "SIGUIENTE"). */
  textoPrimerSiguiente?: string;
  /** Pantalla del calendario (por defecto, el fixture de diciembre). */
  calendario?: string;
  /** La pantalla de cita propuesta muestra una operación matemática (como la web real). */
  operacionCitaPropuesta?: boolean;
}

/** Operación matemática con su campo de respuesta (el campo se llama "captcha", como suele ser). */
const OPERACION_CON_CAMPO = '<p>9 + 2 =</p><input type="text" id="captcha" name="captcha" />';

/** Pantalla "cita propuesta": operación (opcional), desplegable de hora, botones y enlaces. */
function pantallaCitaPropuesta(o: OpcionesFlujo): string {
  return `<p>Cita propuesta</p>
    <select id="horaPropuesta"><option value="12:14">12:14</option><option value="12:18">12:18</option></select>
    ${o.operacionCitaPropuesta === true ? OPERACION_CON_CAMPO : ''}
    <input type="button" value="Aceptar" /><input type="button" value="Cancelar" />
    <a href="#">Cambiar estación</a><a href="#">Cambiar tipo de inspección</a>
    <a href="#">Cambiar fecha y hora</a>`;
}

/** Botón de la primera pantalla, tal como está en el HTML real de la web. */
function botonPrimerSiguiente(o: OpcionesFlujo): string {
  return `<input type="button" value="${o.textoPrimerSiguiente ?? 'SIGUIENTE'}" onclick="siguiente();" />`;
}

/** Tabla de la pantalla de datos de la cita (con "Estación elegida:"). */
function tablaDatosCita(o: OpcionesFlujo): string {
  const estacion = o.estacion === undefined ? 'ITV ESTEPONA' : o.estacion;
  const fila = estacion === null ? '' : `<tr><td>Estación elegida:</td><td>${estacion}</td></tr>`;
  return `<table>
    <tr><td>Tipo de inspección:</td><td>Periódica</td></tr>
    ${fila}${o.estacionDuplicada === true ? fila : ''}
    <tr><td>Fecha:</td><td>10/12/2026</td></tr>
  </table>`;
}

const TRAMPAS = '<button>Confirmar anulación</button><button>Confirmar</button><input type="button" value="Aceptar" />';

/** Pantallas y transiciones del flujo grabado con codegen, hasta el calendario. */
function pantallasFlujo(o: OpcionesFlujo = {}) {
  const formulario = `
    <label for="matricula">Matrícula:</label><input type="text" id="matricula" />
    <select id="tipoAcceso"><option value="1">Opción 1</option><option value="2">Opción 2</option></select>
    ${o.sinBastidor === true ? '' : `<input type="text" id="bastidor" ${o.bastidorAbierto === true ? 'aria-expanded="true"' : ''} />`}
    ${botonPrimerSiguiente(o)}${o.dosSiguientes === true ? botonPrimerSiguiente(o) : ''}
    ${TRAMPAS}`;

  const pantallas: Record<string, string> = {
    inicio: `<div id="aviso"><p>Aviso</p><button>Entendido</button></div>${formulario}`,
    datos: formulario,
    paso2: `<p>Tipo de inspección</p><input type="submit" value="Siguiente" />${TRAMPAS}`,
    localizador: `${tablaDatosCita(o)}
      <label for="localizador">Localizador:</label><input type="text" id="localizador" />
      <input type="button" value="Modificar cita" /><input type="button" value="Volver" />${TRAMPAS}`,
    resumen: `<p>Pantalla intermedia</p><input type="submit" value="Siguiente" />${TRAMPAS}`,
    opciones: pantallaCitaPropuesta(o),
    dic: o.calendario ?? pantallaCalendario(),
  };
  const transiciones: Record<string, string> = {
    'inicio|Entendido': 'datos',
    'datos|SIGUIENTE': 'paso2',
    'paso2|Siguiente': 'localizador',
    'localizador|Modificar cita': 'resumen',
    'resumen|Siguiente': 'opciones',
    'opciones|Cambiar fecha y hora': 'dic',
  };
  return { pantallas, transiciones };
}

function paginaFlujo(o: OpcionesFlujo = {}, extra: { pantallas?: Record<string, string>; transiciones?: Record<string, string> } = {}) {
  const { pantallas, transiciones } = pantallasFlujo(o);
  return new PaginaFalsa('inicio', { ...pantallas, ...extra.pantallas }, { ...transiciones, ...extra.transiciones });
}

const ORDEN_FLUJO = ['Entendido', 'SIGUIENTE', 'Siguiente', 'Modificar cita', 'Siguiente', 'Cambiar fecha y hora'];
const opciones = { hoy: '2026-11-12', fechaLimite: '2026-12-12' };
const BOTONES = Object.keys(BOTONES_FLUJO);
const PROHIBIDOS = /aceptar|confirmar|enviar|cancelar|cambiar estaci[oó]n|volver/i;

async function esperarDetencion(promesa: Promise<unknown>, motivo: MotivoDetencion): Promise<DetencionError> {
  const error = await promesa.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(DetencionError);
  const detencion = error as DetencionError;
  expect(detencion.motivo).toBe(motivo);
  return detencion;
}

let consolaError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  consolaError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('clic()', () => {
  const botones = `
    <input type="button" value="Aceptar" />
    <button>Confirmar</button>
    <button>Confirmar anulación</button>
    <button aria-label="Enviar">→</button>
    <button title="Confirmar">OK</button>
    <input type="button" value="Cancelar" />
    <a href="#" role="button">Cambiar estación</a>
    <input type="button" name="Volver" value="Volver" onclick="volver();" />
    <button>Siguiente</button>`;

  it.each(['Aceptar', 'Confirmar', 'Confirmar anulación', 'Enviar', 'OK', 'Cancelar', 'Cambiar estación', 'Volver'])(
    'lanza error y no pulsa "%s"',
    async (nombre) => {
      const page = new PaginaFalsa('botones', { botones });
      await esperarDetencion(clic(page.getByRole('button', { name: nombre, exact: true }), 'botón de prueba'), 'clic-prohibido');
      expect(page.clics).toEqual([]);
    },
  );

  it('lanza error si el propio nombre del clic es prohibido', async () => {
    const page = new PaginaFalsa('botones', { botones });
    await esperarDetencion(clic(page.getByRole('button', { name: 'Siguiente', exact: true }), 'Aceptar'), 'clic-prohibido');
    expect(page.clics).toEqual([]);
  });

  it('pulsa un botón permitido', async () => {
    const page = new PaginaFalsa('botones', { botones }, { 'botones|Siguiente': 'botones' });
    await clic(page.getByRole('button', { name: 'Siguiente', exact: true }), 'Siguiente');
    expect(page.clics.map((c) => c.clave)).toEqual(['Siguiente']);
  });

  it('si el botón de flujo no está, es una pantalla inesperada', async () => {
    const page = new PaginaFalsa('vacia', { vacia: '<p>Otra cosa</p>' });
    await esperarDetencion(
      pulsarBotonFlujo(page, 'Siguiente', { en: 'tipo de inspección', hacia: 'datos de la cita' }),
      'pantalla-inesperada',
    );
    expect(page.clics).toEqual([]);
  });
});

describe('recorrerFlujo (flujo grabado con codegen)', () => {
  it('pulsa en orden Entendido → Siguiente → Siguiente → Modificar cita → Siguiente → Cambiar fecha y hora', async () => {
    const page = paginaFlujo();
    await recorrerFlujo(page, DATOS_PRUEBA);

    expect(page.clics.map((c) => c.clave)).toEqual(ORDEN_FLUJO);
    expect(page.clics.map((c) => c.pantalla)).toEqual(['inicio', 'datos', 'paso2', 'localizador', 'resumen', 'opciones']);
    expect(page.pantalla).toBe('dic');
  });

  it('no pulsa Aceptar, Confirmar ni Confirmar anulación (presentes en todas las pantallas)', async () => {
    const page = paginaFlujo();
    await recorrerFlujo(page, DATOS_PRUEBA);
    for (const c of page.clics) {
      expect(c.texto).not.toMatch(PROHIBIDOS);
      expect(tipoDeClic(c, BOTONES), c.clave).toBe('boton-flujo');
    }
  });

  it('al llegar al calendario devuelve el control sin pulsar ningún día', async () => {
    const page = paginaFlujo();
    await recorrerFlujo(page, DATOS_PRUEBA);
    expect(page.clics.filter((c) => c.enCuerpoCalendario || c.enCabeceraCalendario)).toEqual([]);
    expect(page.lecturas.filter((l) => l.metodo === 'content')).toEqual([]);
  });

  it('rellena solo matrícula, tipo de acceso, bastidor y localizador, con los valores de prueba', async () => {
    const page = paginaFlujo();
    await recorrerFlujo(page, DATOS_PRUEBA);
    expect(page.escrituras).toEqual([
      { pantalla: 'datos', metodo: 'fill', id: 'matricula', valor: DATOS_PRUEBA.matricula },
      { pantalla: 'datos', metodo: 'selectOption', id: 'tipoAcceso', valor: '2' },
      { pantalla: 'datos', metodo: 'fill', id: 'bastidor', valor: DATOS_PRUEBA.bastidor },
      { pantalla: 'localizador', metodo: 'fill', id: 'localizador', valor: DATOS_PRUEBA.localizador },
    ]);
    expect(page.teclas).toEqual([]);
  });

  it('si el desplegable de bastidor queda abierto, pulsa Escape (sin clics extra)', async () => {
    const page = paginaFlujo({ bastidorAbierto: true });
    await recorrerFlujo(page, DATOS_PRUEBA);
    expect(page.teclas).toEqual(['Escape']);
    expect(page.clics.map((c) => c.clave)).toEqual(ORDEN_FLUJO);
  });

  it('con "Estación elegida: ITV ESTEPONA" sigue, sin necesitar "Estación:" en otras pantallas', async () => {
    const page = paginaFlujo();
    await recorrerFlujo(page, DATOS_PRUEBA);
    expect(page.pantalla).toBe('dic');
    for (const pantalla of ['inicio', 'datos', 'paso2', 'resumen', 'opciones', 'dic']) {
      expect(pantallasFlujo().pantallas[pantalla], pantalla).not.toContain('Estación');
    }
  });

  it.each([
    ['otra estación', { estacion: 'ITV MARBELLA' }, /no es "ITV ESTEPONA"/],
    ['estación vacía', { estacion: '' }, /vacía/],
    ['estación casi igual', { estacion: 'ITV ESTEPONA 2' }, /no es "ITV ESTEPONA"/],
    ['sin la etiqueta', { estacion: null }, /No aparece "Estación elegida:"/],
    ['etiqueta duplicada', { estacionDuplicada: true }, /aparece 2 veces/],
  ] as const)('%s: se detiene antes de rellenar el localizador', async (_, o, mensaje) => {
    const page = paginaFlujo(o);
    const error = await esperarDetencion(recorrerFlujo(page, DATOS_PRUEBA), 'estacion');

    expect(error.message).toMatch(mensaje);
    expect(error.message).not.toContain('MARBELLA');
    expect(page.pantalla).toBe('localizador');
    expect(page.escrituras.map((e) => e.id)).toEqual(['matricula', 'tipoAcceso', 'bastidor']);
    expect(page.clics.map((c) => c.clave)).toEqual(['Entendido', 'SIGUIENTE', 'Siguiente']);
  });

  it('si falta un campo grabado (#bastidor), se detiene sin inventar otro selector', async () => {
    const page = paginaFlujo({ sinBastidor: true });
    const error = await esperarDetencion(recorrerFlujo(page, DATOS_PRUEBA), 'pantalla-inesperada');
    expect(error.message).toMatch(/bastidor/);
    expect(page.clics.map((c) => c.clave)).toEqual(['Entendido']);
  });

  it('si hay dos "Siguiente" visibles a la vez, clic() se detiene', async () => {
    const page = paginaFlujo({ dosSiguientes: true });
    await esperarDetencion(recorrerFlujo(page, DATOS_PRUEBA), 'pantalla-inesperada');
    expect(page.clics.map((c) => c.clave)).toEqual(['Entendido']);
  });

  it('con el localizador vacío no pulsa "Modificar cita"', async () => {
    const page = paginaFlujo();
    await esperarDetencion(recorrerFlujo(page, { ...DATOS_PRUEBA, localizador: '' }), 'datos-incompletos');
    expect(page.clics.map((c) => c.clave)).toEqual(['Entendido', 'SIGUIENTE', 'Siguiente']);
  });

  it('con una operación matemática en el formulario se detiene', async () => {
    const page = paginaFlujo(
      {},
      { pantallas: { datos: '<p>Resuelva: 7 + 2 =</p>' } },
    );
    await esperarDetencion(recorrerFlujo(page, DATOS_PRUEBA), 'antibots');
    expect(page.escrituras).toEqual([]);
  });

  it('ningún error ni log contiene los datos del vehículo', async () => {
    for (const o of [{ estacion: 'OTRA' }, { sinBastidor: true }, { dosSiguientes: true }]) {
      const page = paginaFlujo(o);
      const error = await esperarDetencion(recorrerFlujo(page, DATOS_PRUEBA), o.estacion ? 'estacion' : 'pantalla-inesperada');
      const salida = [error.message, ...consolaError.mock.calls.flat().map(String)].join('\n');
      for (const valor of Object.values(DATOS_PRUEBA)) expect(salida).not.toContain(valor);
    }
  });
});

describe('texto exacto de los botones por pantalla (HTML real)', () => {
  it('cada botón se busca con el texto y el rol de su pantalla', async () => {
    const page = paginaFlujo();
    await recorrerFlujo(page, DATOS_PRUEBA);

    expect(page.clics.map((c) => [c.pantalla, c.etiqueta, c.texto])).toEqual([
      ['inicio', 'button', 'Entendido'],
      ['datos', 'input', 'SIGUIENTE'], // <input type="button" value="SIGUIENTE">
      ['paso2', 'input', 'Siguiente'], // <input type="submit" value="Siguiente">
      ['localizador', 'input', 'Modificar cita'], // <input type="button" value="Modificar cita">
      ['resumen', 'input', 'Siguiente'], // <input type="submit" value="Siguiente">
      ['opciones', 'a', 'Cambiar fecha y hora'], // <a href="#">Cambiar fecha y hora</a>
    ]);
    const busquedas = new Set(page.lecturas.map((l) => l.objetivo));
    for (const b of [
      'role=button[name="SIGUIENTE"]',
      'role=button[name="Siguiente"]',
      'role=button[name="Modificar cita"]',
      'role=link[name="Cambiar fecha y hora"]',
    ]) {
      expect(busquedas).toContain(b);
    }
  });

  it('en datos de la cita no pulsa "Confirmar anulación" ni "Volver" (ambos presentes)', async () => {
    const page = paginaFlujo();
    await recorrerFlujo(page, DATOS_PRUEBA);
    const enDatosCita = page.clics.filter((c) => c.pantalla === 'localizador').map((c) => c.texto);
    expect(enDatosCita).toEqual(['Modificar cita']);
    expect(page.clics.map((c) => c.texto)).not.toContain('Volver');
    expect(page.clics.map((c) => c.texto)).not.toContain('Confirmar anulación');
  });

  it.each(['Siguiente', 'siguiente', 'SIGUIENTe'])(
    'con "%s" en la pantalla de matrícula la búsqueda exacta falla y se detiene (pantalla-inesperada)',
    async (texto) => {
      const page = paginaFlujo({ textoPrimerSiguiente: texto });
      const error = await esperarDetencion(recorrerFlujo(page, DATOS_PRUEBA), 'pantalla-inesperada');

      expect(error.message).toBe('"SIGUIENTE": se esperaba 1 elemento y hay 0.');
      expect(page.clics.map((c) => c.clave)).toEqual(['Entendido']);
      expect(page.pantalla).toBe('datos');

      const errores = consolaError.mock.calls.flat().map(String);
      expect(errores).toHaveLength(1);
      expect(errores[0]).toMatch(/ERROR Detenido \(pantalla-inesperada\): "SIGUIENTE": se esperaba 1 elemento y hay 0\.$/);
      for (const valor of Object.values(DATOS_PRUEBA)) expect(errores[0]).not.toContain(valor);
    },
  );

  it('con "SIGUIENTE" en la pantalla de tipo de inspección (no es su texto) también se detiene', async () => {
    const page = paginaFlujo(
      {},
      { pantallas: { paso2: `<p>Tipo de inspección</p><input type="submit" value="SIGUIENTE" />${TRAMPAS}` } },
    );
    const error = await esperarDetencion(recorrerFlujo(page, DATOS_PRUEBA), 'pantalla-inesperada');
    expect(error.message).toBe('"Siguiente": se esperaba 1 elemento y hay 0.');
    expect(page.clics.map((c) => c.clave)).toEqual(['Entendido', 'SIGUIENTE']);
  });

  it('no quedan botones pendientes de HTML real', () => {
    const codigo = readFileSync(fileURLToPath(new URL('../src/navegador.ts', import.meta.url)), 'utf8');
    expect(codigo).not.toMatch(/TODO|pendiente de HTML real/);
  });
});

describe('calendario sin comprobación previa de estación', () => {
  it('leerHuecos no busca "Estación:" en el calendario', async () => {
    const page = new PaginaFalsa('dic', { dic: pantallaCalendario() }, { 'dic|flecha:anterior': 'dic' });
    expect(page.$.html()).not.toContain('Estación');
    // Llega a pulsar la flecha (y se detiene después por el mes): no se ha parado por la estación.
    await esperarDetencion(leerHuecos(page, opciones), 'mes-inesperado');
    expect(page.clics.map((c) => c.clave)).toEqual(['flecha:anterior']);
  });
});

describe('controles antibots', () => {
  it.each([
    ['operación matemática', '<p>Para continuar: 3 + 4 =</p>'],
    ['captcha', '<div class="g-recaptcha"></div>'],
    ['texto captcha', '<p>Introduzca el CAPTCHA</p>'],
  ])('%s: se detiene sin pulsar nada', async (_, extra) => {
    const page = new PaginaFalsa('dic', { dic: pantallaCalendario({ extra }) });
    await esperarDetencion(leerHuecos(page, opciones), 'antibots');
    expect(page.clics).toEqual([]);
  });
});

describe('días y meses', () => {
  it('no pulsa un día disabled', async () => {
    const page = new PaginaFalsa('dic', { dic: pantallaCalendario() });
    await esperarDetencion(pulsarDia(page, { mes: 12, anio: 2026 }, 13), 'pantalla-inesperada');
    expect(page.clics).toEqual([]);
  });

  it('un clic de mes con título inesperado detiene el flujo', async () => {
    const page = new PaginaFalsa(
      'dic',
      {
        dic: pantallaCalendario(),
        oct: pantallaCalendario({ titulo: 'Octubre, 2026', disponibles: [20] }),
      },
      { 'dic|flecha:anterior': 'oct' },
    );
    const error = await esperarDetencion(leerHuecos(page, opciones), 'mes-inesperado');
    expect(error.message).toMatch(/noviembre 2026.*octubre 2026/);
    expect(page.clics.map((c) => c.clave)).toEqual(['flecha:anterior']);
  });
});

describe('ciclo completo (cicloLectura): navegador nuevo → flujo → lectura → cerrar', () => {
  const PANTALLAS_LECTURA = {
    nov: pantallaCalendario({ titulo: 'Noviembre, 2026', disponibles: [10, 20], horas: [] }),
    nov20: pantallaCalendario({
      titulo: 'Noviembre, 2026',
      disponibles: [10],
      seleccionado: 20,
      fechaSeleccionada: 'viernes, 20/11/2026',
      horas: ['09:15', '09:00'],
    }),
    dic11: pantallaCalendario({
      disponibles: [12],
      seleccionado: 11,
      fechaSeleccionada: 'viernes, 11/12/2026',
      horas: ['12:14', '12:18'],
    }),
  };
  const TRANSICIONES_LECTURA = {
    'dic|flecha:anterior': 'nov',
    'nov|dia:20': 'nov20',
    'nov20|flecha:siguiente': 'dic',
    'dic|dia:11': 'dic11',
  };

  interface Registro {
    paginas: PaginaFalsa[];
    urls: string[];
    /** Orden de los sucesos: clics y cierre del navegador. */
    sucesos: string[];
  }

  /** Cada llamada abre un navegador falso NUEVO que empieza en "inicio" (sin estado previo). */
  function abridorFalso(
    o: OpcionesFlujo = {},
    pantallasExtra: Record<string, string> = {},
    transicionesExtra: Record<string, string> = {},
  ) {
    const registro: Registro = { paginas: [], urls: [], sucesos: [] };
    const abrir = async (): Promise<NavegadorCiclo> => {
      const { pantallas, transiciones } = pantallasFlujo(o);
      const page = new PaginaFalsa(
        'en-blanco',
        { 'en-blanco': '', ...pantallas, ...PANTALLAS_LECTURA, ...pantallasExtra },
        { ...transiciones, ...TRANSICIONES_LECTURA, ...transicionesExtra },
      );
      const clicOriginal = page.registrarClic.bind(page);
      page.registrarClic = (sel) => {
        registro.sucesos.push(`clic ${page.pantalla}`);
        clicOriginal(sel);
      };
      registro.paginas.push(page);
      return {
        pagina: page,
        irA: async (url) => {
          registro.urls.push(url);
          page.irA('inicio');
        },
        cerrar: async () => {
          registro.sucesos.push('cerrar');
        },
      };
    };
    return { abrir, registro };
  }

  it('lee los días del rango y devuelve "lectura-completa"', async () => {
    const { abrir, registro } = abridorFalso();
    const resultado = await cicloLectura(abrir, DATOS_PRUEBA, opciones);

    expect(resultado).toEqual({
      estado: 'lectura-completa',
      dias: [
        { fecha: '2026-11-20', horas: ['09:15', '09:00'] },
        { fecha: '2026-12-11', horas: ['12:14', '12:18'] },
      ],
      // Noviembre: el 10 es anterior a hoy (12), solo cuenta el 20. Diciembre: 11 (el 12 queda fuera).
      meses: [
        { anio: 2026, mes: 11, disponibles: 1 },
        { anio: 2026, mes: 12, disponibles: 1 },
      ],
    });
    const page = registro.paginas[0];
    expect(page?.clics.map((c) => c.clave)).toEqual([...ORDEN_FLUJO, 'flecha:anterior', 'dia:20', 'flecha:siguiente', 'dia:11']);
    for (const c of page?.clics ?? []) {
      expect(tipoDeClic(c, BOTONES), c.clave).not.toBe('otro');
      expect(c.texto).not.toMatch(PROHIBIDOS);
    }
  });

  it('no hace ningún clic después de la lectura del calendario: lo siguiente es cerrar el navegador', async () => {
    const { abrir, registro } = abridorFalso();
    await cicloLectura(abrir, DATOS_PRUEBA, opciones);

    const page = registro.paginas[0];
    // El último clic es el del último día leído; después solo se cierra el navegador.
    expect(page?.clics.at(-1)?.clave).toBe('dia:11');
    expect(registro.sucesos.at(-1)).toBe('cerrar');
    expect(registro.sucesos.filter((x) => x === 'cerrar')).toHaveLength(1);
    expect(registro.sucesos.slice(registro.sucesos.lastIndexOf('clic dic') + 1)).toEqual(['cerrar']);
    expect(page?.clics.map((c) => c.texto)).not.toContain('Volver');
    expect(page?.pantalla).toBe('dic11'); // sigue en el calendario: no se ha navegado a otra parte
  });

  it('cada ciclo abre un navegador nuevo y empieza desde https://www.itvcita.com/', async () => {
    const { abrir, registro } = abridorFalso();
    await cicloLectura(abrir, DATOS_PRUEBA, opciones);
    await cicloLectura(abrir, DATOS_PRUEBA, opciones);

    expect(registro.paginas).toHaveLength(2);
    expect(registro.paginas[0]).not.toBe(registro.paginas[1]);
    expect(registro.urls).toEqual(['https://www.itvcita.com/', 'https://www.itvcita.com/']);
    // El segundo ciclo repite el flujo entero desde el principio (Entendido incluido).
    expect(registro.paginas[1]?.clics[0]?.clave).toBe('Entendido');
    expect(registro.sucesos.filter((x) => x === 'cerrar')).toHaveLength(2);
  });

  it('sin días en el rango: "lectura-completa" con lista vacía', async () => {
    const { abrir } = abridorFalso();
    const resultado = await cicloLectura(abrir, DATOS_PRUEBA, { hoy: '2026-11-12', fechaLimite: '2026-11-13' });
    expect(resultado).toEqual({ estado: 'lectura-completa', dias: [], meses: [{ anio: 2026, mes: 11, disponibles: 0 }] });
  });

  it.each([
    ['matrícula y bastidor', 'datos'],
    ['datos de la cita', 'localizador'],
    ['calendario', 'dic'],
  ] as const)('operación matemática en "%s": "detenido" (antibots) y se cierra el navegador', async (nombre, pantalla) => {
    const todas: Record<string, string> = { ...pantallasFlujo().pantallas, ...PANTALLAS_LECTURA };
    const html = todas[pantalla] ?? '';
    const { abrir, registro } = abridorFalso({}, { [pantalla]: `${html}<p>9 + 2 =</p>` });
    const resultado = await cicloLectura(abrir, DATOS_PRUEBA, opciones);

    expect(resultado).toEqual({ estado: 'detenido', motivo: 'antibots' });
    expect(consolaError.mock.calls.flat().map(String)).toEqual([
      expect.stringMatching(new RegExp(`Operación matemática en la pantalla "${nombre}"\\.$`)),
    ]);
    expect(registro.sucesos.at(-1)).toBe('cerrar');
  });

  it('captcha en el flujo: "detenido" (antibots)', async () => {
    const html = pantallasFlujo().pantallas.paso2 ?? '';
    const { abrir } = abridorFalso({}, { paso2: `${html}<div class="g-recaptcha"></div>` });
    expect(await cicloLectura(abrir, DATOS_PRUEBA, opciones)).toEqual({ estado: 'detenido', motivo: 'antibots' });
  });

  it('la operación de "cita propuesta" sigue siendo la única excepción: se llega al calendario', async () => {
    const { abrir } = abridorFalso({ operacionCitaPropuesta: true });
    const resultado = await cicloLectura(abrir, DATOS_PRUEBA, opciones);
    expect(resultado.estado).toBe('lectura-completa');
  });

  it('un error inesperado también termina en "detenido", se registra sin datos y se cierra el navegador', async () => {
    const { abrir: abrirBase, registro } = abridorFalso();
    const abrir = async (): Promise<NavegadorCiclo> => {
      const nav = await abrirBase();
      return {
        ...nav,
        irA: async () => {
          throw new Error(`net::ERR_FALLO con ${DATOS_PRUEBA.matricula}\n<html>...</html>`);
        },
      };
    };
    const resultado = await cicloLectura(abrir, DATOS_PRUEBA, opciones);

    expect(resultado).toEqual({ estado: 'detenido', motivo: 'error-inesperado' });
    const errores = consolaError.mock.calls.flat().map(String);
    expect(errores).toHaveLength(1);
    expect(errores[0]).toMatch(/Ciclo interrumpido: net::ERR_FALLO con \*\*\*$/);
    expect(registro.sucesos).toEqual(['cerrar']);
  });

  it('enlace no pulsable tras descartar el aviso: "detenido" en una sola línea y el navegador cerrado', async () => {
    const citaPropuesta = pantallaCitaPropuesta({ operacionCitaPropuesta: true });
    const { abrir, registro } = abridorFalso(
      { operacionCitaPropuesta: true },
      {
        opciones: `<div role="dialog" data-tapa><input type="button" value="Entendido" /></div>${citaPropuesta}`,
        // Tras "Entendido" queda una capa (sin diálogo ni botón) que sigue tapando el enlace.
        opciones2: `<div class="cargando" data-tapa></div>${citaPropuesta}`,
      },
      { 'opciones|Entendido': 'opciones2' },
    );
    const resultado = await cicloLectura(abrir, DATOS_PRUEBA, opciones);

    expect(resultado).toEqual({ estado: 'detenido', motivo: 'pantalla-inesperada' });
    const errores = consolaError.mock.calls.flat().map(String);
    expect(errores).toHaveLength(1);
    expect(errores[0]).toMatch(/Detenido \(pantalla-inesperada\): "Cambiar fecha y hora" no se puede pulsar \(tapado o no disponible\)\.$/);
    expect(registro.sucesos.at(-1)).toBe('cerrar');
    expect(registro.sucesos.filter((x) => x === 'cerrar')).toHaveLength(1);
    expect(registro.paginas[0]?.clics.map((c) => c.texto)).not.toContain('Cambiar fecha y hora');
  });

  it('el navegador se cierra en el finally aunque el clic falle con un error de Playwright', async () => {
    const { abrir: abrirBase, registro } = abridorFalso();
    const abrir = async (): Promise<NavegadorCiclo> => {
      const nav = await abrirBase();
      const page = nav.pagina as PaginaFalsa;
      page.registrarClic = () => {
        registro.sucesos.push('clic que falla');
        throw new Error('Target page, context or browser has been closed');
      };
      return nav;
    };
    const resultado = await cicloLectura(abrir, DATOS_PRUEBA, opciones);

    expect(resultado.estado).toBe('detenido');
    expect(registro.sucesos).toEqual(['clic que falla', 'cerrar']);
  });

  it('nunca modifica #horasCita', async () => {
    const { abrir, registro } = abridorFalso();
    await cicloLectura(abrir, DATOS_PRUEBA, opciones);
    const page = registro.paginas[0];
    expect(page?.escrituras.map((e) => e.id)).toEqual(['matricula', 'tipoAcceso', 'bastidor', 'localizador']);
  });
});

describe('modo exploración (EXPLORAR_HASTA=datos-cita)', () => {
  const salidaConsola = (): string =>
    [console.log, console.warn, console.error]
      .flatMap((f) => vi.mocked(f).mock.calls.flat())
      .map(String)
      .join('\n');

  it('se detiene justo tras verificar la estación: nada se escribe ni se pulsa después', async () => {
    const page = paginaFlujo();
    const fin = await recorrerFlujo(page, DATOS_PRUEBA, { explorarHasta: 'datos-cita' });

    expect(fin).toBe('datos-cita');
    expect(page.pantalla).toBe('localizador');
    // Escrituras: solo las de la pantalla anterior a la verificación; ninguna en datos de la cita.
    expect(page.escrituras.map((e) => e.id)).toEqual(['matricula', 'tipoAcceso', 'bastidor']);
    expect(page.escrituras.filter((e) => e.pantalla === 'localizador')).toEqual([]);
    expect(page.clics.map((c) => c.clave)).toEqual(['Entendido', 'SIGUIENTE', 'Siguiente']);
    expect(page.teclas).toEqual([]);
  });

  it('solo registra "Exploración detenida en datos-cita. Estación OK"', async () => {
    const page = paginaFlujo();
    await recorrerFlujo(page, DATOS_PRUEBA, { explorarHasta: 'datos-cita' });

    const lineas = salidaConsola().split('\n').filter(Boolean);
    expect(lineas).toHaveLength(1);
    expect(lineas[0]).toMatch(new RegExp(`^\\[[^\\]]+\\] INFO ${MENSAJE_EXPLORACION_DATOS_CITA}$`));
    expect(MENSAJE_EXPLORACION_DATOS_CITA).toBe('Exploración detenida en datos-cita. Estación OK');
  });

  it('con otra estación registra solo el error de estación, sin datos ni HTML', async () => {
    const page = paginaFlujo({ estacion: 'ITV MARBELLA' });
    await esperarDetencion(recorrerFlujo(page, DATOS_PRUEBA, { explorarHasta: 'datos-cita' }), 'estacion');

    const salida = salidaConsola();
    expect(salida).toMatch(/ERROR Detenido \(estacion\): La estación elegida no es "ITV ESTEPONA"\./);
    expect(salida).not.toContain('Exploración detenida');
    expect(salida).not.toContain('MARBELLA');
    expect(salida).not.toMatch(/<[a-z]/i);
    for (const valor of Object.values(DATOS_PRUEBA)) expect(salida).not.toContain(valor);
    expect(page.escrituras.filter((e) => e.pantalla === 'localizador')).toEqual([]);
  });

  it('sin la etiqueta "Estación elegida:" también se detiene', async () => {
    const page = paginaFlujo({ estacion: null });
    await esperarDetencion(recorrerFlujo(page, DATOS_PRUEBA, { explorarHasta: 'datos-cita' }), 'estacion');
    expect(page.escrituras.filter((e) => e.pantalla === 'localizador')).toEqual([]);
  });

  it('el log de una exploración correcta no contiene datos del vehículo ni HTML', async () => {
    const page = paginaFlujo();
    await recorrerFlujo(page, DATOS_PRUEBA, { explorarHasta: 'datos-cita' });
    const salida = salidaConsola();
    for (const valor of Object.values(DATOS_PRUEBA)) expect(salida).not.toContain(valor);
    expect(salida).not.toMatch(/<[a-z]/i);
  });

  it('no llega a la pantalla de cita propuesta (la de la operación matemática)', async () => {
    const page = paginaFlujo({ operacionCitaPropuesta: true });
    const fin = await recorrerFlujo(page, DATOS_PRUEBA, { explorarHasta: 'datos-cita' });

    expect(fin).toBe('datos-cita');
    expect(page.pantalla).toBe('localizador');
    expect(page.clics.map((c) => c.pantalla)).not.toContain('opciones');
    expect(page.clics.map((c) => c.texto)).not.toContain('Modificar cita');
    expect(salidaConsola()).not.toMatch(/antibots|operación/);
  });

  it('sin modo exploración, con la operación en cita propuesta el flujo llega al calendario', async () => {
    const page = paginaFlujo({ operacionCitaPropuesta: true });
    expect(await recorrerFlujo(page, DATOS_PRUEBA)).toBe('calendario');
    expect(page.pantalla).toBe('dic');
  });

  it('sin modo exploración el flujo sigue hasta el calendario', async () => {
    const page = paginaFlujo();
    expect(await recorrerFlujo(page, DATOS_PRUEBA)).toBe('calendario');
  });
});

describe('modo exploración (EXPLORAR_HASTA=calendario)', () => {
  const salidaConsola = (): string =>
    [console.log, console.warn, console.error]
      .flatMap((f) => vi.mocked(f).mock.calls.flat())
      .map(String)
      .join('\n');

  it('recorre el flujo completo y se detiene en el calendario sin pulsar ningún día', async () => {
    const page = paginaFlujo();
    const fin = await recorrerFlujo(page, DATOS_PRUEBA, { explorarHasta: 'calendario' });

    expect(fin).toBe('calendario');
    expect(page.pantalla).toBe('dic');
    expect(page.clics.map((c) => c.clave)).toEqual(ORDEN_FLUJO);
    expect(page.clics.filter((c) => c.enCuerpoCalendario || c.enCabeceraCalendario)).toEqual([]);
    expect(page.clics.map((c) => c.texto)).not.toContain('Aceptar');
    // No lee el calendario (ni días ni horas) ni escribe en él.
    expect(page.lecturas.filter((l) => l.metodo === 'content')).toEqual([]);
    expect(page.escrituras.map((e) => e.id)).toEqual(['matricula', 'tipoAcceso', 'bastidor', 'localizador']);
  });

  it('solo registra "Exploración detenida en calendario. Estación OK"', async () => {
    const page = paginaFlujo();
    await recorrerFlujo(page, DATOS_PRUEBA, { explorarHasta: 'calendario' });

    const lineas = salidaConsola().split('\n').filter(Boolean);
    expect(lineas).toHaveLength(1);
    expect(lineas[0]).toMatch(new RegExp(`^\\[[^\\]]+\\] INFO ${MENSAJE_EXPLORACION_CALENDARIO}$`));
    expect(MENSAJE_EXPLORACION_CALENDARIO).toBe('Exploración detenida en calendario. Estación OK');
    for (const valor of Object.values(DATOS_PRUEBA)) expect(salidaConsola()).not.toContain(valor);
  });

  it('mantiene la verificación de estación antes del localizador', async () => {
    const page = paginaFlujo({ estacion: 'ITV MARBELLA' });
    await esperarDetencion(recorrerFlujo(page, DATOS_PRUEBA, { explorarHasta: 'calendario' }), 'estacion');
    expect(page.escrituras.map((e) => e.id)).toEqual(['matricula', 'tipoAcceso', 'bastidor']);
    expect(page.clics.map((c) => c.texto)).not.toContain('Modificar cita');
  });

  it('con la operación matemática en cita propuesta llega al calendario y solo registra el mensaje de exploración', async () => {
    const page = paginaFlujo({ operacionCitaPropuesta: true });
    expect(await recorrerFlujo(page, DATOS_PRUEBA, { explorarHasta: 'calendario' })).toBe('calendario');
    expect(page.pantalla).toBe('dic');

    const salida = salidaConsola();
    const lineas = salida.split('\n').filter(Boolean);
    expect(lineas).toHaveLength(1);
    expect(lineas[0]).toMatch(/INFO Exploración detenida en calendario\. Estación OK$/);
    expect(salida).not.toMatch(/\d\s*\+\s*\d/); // ni la operación
    for (const valor of Object.values(DATOS_PRUEBA)) expect(salida).not.toContain(valor);
  });

  it.each([
    ['matrícula y bastidor', 'datos'],
    ['tipo de inspección', 'paso2'],
    ['datos de la cita', 'localizador'],
    ['intermedia tras Modificar cita', 'resumen'],
  ] as const)('una operación en "%s" se registra con el nombre de esa pantalla', async (nombre, pantalla) => {
    const html = pantallasFlujo().pantallas[pantalla] ?? '';
    const page = paginaFlujo({}, { pantallas: { [pantalla]: `${html}${OPERACION_CON_CAMPO}` } });
    const error = await esperarDetencion(recorrerFlujo(page, DATOS_PRUEBA, { explorarHasta: 'calendario' }), 'antibots');
    expect(error.message).toBe(`Operación matemática en la pantalla "${nombre}".`);
  });
});

describe('lectura del calendario (leerHuecos)', () => {
  const HORAS_11 = ['10:05', '10:30'];
  const HORAS_12 = ['12:14', '12:18', '13:22'];
  const HORAS_5 = ['09:00', '09:45'];
  const HOY = '2026-11-12';

  /** Calendario tras pulsar un día: ese día seleccionado, con sus horas. */
  function trasPulsar(dia: number, horas: string[], disponibles: number[]): string {
    return pantallaCalendario({
      disponibles,
      seleccionado: dia,
      fechaSeleccionada: `${dia}/12/2026`,
      horas,
    });
  }

  /** Noviembre sin días (para el recorrido nov → dic) y diciembre del fixture. */
  function pagina(extra: { pantallas?: Record<string, string>; transiciones?: Record<string, string> } = {}) {
    return new PaginaFalsa(
      'dic',
      {
        dic: pantallaCalendario(),
        nov: pantallaCalendario({ titulo: 'Noviembre, 2026', disponibles: [] }),
        salida: '<p>Inicio</p>',
        ...extra.pantallas,
      },
      { 'dic|flecha:anterior': 'nov', 'nov|flecha:siguiente': 'dic', ...extra.transiciones },
    );
  }

  it('fixture de diciembre con FECHA_LIMITE=2026-12-10: lista vacía, sin pulsar días', async () => {
    const page = pagina();
    const dias = await leerHuecos(page, { hoy: HOY, fechaLimite: '2026-12-10' });

    expect(dias).toEqual([]);
    expect(page.clics.map((c) => c.clave)).toEqual(['flecha:anterior', 'flecha:siguiente']);
  });

  it('informa de cada mes leído aunque tenga 0 días (noviembre y diciembre)', async () => {
    const meses: unknown[] = [];
    const page = pagina();
    await leerHuecos(page, { hoy: HOY, fechaLimite: '2026-12-10', alLeerMes: (m) => meses.push(m) });
    expect(meses).toEqual([
      { anio: 2026, mes: 11, disponibles: 0 },
      { anio: 2026, mes: 12, disponibles: 0 },
    ]);
  });

  it('con FECHA_LIMITE=2026-12-13: días 11 y 12, cada uno con sus horas', async () => {
    const page = pagina({
      pantallas: { dic11: trasPulsar(11, HORAS_11, [12]), dic12: trasPulsar(12, HORAS_12, [11]) },
      transiciones: { 'dic|dia:11': 'dic11', 'dic11|dia:12': 'dic12' },
    });
    const dias = await leerHuecos(page, { hoy: HOY, fechaLimite: '2026-12-13' });

    expect(dias).toEqual([
      { fecha: '2026-12-11', horas: HORAS_11 },
      { fecha: '2026-12-12', horas: HORAS_12 },
    ]);
    expect(page.clics.map((c) => c.clave)).toEqual(['flecha:anterior', 'flecha:siguiente', 'dia:11', 'dia:12']);
  });

  it('un día disponible el 5 de diciembre aparece con sus horas (FECHA_LIMITE=2026-12-10)', async () => {
    const page = pagina({
      pantallas: {
        dic: pantallaCalendario({ disponibles: [5, 11, 12], seleccionado: 10 }),
        dic5: trasPulsar(5, HORAS_5, [11, 12]),
      },
      transiciones: { 'dic|dia:5': 'dic5' },
    });
    const dias = await leerHuecos(page, { hoy: HOY, fechaLimite: '2026-12-10' });

    expect(dias).toEqual([{ fecha: '2026-12-05', horas: HORAS_5 }]);
    expect(page.clics.map((c) => c.clave)).not.toContain('dia:10'); // el seleccionado (cita actual)
  });

  it('las horas descartan "Seleccione una hora" (value="-1")', async () => {
    const page = pagina({
      pantallas: { dic11: trasPulsar(11, HORAS_11, [12]) },
      transiciones: { 'dic|dia:11': 'dic11' },
    });
    const [dia] = await leerHuecos(page, { hoy: HOY, fechaLimite: '2026-12-12' });
    expect(dia?.horas).toEqual(HORAS_11);
    expect(dia?.horas).not.toContain('Seleccione una hora');
  });

  it('si #fechaSeleccionada no coincide tras pulsar un día, se detiene sin leer horas ni pulsar nada más', async () => {
    const page = pagina({
      pantallas: { dic11mal: pantallaCalendario({ disponibles: [12], seleccionado: 11, fechaSeleccionada: '12/12/2026', horas: HORAS_11 }) },
      transiciones: { 'dic|dia:11': 'dic11mal' },
    });
    const error = await esperarDetencion(leerHuecos(page, { hoy: HOY, fechaLimite: '2026-12-13' }), 'pantalla-inesperada');

    expect(error.message).toBe('Tras pulsar el día 11, la fecha seleccionada no coincide.');
    expect(page.clics.map((c) => c.clave)).toEqual(['flecha:anterior', 'flecha:siguiente', 'dia:11']);
    expect(page.lecturas.filter((l) => l.pantalla === 'dic11mal' && l.metodo === 'content')).toEqual([]);
    const errores = consolaError.mock.calls.flat().map(String);
    expect(errores).toHaveLength(1);
  });

  it('un mes inesperado detiene la lectura sin pulsar nada más', async () => {
    const page = pagina({
      pantallas: { oct: pantallaCalendario({ titulo: 'Octubre, 2026', disponibles: [20] }) },
      transiciones: { 'dic|flecha:anterior': 'oct' },
    });
    await esperarDetencion(leerHuecos(page, { hoy: HOY, fechaLimite: '2026-12-13' }), 'mes-inesperado');
    expect(page.clics.map((c) => c.clave)).toEqual(['flecha:anterior']);
  });

  it('no pulsa un día con la clase selected', async () => {
    const page = pagina();
    await esperarDetencion(pulsarDia(page, { mes: 12, anio: 2026 }, 10), 'pantalla-inesperada');
    expect(page.clics).toEqual([]);
  });

  it('con más días que MAX_DIAS_POR_CICLO lee los primeros por fecha y registra un aviso', async () => {
    const aviso = vi.mocked(console.warn);
    const page = new PaginaFalsa(
      'dic',
      {
        dic: pantallaCalendario({ disponibles: [1, 2, 3, 4], seleccionado: 10 }),
        dic1: trasPulsar(1, ['08:00'], [2, 3, 4]),
        dic2: trasPulsar(2, ['08:15'], [1, 3, 4]),
        salida: '<p>Inicio</p>',
      },
      { 'dic|dia:1': 'dic1', 'dic1|dia:2': 'dic2' },
    );
    const dias = await leerHuecos(page, { hoy: '2026-12-01', fechaLimite: '2026-12-10', maxDiasPorCiclo: 2 });

    expect(dias).toEqual([
      { fecha: '2026-12-01', horas: ['08:00'] },
      { fecha: '2026-12-02', horas: ['08:15'] },
    ]);
    expect(page.clics.map((c) => c.clave)).toEqual(['dia:1', 'dia:2']);
    expect(aviso.mock.calls.flat().join('\n')).toMatch(/límite de 2 por ciclo/);
  });

  it('durante la lectura no se escribe en ningún campo ni se pulsa Aceptar, Confirmar, Cancelar ni Cambiar estación', async () => {
    const trampas = '<input type="button" value="Cancelar" /><a href="#">Cambiar estación</a>';
    const page = pagina({
      pantallas: {
        dic: pantallaCalendario({ extra: trampas }),
        dic11: pantallaCalendario({ disponibles: [12], seleccionado: 11, fechaSeleccionada: '11/12/2026', horas: HORAS_11, extra: trampas }),
        dic12: pantallaCalendario({ disponibles: [11], seleccionado: 12, fechaSeleccionada: '12/12/2026', horas: HORAS_12, extra: trampas }),
      },
      transiciones: { 'dic|dia:11': 'dic11', 'dic11|dia:12': 'dic12' },
    });
    await leerHuecos(page, { hoy: HOY, fechaLimite: '2026-12-13' });

    expect(page.escrituras).toEqual([]);
    expect(page.teclas).toEqual([]);
    for (const c of page.clics) expect(c.texto).not.toMatch(PROHIBIDOS);
  });

  it('sin "hoy", usa la fecha de España (hoyEnMadrid, como ciclo.ts)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    // 2026-11-30 23:30 UTC = 2026-12-01 00:30 en España: el día 1 de diciembre ya es "hoy".
    vi.setSystemTime(new Date('2026-11-30T23:30:00Z'));
    try {
      const page = new PaginaFalsa(
        'dic',
        {
          dic: pantallaCalendario({ disponibles: [1], seleccionado: 10 }),
          dic1: trasPulsar(1, ['08:00'], []),
          salida: '<p>Inicio</p>',
        },
        { 'dic|dia:1': 'dic1' },
      );
      const dias = await leerHuecos(page, { fechaLimite: '2026-12-10' });
      expect(dias).toEqual([{ fecha: '2026-12-01', horas: ['08:00'] }]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('pantalla "cita propuesta"', () => {
  it('con "9 + 2 =" pulsa solo "Cambiar fecha y hora" y llega al calendario', async () => {
    const page = paginaFlujo({ operacionCitaPropuesta: true });
    expect(await recorrerFlujo(page, DATOS_PRUEBA)).toBe('calendario');

    expect(page.pantalla).toBe('dic');
    const enCitaPropuesta = page.clics.filter((c) => c.pantalla === 'opciones');
    expect(enCitaPropuesta.map((c) => [c.etiqueta, c.texto])).toEqual([['a', 'Cambiar fecha y hora']]);
    expect(page.clics.filter((c) => c.texto === 'Cambiar fecha y hora')).toHaveLength(1);
  });

  it('no lee ni escribe en la operación ni en el desplegable de hora: solo lee el enlace', async () => {
    const page = paginaFlujo({ operacionCitaPropuesta: true });
    await recorrerFlujo(page, DATOS_PRUEBA);

    expect(page.escrituras.filter((e) => e.pantalla === 'opciones')).toEqual([]);
    const lecturas = page.lecturas.filter((l) => l.pantalla === 'opciones');
    expect(lecturas.length).toBeGreaterThan(0);
    // Solo el enlace y la comprobación de si hay un aviso: nunca el texto de la página.
    const permitidas = new Set([
      'role=link[name="Cambiar fecha y hora"]',
      'role=button[name="Entendido"]',
      `${SELECTORES.dialogo} >> visible=true`,
    ]);
    for (const l of lecturas) expect(permitidas.has(l.objetivo), `${l.metodo} ${l.objetivo}`).toBe(true);
  });

  it.each(['Aceptar', 'Cancelar', 'Cambiar estación', 'Cambiar tipo de inspección'])(
    'no pulsa "%s" (presente en la pantalla)',
    async (texto) => {
      const page = paginaFlujo({ operacionCitaPropuesta: true });
      await recorrerFlujo(page, DATOS_PRUEBA);
      expect(page.clics.map((c) => c.texto)).not.toContain(texto);
    },
  );

  it('no se escribe en ningún campo después de llegar a "cita propuesta"', async () => {
    const page = paginaFlujo({ operacionCitaPropuesta: true });
    await recorrerFlujo(page, DATOS_PRUEBA);
    const pantallas = page.escrituras.map((e) => e.pantalla);
    expect(pantallas).toEqual(['datos', 'datos', 'datos', 'localizador']);
    expect(page.teclas).toEqual([]);
  });

  it('si hubiera dos enlaces "Cambiar fecha y hora", no pulsa ninguno', async () => {
    const page = paginaFlujo(
      {},
      { pantallas: { opciones: `${pantallaCitaPropuesta({ operacionCitaPropuesta: true })}<a href="#">Cambiar fecha y hora</a>` } },
    );
    await esperarDetencion(recorrerFlujo(page, DATOS_PRUEBA), 'pantalla-inesperada');
    expect(page.clics.map((c) => c.texto)).not.toContain('Cambiar fecha y hora');
  });
});

describe('aviso informativo en "cita propuesta"', () => {
  const AVISO_ENTENDIDO =
    '<div role="dialog" data-tapa><p>Aviso informativo</p><input type="button" value="Entendido" /></div>';
  const AVISO_OTRO_BOTON =
    '<div role="dialog" data-tapa><p>Aviso</p><input type="button" value="Aceptar" /><input type="button" value="Cerrar" /></div>';
  const citaPropuesta = pantallaCitaPropuesta({ operacionCitaPropuesta: true });

  /** "opciones" con `aviso` encima; al pulsar Entendido pasa a "opciones2" (`trasEntendido`). */
  function pagina(aviso: string, trasEntendido = '') {
    return paginaFlujo(
      { operacionCitaPropuesta: true },
      {
        pantallas: { opciones: `${aviso}${citaPropuesta}`, opciones2: `${trasEntendido}${citaPropuesta}` },
        transiciones: { 'opciones|Entendido': 'opciones2', 'opciones2|Cambiar fecha y hora': 'dic' },
      },
    );
  }

  it('un aviso "Entendido" tapa el enlace: se pulsa "Entendido", luego el enlace, y se llega al calendario', async () => {
    const page = pagina(AVISO_ENTENDIDO);
    expect(await recorrerFlujo(page, DATOS_PRUEBA)).toBe('calendario');

    expect(page.pantalla).toBe('dic');
    expect(page.clics.filter((c) => c.pantalla.startsWith('opciones')).map((c) => [c.pantalla, c.texto])).toEqual([
      ['opciones', 'Entendido'],
      ['opciones2', 'Cambiar fecha y hora'],
    ]);
    expect(page.escrituras.filter((e) => e.pantalla.startsWith('opciones'))).toEqual([]);
  });

  it('sin descartar el aviso, el enlace tapado no se puede pulsar (lo que pasaba antes)', async () => {
    const page = new PaginaFalsa('opciones', { opciones: `${AVISO_ENTENDIDO}${citaPropuesta}` });
    await esperarDetencion(
      pulsarBotonFlujo(page, 'Cambiar fecha y hora', { en: 'cita propuesta', hacia: 'calendario' }),
      'pantalla-inesperada',
    );
    expect(page.clics).toEqual([]);
  });

  it('un diálogo con otro botón distinto de "Entendido" no se pulsa y se detiene', async () => {
    const page = pagina(AVISO_OTRO_BOTON);
    const error = await esperarDetencion(recorrerFlujo(page, DATOS_PRUEBA), 'pantalla-inesperada');

    expect(error.message).toBe('Diálogo sin "Entendido" en la pantalla "cita propuesta"; no se cierra.');
    expect(page.clics.filter((c) => c.pantalla === 'opciones')).toEqual([]);
  });

  it.each([
    ['otro aviso con "Entendido"', AVISO_ENTENDIDO, /Sigue habiendo un aviso/],
    ['otro diálogo con otro botón', AVISO_OTRO_BOTON, /Otro diálogo/],
  ])('un segundo diálogo tras el primero (%s): se detiene sin pulsar nada más', async (_, segundo, mensaje) => {
    const page = pagina(AVISO_ENTENDIDO, segundo);
    const error = await esperarDetencion(recorrerFlujo(page, DATOS_PRUEBA), 'pantalla-inesperada');

    expect(error.message).toMatch(mensaje);
    expect(page.clics.filter((c) => c.pantalla.startsWith('opciones')).map((c) => c.texto)).toEqual(['Entendido']);
    expect(page.pantalla).toBe('opciones2');
  });

  it('nunca cierra un diálogo con Aceptar, Cancelar ni Cambiar estación', async () => {
    const dialogo =
      '<div role="dialog" data-tapa><input type="button" value="Aceptar" /><input type="button" value="Cancelar" /><a href="#">Cambiar estación</a></div>';
    const page = pagina(dialogo);
    await esperarDetencion(recorrerFlujo(page, DATOS_PRUEBA), 'pantalla-inesperada');
    expect(page.clics.map((c) => c.texto)).not.toEqual(expect.arrayContaining(['Aceptar']));
    for (const c of page.clics) expect(c.texto).not.toMatch(PROHIBIDOS);
  });

  it('sin aviso, el flujo sigue igual (no pulsa "Entendido" en cita propuesta)', async () => {
    const page = paginaFlujo({ operacionCitaPropuesta: true });
    await recorrerFlujo(page, DATOS_PRUEBA);
    expect(page.clics.filter((c) => c.pantalla === 'opciones').map((c) => c.texto)).toEqual(['Cambiar fecha y hora']);
  });

  it('con el aviso no lee el texto de la página (la operación sigue sin leerse)', async () => {
    const page = pagina(AVISO_ENTENDIDO);
    await recorrerFlujo(page, DATOS_PRUEBA);
    const enCitaPropuesta = page.lecturas.filter((l) => l.pantalla.startsWith('opciones'));
    expect(enCitaPropuesta.filter((l) => l.objetivo === 'body' || l.metodo === 'content')).toEqual([]);
  });
});

describe('etiqueta de la detección antibots (fuera de "cita propuesta")', () => {
  it.each([
    ['matrícula y bastidor', 'datos'],
    ['datos de la cita', 'localizador'],
  ] as const)('operación con campo "captcha" en "%s": dice "Operación matemática", no "Captcha"', async (nombre, pantalla) => {
    const html = pantallasFlujo().pantallas[pantalla] ?? '';
    const page = paginaFlujo({}, { pantallas: { [pantalla]: `${html}${OPERACION_CON_CAMPO}` } });
    const error = await esperarDetencion(recorrerFlujo(page, DATOS_PRUEBA), 'antibots');

    expect(error.message).toBe(`Operación matemática en la pantalla "${nombre}".`);
    const errores = consolaError.mock.calls.flat().map(String);
    expect(errores).toHaveLength(1);
    expect(errores[0]).not.toMatch(/Captcha/);
    expect(errores[0]).not.toMatch(/9\s*\+\s*2/);
    expect(page.escrituras.filter((e) => e.pantalla === pantalla && e.id === 'captcha')).toEqual([]);
  });

  it('un captcha real (sin operación) sigue diciendo "Captcha"', async () => {
    const html = pantallasFlujo().pantallas.datos ?? '';
    const page = paginaFlujo({}, { pantallas: { datos: `${html}<div class="g-recaptcha"></div>` } });
    const error = await esperarDetencion(recorrerFlujo(page, DATOS_PRUEBA), 'antibots');
    expect(error.message).toBe('Captcha en la pantalla "matrícula y bastidor".');
  });
});

describe('scripts/explorar.ts', () => {
  const codigo = readFileSync(fileURLToPath(new URL('../scripts/explorar.ts', import.meta.url)), 'utf8');

  it('no envía avisos ni lee el calendario', () => {
    expect(codigo).not.toMatch(/ciclo\.js|notificar\.js|email\.js|fetch\(|leerHuecos|pulsarDia|cambiarMes/);
  });

  it('se niega a ejecutarse sin EXPLORAR_HASTA y siempre pasa explorarHasta al flujo', () => {
    expect(codigo).toContain('if (modo === undefined)');
    expect(codigo).toContain('recorrerFlujo(comoPagina(page), datos, { explorarHasta: modo })');
  });

  it('no guarda capturas ni HTML', () => {
    expect(codigo).not.toMatch(/screenshot|content\(|writeFile/);
  });
});

describe('reglas comprobadas sobre el código fuente', () => {
  const dirSrc = fileURLToPath(new URL('../src/', import.meta.url));
  const dirTests = fileURLToPath(new URL('./', import.meta.url));

  async function fuentes(dir: string): Promise<Array<[string, string]>> {
    const archivos = (await readdir(dir, { recursive: true })).filter((a) => a.endsWith('.ts'));
    return archivos.map((a) => [a, readFileSync(`${dir}${a}`, 'utf8')]);
  }

  async function llamadas(metodo: string): Promise<string[]> {
    const patron = new RegExp(`\\.${metodo}\\(`, 'g');
    return (await fuentes(dirSrc)).flatMap(([archivo, codigo]) => (codigo.match(patron) ?? []).map(() => archivo));
  }

  it('solo clic() llama a .click(): una única llamada en todo src/', async () => {
    expect(await llamadas('click')).toEqual(['navegador.ts']);
  });

  it('solo rellenarCampo() escribe texto y solo elegirTipoAcceso() cambia un select', async () => {
    expect(await llamadas('fill')).toEqual(['navegador.ts']);
    expect(await llamadas('selectOption')).toEqual(['navegador.ts']);
    const navegador = readFileSync(`${dirSrc}navegador.ts`, 'utf8');
    expect(navegador).toContain('await selector.selectOption(TIPO_ACCESO);');
    expect(navegador).toContain("tipoAcceso: '#tipoAcceso',");
  });

  it('la única tecla que se pulsa es Escape', async () => {
    expect(await llamadas('press')).toEqual(['navegador.ts']);
    expect(readFileSync(`${dirSrc}navegador.ts`, 'utf8')).toContain("page.keyboard.press('Escape')");
  });

  it('"Volver" no es un botón permitido y no queda código de salida con Volver', async () => {
    expect(Object.keys(BOTONES_FLUJO)).not.toContain('Volver');
    for (const [archivo, codigo] of await fuentes(dirSrc)) {
      expect(/salirSinGuardar|leerCalendarioYSalir/.test(codigo), archivo).toBe(false);
    }
  });

  it('src/ no usa otros métodos que modifiquen la página', async () => {
    const prohibidos = /\.(check|uncheck|type|pressSequentially|setInputFiles|dispatchEvent|evaluate|tap|dblclick)\(/;
    for (const [archivo, codigo] of await fuentes(dirSrc)) {
      expect(prohibidos.test(codigo), archivo).toBe(false);
    }
  });

  it('los tests no cargan el .env ni usan datos reales del vehículo', async () => {
    for (const [archivo, codigo] of await fuentes(dirTests)) {
      expect(/from ['"]dotenv|import ['"]dotenv/.test(codigo), archivo).toBe(false);
      expect(/process\.env\.(MATRICULA|BASTIDOR|LOCALIZADOR)/.test(codigo), archivo).toBe(false);
    }
    for (const variable of ['MATRICULA', 'BASTIDOR', 'LOCALIZADOR']) {
      expect(process.env[variable], variable).toBeUndefined();
    }
  });
});
