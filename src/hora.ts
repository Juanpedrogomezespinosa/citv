// Fecha y hora de España (Europe/Madrid), independientes de la zona horaria del equipo.

export interface PartesMadrid {
  /** AAAA-MM-DD */
  fecha: string;
  hora: number;
  minuto: number;
  segundo: number;
  /** "AAAA-MM-DD HH:MM:SS" */
  texto: string;
}

const FORMATO = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Madrid',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

export function partesMadrid(fecha: Date): PartesMadrid {
  const p = Object.fromEntries(FORMATO.formatToParts(fecha).map((x) => [x.type, x.value]));
  const dosCifras = (v: string | undefined): string => (v ?? '00').padStart(2, '0');
  const dia = `${p.year ?? '0000'}-${dosCifras(p.month)}-${dosCifras(p.day)}`;
  const hhmmss = `${dosCifras(p.hour)}:${dosCifras(p.minute)}:${dosCifras(p.second)}`;
  return {
    fecha: dia,
    hora: Number(p.hour),
    minuto: Number(p.minute),
    segundo: Number(p.second),
    texto: `${dia} ${hhmmss}`,
  };
}

/** Horario sin ciclos: de 23:00 a 07:00, hora de España. */
export function enHorarioDeDescanso(fecha: Date): boolean {
  const { hora } = partesMadrid(fecha);
  return hora >= 23 || hora < 7;
}

/** Minutos entre dos textos "AAAA-MM-DD HH:MM:SS" de hora de España (b − a). */
export function minutosEntre(a: string, b: string): number {
  const ms = (t: string): number => {
    const [d = '', h = ''] = t.split(' ');
    const [an, me, di] = d.split('-').map(Number);
    const [ho, mi, se] = h.split(':').map(Number);
    return Date.UTC(an ?? 0, (me ?? 1) - 1, di ?? 1, ho ?? 0, mi ?? 0, se ?? 0);
  };
  return (ms(b) - ms(a)) / 60_000;
}
