import { randomBytes } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import type { Deps } from '../deps';
import { compilarPrompt, perfilSchema } from '../ai/perfil';
import { encrypt, randomToken, sha256 } from '../lib/crypto';
import { addDays, localParts } from '../lib/dates';
import { conflict, HttpError, notFound } from '../lib/errors';
import { hashPassword, verifyPassword } from '../lib/password';
import { slugify } from '../lib/slug';
import { registrarAceptacion, type Evidencia, type DocumentoLegal } from '../legal/legal';
import { MENSAJES_DEFAULT, leerMensajes } from '../tenants/defaults';
import { getTenant, type TenantFull } from '../tenants/repo';
import { avisoOrbita, enviarCorreo } from '../correo/correo';
import { actualizarTenant, appTokenMaskDe, canalSchema, importeDe } from '../tenants/service';

const PLANES_AUTOGESTION = ['mensajes', 'turnos', 'completo'] as const;
const password = z.string().min(8, 'La contraseña necesita al menos 8 caracteres').max(200);
const aceptar = (msg: string) => z.literal(true, { errorMap: () => ({ message: msg }) });

export const registroSchema = z.object({
  negocio: z.string().trim().min(2).max(120),
  rubro: z.string().trim().min(2).max(80),
  nombre: z.string().trim().min(2).max(120),
  email: z.string().trim().toLowerCase().email(),
  password,
  planId: z.enum(PLANES_AUTOGESTION),
  medio: z.literal('mercadopago').default('mercadopago'),
  aceptaTerminos: aceptar('Tenés que aceptar los Términos y Condiciones'),
  aceptaPrivacidad: aceptar('Tenés que aceptar la Política de Privacidad'),
});

export const loginSchema = z.object({ email: z.string().trim().toLowerCase().email(), password: z.string().min(1) });

async function idDisponible(deps: Deps, negocio: string): Promise<string> {
  const base = slugify(negocio) || 'negocio';
  const libre = !(await deps.prisma.tenant.findUnique({ where: { id: base }, select: { id: true } }));
  return libre ? base : `${base}-${randomBytes(2).toString('hex')}`;
}

/** Alta autogestionada: la ficha nace pausada (motivo onboarding) hasta que pague y termine el tutorial. */
export async function registrar(deps: Deps, raw: unknown, evidencia: Evidencia) {
  const input = registroSchema.parse(raw);
  if (await deps.prisma.clientUser.findUnique({ where: { email: input.email } })) {
    throw conflict('Ya existe una cuenta con ese email');
  }
  const plan = await deps.prisma.plan.findUniqueOrThrow({ where: { id: input.planId } });
  const id = await idDisponible(deps, input.negocio);
  const timezone = 'America/Argentina/Buenos_Aires';
  const now = deps.now();

  const tenant = await deps.prisma.tenant.create({
    data: {
      id,
      nombre: input.negocio,
      rubro: input.rubro,
      estado: 'pausado',
      pausaMotivo: 'onboarding',
      planId: plan.id,
      timezone,
      apiKey: randomToken(24),
      publicToken: randomToken(18),
      mensajes: { ...MENSAJES_DEFAULT },
      modulos: plan.modulos,
      topeDia: plan.topeDia,
      topeSemana: plan.topeSemana,
      topeMes: plan.topeMes,
      emailContacto: input.email,
      subscription: {
        create: { medio: input.medio, estadoPago: 'pendiente', diaAbono: localParts(now, timezone).d, vencimiento: now },
      },
      usuario: {
        create: { email: input.email, nombre: input.nombre, passwordHash: await hashPassword(input.password) },
      },
    },
    include: { usuario: true },
  });
  const usuario = tenant.usuario!;
  await registrarAceptacion(deps.prisma, usuario.id, ['terminos', 'privacidad'], evidencia);
  await enviarCorreo(
    deps.correo,
    avisoOrbita(
      input.email,
      'Tu cuenta de Orbita está lista',
      `Hola ${input.nombre}, ya creamos la cuenta de ${input.negocio}.`,
      'Podés recorrer el panel ahora. La IA se habilita cuando se acredita el pago con Mercado Pago.',
      { texto: 'Entrar al panel', url: `${deps.config.PUBLIC_URL}/cuenta` },
    ),
  );
  return { userId: usuario.id, tenantId: tenant.id };
}

export async function login(deps: Deps, raw: unknown) {
  const { email, password: pass } = loginSchema.parse(raw);
  const usuario = await deps.prisma.clientUser.findUnique({ where: { email } });
  if (!usuario || !(await verifyPassword(pass, usuario.passwordHash))) {
    throw new HttpError(401, 'Email o contraseña incorrectos');
  }
  await deps.prisma.clientUser.update({ where: { id: usuario.id }, data: { ultimoLogin: deps.now() } });
  return { userId: usuario.id, tenantId: usuario.tenantId };
}

export async function cambiarPassword(deps: Deps, userId: string, raw: unknown) {
  const { actual, nueva } = z.object({ actual: z.string().min(1), nueva: password }).parse(raw);
  const usuario = await deps.prisma.clientUser.findUniqueOrThrow({ where: { id: userId } });
  if (!(await verifyPassword(actual, usuario.passwordHash))) throw new HttpError(400, 'La contraseña actual no coincide');
  await deps.prisma.clientUser.update({ where: { id: userId }, data: { passwordHash: await hashPassword(nueva) } });
}

/** El equipo genera un link de un solo uso (24 h) y se lo pasa al cliente por el canal que use. */
export async function generarReset(deps: Deps, tenantId: string): Promise<{ link: string; expira: Date }> {
  const usuario = await deps.prisma.clientUser.findUnique({ where: { tenantId } });
  if (!usuario) throw notFound('Cuenta del cliente');
  const token = randomToken(32);
  const expira = addDays(deps.now(), 1);
  await deps.prisma.clientUser.update({
    where: { id: usuario.id },
    data: { resetTokenHash: sha256(token), resetExpira: expira },
  });
  return { link: `${deps.config.PUBLIC_URL}/restablecer/${token}`, expira };
}

/** Siempre responde igual, exista o no la cuenta, para no revelar qué emails están registrados. */
export async function pedirRestablecimiento(deps: Deps, raw: unknown) {
  const { email } = z.object({ email: z.string().trim().toLowerCase().email() }).parse(raw);
  const usuario = await deps.prisma.clientUser.findUnique({ where: { email } });
  if (!usuario) return;
  const { link } = await generarReset(deps, usuario.tenantId);
  await enviarCorreo(
    deps.correo,
    avisoOrbita(
      email,
      'Restablecé tu contraseña de Orbita',
      `Hola ${usuario.nombre}, recibimos un pedido para cambiar la contraseña de tu cuenta.`,
      'El link vence en 24 horas. Si no pediste este cambio, ignorá el mensaje.',
      { texto: 'Elegir una contraseña nueva', url: link },
    ),
  );
}

/** Da acceso a una ficha creada por el equipo: el cliente define su contraseña con el link y acepta los documentos al entrar. */
export async function invitarCliente(deps: Deps, tenantId: string, raw: unknown) {
  const { email, nombre } = z
    .object({ email: z.string().trim().toLowerCase().email(), nombre: z.string().trim().min(2).max(120) })
    .parse(raw);
  const tenant = await getTenant(deps.prisma, tenantId);
  if (tenant.usuario) throw conflict('Este cliente ya tiene una cuenta. Generá un link de restablecimiento.');
  if (await deps.prisma.clientUser.findUnique({ where: { email } })) throw conflict('Ya existe una cuenta con ese email');
  await deps.prisma.clientUser.create({
    data: { tenantId, email, nombre, passwordHash: await hashPassword(randomToken(32)) },
  });
  return generarReset(deps, tenantId);
}

export async function restablecer(deps: Deps, raw: unknown) {
  const { token, password: nueva } = z.object({ token: z.string().min(10), password }).parse(raw);
  const usuario = await deps.prisma.clientUser.findUnique({ where: { resetTokenHash: sha256(token) } });
  if (!usuario?.resetExpira || usuario.resetExpira < deps.now()) {
    throw new HttpError(400, 'El link venció o ya se usó. Pedí uno nuevo al equipo de Orbita.');
  }
  await deps.prisma.clientUser.update({
    where: { id: usuario.id },
    data: { passwordHash: await hashPassword(nueva), resetTokenHash: null, resetExpira: null },
  });
}

export interface Requisitos {
  pago: boolean;
  manychat: boolean;
  canal: boolean;
  prompt: boolean;
}

export function requisitosOnboarding(tenant: TenantFull): Requisitos {
  return {
    pago: tenant.subscription?.estadoPago === 'al_dia',
    manychat: Boolean(tenant.pageId && tenant.appTokenEnc),
    canal: tenant.canales.length > 0,
    prompt: tenant.prompt.trim().length > 0,
  };
}

export function cuentaDto(deps: Deps, tenant: TenantFull, legalPendiente: DocumentoLegal[]) {
  const sub = tenant.subscription;
  const importe = importeDe(tenant);
  const api = `${deps.config.PUBLIC_URL}/api/webhooks/manychat`;
  return {
    usuario: tenant.usuario ? { nombre: tenant.usuario.nombre, email: tenant.usuario.email } : null,
    legalPendiente,
    negocio: {
      id: tenant.id,
      nombre: tenant.nombre,
      rubro: tenant.rubro,
      estado: tenant.estado,
      pausaMotivo: tenant.pausaMotivo,
      timezone: tenant.timezone,
      prompt: tenant.prompt,
      perfil: tenant.perfil,
      mensajes: leerMensajes(tenant.mensajes),
      modulos: tenant.modulos,
      topes: { dia: tenant.topeDia, semana: tenant.topeSemana, mes: tenant.topeMes },
    },
    plan: tenant.plan,
    canales: tenant.canales.map(({ tipo, endpointId, etiqueta }) => ({ tipo, endpointId, etiqueta })),
    manychat: {
      pageId: tenant.pageId,
      appTokenMask: appTokenMaskDe(deps, tenant.appTokenEnc),
      apiKey: tenant.apiKey,
      entrada: `${api}/entrada`,
      salida: `${api}/salida`,
    },
    suscripcion: sub
      ? { medio: sub.medio, estadoPago: sub.estadoPago, vencimiento: sub.vencimiento, importe, mpInitPoint: sub.mpInitPoint }
      : null,
    transferencia: sub?.medio === 'transferencia' ? { alias: deps.config.TRANSFER_ALIAS, importe, concepto: tenant.id } : null,
    onboarding: {
      paso: tenant.onboardingPaso,
      completado: tenant.onboardingCompletado,
      requisitos: requisitosOnboarding(tenant),
    },
  };
}

export async function guardarPerfil(deps: Deps, tenantId: string, raw: unknown) {
  const tenant = await getTenant(deps.prisma, tenantId);
  const perfil = perfilSchema.parse(raw);
  await deps.prisma.tenant.update({
    where: { id: tenantId },
    data: { perfil: perfil as Prisma.InputJsonValue, prompt: compilarPrompt(perfil, tenant.modulos) },
  });
  return getTenant(deps.prisma, tenantId);
}

export const textosSchema = z
  .object({ espera: z.string(), tope: z.string(), handoff: z.string(), recordatorio: z.string() })
  .partial();

export const promptSchema = z.object({ prompt: z.string().max(20_000) });

export const canalesSchema = z.object({ canales: z.array(canalSchema).min(1) });

export const manychatSchema = z.object({ pageId: z.string().trim().min(1), appToken: z.string().trim().min(10) });

export const planSchema = z.object({
  planId: z.enum(PLANES_AUTOGESTION).optional(),
  medio: z.literal('mercadopago').optional(),
});

export async function actualizarManychat(deps: Deps, tenantId: string, raw: unknown) {
  const { pageId, appToken } = manychatSchema.parse(raw);
  await deps.prisma.tenant.update({
    where: { id: tenantId },
    data: { pageId, appTokenEnc: encrypt(appToken, deps.config.ENCRYPTION_KEY) },
  });
  return getTenant(deps.prisma, tenantId);
}

export async function cambiarPlan(deps: Deps, tenantId: string, raw: unknown) {
  const tenant = await getTenant(deps.prisma, tenantId);
  if (tenant.planId === 'personalizado') {
    throw conflict('Tu plan es Personalizado: los cambios se coordinan con el equipo de Orbita');
  }
  return actualizarTenant(deps, tenantId, planSchema.parse(raw));
}

export async function avanzarOnboarding(deps: Deps, tenantId: string, raw: unknown) {
  const { paso } = z.object({ paso: z.number().int().min(0).max(50) }).parse(raw);
  const tenant = await getTenant(deps.prisma, tenantId);
  if (paso > tenant.onboardingPaso) {
    await deps.prisma.tenant.update({ where: { id: tenantId }, data: { onboardingPaso: paso } });
  }
  return getTenant(deps.prisma, tenantId);
}

const FALTANTES: Record<keyof Requisitos, string> = {
  pago: 'el pago del plan acreditado',
  manychat: 'conectar tu cuenta de ManyChat',
  canal: 'cargar al menos un canal',
  prompt: 'contarle a tu IA sobre tu negocio',
};

export async function completarOnboarding(deps: Deps, tenantId: string) {
  const tenant = await getTenant(deps.prisma, tenantId);
  if (tenant.onboardingCompletado) return tenant;
  const req = requisitosOnboarding(tenant);
  const faltan = (Object.keys(req) as (keyof Requisitos)[]).filter((k) => !req[k]);
  if (faltan.length) throw conflict(`Para activar tu IA falta: ${faltan.map((k) => FALTANTES[k]).join(', ')}`);
  await deps.prisma.tenant.update({
    where: { id: tenantId },
    data: { onboardingCompletado: deps.now(), estado: 'activo', pausaMotivo: null },
  });
  return getTenant(deps.prisma, tenantId);
}

export async function pausarPropio(deps: Deps, tenantId: string) {
  const tenant = await getTenant(deps.prisma, tenantId);
  if (!tenant.onboardingCompletado) throw conflict('Primero terminá el tutorial');
  await deps.prisma.tenant.update({ where: { id: tenantId }, data: { estado: 'pausado', pausaMotivo: 'manual' } });
  return getTenant(deps.prisma, tenantId);
}

export async function activarPropio(deps: Deps, tenantId: string) {
  const tenant = await getTenant(deps.prisma, tenantId);
  if (!tenant.onboardingCompletado) throw conflict('Primero terminá el tutorial');
  if (tenant.subscription?.estadoPago !== 'al_dia') throw conflict('Tu IA se activa con el pago al día');
  await deps.prisma.tenant.update({ where: { id: tenantId }, data: { estado: 'activo', pausaMotivo: null } });
  return getTenant(deps.prisma, tenantId);
}
