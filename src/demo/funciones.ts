import { pideHandoff, TAG_HANDOFF } from '../modules/handoff';
import { parsearEtiquetas } from '../modules/turnos';

export const FUNCIONES_DEMO = ['stock', 'horarios', 'turnos', 'pedidos', 'derivar'] as const;
export type FuncionDemo = (typeof FUNCIONES_DEMO)[number];

export const INSTRUCCIONES: Record<FuncionDemo, string> = {
  stock: [
    'Stock y precios: las planillas cargadas son el inventario del negocio.',
    'Antes de responder disponibilidad o precio, buscá el producto en la planilla (aceptá nombres aproximados o sin tildes).',
    'Si el stock es 0 o el producto no figura, decilo y sugerí hasta dos alternativas parecidas que sí tengan stock.',
    'Si la persona quiere que le separes unidades, confirmá producto y cantidad y agregá al final [STOCK_RESERVAR producto | cantidad].',
  ].join('\n'),
  horarios: [
    'Horarios: usá la fecha y hora actual del negocio para decir si ahora está abierto o cerrado, y cuándo abre o cierra.',
    'Si no hay horarios cargados, decí que no tenés ese dato.',
  ].join('\n'),
  turnos: [
    'Turnos: podés agendar turnos dentro de los horarios del negocio, nunca en el pasado.',
    'Confirmá día y hora con la persona y agregá al final [TURNO_RESERVAR AAAA-MM-DD HH:mm].',
  ].join('\n'),
  pedidos: [
    'Pedidos: si la persona quiere comprar, armá el pedido con productos, cantidades y precios de la información cargada y calculá el total.',
    'Pedí nombre y forma de entrega. Cuando confirme, agregá al final [PEDIDO resumen corto con el total].',
  ].join('\n'),
  derivar: `Atención humana: si la persona pide hablar con alguien, hace un reclamo o no podés resolver lo que pide, respondé únicamente ${TAG_HANDOFF}.`,
};

const RE_STOCK = /\[STOCK_RESERVAR\s+([^|\]]+?)\s*\|\s*(\d+)\s*\]/gi;
const RE_PEDIDO = /\[PEDIDO\s+([^\]]+)\]/gi;

export interface SalidaDemo {
  texto: string;
  handoff: boolean;
  acciones: string[];
}

/** Interpreta las etiquetas de las funciones prendidas. En la demo nada se ejecuta: las acciones se describen. */
export function procesarSalida(salida: string, funciones: FuncionDemo[], textoHandoff: string): SalidaDemo {
  if (funciones.includes('derivar') && pideHandoff(salida)) {
    return { texto: textoHandoff, handoff: true, acciones: ['Derivaría la charla a una persona del equipo y te avisaría por mail'] };
  }
  const acciones: string[] = [];
  let texto = salida.replace(/\[HANDOFF\]/gi, '');

  if (funciones.includes('stock')) {
    for (const m of texto.matchAll(RE_STOCK)) acciones.push(`Separaría ${m[2]} × ${m[1].trim()}`);
  }
  texto = texto.replace(RE_STOCK, '');

  if (funciones.includes('pedidos')) {
    for (const m of texto.matchAll(RE_PEDIDO)) acciones.push(`Registraría el pedido: ${m[1].trim()}`);
  }
  texto = texto.replace(RE_PEDIDO, '');

  const turnos = parsearEtiquetas(texto);
  if (funciones.includes('turnos')) acciones.push(...turnos.reservas.map((r) => `Reservaría un turno el ${r}`));

  return { texto: turnos.limpio.replace(/[ \t]{2,}/g, ' ').trim(), handoff: false, acciones };
}
