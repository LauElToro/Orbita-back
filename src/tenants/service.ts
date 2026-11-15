import { Prisma } from '@prisma/client';
import { z } from 'zod';
import type { Deps } from '../deps';
import { cancelarSuscripcionVieja } from '../billing/mercadopago';
import { precioDe } from '../billing/plans';
import { decrypt, encrypt, mask, randomToken } from '../lib/crypto';
import { localParts } from '../lib/dates';
import { badRequest, conflict, notFound } from '../lib/errors';
import { MODULOS_VALIDOS } from '../modules';
import { MENSAJES_DEFAULT, leerMensajes } from './defaults';
import { getTenant, rebuildIndex, tenantInclude, type TenantFull } from './repo';

const PLAN_IDS = ['mensajes', 'turnos', 'completo', 'personalizado'] as const;

export const canalSchema = z.object({
  tipo: z.enum(['whatsapp', 'instagram', 'tiktok']),
  endpointId: z.string().trim().min(1),
  etiqueta: z.string().trim().min(1),
});

const topesSchema = z.object({
  dia: z.number().int().positive(),
  semana: z.number().int().positive(),
  mes: z.number().int().positive(),
});

export const altaSchema = z.object({
  clientId: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9-]{1,48}$/, 'Usar minúsculas, números y guiones'),
  nombre: z.string().trim().min(1),
  planId: z.enum(PLAN_IDS),
  medio: z.enum(['mercadopago', 'transferencia']),
  canales: z.array(canalSchema).min(1),
  pageId: z.string().trim().min(1),
  appToken: z.string().trim().min(1),
  prompt: z.string().default(''),
  emailContacto: z.string().email().optional(),
  precioPersonalizado: z.number().int().positive().optional(),
  modulos: z.array(z.enum(MODULOS_VALIDOS as [string, ...string[]])).optional(),
  topes: topesSchema.optional(),
  timezone: z.string().optional(),
});

export type AltaInput = z.infer<typeof altaSchema>;

export const patchSchema = z.object({
  nombre: z.string().trim().min(1).optional(),
  timezone: z.string().optional(),
  modelo: z.string().trim().min(1).optional(),
  mensajes: z
    .object({
      espera: z.string(),
      tope: z.string(),
      handoff: z.string(),
      recordatorio: z.string(),
    })
    .partial()
    .optional(),
  pageId: z.string().trim().min(1).optional(),
  appToken: z.string().trim().min(1).optional(),
  emailContacto: z.string().email().nullable().optional(),
  canales: z.array(canalSchema).min(1).optional(),
  planId: z.enum(PLAN_IDS).optional(),
  medio: z.enum(['mercadopago', 'transferencia']).optional(),
  precioPersonalizado: z.number().int().positive().optional(),
  modulos: z.array(z.enum(MODULOS_VALIDOS as [string, ...string[]])).optional(),
  topes: topesSchema.optional(),
});

export type PatchInput = z.infer<typeof patchSchema>;

function validarZona(tz: string | undefined): void {
  if (!tz) return;
  try {
    new Intl.DateTimeFormat('es-AR', { timeZone: tz });
  } catch {
    throw badRequest(`Zona horaria inválida: ${tz}`);
  }
}

function traducirUnico(err: unknown): never {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
    const target = String((err.meta?.target as string[] | undefined)?.join(',') ?? '');
    if (target.includes('endpointId')) throw conflict('Ese endpointId ya pertenece a otra ficha');
    throw conflict('Ya existe un cliente con ese clientId');
  }
  throw err;
}

export async function crearTenant(deps: Deps, raw: unknown): Promise<TenantFull> {
  const input = altaSchema.parse(raw);
  validarZona(input.timezone);
  const plan = await deps.prisma.plan.findUnique({ where: { id: input.planId } });
  if (!plan) throw notFound('Plan');
  if (input.canales.length > plan.maxCanales) {
    throw badRequest(`El plan ${plan.nombre} admite hasta ${plan.maxCanales} canal(es)`);
  }
  const personalizado = plan.id === 'personalizado';
  if (personalizado && !input.precioPersonalizado) {
    throw badRequest('El plan Personalizado necesita el importe mensual acordado');
  }

  const timezone = input.timezone ?? 'America/Argentina/Buenos_Aires';
  const now = deps.now();
  const topes = (personalizado && input.topes) || { dia: plan.topeDia, semana: plan.topeSemana, mes: plan.topeMes };

  try {
    await deps.prisma.tenant.create({
      data: {
        id: input.clientId,
        nombre: input.nombre,
        planId: plan.id,
        timezone,
        pageId: input.pageId,
        appTokenEnc: encrypt(input.appToken, deps.config.ENCRYPTION_KEY),
        apiKey: randomToken(24),
        publicToken: randomToken(18),
        prompt: input.prompt,
        mensajes: { ...MENSAJES_DEFAULT },
        modulos: (personalizado && input.modulos) || plan.modulos,
        topeDia: topes.dia,
        topeSemana: topes.semana,
        topeMes: topes.mes,
        precioPersonalizado: input.precioPersonalizado ?? null,
        emailContacto: input.emailContacto ?? null,
        canales: { create: input.canales },
        subscription: {
          create: {
            medio: input.medio,
            estadoPago: 'pendiente',
            diaAbono: localParts(now, timezone).d,
            vencimiento: now,
          },
        },
      },
    });
  } catch (err) {
    traducirUnico(err);
  }
  await rebuildIndex(deps.prisma, deps.redis);
  return getTenant(deps.prisma, input.clientId);
}

export async function actualizarTenant(deps: Deps, id: string, raw: unknown): Promise<TenantFull> {
  const input = patchSchema.parse(raw);
  validarZona(input.timezone);
  const actual = await getTenant(deps.prisma, id);
  const data: Prisma.TenantUpdateInput = {};

  if (input.nombre) data.nombre = input.nombre;
  if (input.timezone) data.timezone = input.timezone;
  if (input.modelo) data.modelo = input.modelo;
  if (input.pageId) data.pageId = input.pageId;
  if (input.appToken) data.appTokenEnc = encrypt(input.appToken, deps.config.ENCRYPTION_KEY);
  if (input.emailContacto !== undefined) data.emailContacto = input.emailContacto;
  if (input.mensajes) data.mensajes = { ...leerMensajes(actual.mensajes), ...input.mensajes };
  if (input.precioPersonalizado) data.precioPersonalizado = input.precioPersonalizado;

  const planId = input.planId ?? actual.planId;
  const plan = planId === actual.planId ? actual.plan : await deps.prisma.plan.findUnique({ where: { id: planId } });
  if (!plan) throw notFound('Plan');
  const cantCanales = input.canales?.length ?? actual.canales.length;
  if (cantCanales > plan.maxCanales) {
    throw badRequest(`El plan ${plan.nombre} admite hasta ${plan.maxCanales} canal(es). Sacá un canal antes de cambiar.`);
  }

  const personalizado = plan.id === 'personalizado';
  if (input.planId && input.planId !== actual.planId) {
    if (personalizado && !input.precioPersonalizado && !actual.precioPersonalizado) {
      throw badRequest('El plan Personalizado necesita el importe mensual acordado');
    }
    data.plan = { connect: { id: plan.id } };
    data.modulos = plan.modulos;
    data.topeDia = plan.topeDia;
    data.topeSemana = plan.topeSemana;
    data.topeMes = plan.topeMes;
    if (!plan.modeloCapaz) data.modelo = 'barato';
  }
  if (personalizado && input.modulos) data.modulos = input.modulos;
  if (personalizado && input.topes) {
    data.topeDia = input.topes.dia;
    data.topeSemana = input.topes.semana;
    data.topeMes = input.topes.mes;
  }
  const cambiaMedio = Boolean(input.medio && actual.subscription && input.medio !== actual.subscription.medio);
  const cambiaImporte =
    planId !== actual.planId ||
    Boolean(input.precioPersonalizado && input.precioPersonalizado !== actual.precioPersonalizado);
  const mpViejo = (cambiaMedio || cambiaImporte) && actual.subscription?.mpPreapprovalId;
  if (actual.subscription && (cambiaMedio || cambiaImporte)) {
    data.subscription = {
      update: { ...(cambiaMedio ? { medio: input.medio } : {}), mpPreapprovalId: null, mpInitPoint: null },
    };
  }

  try {
    await deps.prisma.$transaction(async (tx) => {
      await tx.tenant.update({ where: { id }, data });
      if (input.canales) {
        await tx.channel.deleteMany({ where: { tenantId: id } });
        await tx.channel.createMany({ data: input.canales.map((c) => ({ ...c, tenantId: id })) });
      }
    });
  } catch (err) {
    traducirUnico(err);
  }
  if (input.canales) await rebuildIndex(deps.prisma, deps.redis);
  if (mpViejo) await cancelarSuscripcionVieja(deps.mercadopago, mpViejo);
  return getTenant(deps.prisma, id);
}

export async function actualizarPrompt(deps: Deps, id: string, raw: unknown): Promise<TenantFull> {
  const { prompt } = z.object({ prompt: z.string() }).parse(raw);
  await getTenant(deps.prisma, id);
  await deps.prisma.tenant.update({ where: { id }, data: { prompt } });
  return getTenant(deps.prisma, id);
}

export function importeDe(tenant: TenantFull): number {
  return precioDe(tenant.plan, tenant.subscription?.medio ?? 'transferencia', tenant.precioPersonalizado);
}

/** El appToken nunca sale completo. `null` si todavía no se cargó. */
export function appTokenMaskDe(deps: Deps, appTokenEnc: string | null): string | null {
  if (!appTokenEnc) return null;
  try {
    return mask(decrypt(appTokenEnc, deps.config.ENCRYPTION_KEY));
  } catch {
    return '****';
  }
}

/** Ficha para el panel del equipo. */
export function fichaDto(deps: Deps, tenant: TenantFull) {
  const { appTokenEnc, ...resto } = tenant;
  return {
    ...resto,
    mensajes: leerMensajes(tenant.mensajes),
    appTokenMask: appTokenMaskDe(deps, appTokenEnc),
    importe: importeDe(tenant),
    linkPublico: `${deps.config.PUBLIC_URL}/p/${tenant.publicToken}`,
  };
}

export async function listarTenants(deps: Deps) {
  const tenants = await deps.prisma.tenant.findMany({ include: tenantInclude, orderBy: { nombre: 'asc' } });
  return tenants.map((t) => ({
    id: t.id,
    nombre: t.nombre,
    plan: { id: t.plan.id, nombre: t.plan.nombre },
    canales: t.canales.map((c) => ({ tipo: c.tipo, etiqueta: c.etiqueta })),
    estado: t.estado,
    pausaMotivo: t.pausaMotivo,
    estadoPago: t.subscription?.estadoPago ?? 'pendiente',
    vencimiento: t.subscription?.vencimiento ?? null,
  }));
}
