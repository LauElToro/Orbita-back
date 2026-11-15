import { describe, expect, it } from 'vitest';
import { addMonths, daysInMonth, localParts, localToUtc, periodos } from '../../src/lib/dates';

const TZ = 'America/Argentina/Buenos_Aires';

describe('localParts', () => {
  it('convierte a la hora de Buenos Aires (UTC-3)', () => {
    const l = localParts(new Date('2026-11-15T02:30:00Z'), TZ);
    expect(l).toMatchObject({ y: 2026, m: 11, d: 14, hh: 23, mm: 30, weekday: 6 });
  });
});

describe('periodos', () => {
  it('arma día, semana (lunes) y mes desde el día del abono', () => {
    const p = periodos(new Date('2026-11-14T15:00:00Z'), TZ, 10);
    expect(p.dia).toBe('dia:2026-11-14');
    expect(p.semana).toBe('semana:2026-11-09');
    expect(p.mes).toBe('mes:2026-11-10');
    expect(p.reinicio).toEqual({ dia: '2026-11-15', semana: '2026-11-16', mes: '2026-12-10' });
  });

  it('antes del día del abono el mes arranca en el mes anterior', () => {
    const p = periodos(new Date('2026-11-05T15:00:00Z'), TZ, 20);
    expect(p.mes).toBe('mes:2026-10-20');
    expect(p.reinicio.mes).toBe('2026-11-20');
  });

  it('un abono el 31 cae el último día de los meses cortos', () => {
    const p = periodos(new Date('2026-02-28T15:00:00Z'), TZ, 31);
    expect(p.mes).toBe('mes:2026-02-28');
    expect(p.reinicio.mes).toBe('2026-03-31');
  });

  it('el domingo pertenece a la semana que empezó el lunes anterior', () => {
    const p = periodos(new Date('2026-11-15T15:00:00Z'), TZ, 1);
    expect(p.semana).toBe('semana:2026-11-09');
  });
});

describe('addMonths y daysInMonth', () => {
  it('respeta el día del abono', () => {
    expect(addMonths(new Date('2026-01-31T12:00:00Z'), 1, 31).toISOString()).toBe('2026-02-28T12:00:00.000Z');
    expect(addMonths(new Date('2026-02-28T12:00:00Z'), 1, 31).toISOString()).toBe('2026-03-31T12:00:00.000Z');
    expect(addMonths(new Date('2026-12-15T12:00:00Z'), 1, 15).toISOString()).toBe('2027-01-15T12:00:00.000Z');
    expect(daysInMonth(2028, 2)).toBe(29);
  });
});

describe('localToUtc', () => {
  it('interpreta la fecha en la zona del negocio', () => {
    expect(localToUtc('2026-11-20 10:30', TZ)?.toISOString()).toBe('2026-11-20T13:30:00.000Z');
  });
  it('rechaza formatos inválidos', () => {
    expect(localToUtc('mañana a las 10', TZ)).toBeNull();
  });
});
