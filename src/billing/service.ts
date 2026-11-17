import type { MedioPago } from '@prisma/client';
import type { Deps } from '../deps';
import { comisionarPrimerPago } from '../afiliados/service';
import { addDays, addMonths } from '../lib/dates';
import { conflict, HttpError, notFound } from '../lib/errors';
import { getTenant, type TenantFull } from '../tenants/repo';
import { importeDe } from '../tenants/service';

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
  const nuevoVencimiento = addMonths(sub.vencimiento, 1, sub.diaAbono);
  const alDia = nuevoVencimiento > deps.now();

  const [payment] = await deps.prisma.$transaction([
    deps.prisma.payment.create({
      data: {
        tenantId,
        medio: pago.medio,
        importe: pago.importe ?? importeDe(tenant),
        periodo: sub.vencimiento.toISOString().slice(0, 10),
        externalId: pago.externalId ?? null,
        acreditaEn: pago.medio === 'mercadopago' ? addDays(now, DIAS_ACREDITACION_MP) : now,
      },
    }),
    deps.prisma.subscription.update({
      where: { tenantId },
      data: { vencimiento: nuevoVencimiento, estadoPago: alDia ? 'al_dia' : 'pendiente' },
    }),
    deps.prisma.tenant.update({
      where: { id: tenantId },
      data:
        alDia && tenant.estado === 'pausado' && tenant.pausaMotivo === 'impago'
          ? { estado: 'activo', pausaMotivo: null }
          : {},
    }),
  ]);
  await comisionarPrimerPago(deps, tenantId, payment);
  return payment;
}

/** Crea (una sola vez) la suscripción mensual de Mercado Pago y devuelve el link para aprobar el débito. */
export async function iniciarSuscripcionMp(deps: Deps, tenant: TenantFull, email: string | undefined, backUrl: string) {
  const sub = tenant.subscription;
  if (!sub) throw notFound('Suscripción');
  if (sub.medio !== 'mercadopago') throw new HttpError(409, 'El medio de pago es transferencia');
  if (!tenant.planElegido) throw new HttpError(409, 'Elegí un plan antes de pagar');
  if (sub.mpInitPoint) return { initPoint: sub.mpInitPoint };
  if (!deps.mercadopago.habilitado) throw new HttpError(503, 'Mercado Pago no está configurado');

  const payerEmail = tenant.emailContacto ?? email;
  if (!payerEmail) throw new HttpError(400, 'Necesitamos un email para la suscripción');

  const { id, initPoint } = await deps.mercadopago.crearSuscripcion({
    reason: `Orbita - Plan ${tenant.plan.nombre} - ${tenant.nombre}`,
    externalReference: tenant.id,
    payerEmail,
    importe: importeDe(tenant),
    backUrl,
  });
  await deps.prisma.subscription.update({
    where: { tenantId: tenant.id },
    data: { mpPreapprovalId: id, mpInitPoint: initPoint },
  });
  if (!tenant.emailContacto) {
    await deps.prisma.tenant.update({ where: { id: tenant.id }, data: { emailContacto: payerEmail } });
  }
  return { initPoint };
}

export async function marcarTransferencia(deps: Deps, tenantId: string) {
  const tenant = await getTenant(deps.prisma, tenantId);
  if (tenant.subscription?.medio !== 'transferencia') {
    throw conflict('El medio de pago de esta ficha no es transferencia');
  }
  await registrarPago(deps, tenantId, { medio: 'transferencia' });
  return getTenant(deps.prisma, tenantId);
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
  const pendientes = await deps.prisma.subscription.updateMany({
    where: { estadoPago: 'al_dia', vencimiento: { lt: now } },
    data: { estadoPago: 'pendiente' },
  });
  const limite = addDays(now, -DIAS_GRACIA);
  const vencidas = await deps.prisma.subscription.findMany({
    where: { estadoPago: { not: 'impago' }, vencimiento: { lt: limite } },
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
  }
  return { pendientes: pendientes.count, impagos: vencidas.length };
}
