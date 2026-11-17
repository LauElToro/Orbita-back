import { randomBytes } from 'node:crypto';
import { Prisma, type ComisionEstado } from '@prisma/client';
import { z } from 'zod';
import type { Deps } from '../deps';
import { avisoOrbita, enviarCorreo } from '../correo/correo';
import { randomToken, sha256 } from '../lib/crypto';
import { addDays } from '../lib/dates';
import { conflict, HttpError, notFound } from '../lib/errors';
import { hashPassword, verifyPassword } from '../lib/password';
import { slugify } from '../lib/slug';

/** Porción del primer pago de un referido que le corresponde al afiliado. */
export const COMISION_REFERIDO = 0.5;

const email = z.string().trim().toLowerCase().email();
const password = z.string().min(8, 'La contraseña necesita al menos 8 caracteres').max(200);

export const registroAfiliadoSchema = z.object({
  nombre: z.string().trim().min(2).max(120),
  email,
  password,
  aceptaTerminos: z.literal(true, { errorMap: () => ({ message: 'Tenés que aceptar los Términos del programa' }) }),
});

async function codigoDisponible(deps: Deps, nombre: string): Promise<string> {
  const base = slugify(nombre, 16) || 'socio';
  for (;;) {
    const codigo = `${base}-${randomBytes(2).toString('hex')}`;
    if (!(await deps.prisma.affiliate.findUnique({ where: { codigo }, select: { id: true } }))) return codigo;
  }
}

export async function registrarAfiliado(deps: Deps, raw: unknown) {
  const input = registroAfiliadoSchema.parse(raw);
  if (await deps.prisma.affiliate.findUnique({ where: { email: input.email } })) {
    throw conflict('Ya existe un afiliado con ese email');
  }
  const afiliado = await deps.prisma.affiliate.create({
    data: {
      email: input.email,
      nombre: input.nombre,
      passwordHash: await hashPassword(input.password),
      codigo: await codigoDisponible(deps, input.nombre),
      aceptaTerminos: deps.now(),
    },
  });
  await enviarCorreo(
    deps.correo,
    avisoOrbita(
      input.email,
      'Bienvenido al programa de afiliados de Orbita',
      `Hola ${input.nombre}, ya tenés tu link de referidos.`,
      `Por cada comercio que contrate un plan con tu link te llevás el ${COMISION_REFERIDO * 100}% de su primer pago.`,
      { texto: 'Ver mi panel', url: `${deps.config.PUBLIC_URL}/afiliados/panel` },
    ),
  );
  return afiliado;
}

export async function loginAfiliado(deps: Deps, raw: unknown) {
  const input = z.object({ email, password: z.string().min(1) }).parse(raw);
  const afiliado = await deps.prisma.affiliate.findUnique({ where: { email: input.email } });
  if (!afiliado || !(await verifyPassword(input.password, afiliado.passwordHash))) {
    throw new HttpError(401, 'Email o contraseña incorrectos');
  }
  return afiliado;
}

/** Siempre responde igual, exista o no, para no revelar qué emails están registrados. */
export async function pedirRestablecimientoAfiliado(deps: Deps, raw: unknown) {
  const input = z.object({ email }).parse(raw);
  const afiliado = await deps.prisma.affiliate.findUnique({ where: { email: input.email } });
  if (!afiliado) return;
  const token = randomToken(32);
  await deps.prisma.affiliate.update({
    where: { id: afiliado.id },
    data: { resetTokenHash: sha256(token), resetExpira: addDays(deps.now(), 1) },
  });
  await enviarCorreo(
    deps.correo,
    avisoOrbita(
      input.email,
      'Restablecé tu contraseña de afiliado',
      `Hola ${afiliado.nombre}, recibimos un pedido para cambiar tu contraseña.`,
      'El link vence en 24 horas. Si no pediste este cambio, ignorá el mensaje.',
      { texto: 'Elegir una contraseña nueva', url: `${deps.config.PUBLIC_URL}/afiliados/restablecer/${token}` },
    ),
  );
}

export async function restablecerAfiliado(deps: Deps, raw: unknown) {
  const input = z.object({ token: z.string().min(10), password }).parse(raw);
  const afiliado = await deps.prisma.affiliate.findUnique({ where: { resetTokenHash: sha256(input.token) } });
  if (!afiliado?.resetExpira || afiliado.resetExpira < deps.now()) {
    throw new HttpError(400, 'El link venció o ya se usó. Pedí uno nuevo.');
  }
  await deps.prisma.affiliate.update({
    where: { id: afiliado.id },
    data: { passwordHash: await hashPassword(input.password), resetTokenHash: null, resetExpira: null },
  });
}

export async function datosCobro(deps: Deps, affiliateId: string, raw: unknown) {
  const input = z.object({ datosCobro: z.string().trim().max(300).nullable() }).parse(raw);
  await deps.prisma.affiliate.update({
    where: { id: affiliateId },
    data: { datosCobro: input.datosCobro || null },
  });
}

export async function panelAfiliado(deps: Deps, affiliateId: string) {
  const afiliado = await deps.prisma.affiliate.findUnique({
    where: { id: affiliateId },
    include: {
      referidos: { orderBy: { createdAt: 'desc' }, include: { tenant: { select: { nombre: true, planElegido: true, plan: { select: { nombre: true } } } } } },
      comisiones: { orderBy: { createdAt: 'desc' } },
    },
  });
  if (!afiliado) throw notFound('Afiliado');
  const total = (estado: ComisionEstado) =>
    afiliado.comisiones.filter((c) => c.estado === estado).reduce((s, c) => s + c.importe, 0);
  const pagaron = new Set(afiliado.comisiones.map((c) => c.tenantId));
  return {
    nombre: afiliado.nombre,
    email: afiliado.email,
    codigo: afiliado.codigo,
    link: `${deps.config.PUBLIC_URL}/?ref=${afiliado.codigo}`,
    porcentaje: COMISION_REFERIDO * 100,
    datosCobro: afiliado.datosCobro,
    totales: { pendiente: total('pendiente'), pagada: total('pagada') },
    referidos: afiliado.referidos.map((r) => ({
      id: r.id,
      negocio: r.tenant.nombre,
      plan: r.tenant.planElegido ? r.tenant.plan.nombre : null,
      pago: pagaron.has(r.tenantId),
      createdAt: r.createdAt,
    })),
    comisiones: afiliado.comisiones.map((c) => ({
      id: c.id,
      importe: c.importe,
      estado: c.estado,
      pagadaEn: c.pagadaEn,
      createdAt: c.createdAt,
    })),
  };
}

/** Vincula una cuenta nueva con el afiliado del código. Un código desconocido o propio se ignora sin cortar el alta. */
export async function atribuirReferido(deps: Deps, tenantId: string, emailCliente: string, codigo: string) {
  const afiliado = await deps.prisma.affiliate.findUnique({ where: { codigo: codigo.trim().toLowerCase() } });
  if (!afiliado || afiliado.email === emailCliente.toLowerCase()) return;
  await deps.prisma.referral.create({ data: { affiliateId: afiliado.id, tenantId } });
}

/**
 * Genera la comisión del primer pago de un referido. El plan Personalizado no comisiona.
 * El índice único por tenant evita duplicados si dos pagos llegan a la vez.
 */
export async function comisionarPrimerPago(deps: Deps, tenantId: string, payment: { id: string; importe: number }) {
  const referido = await deps.prisma.referral.findUnique({
    where: { tenantId },
    include: { tenant: { select: { planId: true } } },
  });
  if (!referido || referido.tenant.planId === 'personalizado') return null;
  const anteriores = await deps.prisma.payment.count({ where: { tenantId, id: { not: payment.id } } });
  if (anteriores > 0) return null;
  try {
    return await deps.prisma.commission.create({
      data: {
        affiliateId: referido.affiliateId,
        tenantId,
        paymentId: payment.id,
        importe: Math.round(payment.importe * COMISION_REFERIDO),
      },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return null;
    throw err;
  }
}

export async function listarAfiliados(deps: Deps) {
  const afiliados = await deps.prisma.affiliate.findMany({
    orderBy: { createdAt: 'desc' },
    include: { _count: { select: { referidos: true } }, comisiones: { select: { importe: true, estado: true } } },
  });
  return afiliados.map((a) => {
    const suma = (estado: ComisionEstado) =>
      a.comisiones.filter((c) => c.estado === estado).reduce((s, c) => s + c.importe, 0);
    return {
      id: a.id,
      nombre: a.nombre,
      email: a.email,
      codigo: a.codigo,
      datosCobro: a.datosCobro,
      referidos: a._count.referidos,
      pendiente: suma('pendiente'),
      pagada: suma('pagada'),
      createdAt: a.createdAt,
    };
  });
}

export async function listarComisiones(deps: Deps, raw: unknown) {
  const { estado } = z.object({ estado: z.enum(['pendiente', 'pagada', 'anulada']).optional() }).parse(raw ?? {});
  const comisiones = await deps.prisma.commission.findMany({
    where: estado ? { estado } : {},
    orderBy: { createdAt: 'desc' },
    include: {
      affiliate: { select: { nombre: true, email: true, datosCobro: true } },
      tenant: { select: { id: true, nombre: true } },
      payment: { select: { importe: true, medio: true, createdAt: true } },
    },
  });
  return comisiones;
}

export async function cambiarEstadoComision(deps: Deps, id: string, estado: 'pagada' | 'anulada') {
  const comision = await deps.prisma.commission.findUnique({ where: { id } });
  if (!comision) throw notFound('Comisión');
  if (comision.estado !== 'pendiente') throw conflict(`La comisión ya está ${comision.estado}`);
  return deps.prisma.commission.update({
    where: { id },
    data: { estado, pagadaEn: estado === 'pagada' ? deps.now() : null },
  });
}
