// Prueba manual del ciclo de avisos completo (ntfy + email) con un hueco INVENTADO.
// No consulta la web de la ITV y no forma parte de "npm start" ni del ciclo real.
// Usa data/notificados-prueba.json para no tocar el estado real (data/notificados.json).
// Uso: npm run probar:aviso   (la segunda ejecución no debe enviar nada)

import 'dotenv/config';
import { ejecutarCiclo } from '../src/ciclo.js';
import { variableObligatoria } from '../src/config.js';
import { leerConfigEmail, secretosEmail } from '../src/email.js';
import { ocultarSecretos } from '../src/logger.js';
import type { Hueco } from '../src/notificar.js';

const HUECO_INVENTADO: Hueco = { fecha: '2026-11-15', hora: '10:15' };
const RUTA_PRUEBA = 'data/notificados-prueba.json';

let secretos: string[] = [];
try {
  const topic = variableObligatoria('NTFY_TOPIC');
  const email = leerConfigEmail();
  secretos = [topic, ...secretosEmail(email)];

  const resultado = await ejecutarCiclo([HUECO_INVENTADO], {
    topic,
    email,
    fechaLimite: variableObligatoria('FECHA_LIMITE'),
    rutaNotificados: RUTA_PRUEBA,
  });

  if (resultado.aviso === null) {
    console.log('Sin huecos nuevos: no se ha enviado nada.');
  } else {
    console.log(`Aviso enviado por: ${resultado.enviadoPor.join(', ')}`);
    console.log(`Título: ${resultado.aviso.titulo}`);
    console.log(`Mensaje: ${resultado.aviso.mensaje}`);
  }
} catch (error) {
  const mensaje = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${ocultarSecretos(mensaje, secretos)}`);
  process.exitCode = 1;
}
