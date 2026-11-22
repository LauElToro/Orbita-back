import type { MedioPago } from '@prisma/client';
import type { SuscripcionMp } from './mercadopago';
import type { Deps } from '../deps';
import { comisionarPrimerPago } from '../afiliados/service';
import { addDays, addMonths, localParts } from '../lib/dates';
import { conflict, HttpError, notFound } from '../lib/errors';
import { getTenant, type TenantFull } from '../tenants/repo';
import { correoPlan } from '../correo/campanas';
import { mensajeCompra } from '../correo/plantillas';
import { enviarCorreo } from '../correo/correo';
import { datosDePlan, importeDe, planACobrar } from '../tenants/service';
import { resumenExtras } from '../usage/usage';

export const DIAS_GRACIA = 7;
export const DIAS_ACREDITACION_MP = 18;

export interface PagoInput {
  medio: MedioPago;
  importe?: number;
  externalId?: string;
  fecha?: Date;
}

/** Registra un pago, corre el vencimiento un mes y reactiva la ficha si estaba pausada por impago. */
export async function registrarPago(deps: Deps, tenantId: string, pago: PagoInput) {
  const tenant = await getTenant(deps.prisma, tenantId);
  const sub = tenant.subscription;
  if (!sub) throw notFound('Suscripción');
  if (pago.externalId) {
    const ya = await deps.prisma.payment.findUnique({ where: { externalId: pago.externalId } });
    if (ya) return ya;
  }

  const now = pago.fecha ?? deps.now();
  // El primer pago, o uno después de atrasarse más de un mes, arranca el ciclo ese día para coincidir con el débito de Mercado Pago.
  const pagosPrevios = await deps.prisma.payment.count({ where: { tenantId } });
  const reinicia = pagosPrevios === 0 || addMonths(sub.vencimiento, 1, sub.diaAbono) <= now;
  const diaAbono = reinicia ? localParts(now, tenant.timezone).d : sub.diaAbono;
  const desde = reinicia ? now : sub.vencimiento;
  const nuevoVencimiento = addMonths(desde, 1, diaAbono);
  const alDia = nuevoVencimiento > deps.now();
  const importe = pago.importe ?? importeDe(tenant);
  // Un cobro viejo por el importe anterior no alcanza para pasar al plan pendiente.
  const nuevoPlan = tenant.planPendiente && importe >= importeDe(tenant) ? tenant.planPendiente : null;

  const [payment] = await deps.prisma.$transaction([
    deps.prisma.payment.create({
      data: {
        tenantId,
        medio: pago.medio,
        importe,
        periodo: desde.toISOString().slice(0, 10),
        externalId: pago.externalId ?? null,
        acreditaEn: pago.medio === 'mercadopago' ? addDays(now, DIAS_ACREDITACION_MP) : now,
      },
    }),
    deps.prisma.subscription.update({
      where: { tenantId },
      data: { vencimiento: nuevoVencimiento, diaAbono, estadoPago: alDia ? 'al_dia' : 'pendiente', canceladaEn: null },
    }),
    deps.prisma.tenant.update({
      where: { id: tenantId },
      data: {
        ...(alDia && tenant.estado === 'pausado' && (tenant.pausaMotivo === 'impago' || tenant.pausaMotivo === 'baja')
          ? { estado: 'activo', pausaMotivo: null }
          : {}),
        ...(nuevoPlan ? { ...datosDePlan(nuevoPlan), planPendiente: { disconnect: true } } : {}),
      },
    }),
  ]);
  await comisionarPrimerPago(deps, tenantId, payment, now);
  const email = tenant.usuario?.email;
  if (email) {
    await enviarCorreo(
      deps.correo,
      mensajeCompra(
        { email, nombre: tenant.usuario?.nombre ?? tenant.nombre },
        tenant.nombre,
        (nuevoPlan ?? tenant.plan).nombre,
        payment.importe,
        nuevoVencimiento,
        pagosPrevios === 0,
        deps.config.PUBLIC_URL,
      ),
    );
  }
  return payment;
}

/** Crea (una sola vez) la suscripción mensual de Mercado Pago y devuelve el link para aprobar el débito. */
export async function iniciarSuscripcionMp(deps: Deps, tenant: TenantFull, email: string | undefined, backUrl: string) {
  const sub = tenant.subscription;
  if (!sub) throw notFound('Suscripción');
  // Sin pagos, la baja cierra la cuenta: no hay período que seguir cobrando.
  // Con un período ya pago, se puede volver a suscribir recién cuando ese período termina.
  if (sub.canceladaEn && (tenant._count.payments === 0 || sub.vencimiento > deps.now())) {
    throw new HttpError(
      409,
      tenant._count.payments === 0
        ? 'Este plan está dado de baja. Como no llegaste a pagar, no hay nada que cobrar.'
        : 'La baja ya está hecha. El plan sigue hasta el vencimiento y no se vuelve a cobrar.',
    );
  }
  if (!tenant.planElegido) throw new HttpError(409, 'Elegí un plan antes de pagar');
  if (sub.mpInitPoint) return { initPoint: sub.mpInitPoint };
  if (!deps.mercadopago.habilitado) throw new HttpError(503, 'Mercado Pago no está configurado');

  const payerEmail = tenant.emailContacto ?? email;
  if (!payerEmail) throw new HttpError(400, 'Necesitamos un email para la suscripción');

  const { id, initPoint } = await deps.mercadopago.crearSuscripcion({
    reason: `Orbita - Plan ${planACobrar(tenant).nombre} - ${tenant.nombre}`,
    externalReference: tenant.id,
    payerEmail,
    importe: importeDe(tenant),
    backUrl,
  });
  await deps.prisma.subscription.update({
    where: { tenantId: tenant.id },
    data: { mpPreapprovalId: id, mpInitPoint: initPoint, mpEstado: 'pending' },
  });
  if (!tenant.emailContacto) {
    await deps.prisma.tenant.update({ where: { id: tenant.id }, data: { emailContacto: payerEmail } });
  }
  return { initPoint };
}

/**
 * Aviso de Mercado Pago sobre el débito automático (authorized, paused o cancelled).
 * Si el cliente lo cancela desde Mercado Pago se olvida el link, así puede volver a suscribirse.
 */
export async function actualizarEstadoSuscripcion(deps: Deps, suscripcion: SuscripcionMp) {
  const sub = await deps.prisma.subscription.findUnique({ where: { mpPreapprovalId: suscripcion.id } });
  if (!sub) return null;
  if (sub.mpEstado === suscripcion.estado) return sub;
  return deps.prisma.subscription.update({
    where: { tenantId: sub.tenantId },
    data:
      suscripcion.estado === 'cancelled'
        ? { mpEstado: 'cancelled', mpPreapprovalId: null, mpInitPoint: null }
        : { mpEstado: suscripcion.estado },
  });
}

export const DIAS_LINK_SIN_APROBAR = 30;

/**
 * Por si un aviso de Mercado Pago no llega: revisa las suscripciones vencidas o por vencer
 * (incluye las que todavía no tuvieron el primer pago) y registra los cobros aprobados.
 */
export async function conciliarMercadoPago(deps: Deps): Promise<{ revisadas: number; pagos: number }> {
  if (!deps.mercadopago.habilitado) return { revisadas: 0, pagos: 0 };
  const now = deps.now();
  const subs = await deps.prisma.subscription.findMany({
    where: {
      medio: 'mercadopago',
      mpPreapprovalId: { not: null },
      vencimiento: { lt: addDays(now, 1) },
      OR: [{ mpEstado: null }, { mpEstado: { not: 'pending' } }, { updatedAt: { gt: addDays(now, -DIAS_LINK_SIN_APROBAR) } }],
    },
    select: { tenantId: true, mpPreapprovalId: true },
  });
  let pagos = 0;
  for (const { tenantId, mpPreapprovalId } of subs) {
    try {
      const cobros = (await deps.mercadopago.listarPagosSuscripcion(mpPreapprovalId!))
        .filter((p) => p.aprobado)
        .sort((a, b) => a.fecha.getTime() - b.fecha.getTime());
      for (const cobro of cobros) {
        const externalId = `mp:${cobro.id}`;
        if (await deps.prisma.payment.findUnique({ where: { externalId } })) continue;
        await registrarPago(deps, tenantId, { medio: 'mercadopago', importe: cobro.importe, externalId, fecha: cobro.fecha });
        pagos++;
      }
      await actualizarEstadoSuscripcion(deps, await deps.mercadopago.obtenerSuscripcion(mpPreapprovalId!));
    } catch (err) {
      console.error(`no se pudo conciliar la suscripción de ${tenantId}`, err);
    }
  }
  return { revisadas: subs.length, pagos };
}

/**
 * La baja corta el débito al instante.
 * Si nunca hubo un pago, cierra la cuenta en el momento y no queda nada por cobrar.
 * Si el período ya está pago, el plan sigue hasta el vencimiento y después no se vuelve a cobrar.
 */
export async function darDeBaja(deps: Deps, tenantId: string) {
  const tenant = await getTenant(deps.prisma, tenantId);
  const sub = tenant.subscription;
  if (!sub) throw notFound('Suscripción');
  if (sub.canceladaEn) return tenant;
  if (sub.mpPreapprovalId) {
    if (!deps.mercadopago.habilitado) throw new HttpError(503, 'Mercado Pago no está configurado');
    await deps.mercadopago.cancelarSuscripcion(sub.mpPreapprovalId);
  }
  const nuncaPago = tenant._count.payments === 0;
  await deps.prisma.$transaction([
    deps.prisma.subscription.update({
      where: { tenantId },
      data: {
        canceladaEn: deps.now(),
        mpEstado: 'cancelled',
        mpPreapprovalId: null,
        mpInitPoint: null,
        ...(nuncaPago ? { estadoPago: 'impago' as const } : {}),
      },
    }),
    ...(nuncaPago
      ? [deps.prisma.tenant.update({ where: { id: tenantId }, data: { estado: 'pausado', pausaMotivo: 'baja' } })]
      : []),
  ]);
  return getTenant(deps.prisma, tenantId);
}

/** Vuelve a abrir un plan que se dio de baja sin haber pagado nunca, para poder contratarlo. */
export async function recontratar(deps: Deps, tenantId: string) {
  const tenant = await getTenant(deps.prisma, tenantId);
  const sub = tenant.subscription;
  if (!sub) throw notFound('Suscripción');
  if (!sub.canceladaEn) return tenant;
  if (tenant._count.payments > 0) {
    throw new HttpError(409, 'Este plan ya tuvo un pago. Cuando vence, podés suscribirte de nuevo.');
  }
  await deps.prisma.$transaction([
    deps.prisma.subscription.update({
      where: { tenantId },
      data: { canceladaEn: null, estadoPago: 'pendiente', mpEstado: null },
    }),
    ...(tenant.pausaMotivo === 'baja'
      ? [deps.prisma.tenant.update({ where: { id: tenantId }, data: { estado: 'pausado', pausaMotivo: 'onboarding' } })]
      : []),
  ]);
  return getTenant(deps.prisma, tenantId);
}

/** Link de Mercado Pago para el cargo de mensajes extra, separado del abono. */
export async function iniciarCobroExtra(deps: Deps, tenant: TenantFull) {
  const resumen = await resumenExtras(deps, tenant);
  if (resumen.pendiente <= 0) throw conflict('No hay mensajes extra para cobrar');
  if (!deps.mercadopago.habilitado) throw new HttpError(503, 'Mercado Pago no está configurado');
  const email = tenant.emailContacto ?? tenant.usuario?.email ?? undefined;
  return deps.mercadopago.crearPreferencia({
    titulo: `Orbita - mensajes extra de ${tenant.nombre}`,
    externalReference: `extra:${tenant.id}:${resumen.periodo}`,
    importe: resumen.pendiente,
    payerEmail: email,
    backUrl: `${deps.config.PUBLIC_URL}/cuenta/plan`,
  });
}

export async function pausar(deps: Deps, tenantId: string) {
  await getTenant(deps.prisma, tenantId);
  await deps.prisma.tenant.update({ where: { id: tenantId }, data: { estado: 'pausado', pausaMotivo: 'manual' } });
  return getTenant(deps.prisma, tenantId);
}

export async function activar(deps: Deps, tenantId: string) {
  const tenant = await getTenant(deps.prisma, tenantId);
  if (tenant.subscription?.estadoPago !== 'al_dia') {
    throw conflict('Solo se puede activar con el pago al día');
  }
  await deps.prisma.tenant.update({ where: { id: tenantId }, data: { estado: 'activo', pausaMotivo: null } });
  return getTenant(deps.prisma, tenantId);
}

/** Corre cada hora: vencido pasa a pendiente; vencido hace más de 7 días pasa a impago y pausa el bot. */
export async function revisarVencimientos(deps: Deps): Promise<{ pendientes: number; impagos: number }> {
  const now = deps.now();
  const aCerrar = await deps.prisma.subscription.findMany({
    where: {
      canceladaEn: { not: null },
      vencimiento: { lt: now },
      // `not: 'baja'` no incluye el null: una ficha activa no tiene motivo de pausa.
      OR: [{ tenant: { pausaMotivo: null } }, { tenant: { pausaMotivo: { not: 'baja' } } }],
    },
    select: { tenantId: true },
  });
  for (const { tenantId } of aCerrar) {
    await deps.prisma.$transaction([
      deps.prisma.subscription.update({ where: { tenantId }, data: { estadoPago: 'impago' } }),
      deps.prisma.tenant.update({ where: { id: tenantId }, data: { estado: 'pausado', pausaMotivo: 'baja' } }),
    ]);
  }
  const aVencer = await deps.prisma.subscription.findMany({
    where: { estadoPago: 'al_dia', vencimiento: { lt: now }, canceladaEn: null },
    select: { tenantId: true },
  });
  const pendientes = await deps.prisma.subscription.updateMany({
    where: { estadoPago: 'al_dia', vencimiento: { lt: now }, canceladaEn: null },
    data: { estadoPago: 'pendiente' },
  });
  for (const { tenantId } of aVencer) await correoPlan(deps, tenantId, 'vencio');
  const limite = addDays(now, -DIAS_GRACIA);
  const vencidas = await deps.prisma.subscription.findMany({
    where: { estadoPago: { not: 'impago' }, vencimiento: { lt: limite }, canceladaEn: null },
    select: { tenantId: true },
  });
  for (const { tenantId } of vencidas) {
    await deps.prisma.$transaction([
      deps.prisma.subscription.update({ where: { tenantId }, data: { estadoPago: 'impago' } }),
      deps.prisma.tenant.updateMany({
        where: { id: tenantId, estado: 'activo' },
        data: { estado: 'pausado', pausaMotivo: 'impago' },
      }),
    ]);
    await correoPlan(deps, tenantId, 'impago');
  }
  return { pendientes: pendientes.count, impagos: vencidas.length };
}
