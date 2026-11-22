export const MEDIOS = ['efectivo', 'transferencia', 'mercadopago', 'tarjeta', 'debito'] as const;
export type Medio = (typeof MEDIOS)[number];

export const MEDIO_LABEL: Record<Medio, string> = {
  efectivo: 'efectivo',
  transferencia: 'transferencia',
  mercadopago: 'Mercado Pago',
  tarjeta: 'tarjeta',
  debito: 'débito',
};

/** Miles con punto, sin depender del idioma del servidor. */
export function pesos(n: number): string {
  const s = Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `$${s}`;
}

export function juntar(partes: string[]): string {
  if (partes.length <= 1) return partes[0] ?? '';
  return `${partes.slice(0, -1).join(', ')} y ${partes[partes.length - 1]}`;
}
