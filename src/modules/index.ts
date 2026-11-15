import { faq } from './faq';
import { handoff } from './handoff';
import { recordatorios } from './recordatorios';
import { turnos } from './turnos';
import type { Modulo } from './types';

export const MODULOS: Record<string, Modulo> = { faq, handoff, turnos, recordatorios };

export const MODULOS_VALIDOS = Object.keys(MODULOS);

/** Handoff va último: si el modelo pidió una persona, ese texto pisa cualquier otro. */
export function modulosActivos(ids: string[]): Modulo[] {
  const lista = ids.map((id) => MODULOS[id]).filter((m): m is Modulo => Boolean(m));
  return [...lista.filter((m) => m.id !== 'handoff'), ...lista.filter((m) => m.id === 'handoff')];
}
