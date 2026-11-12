// Registra mensajes con fecha/hora y nivel. Nunca se deben pasar aquí datos personales,
// el topic de ntfy ni el HTML completo de la página.

type Nivel = 'INFO' | 'AVISO' | 'ERROR';

function escribir(nivel: Nivel, mensaje: string): void {
  const linea = `[${new Date().toISOString()}] ${nivel} ${mensaje}`;
  if (nivel === 'ERROR') console.error(linea);
  else if (nivel === 'AVISO') console.warn(linea);
  else console.log(linea);
}

export const log = {
  info: (mensaje: string): void => escribir('INFO', mensaje),
  aviso: (mensaje: string): void => escribir('AVISO', mensaje),
  error: (mensaje: string): void => escribir('ERROR', mensaje),
};

/** Sustituye por "***" cualquier aparición de los valores secretos (contraseña, destinatario, topic...). */
export function ocultarSecretos(texto: string, secretos: readonly string[]): string {
  return secretos
    .filter((s) => s.length >= 3)
    .reduce((t, s) => t.split(s).join('***'), texto);
}
