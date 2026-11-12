// Page falso para tests: HTML en memoria (cheerio). Registra clics, lecturas, escrituras
// en campos y teclas. Las transiciones entre pantallas las define el test.

import { load, type CheerioAPI } from 'cheerio';
import type { Localizador, Pagina } from '../../src/navegador.js';

export type TipoClic = 'boton-flujo' | 'dia' | 'flecha-mes' | 'otro';

export interface RegistroClic {
  /** Pantalla en la que se pulsó. */
  pantalla: string;
  /** Clave de transición: texto del botón, "dia:N", "flecha:anterior" o "flecha:siguiente". */
  clave: string;
  etiqueta: string;
  texto: string;
  clases: string[];
  /** Si el elemento está en la fila de cabecera / el cuerpo de la tabla del calendario. */
  enCabeceraCalendario: boolean;
  enCuerpoCalendario: boolean;
}

export interface RegistroLectura {
  /** Pantalla en la que se hizo la lectura. */
  pantalla: string;
  metodo: string;
  objetivo: string;
}

export interface RegistroEscritura {
  pantalla: string;
  metodo: 'fill' | 'selectOption';
  /** id del elemento escrito. */
  id: string;
  valor: string;
}

type Seleccion = ReturnType<CheerioAPI>;

const BLOQUES = 'p, div, tr, li, h1, h2, h3, h4, h5, h6, form, table, thead, tbody, tfoot, br, dt, dd, label';

const CANDIDATOS_ROL = {
  button: 'button, input[type="button"], input[type="submit"], [role="button"]',
  link: 'a[href], [role="link"]',
  textbox: 'input[type="text"], input:not([type]), textarea, [role="textbox"]',
} as const;

function normalizar(texto: string): string {
  return texto.replace(/\s+/g, ' ').trim();
}

/** Atributo de test: el elemento tapa la pantalla (como un aviso modal) mientras sea visible. */
export const ATRIBUTO_TAPA = 'data-tapa';

export class PaginaFalsa implements Pagina {
  $: CheerioAPI;
  readonly clics: RegistroClic[] = [];
  readonly lecturas: RegistroLectura[] = [];
  readonly escrituras: RegistroEscritura[] = [];
  readonly teclas: string[] = [];
  private esperasCarga: Array<() => void> = [];

  readonly keyboard = {
    press: async (tecla: string): Promise<void> => {
      this.teclas.push(tecla);
    },
  };

  constructor(
    public pantalla: string,
    private readonly pantallas: Record<string, string>,
    /** "<pantalla>|<clave>" → pantalla siguiente. */
    private readonly transiciones: Record<string, string> = {},
  ) {
    this.$ = load(this.html(pantalla));
  }

  private html(pantalla: string): string {
    const html = this.pantallas[pantalla];
    if (html === undefined) throw new Error(`Pantalla falsa desconocida: ${pantalla}`);
    return html;
  }

  irA(pantalla: string): void {
    this.pantalla = pantalla;
    this.$ = load(this.html(pantalla));
    const esperas = this.esperasCarga;
    this.esperasCarga = [];
    for (const resolver of esperas) resolver();
  }

  /** Visible si ni él ni ningún antecesor tiene `hidden` o `display: none`. */
  esVisible(el: Parameters<CheerioAPI>[0]): boolean {
    const e = this.$(el);
    return [e, ...e.parents().toArray().map((p) => this.$(p))].every(
      (x) => x.attr('hidden') === undefined && !/display:\s*none/.test(x.attr('style') ?? ''),
    );
  }

  /** Simula la comprobación de Playwright: si un elemento visible tapa la pantalla, solo se puede pulsar lo que está dentro. */
  tapadoPor(seleccion: Seleccion): boolean {
    const tapas = this.$(`[${ATRIBUTO_TAPA}]`).filter((_, el) => this.esVisible(el));
    return tapas.length > 0 && seleccion.closest(`[${ATRIBUTO_TAPA}]`).length === 0;
  }

  /** Nombre accesible simplificado: aria-label, <label for>, texto o value. */
  private nombreAccesible(el: Parameters<CheerioAPI>[0]): string {
    const e = this.$(el);
    const aria = e.attr('aria-label');
    if (aria !== undefined) return normalizar(aria);
    const id = e.attr('id');
    if (id !== undefined && e.is('input, textarea, select')) {
      const etiqueta = this.$(`label[for="${id}"]`);
      if (etiqueta.length > 0) return normalizar(etiqueta.text());
    }
    return normalizar(e.text() || e.attr('value') || '');
  }

  locator(selector: string): Localizador {
    return new LocalizadorFalso(this, () => this.$(selector), selector);
  }

  getByRole(rol: 'button' | 'link' | 'textbox', opciones: { name: string; exact: true }): Localizador {
    return new LocalizadorFalso(
      this,
      // Como Playwright: getByRole no incluye elementos ocultos.
      () =>
        this.$(CANDIDATOS_ROL[rol]).filter((_, el) => this.esVisible(el) && this.nombreAccesible(el) === opciones.name),
      `role=${rol}[name="${opciones.name}"]`,
    );
  }

  async content(): Promise<string> {
    this.lecturas.push({ pantalla: this.pantalla, metodo: 'content', objetivo: 'page' });
    return this.$.html();
  }

  waitForEvent(): Promise<unknown> {
    return new Promise((resolver) => this.esperasCarga.push(() => resolver(undefined)));
  }

  registrarEscritura(seleccion: Seleccion, metodo: 'fill' | 'selectOption', valor: string): void {
    const e = seleccion.first();
    this.escrituras.push({ pantalla: this.pantalla, metodo, id: e.attr('id') ?? '', valor });
    if (metodo === 'fill') e.attr('value', valor);
    else {
      e.find('option').removeAttr('selected');
      e.find(`option[value="${valor}"]`).attr('selected', 'selected');
    }
  }

  registrarClic(seleccion: Seleccion): void {
    const e = seleccion.first();
    const clases = (e.attr('class') ?? '').split(/\s+/).filter(Boolean);
    const texto = normalizar(e.text() || e.attr('value') || '');
    const enCabeceraCalendario = e.closest('#calendar-container table thead tr.headrow').length > 0;
    const enCuerpoCalendario = e.closest('#calendar-container table tbody').length > 0;

    let clave = texto;
    if (enCabeceraCalendario && clases.includes('nav')) {
      clave = e.next().hasClass('title') ? 'flecha:anterior' : 'flecha:siguiente';
    } else if (enCuerpoCalendario) {
      clave = `dia:${texto}`;
    }

    this.clics.push({
      pantalla: this.pantalla,
      clave,
      etiqueta: e.prop('tagName')?.toLowerCase() ?? '',
      texto,
      clases,
      enCabeceraCalendario,
      enCuerpoCalendario,
    });

    const destino = this.transiciones[`${this.pantalla}|${clave}`];
    if (destino === undefined) {
      throw new Error(`Transición no definida en el test: ${this.pantalla}|${clave}`);
    }
    this.irA(destino);
  }
}

class LocalizadorFalso implements Localizador {
  constructor(
    private readonly pagina: PaginaFalsa,
    private readonly resolver: () => Seleccion,
    readonly descripcion: string,
  ) {}

  /** Como el modo estricto de Playwright: las acciones exigen un único elemento. */
  private unico(metodo: string): Seleccion {
    const sel = this.resolver();
    if (sel.length !== 1) {
      throw new Error(`strict mode: ${metodo} sobre "${this.descripcion}" encuentra ${sel.length} elementos`);
    }
    return sel;
  }

  private leer(metodo: string): void {
    this.pagina.lecturas.push({ pantalla: this.pagina.pantalla, metodo, objetivo: this.descripcion });
  }

  async count(): Promise<number> {
    this.leer('count');
    return this.resolver().length;
  }

  async textContent(): Promise<string | null> {
    this.leer('textContent');
    return this.unico('textContent').text();
  }

  async innerText(): Promise<string> {
    this.leer('innerText');
    const copia = this.unico('innerText').clone();
    copia.find('script, style').remove();
    copia.find(BLOQUES).before('\n').after('\n');
    copia.find('td, th').after('\t');
    return copia.text();
  }

  async getAttribute(nombre: string): Promise<string | null> {
    this.leer(`getAttribute(${nombre})`);
    return this.unico('getAttribute').attr(nombre) ?? null;
  }

  async inputValue(): Promise<string> {
    this.leer('inputValue');
    return this.unico('inputValue').attr('value') ?? '';
  }

  async waitFor(opciones: { state: 'visible' | 'hidden' }): Promise<void> {
    const total = this.resolver().length;
    if (opciones.state === 'hidden' && total !== 0) throw new Error(`timeout: "${this.descripcion}" sigue visible`);
    if (opciones.state === 'visible' && total !== 1) {
      throw new Error(`waitFor visible sobre "${this.descripcion}": ${total} elementos`);
    }
  }

  async click(): Promise<void> {
    const sel = this.unico('click');
    if (this.pagina.tapadoPor(sel)) {
      throw new Error(`Timeout: otro elemento intercepta el clic sobre "${this.descripcion}"`);
    }
    this.pagina.registrarClic(sel);
  }

  async fill(valor: string): Promise<void> {
    this.pagina.registrarEscritura(this.unico('fill'), 'fill', valor);
  }

  async selectOption(valor: string): Promise<unknown> {
    this.pagina.registrarEscritura(this.unico('selectOption'), 'selectOption', valor);
    return [valor];
  }

  locator(selector: string): Localizador {
    // cheerio no entiende XPath: solo se emula el que usa navegador.ts (celda hermana siguiente).
    const resolver =
      selector === 'xpath=following-sibling::*[1]'
        ? () => this.resolver().next()
        : () => this.resolver().find(selector);
    return new LocalizadorFalso(this.pagina, resolver, `${this.descripcion} >> ${selector}`);
  }

  filter(opciones: { hasText?: RegExp; visible?: boolean }): Localizador {
    const { hasText, visible } = opciones;
    return new LocalizadorFalso(
      this.pagina,
      () =>
        this.resolver().filter(
          (_, el) =>
            (hasText === undefined || hasText.test(normalizar(this.pagina.$(el).text()))) &&
            (visible === undefined || this.pagina.esVisible(el) === visible),
        ),
      `${this.descripcion}${hasText === undefined ? '' : ` >> hasText=${String(hasText)}`}${visible === undefined ? '' : ` >> visible=${visible}`}`,
    );
  }
}

/** Clasifica un clic según los tipos permitidos. */
export function tipoDeClic(c: RegistroClic, botonesPermitidos: readonly string[]): TipoClic {
  if (c.enCabeceraCalendario && c.clases.includes('nav')) return 'flecha-mes';
  if (
    c.enCuerpoCalendario &&
    c.etiqueta === 'td' &&
    /^\d{1,2}$/.test(c.texto) &&
    !c.clases.includes('disabled') &&
    !c.clases.includes('emptycell')
  ) {
    return 'dia';
  }
  if (['button', 'input', 'a'].includes(c.etiqueta) && botonesPermitidos.includes(c.texto)) return 'boton-flujo';
  return 'otro';
}
