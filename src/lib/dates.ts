export interface LocalDate {
  y: number;
  m: number;
  d: number;
  hh: number;
  mm: number;
  weekday: number;
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function localParts(date: Date, timezone: string): LocalDate {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return {
    y: Number(get('year')),
    m: Number(get('month')),
    d: Number(get('day')),
    hh: Number(get('hour')),
    mm: Number(get('minute')),
    weekday: WEEKDAYS[get('weekday')],
  };
}

export function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function fmt(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function shift(y: number, m: number, d: number, days: number): string {
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return fmt(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

function addMonthsCalendar(y: number, m: number, months: number): { y: number; m: number } {
  const idx = y * 12 + (m - 1) + months;
  return { y: Math.floor(idx / 12), m: (idx % 12) + 1 };
}

export interface Periodos {
  dia: string;
  semana: string;
  mes: string;
  reinicio: { dia: string; semana: string; mes: string };
}

/** Claves de período en la zona horaria de la ficha. El mes arranca el día del abono. */
export function periodos(now: Date, timezone: string, diaAbono: number): Periodos {
  const l = localParts(now, timezone);
  const desdeLunes = (l.weekday + 6) % 7;
  const lunes = shift(l.y, l.m, l.d, -desdeLunes);

  const abonoEste = Math.min(diaAbono, daysInMonth(l.y, l.m));
  let inicio = { y: l.y, m: l.m };
  if (l.d < abonoEste) inicio = addMonthsCalendar(l.y, l.m, -1);
  const inicioDia = Math.min(diaAbono, daysInMonth(inicio.y, inicio.m));
  const prox = addMonthsCalendar(inicio.y, inicio.m, 1);
  const proxDia = Math.min(diaAbono, daysInMonth(prox.y, prox.m));

  return {
    dia: `dia:${fmt(l.y, l.m, l.d)}`,
    semana: `semana:${lunes}`,
    mes: `mes:${fmt(inicio.y, inicio.m, inicioDia)}`,
    reinicio: {
      dia: shift(l.y, l.m, l.d, 1),
      semana: shift(l.y, l.m, l.d, 7 - desdeLunes),
      mes: fmt(prox.y, prox.m, proxDia),
    },
  };
}

/** Suma meses a un instante respetando el día del abono (31 -> último día del mes). */
export function addMonths(date: Date, months: number, diaAbono: number): Date {
  const { y, m } = addMonthsCalendar(date.getUTCFullYear(), date.getUTCMonth() + 1, months);
  const d = Math.min(diaAbono, daysInMonth(y, m));
  return new Date(Date.UTC(y, m - 1, d, date.getUTCHours(), date.getUTCMinutes()));
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

export function addHours(date: Date, hours: number): Date {
  return new Date(date.getTime() + hours * 3_600_000);
}

export function describirAhora(now: Date, timezone: string): string {
  return new Intl.DateTimeFormat('es-AR', {
    timeZone: timezone,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(now);
}

/** Convierte "YYYY-MM-DD HH:mm" en hora local de la zona a un instante UTC. */
export function localToUtc(texto: string, timezone: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/.exec(texto.trim());
  if (!match) return null;
  const [y, m, d, hh, mm] = match.slice(1).map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const l = localParts(new Date(guess), timezone);
  const offset = Date.UTC(l.y, l.m - 1, l.d, l.hh, l.mm) - guess;
  return new Date(guess - offset);
}
