import { leerMensajes } from '../../tenants/defaults';
import type { Modulo } from '../types';

export const TAG_HANDOFF = '[HANDOFF]';

export function pideHandoff(texto: string): boolean {
  return texto.toUpperCase().includes(TAG_HANDOFF);
}

export const handoff: Modulo = {
  id: 'handoff',
  instrucciones: () =>
    `Si la persona pide hablar con alguien, hace un reclamo, se queja, o el negocio indica que ese caso lo atiende una persona, respondé únicamente ${TAG_HANDOFF}, sin ningún otro texto: una persona del local sigue la charla.`,
  async procesar(ctx, salida) {
    if (!pideHandoff(salida.texto)) return salida;
    return { texto: leerMensajes(ctx.tenant.mensajes).handoff, handoff: true };
  },
};
