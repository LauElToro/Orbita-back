import type { Modulo } from '../types';

export const faq: Modulo = {
  id: 'faq',
  instrucciones: () =>
    [
      'Respondé solo con la información del negocio que figura arriba.',
      'Si no tenés el dato, decilo con honestidad y no inventes precios, horarios ni stock.',
      'Respuestas cortas, en español argentino neutro y sin jerga, con el tono indicado por el negocio.',
    ].join('\n'),
};
