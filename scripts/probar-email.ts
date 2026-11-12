// Prueba manual: envía UN correo de prueba con la configuración SMTP del .env real.
// No forma parte de "npm start" ni del ciclo real. Uso: npm run probar:email
// Solo muestra "Enviado" o el error (sin contraseña, usuario ni destinatario).

import 'dotenv/config';
import { enviarEmail, leerConfigEmail, secretosEmail } from '../src/email.js';
import { ocultarSecretos } from '../src/logger.js';

let secretos: string[] = [];
try {
  const config = leerConfigEmail();
  secretos = secretosEmail(config);
  await enviarEmail(config, 'Prueba aviso ITV', 'Si lees esto, el envío funciona');
  console.log('Enviado');
} catch (error) {
  const mensaje = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${ocultarSecretos(mensaje, secretos)}`);
  process.exitCode = 1;
}
