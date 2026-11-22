import { criterioDerivacion } from '../../ai/perfil';
import { leerMensajes } from '../../tenants/defaults';
import type { Modulo } from '../types';

export const TAG_HANDOFF = '[HANDOFF]';

export function pideHandoff(texto: string): boolean {
  return texto.toUpperCase().includes(TAG_HANDOFF);
}

export const handoff: Modulo = {
  id: 'handoff',
  instrucciones: (ctx) => {
    const casos = criterioDerivacion(ctx.tenant.perfil);
    const cuando = casos
      ? `Derivá la charla cuando entiendas que pasó alguno de estos casos:\n${casos}`
      : 'Derivá la charla si la persona pide hablar con alguien, hace un reclamo o se queja.';
    return `${cuando}\nCuando corresponda derivar, respondé únicamente ${TAG_HANDOFF}, sin ningún otro texto. Si no es uno de esos casos, seguí la charla vos.`;
  },
  async procesar(ctx, salida) {
    if (!pideHandoff(salida.texto)) return salida;
    return { texto: leerMensajes(ctx.tenant.mensajes).handoff, handoff: true };
  },
};
