// Test de integración de cicloLectura con el page falso y el fixture REAL de diciembre
// (11 y 12 disponibles, 10 seleccionado = cita actual). Sin web real, sin .env:
// los datos del vehículo son valores de prueba.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { load } from 'cheerio';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatosVehiculo } from '../src/config.js';
import { formatearLectura } from '../src/index.js';
import { cicloLectura, type NavegadorCiclo, type ResultadoLectura } from '../src/lectura.js';
import { PaginaFalsa } from './helpers/paginaFalsa.js';

const leerFixture = (nombre: string): string =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${nombre}`, import.meta.url)), 'utf8');
const FIXTURE = leerFixture('calendario-diciembre.html');
/** Noviembre sin días, con el aviso real de la web debajo del calendario. */
const FIXTURE_NOVIEMBRE = leerFixture('calendario-noviembre.html');

/** Valores de prueba: nunca los reales. */
const DATOS_PRUEBA: DatosVehiculo = {
  matricula: '0000-PRUEBA',
  bastidor: 'BASTIDOR-DE-PRUEBA',
  localizador: 'LOCALIZADOR-PRUEBA',
};

/** Hoy fijo en diciembre para que la lectura empiece en el mes del fixture. */
const HOY = '2026-12-01';
const HORAS_11 = ['10:05', '10:30', '11:15'];
const HORAS_12 = ['12:14', '13:22'];

/** Aviso que muestra la web real en un mes sin días disponibles (etiqueta exacta). */
const AVISO_SIN_DIAS =
  '<div class="mensaje error"><ul><li>No hay días seleccionables para la estación elegida en el mes seleccionado.</li></ul></div>';

/** Pantallas del flujo hasta el calendario, con el HTML confirmado de cada botón. */
const FLUJO: Record<string, string> = {
  inicio: `<div id="aviso"><button>Entendido</button></div>
    <label for="matricula">Matrícula:</label><input type="text" id="matricula" />
    <select id="tipoAcceso"><option value="1">1</option><option value="2">2</option></select>
    <input type="text" id="bastidor" /><input type="button" value="SIGUIENTE" />`,
  inspeccion: '<input type="submit" value="Siguiente" />',
  datosCita: `<table><tr><td>Estación elegida:</td><td>ITV ESTEPONA</td></tr></table>
    <input type="text" id="localizador" />
    <input type="button" value="Modificar cita" /><input type="button" value="Confirmar anulación" />`,
  intermedia: '<input type="submit" value="Siguiente" />',
  citaPropuesta: '<p>9 + 2 =</p><input type="text" name="captcha" /><a href="#">Cambiar fecha y hora</a>',
};

const TRANSICIONES_FLUJO: Record<string, string> = {
  'inicio|Entendido': 'inicioSinAviso',
  'inicioSinAviso|SIGUIENTE': 'inspeccion',
  'inspeccion|Siguiente': 'datosCita',
  'datosCita|Modificar cita': 'intermedia',
  'intermedia|Siguiente': 'citaPropuesta',
  'citaPropuesta|Cambiar fecha y hora': 'dic',
};

/** El fixture (o `base`) tras pulsar `dia`: ese día seleccionado, #fechaSeleccionada y sus horas. */
function fixtureTrasPulsar(dia: number, diaSemana: string, horas: string[], base = FIXTURE): string {
  const $ = load(base);
  $('tbody td.day').each((_, el) => {
    if (Number($(el).text().trim()) === dia) $(el).attr('class', 'day special_sabado selected');
  });
  $('#fechaSeleccionada').attr('value', `${diaSemana}, ${dia}/12/2026`);
  $('#horasCita option:not([value="-1"])').remove();
  for (const hora of horas) $('#horasCita').append(`<option value="${hora}:00">${hora}</option>`);
  return $.html();
}

/** El fixture con un cambio en memoria: `clases` por día y, opcionalmente, otro título. */
function fixtureModificado(clases: Record<number, string>, titulo?: string): string {
  const $ = load(FIXTURE);
  $('tbody td.day').each((_, el) => {
    const nueva = clases[Number($(el).text().trim())];
    if (nueva !== undefined) $(el).attr('class', nueva);
  });
  if (titulo !== undefined) $('td.title').text(titulo);
  return $.html();
}

interface Ciclo {
  resultado: ResultadoLectura;
  page: PaginaFalsa;
  cerrado: number;
}

interface OpcionesEjecucion {
  hoy?: string;
  /** Sustituye o añade pantallas del calendario. */
  pantallas?: Record<string, string>;
  /** Sustituye las transiciones del calendario (por defecto: dic → 11 → 12). */
  transiciones?: Record<string, string>;
}

async function ejecutar(fechaLimite: string, o: OpcionesEjecucion = {}): Promise<Ciclo> {
  const page = new PaginaFalsa(
    'en-blanco',
    {
      'en-blanco': '',
      ...FLUJO,
      inicioSinAviso: FLUJO.inicio?.replace('<div id="aviso"><button>Entendido</button></div>', '') ?? '',
      dic: FIXTURE, // fixture real, sin modificar
      dic11: fixtureTrasPulsar(11, 'viernes', HORAS_11),
      dic12: fixtureTrasPulsar(12, 'sábado', HORAS_12),
      ...o.pantallas,
    },
    { ...TRANSICIONES_FLUJO, ...(o.transiciones ?? { 'dic|dia:11': 'dic11', 'dic11|dia:12': 'dic12' }) },
  );
  let cerrado = 0;
  const abrir = async (): Promise<NavegadorCiclo> => ({
    pagina: page,
    irA: async () => page.irA('inicio'),
    cerrar: async () => {
      cerrado++;
    },
  });
  const resultado = await cicloLectura(abrir, DATOS_PRUEBA, { hoy: o.hoy ?? HOY, fechaLimite });
  return { resultado, page, cerrado };
}

function salida(resultado: ResultadoLectura, fechaLimite: string): string[] {
  if (resultado.estado !== 'lectura-completa') throw new Error(`Lectura detenida: ${resultado.motivo}`);
  return formatearLectura(resultado.meses, resultado.dias, fechaLimite);
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('cicloLectura con el fixture real de diciembre', () => {
  it('FECHA_LIMITE=2026-12-13: devuelve el 11 y el 12 con sus horas y "Diciembre 2026: 2 días disponibles"', async () => {
    const { resultado, page, cerrado } = await ejecutar('2026-12-13');

    expect(resultado).toEqual({
      estado: 'lectura-completa',
      dias: [
        { fecha: '2026-12-11', horas: HORAS_11 },
        { fecha: '2026-12-12', horas: HORAS_12 },
      ],
      meses: [{ anio: 2026, mes: 12, disponibles: 2 }],
    });

    const lineas = salida(resultado, '2026-12-13');
    expect(lineas.join('\n')).toContain('Diciembre 2026: 2 días disponibles');
    expect(lineas).toEqual([
      'Diciembre 2026: 2 días disponibles antes de 2026-12-13.',
      '2026-12-11 (viernes 11 de diciembre): 10:05, 10:30, 11:15',
      '2026-12-12 (sábado 12 de diciembre): 12:14, 13:22',
    ]);

    // En el calendario solo se pulsan el 11 y el 12 (nunca el 10, que es la cita actual,
    // ni "Aceptar"), no se escribe nada y se cierra el navegador una vez.
    expect(page.clics.filter((c) => c.pantalla.startsWith('dic')).map((c) => c.clave)).toEqual(['dia:11', 'dia:12']);
    expect(page.clics.map((c) => c.texto)).not.toContain('Aceptar');
    expect(page.escrituras.filter((e) => e.pantalla.startsWith('dic'))).toEqual([]);
    expect(cerrado).toBe(1);
  });

  it('FECHA_LIMITE=2026-12-10: lista vacía y "Diciembre 2026: 0 días disponibles antes de 2026-12-10."', async () => {
    const { resultado, page, cerrado } = await ejecutar('2026-12-10');

    expect(resultado).toEqual({
      estado: 'lectura-completa',
      dias: [],
      meses: [{ anio: 2026, mes: 12, disponibles: 0 }],
    });
    expect(salida(resultado, '2026-12-10')).toEqual(['Diciembre 2026: 0 días disponibles antes de 2026-12-10.']);

    // No se pulsa ningún día del calendario.
    expect(page.clics.filter((c) => c.pantalla.startsWith('dic'))).toEqual([]);
    expect(cerrado).toBe(1);
  });

  it('un solo día disponible (el 12, sin el 11): "1 día disponible" y solo se lista el 12', async () => {
    const soloEl12 = fixtureModificado({ 11: 'day disabled' }); // 10 seleccionado, 11 deshabilitado, 12 disponible
    const { resultado, page } = await ejecutar('2026-12-13', {
      pantallas: { dic: soloEl12, dic12: fixtureTrasPulsar(12, 'sábado', HORAS_12, soloEl12) },
      transiciones: { 'dic|dia:12': 'dic12' },
    });

    expect(resultado).toEqual({
      estado: 'lectura-completa',
      dias: [{ fecha: '2026-12-12', horas: HORAS_12 }],
      meses: [{ anio: 2026, mes: 12, disponibles: 1 }],
    });
    expect(salida(resultado, '2026-12-13')).toEqual([
      'Diciembre 2026: 1 día disponible antes de 2026-12-13.',
      '2026-12-12 (sábado 12 de diciembre): 12:14, 13:22',
    ]);
    expect(page.clics.filter((c) => c.pantalla.startsWith('dic')).map((c) => c.clave)).toEqual(['dia:12']);
  });

  it('con hoy = 2026-11-12 el calendario abre en noviembre (0 días, con el aviso de la web) y avanza a diciembre con la flecha', async () => {
    // Como la web real: noviembre sin días y con el aviso "No hay días seleccionables…".
    expect(FIXTURE_NOVIEMBRE).toContain(AVISO_SIN_DIAS);

    const { resultado, page, cerrado } = await ejecutar('2026-12-10', {
      hoy: '2026-11-12',
      pantallas: { nov: FIXTURE_NOVIEMBRE },
      transiciones: {
        // "Cambiar fecha y hora" abre el calendario en NOVIEMBRE, el mes de hoy.
        'citaPropuesta|Cambiar fecha y hora': 'nov',
        'nov|flecha:siguiente': 'dic',
      },
    });

    expect(resultado).toEqual({
      estado: 'lectura-completa',
      dias: [],
      meses: [
        { anio: 2026, mes: 11, disponibles: 0 },
        { anio: 2026, mes: 12, disponibles: 0 },
      ],
    });
    expect(salida(resultado, '2026-12-10')).toEqual([
      'Noviembre 2026: 0 días disponibles.',
      'Diciembre 2026: 0 días disponibles antes de 2026-12-10.',
    ]);

    // Un único clic en el calendario: la flecha de noviembre a diciembre. Ningún día.
    const enCalendario = page.clics.filter((c) => c.enCabeceraCalendario || c.enCuerpoCalendario);
    expect(enCalendario.map((c) => [c.pantalla, c.clave])).toEqual([['nov', 'flecha:siguiente']]);
    expect(page.pantalla).toBe('dic');
    expect(cerrado).toBe(1);

    // El aviso de noviembre no es un error: es un mes sin días.
    expect(vi.mocked(console.error)).not.toHaveBeenCalled();
    expect(vi.mocked(console.warn)).not.toHaveBeenCalled();
  });

  it('el aviso de noviembre no es un error: el ciclo termina en lectura-completa sin registrar errores', async () => {
    const { resultado } = await ejecutar('2026-12-10', {
      hoy: '2026-11-12',
      pantallas: { nov: FIXTURE_NOVIEMBRE },
      transiciones: { 'citaPropuesta|Cambiar fecha y hora': 'nov', 'nov|flecha:siguiente': 'dic' },
    });
    expect(resultado.estado).toBe('lectura-completa');
    expect(vi.mocked(console.error)).not.toHaveBeenCalled();

    // El lector no decide el estado mirando la clase "error" ni el texto del aviso.
    for (const archivo of ['navegador.ts', 'lectura.ts', 'calendario.ts', 'index.ts']) {
      const codigo = readFileSync(fileURLToPath(new URL(`../src/${archivo}`, import.meta.url)), 'utf8');
      expect(codigo, archivo).not.toMatch(/mensaje error|\.error\b['"]|No hay días seleccionables/);
    }
  });

  it('el aviso no es un diálogo y no tapa la flecha: se pasa a diciembre sin descartar nada', async () => {
    const $ = load(FIXTURE_NOVIEMBRE);
    const aviso = $('div.mensaje.error');
    expect(aviso).toHaveLength(1);
    expect(aviso.attr('role')).toBeUndefined();
    expect(aviso.closest('[role="dialog"], [role="alertdialog"], dialog')).toHaveLength(0);
    expect($('[role="dialog"], [role="alertdialog"], dialog')).toHaveLength(0);

    const { page } = await ejecutar('2026-12-10', {
      hoy: '2026-11-12',
      pantallas: { nov: FIXTURE_NOVIEMBRE },
      transiciones: { 'citaPropuesta|Cambiar fecha y hora': 'nov', 'nov|flecha:siguiente': 'dic' },
    });
    // En noviembre solo se pulsa la flecha: ni "Entendido" ni nada para cerrar el aviso.
    expect(page.clics.filter((c) => c.pantalla === 'nov').map((c) => c.clave)).toEqual(['flecha:siguiente']);
    expect(page.lecturas.filter((l) => l.pantalla === 'nov' && /Entendido|dialog/.test(l.objetivo))).toEqual([]);
  });

  it('la salida no contiene datos del vehículo', async () => {
    const { resultado } = await ejecutar('2026-12-13');
    const consola = [console.log, console.warn, console.error].flatMap((f) => vi.mocked(f).mock.calls.flat()).map(String);
    const texto = [...salida(resultado, '2026-12-13'), ...consola].join('\n');
    for (const valor of Object.values(DATOS_PRUEBA)) expect(texto).not.toContain(valor);
  });
});
