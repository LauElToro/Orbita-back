export interface Mensajes {
  espera: string;
  tope: string;
  handoff: string;
  recordatorio: string;
}

export const MENSAJES_DEFAULT: Mensajes = {
  espera: 'Ya te respondo.',
  tope: 'En este momento te deriva una persona del local.',
  handoff: 'Lo comunico con una persona del local.',
  recordatorio: 'Mañana tenés turno a las {{hora}}. Respondé SI para confirmar.',
};

export function leerMensajes(raw: unknown): Mensajes {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Partial<Mensajes>;
  return { ...MENSAJES_DEFAULT, ...obj };
}
