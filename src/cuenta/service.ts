import { randomBytes } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import type { Deps } from '../deps';
import { atribuirReferido } from '../afiliados/service';
import { compilarPrompt, perfilSchema } from '../ai/perfil';
import { cancelarSuscripcionVieja } from '../billing/mercadopago';
import { iniciarSuscripcionMp } from '../billing/service';
import { randomToken, sha256 } from '../lib/crypto';
import { addDays, localParts } from '../lib/dates';
import { badRequest, conflict, HttpError, notFound } from '../lib/errors';
import { hashPassword, verifyPassword } from '../lib/password';
import { slugify } from '../lib/slug';
import { documentosPendientes, registrarAceptacion, type Evidencia, type DocumentoLegal } from '../legal/legal';
import { MENSAJES_DEFAULT, leerMensajes } from '../tenants/defaults';
import { getTenant, type TenantFull } from '../tenants/repo';
import { enviarCorreo } from '../correo/correo';
import { avisarSesion } from '../correo/envios';
import { mensajeBienvenida, mensajeBienvenidaGoogle, mensajeDefinirContrasena, mensajeRestablecer } from '../correo/plantillas';
import { actualizarTenant, canalesDto, canalSchema, importeDe } from '../tenants/service';
import { metaListo } from '../messaging/whatsapp';
import type { ResumenExtra } from '../usage/usage';
import { webDto } from '../web/service';

const PLANES_AUTOGESTION = ['mensajes', 'turnos', 'completo'] as const;
const password = z.string().min(8, 'La contraseña necesita al menos 8 caracteres').max(200);
const aceptar = (msg: string) => z.literal(true, { errorMap: () => ({ message: msg }) });
const refSchema = z.string().trim().max(40).optional();

export const registroSchema = z.object({
  negocio: z.string().trim().min(2).max(120),
  rubro: z.string().trim().min(2).max(80),
  nombre: z.string().trim().min(2).max(120),
  email: z.string().trim().toLowerCase().email(),
  password,
  planId: z.enum(PLANES_AUTOGESTION).optional(),
  medio: z.literal('mercadopago').default('mercadopago'),
  aceptaTerminos: aceptar('Tenés que aceptar los Términos y Condiciones'),
  aceptaPrivacidad: aceptar('Tenés que aceptar la Política de Privacidad'),
  ref: refSchema,
});

export const loginSchema = z.object({ email: z.string().trim().toLowerCase().email(), password: z.string().min(1) });

async function idDisponible(deps: Deps, negocio: string): Promise<string> {
  const base = slugify(negocio) || 'negocio';
  const libre = !(await deps.prisma.tenant.findUnique({ where: { id: base }, select: { id: true } }));
  return libre ? base : `${base}-${randomBytes(2).toString('hex')}`;
}

interface NuevaCuenta {
  slug: string;
  negocio: string;
  rubro: string | null;
  nombre: string;
  email: string;
  password: string;
  planId?: (typeof PLANES_AUTOGESTION)[number];
  ref?: string;
}

/**
 * La ficha nace pausada (motivo onboarding) hasta que pague y termine el tutorial.
 * Sin plan, la ficha guarda el más chico solo para cumplir la relación y `planElegido` queda en false hasta que elija.
 */
async function crearCuenta(deps: Deps, datos: NuevaCuenta) {
  if (await deps.prisma.clientUser.findUnique({ where: { email: datos.email } })) {
    throw conflict('Ya existe una cuenta con ese email');
  }
  const plan = await deps.prisma.plan.findUniqueOrThrow({ where: { id: datos.planId ?? 'mensajes' } });
  const id = await idDisponible(deps, datos.slug);
  const timezone = 'America/Argentina/Buenos_Aires';
  const now = deps.now();

  const tenant = await deps.prisma.tenant.create({
    data: {
      id,
      nombre: datos.negocio,
      rubro: datos.rubro,
      estado: 'pausado',
      pausaMotivo: 'onboarding',
      planId: plan.id,
      planElegido: Boolean(datos.planId),
      timezone,
      publicToken: randomToken(18),
      mensajes: { ...MENSAJES_DEFAULT },
      modulos: plan.modulos,
      topeDia: plan.topeDia,
      topeSemana: plan.topeSemana,
      topeMes: plan.topeMes,
      emailContacto: datos.email,
      subscription: {
        create: { medio: 'mercadopago', estadoPago: 'pendiente', diaAbono: localParts(now, timezone).d, vencimiento: now },
      },
      usuario: {
        create: { email: datos.email, nombre: datos.nombre, passwordHash: await hashPassword(datos.password) },
      },
    },
    include: { usuario: true },
  });
  if (datos.ref) await atribuirReferido(deps, tenant.id, datos.email, datos.ref);
  return { tenantId: tenant.id, usuario: tenant.usuario! };
}

export async function registrar(deps: Deps, raw: unknown, evidencia: Evidencia) {
  const input = registroSchema.parse(raw);
  const { usuario } = await crearCuenta(deps, {
    slug: input.negocio,
    negocio: input.negocio,
    rubro: input.rubro,
    nombre: input.nombre,
    email: input.email,
    password: input.password,
    planId: input.planId,
    ref: input.ref,
  });
  await registrarAceptacion(deps.prisma, usuario.id, ['terminos', 'privacidad'], evidencia);
  await enviarCorreo(deps.correo, mensajeBienvenida({ email: input.email, nombre: input.nombre }, input.negocio, deps.config.PUBLIC_URL));
  return { userId: usuario.id, tenantId: usuario.tenantId };
}

/** Alta con Google: nombre y email vienen de la cuenta. El negocio y el plan se completan después. */
export async function registrarConGoogle(deps: Deps, perfil: { email: string; nombre: string }, ref?: string) {
  const nombre = perfil.nombre.trim().length >= 2 ? perfil.nombre.trim() : 'Titular';
  const { usuario } = await crearCuenta(deps, {
    slug: nombre,
    negocio: 'Mi negocio',
    rubro: null,
    nombre,
    email: perfil.email,
    password: randomToken(24),
    ref,
  });
  await enviarCorreo(deps.correo, mensajeBienvenidaGoogle({ email: perfil.email, nombre }, deps.config.PUBLIC_URL));
  return { userId: usuario.id, tenantId: usuario.tenantId };
}

export const checkoutSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  planId: z.enum(PLANES_AUTOGESTION),
  aceptaTerminos: aceptar('Tenés que aceptar los Términos y Condiciones'),
  aceptaPrivacidad: aceptar('Tenés que aceptar la Política de Privacidad'),
  ref: refSchema,
});

const DIAS_LINK_CHECKOUT = 7;

/**
 * Checkout sin sesión: con el email alcanza para crear la cuenta e ir a Mercado Pago.
 * La contraseña se define después con el link que llega por mail.
 * Si la cuenta ya existe pero nunca pagó, se retoma el checkout (con el plan elegido ahora).
 */
export async function checkoutPublico(deps: Deps, raw: unknown, evidencia: Evidencia) {
  const input = checkoutSchema.parse(raw);
  const existente = await deps.prisma.clientUser.findUnique({ where: { email: input.email } });
  let tenantId: string;
  if (existente) {
    const tenant = await getTenant(deps.prisma, existente.tenantId);
    const pagos = await deps.prisma.payment.count({ where: { tenantId: tenant.id } });
    if (pagos > 0 || tenant.planId === 'personalizado' || tenant.subscription?.estadoPago !== 'pendiente') {
      throw conflict('Ya tenés una cuenta con ese email. Ingresá para gestionar tu plan.');
    }
    tenantId = tenant.id;
    await cambiarPlan(deps, tenantId, { planId: input.planId });
    const pendientes = await documentosPendientes(deps.prisma, existente.id);
    if (pendientes.length) await registrarAceptacion(deps.prisma, existente.id, pendientes, evidencia);
  } else {
    const { usuario } = await crearCuenta(deps, {
      slug: input.email.split('@')[0],
      negocio: 'Mi negocio',
      rubro: null,
      nombre: 'Titular',
      email: input.email,
      password: randomToken(24),
      planId: input.planId,
      ref: input.ref,
    });
    tenantId = usuario.tenantId;
    await registrarAceptacion(deps.prisma, usuario.id, ['terminos', 'privacidad'], evidencia);
  }

  const { link } = await generarReset(deps, tenantId, DIAS_LINK_CHECKOUT);
  await enviarCorreo(deps.correo, mensajeDefinirContrasena(input.email, link, DIAS_LINK_CHECKOUT));
  const tenant = await getTenant(deps.prisma, tenantId);
  return iniciarSuscripcionMp(deps, tenant, input.email, `${deps.config.PUBLIC_URL}/checkout/gracias`);
}

const datosNegocioSchema = z.object({
  nombre: z.string().trim().min(2).max(120),
  rubro: z.string().trim().min(2).max(80),
});

export async function guardarDatosNegocio(deps: Deps, tenantId: string, raw: unknown) {
  const { nombre, rubro } = datosNegocioSchema.parse(raw);
  await deps.prisma.tenant.update({ where: { id: tenantId }, data: { nombre, rubro } });
  return getTenant(deps.prisma, tenantId);
}

export async function login(deps: Deps, raw: unknown, ip?: string) {
  const { email, password: pass } = loginSchema.parse(raw);
  const usuario = await deps.prisma.clientUser.findUnique({ where: { email } });
  if (!usuario || !(await verifyPassword(pass, usuario.passwordHash))) {
    throw new HttpError(401, 'Email o contraseña incorrectos');
  }
  await deps.prisma.clientUser.update({ where: { id: usuario.id }, data: { ultimoLogin: deps.now() } });
  void avisarSesion(deps, usuario, ip);
  return { userId: usuario.id, tenantId: usuario.tenantId };
}

export async function cambiarPassword(deps: Deps, userId: string, raw: unknown) {
  const { actual, nueva } = z.object({ actual: z.string().min(1), nueva: password }).parse(raw);
  const usuario = await deps.prisma.clientUser.findUniqueOrThrow({ where: { id: userId } });
  if (!(await verifyPassword(actual, usuario.passwordHash))) throw new HttpError(400, 'La contraseña actual no coincide');
  await deps.prisma.clientUser.update({ where: { id: userId }, data: { passwordHash: await hashPassword(nueva) } });
}

/** El equipo genera un link de un solo uso (24 h) y se lo pasa al cliente por el canal que use. */
export async function generarReset(deps: Deps, tenantId: string, dias = 1): Promise<{ link: string; expira: Date }> {
  const usuario = await deps.prisma.clientUser.findUnique({ where: { tenantId } });
  if (!usuario) throw notFound('Cuenta del cliente');
  const token = randomToken(32);
  const expira = addDays(deps.now(), dias);
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
  await enviarCorreo(deps.correo, mensajeRestablecer(usuario, link));
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
  canal: boolean;
  prompt: boolean;
}

export function requisitosOnboarding(tenant: TenantFull): Requisitos {
  return {
    pago: tenant.subscription?.estadoPago === 'al_dia',
    canal: tenant.canales.some((c) => c.tokenEnc) || tenant.webActiva,
    prompt: tenant.prompt.trim().length > 0,
  };
}

export function cuentaDto(deps: Deps, tenant: TenantFull, legalPendiente: DocumentoLegal[], extras?: ResumenExtra) {
  const sub = tenant.subscription;
  const importe = importeDe(tenant);
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
    planPendiente: tenant.planPendiente,
    planElegido: tenant.planElegido,
    canales: canalesDto(deps, tenant.canales),
    web: webDto(deps, tenant),
    whatsapp: {
      listo: metaListo(deps),
      appId: deps.config.META_APP_ID,
      configId: deps.config.META_EMBEDDED_CONFIG_ID,
      version: deps.config.META_API_VERSION,
    },
    redes: {
      facebook: { listo: deps.redes.listo('facebook') },
      instagram: { listo: deps.redes.listo('instagram') },
      tiktok: { listo: deps.redes.listo('tiktok') },
    },
    calendario: { conectado: Boolean(tenant.calendario), email: tenant.calendario?.email ?? null },
    extras: extras ?? null,
    suscripcion: sub
      ? {
          medio: sub.medio,
          estadoPago: sub.estadoPago,
          vencimiento: sub.vencimiento,
          importe,
          mpInitPoint: sub.mpInitPoint,
          debitoActivo: sub.mpEstado === 'authorized',
          canceladaEn: sub.canceladaEn,
        }
      : null,
    referido: tenant.referido ? { codigo: tenant.referido.affiliate.codigo } : null,
    referidoEditable: !tenant.referido && tenant._count.payments === 0,
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

export const promptSchema = z.object({ prompt: z.string().max(60_000) });

export const canalesSchema = z.object({ canales: z.array(canalSchema).min(1) });

export const planSchema = z.object({
  planId: z.enum(PLANES_AUTOGESTION).optional(),
  medio: z.literal('mercadopago').optional(),
});

export async function cambiarPlan(deps: Deps, tenantId: string, raw: unknown) {
  const tenant = await getTenant(deps.prisma, tenantId);
  if (tenant.planId === 'personalizado') {
    throw conflict('Tu plan es Personalizado: los cambios se coordinan con el equipo de Orbita');
  }
  const input = planSchema.parse(raw);
  if (!tenant.planElegido) {
    const actualizado = await actualizarTenant(deps, tenantId, input);
    if (!input.planId) return actualizado;
    await deps.prisma.tenant.update({ where: { id: tenantId }, data: { planElegido: true } });
    return getTenant(deps.prisma, tenantId);
  }
  if (input.medio) await actualizarTenant(deps, tenantId, { medio: input.medio });
  if (input.planId) await programarPlan(deps, tenantId, input.planId);
  return getTenant(deps.prisma, tenantId);
}

/**
 * El plan nuevo no se aplica hasta que se acredita un pago por su importe (ver `registrarPago`).
 * Volver a elegir el plan vigente descarta el cambio pendiente.
 */
async function programarPlan(deps: Deps, tenantId: string, planId: string) {
  const tenant = await getTenant(deps.prisma, tenantId);
  const pendienteId = planId === tenant.planId ? null : planId;
  if (pendienteId === tenant.planPendienteId) return;
  if (pendienteId) {
    const plan = await deps.prisma.plan.findUnique({ where: { id: pendienteId } });
    if (!plan) throw notFound('Plan');
    if (tenant.canales.length > plan.maxCanales) {
      throw badRequest(`El plan ${plan.nombre} admite hasta ${plan.maxCanales} canal(es). Sacá un canal antes de cambiar.`);
    }
  }
  const mpViejo = tenant.subscription?.mpPreapprovalId;
  await deps.prisma.tenant.update({
    where: { id: tenantId },
    data: {
      planPendiente: pendienteId ? { connect: { id: pendienteId } } : { disconnect: true },
      ...(tenant.subscription
        ? { subscription: { update: { mpPreapprovalId: null, mpInitPoint: null, mpEstado: null } } }
        : {}),
    },
  });
  if (mpViejo) await cancelarSuscripcionVieja(deps.mercadopago, mpViejo);
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
  canal: 'conectar al menos un canal con su token o activar la integración web',
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
