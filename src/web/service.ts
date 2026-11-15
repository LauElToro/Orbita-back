import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Deps } from '../deps';
import { leerHistorial } from '../ai/prompt';
import { randomToken } from '../lib/crypto';
import { HttpError, notFound } from '../lib/errors';
import { getTenant, tenantInclude, type TenantFull } from '../tenants/repo';
import { avisarDerivacion, conLockDeFicha, responderConsulta } from '../worker/procesar';

const COLOR = /^#[0-9a-fA-F]{6}$/;

export const webSchema = z.object({
  activa: z.boolean(),
  origenes: z.array(z.string().trim().min(1).max(200)).max(20).default([]),
  bienvenida: z.string().trim().max(300).optional(),
  color: z.string().regex(COLOR, 'El color va en formato #RRGGBB').optional(),
});

const sesion = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/, 'sesion: entre 8 y 64 letras, números, guiones o guiones bajos');

export const mensajeWebSchema = z.object({
  sesion,
  texto: z.string().trim().min(1).max(2000),
  nombre: z.string().trim().max(80).optional(),
  contacto: z.string().trim().max(120).optional(),
});

export const contactoWebSchema = z.object({
  sesion,
  contacto: z.string().trim().min(3).max(120),
  nombre: z.string().trim().max(80).optional(),
});

/** "https://www.mitienda.com/algo" -> "mitienda.com". Un dominio habilita también sus subdominios. */
export function normalizarOrigen(origen: string): string {
  const conEsquema = /^[a-z]+:\/\//i.test(origen) ? origen : `https://${origen}`;
  try {
    return new URL(conEsquema).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    throw new HttpError(400, `Dominio inválido: ${origen}`);
  }
}

export function origenPermitido(origenes: string[], origin: string | undefined): boolean {
  if (!origenes.length || !origin) return true;
  let host: string;
  try {
    host = new URL(origin).hostname.toLowerCase();
  } catch {
    return false;
  }
  return origenes.some((o) => host === o || host.endsWith(`.${o}`));
}

const nuevaClave = () => `web_${randomToken(18)}`;

export function webDto(deps: Deps, tenant: TenantFull) {
  const clave = tenant.webClave;
  const api = `${deps.config.PUBLIC_URL}/api`;
  return {
    activa: tenant.webActiva,
    clave,
    origenes: tenant.webOrigenes,
    bienvenida: tenant.webBienvenida,
    color: tenant.webColor,
    endpoint: clave ? `${api}/web/${clave}/mensajes` : null,
    script: clave ? `<script src="${api}/web/widget.js" data-clave="${clave}" async></script>` : null,
  };
}

export async function guardarWeb(deps: Deps, tenantId: string, raw: unknown) {
  const input = webSchema.parse(raw);
  const actual = await getTenant(deps.prisma, tenantId);
  await deps.prisma.tenant.update({
    where: { id: tenantId },
    data: {
      webActiva: input.activa,
      webClave: actual.webClave ?? nuevaClave(),
      webOrigenes: [...new Set(input.origenes.map(normalizarOrigen))],
      webBienvenida: input.bienvenida || null,
      webColor: input.color ?? null,
    },
  });
}

/** La clave vieja deja de funcionar al instante: hay que actualizar el código pegado en la web. */
export async function rotarClaveWeb(deps: Deps, tenantId: string) {
  await deps.prisma.tenant.update({ where: { id: tenantId }, data: { webClave: nuevaClave() } });
}

async function fichaWeb(deps: Deps, clave: string, origin: string | undefined): Promise<TenantFull> {
  const tenant = await deps.prisma.tenant.findUnique({ where: { webClave: clave }, include: tenantInclude });
  if (!tenant?.webActiva) throw notFound('Integración web');
  if (!origenPermitido(tenant.webOrigenes, origin)) throw new HttpError(403, 'Este dominio no está habilitado para la integración web');
  return tenant;
}

export async function configWeb(deps: Deps, clave: string, origin: string | undefined) {
  const tenant = await fichaWeb(deps, clave, origin);
  return {
    negocio: tenant.nombre,
    bienvenida: tenant.webBienvenida || `¡Hola! Soy el asistente de ${tenant.nombre}. ¿En qué te ayudo?`,
    color: tenant.webColor || '#5b4cf0',
    disponible: tenant.estado === 'activo',
  };
}

const subscriberWeb = (s: string) => `web:${s}`;

export async function mensajeWeb(deps: Deps, clave: string, origin: string | undefined, raw: unknown) {
  const input = mensajeWebSchema.parse(raw);
  const { id: tenantId } = await fichaWeb(deps, clave, origin);
  return conLockDeFicha(deps, tenantId, async () => {
    const tenant = await getTenant(deps.prisma, tenantId);
    if (tenant.estado === 'pausado') return { ok: true, estado: 'no_disponible' as const, texto: '', handoff: false };

    const subscriberId = subscriberWeb(input.sesion);
    const where = { tenantId_subscriberId: { tenantId, subscriberId } };
    const previa = await deps.prisma.conversation.findUnique({ where });
    const nombre = input.nombre || previa?.nombre || '';
    const messageId = randomUUID();
    const r = await responderConsulta(deps, tenant, { messageId, subscriberId, texto: input.texto, nombre });

    await deps.prisma.conversation.upsert({
      where,
      create: { tenantId, subscriberId, historial: [], ...(nombre ? { nombre } : {}) },
      update: nombre ? { nombre } : {},
    });
    if (r.handoff && input.contacto) {
      await avisarDerivacion(deps, tenant, 'la web', nombre, input.texto, `Dejó este contacto: ${input.contacto}.`);
    }
    return { ok: true, estado: r.tope ? ('tope' as const) : ('respondido' as const), messageId, texto: r.texto, handoff: r.handoff };
  });
}

/** El visitante deja su WhatsApp o email cuando la IA lo deriva; el comercio recibe la charla por mail. */
export async function contactoWeb(deps: Deps, clave: string, origin: string | undefined, raw: unknown) {
  const input = contactoWebSchema.parse(raw);
  const tenant = await fichaWeb(deps, clave, origin);
  const conv = await deps.prisma.conversation.findUnique({
    where: { tenantId_subscriberId: { tenantId: tenant.id, subscriberId: subscriberWeb(input.sesion) } },
  });
  const historial = leerHistorial(conv?.historial);
  const ultimo = [...historial].reverse().find((h) => h.rol === 'user')?.texto ?? '';
  const charla = historial
    .slice(-6)
    .map((h) => `${h.rol === 'user' ? 'Cliente' : 'IA'}: ${h.texto}`)
    .join(' | ');
  await avisarDerivacion(
    deps,
    tenant,
    'la web',
    input.nombre || conv?.nombre || '',
    ultimo,
    `Dejó este contacto: ${input.contacto}. Charla reciente: ${charla.slice(0, 1200)}`,
  );
  return { ok: true };
}
