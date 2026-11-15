import { z } from 'zod';
import type { Deps } from '../deps';
import { LEGAL } from '../legal/legal';
import { badRequest, conflict, notFound } from '../lib/errors';
import { altaSchema, crearTenant } from '../tenants/service';

const aceptaPrivacidad = z.literal(true, {
  errorMap: () => ({ message: 'Tenés que aceptar la Política de Privacidad' }),
});

export const contactoSchema = z.object({
  nombre: z.string().trim().min(2).max(120),
  email: z.string().trim().email(),
  telefono: z.string().trim().max(40).optional(),
  empresa: z.string().trim().min(1).max(120),
  rubro: z.string().trim().min(1).max(80),
  necesidad: z.string().trim().min(10).max(4000),
  aceptaPrivacidad,
  /** Honeypot: los humanos no lo ven, los bots lo completan. */
  website: z.string().optional(),
});

/** Botón de arrepentimiento (Res. 424/2020): se puede revocar la contratación dentro de los 10 días. */
export const arrepentimientoSchema = z.object({
  nombre: z.string().trim().min(2).max(120),
  email: z.string().trim().email(),
  negocio: z.string().trim().max(120).optional(),
  motivo: z.string().trim().max(2000).optional(),
  aceptaPrivacidad,
  website: z.string().optional(),
});

const TICKET_ESTADOS = ['nuevo', 'en_gestion', 'cotizado', 'contratado', 'descartado'] as const;

export const ticketPatchSchema = z.object({
  estado: z.enum(TICKET_ESTADOS).optional(),
  importeMensual: z.number().int().positive().nullable().optional(),
  notas: z.string().max(10_000).nullable().optional(),
});

/** El alta se hace con los mismos datos que una ficha normal, salvo plan e importe que salen del ticket. */
export const convertirSchema = altaSchema.omit({ planId: true, precioPersonalizado: true });

export async function crearTicket(deps: Deps, raw: unknown, ip?: string) {
  const { website, aceptaPrivacidad: _acepta, ...data } = contactoSchema.parse(raw);
  if (website) return null;
  return deps.prisma.ticket.create({ data: { ...data, privacidadVersion: LEGAL.privacidad, ip: ip ?? null } });
}

export async function crearArrepentimiento(deps: Deps, raw: unknown, ip?: string) {
  const { website, aceptaPrivacidad: _acepta, negocio, motivo, ...data } = arrepentimientoSchema.parse(raw);
  if (website) return null;
  return deps.prisma.ticket.create({
    data: {
      ...data,
      tipo: 'arrepentimiento',
      empresa: negocio || '-',
      rubro: '-',
      necesidad: motivo || 'Solicitud de revocación de la contratación (botón de arrepentimiento).',
      privacidadVersion: LEGAL.privacidad,
      ip: ip ?? null,
    },
  });
}

export async function listarTickets(deps: Deps, estado?: string, tipo?: string) {
  const e = z.enum(TICKET_ESTADOS).optional().parse(estado);
  const t = z.enum(['ia_personalizada', 'arrepentimiento']).optional().parse(tipo);
  return deps.prisma.ticket.findMany({
    where: { ...(e ? { estado: e } : {}), ...(t ? { tipo: t } : {}) },
    orderBy: { createdAt: 'desc' },
  });
}

export async function getTicket(deps: Deps, id: string) {
  const ticket = await deps.prisma.ticket.findUnique({ where: { id } });
  if (!ticket) throw notFound('Ticket');
  return ticket;
}

export async function actualizarTicket(deps: Deps, id: string, raw: unknown) {
  const data = ticketPatchSchema.parse(raw);
  const ticket = await getTicket(deps, id);
  if (ticket.tenantId && data.estado && data.estado !== 'contratado') {
    throw conflict('El ticket ya se convirtió en ficha');
  }
  return deps.prisma.ticket.update({ where: { id }, data });
}

export async function convertirTicket(deps: Deps, id: string, raw: unknown) {
  const ticket = await getTicket(deps, id);
  if (ticket.tipo !== 'ia_personalizada') throw conflict('Solo los pedidos de IA personalizada se convierten en ficha');
  if (ticket.tenantId) throw conflict('El ticket ya tiene una ficha');
  if (!ticket.importeMensual) throw badRequest('Cargá el importe mensual acordado antes de convertir');
  const input = convertirSchema.parse(raw);
  const tenant = await crearTenant(deps, {
    ...input,
    emailContacto: input.emailContacto ?? ticket.email,
    planId: 'personalizado',
    precioPersonalizado: ticket.importeMensual,
  });
  await deps.prisma.ticket.update({ where: { id }, data: { estado: 'contratado', tenantId: tenant.id } });
  return tenant;
}
