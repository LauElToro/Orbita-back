import type { Plan, PrismaClient } from '@prisma/client';

export type PlanId = 'mensajes' | 'turnos' | 'completo' | 'personalizado';

export const PLANES: Plan[] = [
  {
    id: 'mensajes',
    nombre: 'Mensajes',
    precioTransferencia: 40_000,
    precioMercadoPago: 42_000,
    // Más caro que el cupo incluido (~$21) y que subir a Turnos (~$21 por respuesta nueva).
    precioMensajeExtra: 45,
    topeDia: 100,
    topeSemana: 500,
    topeMes: 2_000,
    modulos: ['faq', 'handoff'],
    maxCanales: 1,
    modeloCapaz: false,
  },
  {
    id: 'turnos',
    nombre: 'Turnos',
    precioTransferencia: 80_000,
    precioMercadoPago: 84_000,
    precioMensajeExtra: 40,
    topeDia: 200,
    topeSemana: 1_000,
    topeMes: 4_000,
    modulos: ['faq', 'handoff', 'turnos'],
    maxCanales: 2,
    modeloCapaz: false,
  },
  {
    id: 'completo',
    nombre: 'Completo',
    precioTransferencia: 110_000,
    precioMercadoPago: 115_000,
    precioMensajeExtra: 30,
    topeDia: 400,
    topeSemana: 2_000,
    topeMes: 8_000,
    modulos: ['faq', 'handoff', 'turnos', 'recordatorios'],
    maxCanales: 3,
    modeloCapaz: true,
  },
  {
    id: 'personalizado',
    nombre: 'Personalizado',
    precioTransferencia: 0,
    precioMercadoPago: 0,
    precioMensajeExtra: 25,
    topeDia: 1_000,
    topeSemana: 5_000,
    topeMes: 20_000,
    modulos: ['faq', 'handoff', 'turnos', 'recordatorios'],
    maxCanales: 5,
    modeloCapaz: true,
  },
];

export async function ensurePlans(prisma: PrismaClient): Promise<void> {
  for (const plan of PLANES) {
    await prisma.plan.upsert({ where: { id: plan.id }, create: plan, update: plan });
  }
}

/** Importe mensual del abono, siempre por Mercado Pago. El plan personalizado usa el precio acordado. */
export function precioDe(
  plan: Pick<Plan, 'id' | 'precioMercadoPago'>,
  precioPersonalizado?: number | null,
): number {
  if (plan.id === 'personalizado') return precioPersonalizado ?? 0;
  return plan.precioMercadoPago;
}
