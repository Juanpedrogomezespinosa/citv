// Envío del aviso por correo (SMTP con nodemailer).
// Ni la contraseña ni el destinatario se escriben nunca en logs ni en mensajes de error.

import nodemailer from 'nodemailer';
import { variableObligatoria } from './config.js';

export interface ConfigEmail {
  host: string;
  puerto: number;
  usuario: string;
  password: string;
  destino: string;
}

/** Lee SMTP_HOST, SMTP_PORT, SMTP_USUARIO, SMTP_PASSWORD y EMAIL_DESTINO. */
export function leerConfigEmail(env: NodeJS.ProcessEnv = process.env): ConfigEmail {
  const puertoTexto = variableObligatoria('SMTP_PORT', env);
  const puerto = Number(puertoTexto);
  if (!Number.isInteger(puerto) || puerto < 1 || puerto > 65535) {
    throw new Error('SMTP_PORT debe ser un número de puerto válido.');
  }
  return {
    host: variableObligatoria('SMTP_HOST', env),
    puerto,
    usuario: variableObligatoria('SMTP_USUARIO', env),
    password: variableObligatoria('SMTP_PASSWORD', env),
    destino: variableObligatoria('EMAIL_DESTINO', env),
  };
}

/** Valores que nunca deben aparecer en la salida. */
export function secretosEmail(config: ConfigEmail): string[] {
  return [config.password, config.destino, config.usuario];
}

export async function enviarEmail(config: ConfigEmail, asunto: string, cuerpo: string): Promise<void> {
  const transporte = nodemailer.createTransport({
    host: config.host,
    port: config.puerto,
    secure: config.puerto === 465,
    auth: { user: config.usuario, pass: config.password },
  });
  await transporte.sendMail({ from: config.usuario, to: config.destino, subject: asunto, text: cuerpo });
}
