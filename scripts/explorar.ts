// Exploración manual contra itvcita.com. NO envía avisos (no usa ntfy ni email), no lee
// días ni horas y no forma parte de "npm start".
// - EXPLORAR_HASTA=datos-cita: hasta la pantalla de datos de la cita; verifica
//   "Estación elegida:" y se detiene. NO rellena el localizador ni pulsa "Modificar cita".
// - EXPLORAR_HASTA=calendario: flujo completo (localizador, Modificar cita, Siguiente,
//   Cambiar fecha y hora) y se detiene en el calendario, sin pulsar ningún día ni "Aceptar".
//
// Uso (lo lanza el usuario):
//   EXPLORAR_HASTA=datos-cita HEADLESS=false npm run explorar
//   EXPLORAR_HASTA=calendario HEADLESS=false npm run explorar
//
// Solo se registra "Exploración detenida en <punto>. Estación OK" o el error
// correspondiente, nunca matrícula, bastidor, localizador ni HTML.

import 'dotenv/config';
import { createInterface } from 'node:readline/promises';
import { chromium } from 'playwright';
import { leerDatosVehiculo, leerHeadless, leerModoExploracion, type DatosVehiculo } from '../src/config.js';
import { log, ocultarSecretos } from '../src/logger.js';
import { comoPagina, DetencionError, recorrerFlujo, URL_INICIO } from '../src/navegador.js';

/** Primera línea del error, sin datos del vehículo (Playwright puede añadir trozos de HTML). */
function errorSeguro(error: unknown, datos: DatosVehiculo | undefined): string {
  const mensaje = (error instanceof Error ? error.message : String(error)).split('\n')[0] ?? '';
  return ocultarSecretos(mensaje, datos === undefined ? [] : Object.values(datos));
}

let datos: DatosVehiculo | undefined;
let navegador: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let headless = true;

try {
  const modo = leerModoExploracion();
  if (modo === undefined) {
    throw new Error('Este script solo se ejecuta en modo exploración: EXPLORAR_HASTA=datos-cita o calendario.');
  }
  datos = leerDatosVehiculo();
  headless = leerHeadless();

  navegador = await chromium.launch({ headless });
  const page = await navegador.newPage();
  await page.goto(URL_INICIO, { waitUntil: 'load' });
  await recorrerFlujo(comoPagina(page), datos, { explorarHasta: modo });
} catch (error) {
  // Las detenciones (estación, antibots, pantalla inesperada...) ya se han registrado.
  if (!(error instanceof DetencionError)) log.error(`Exploración interrumpida: ${errorSeguro(error, datos)}`);
  process.exitCode = 1;
} finally {
  if (navegador !== undefined) {
    if (!headless && process.stdin.isTTY) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      await rl.question('Pulsa Enter para cerrar el navegador (no se guarda nada). ');
      rl.close();
    }
    await navegador.close();
  }
}
