import type { Deps } from '../deps';
import { addDays, localParts } from '../lib/dates';
import { leerUso } from '../usage/usage';
import type { TenantFull } from '../tenants/repo';
import { urlBaja, enviarUnaVez } from './envios';
import {
  mensajeLimite,
  mensajeNewsletter,
  mensajePromoGratis,
  mensajeSeguimiento,
  mensajeVencimiento,
} from './plantillas';

const ZONA = 'America/Argentina/Buenos_Aires';

function diaClave(fecha: Date): string {
  return fecha.toISOString().slice(0, 10);
}

/** Avisos que no dependen de un click: vencimiento, newsletter, seguimiento y promo de la demo. */
export async function enviarAvisosProgramados(deps: Deps): Promise<{ enviados: number }> {
  const partes = await Promise.all([
    avisarVencimientos(deps),
    avisarNewsletter(deps),
    avisarSeguimiento(deps),
    avisarPromoGratis(deps),
  ]);
  return { enviados: partes.reduce((n, x) => n + x, 0) };
}

async function avisarVencimientos(deps: Deps): Promise<number> {
  const now = deps.now();
  const porVencer = await deps.prisma.subscription.findMany({
    where: {
      estadoPago: 'al_dia',
      vencimiento: { gt: addDays(now, 2), lte: addDays(now, 3) },
      tenant: { payments: { some: {} }, usuario: { isNot: null } },
    },
    select: { tenantId: true },
  });
  let n = 0;
  for (const { tenantId } of porVencer) n += (await correoPlan(deps, tenantId, 'previo')) ? 1 : 0;
  return n;
}

/** Lo llama el pase a pendiente y el pase a impago, con la ficha ya actualizada. */
export async function correoPlan(deps: Deps, tenantId: string, momento: 'previo' | 'vencio' | 'impago'): Promise<boolean> {
  try {
    return await enviarCorreoPlan(deps, tenantId, momento);
  } catch (err) {
    console.error(`correo vencimiento: ${err instanceof Error ? err.message : 'no se pudo avisar'}`);
    return false;
  }
}

async function enviarCorreoPlan(deps: Deps, tenantId: string, momento: 'previo' | 'vencio' | 'impago'): Promise<boolean> {
  const tenant = await deps.prisma.tenant.findUnique({
    where: { id: tenantId },
    select: {
      id: true,
      nombre: true,
      plan: { select: { nombre: true } },
      subscription: { select: { vencimiento: true } },
      usuario: { select: { id: true, email: true, nombre: true } },
      _count: { select: { payments: true } },
    },
  });
  if (!tenant?.usuario || !tenant.subscription || tenant._count.payments === 0) return false;
  const clave = `${momento}:${diaClave(tenant.subscription.vencimiento)}`;
  return enviarUnaVez(deps, {
    email: tenant.usuario.email,
    tenantId: tenant.id,
    tipo: 'vencimiento',
    clave,
    mensaje: mensajeVencimiento(
      tenant.usuario,
      tenant.nombre,
      tenant.plan.nombre,
      tenant.subscription.vencimiento,
      momento,
      deps.config.PUBLIC_URL,
    ),
  });
}

async function avisarNewsletter(deps: Deps): Promise<number> {
  const hoy = localParts(deps.now(), ZONA);
  if (hoy.d > 3) return 0;
  const clave = `${hoy.y}-${String(hoy.m).padStart(2, '0')}`;
  const clientes = await deps.prisma.clientUser.findMany({
    where: { avisosComerciales: true, tenant: { subscription: { estadoPago: 'al_dia' } } },
    select: { id: true, email: true, nombre: true, tenantId: true, tenant: { select: { nombre: true } } },
  });
  let n = 0;
  for (const c of clientes) {
    const ok = await enviarUnaVez(deps, {
      email: c.email,
      tenantId: c.tenantId,
      tipo: 'newsletter',
      clave,
      comercial: true,
      mensaje: mensajeNewsletter(c, c.tenant.nombre, hoy.m - 1, deps.config.PUBLIC_URL, urlBaja(deps, c.id)),
    });
    if (ok) n += 1;
  }
  return n;
}

async function avisarSeguimiento(deps: Deps): Promise<number> {
  const now = deps.now();
  const fichas = await deps.prisma.tenant.findMany({
    where: {
      usuario: { isNot: null },
      payments: { some: { createdAt: { lte: addDays(now, -3), gte: addDays(now, -10) } } },
    },
    select: {
      id: true,
      nombre: true,
      plan: { select: { nombre: true } },
      usuario: { select: { email: true, nombre: true } },
      payments: { orderBy: { createdAt: 'asc' }, take: 1, select: { createdAt: true } },
    },
  });
  let n = 0;
  for (const f of fichas) {
    const primero = f.payments[0];
    if (!f.usuario || !primero) continue;
    if (primero.createdAt > addDays(now, -3) || primero.createdAt < addDays(now, -10)) continue;
    const ok = await enviarUnaVez(deps, {
      email: f.usuario.email,
      tenantId: f.id,
      tipo: 'seguimiento',
      clave: 'alta',
      mensaje: mensajeSeguimiento(f.usuario, f.nombre, f.plan.nombre, deps.config.PUBLIC_URL),
    });
    if (ok) n += 1;
  }
  return n;
}

async function avisarPromoGratis(deps: Deps): Promise<number> {
  const clientes = await deps.prisma.clientUser.findMany({
    where: {
      avisosComerciales: true,
      createdAt: { lte: addDays(deps.now(), -3) },
      tenant: { payments: { none: {} } },
    },
    select: { id: true, email: true, nombre: true, tenantId: true, tenant: { select: { nombre: true } } },
  });
  let n = 0;
  for (const c of clientes) {
    const ok = await enviarUnaVez(deps, {
      email: c.email,
      tenantId: c.tenantId,
      tipo: 'promo-gratis',
      clave: 'demo',
      comercial: true,
      mensaje: mensajePromoGratis(c, c.tenant.nombre, deps.config.PUBLIC_URL, urlBaja(deps, c.id)),
    });
    if (ok) n += 1;
  }
  return n;
}

/** 80% y 100% del tope mensual. Una vez por período. */
export async function avisarSiLlegoAlLimite(deps: Deps, tenant: TenantFull): Promise<void> {
  try {
    const email = tenant.usuario?.email;
    const nombre = tenant.usuario?.nombre;
    if (!email || !nombre || tenant.topeMes <= 0) return;
    const uso = await leerUso(deps, tenant);
    const nivel: 80 | 100 | null = uso.mes >= tenant.topeMes ? 100 : uso.mes >= Math.ceil(tenant.topeMes * 0.8) ? 80 : null;
    if (!nivel) return;
    await enviarUnaVez(deps, {
      email,
      tenantId: tenant.id,
      tipo: 'limite',
      clave: `${nivel}:${uso.periodos.mes}`,
      mensaje: mensajeLimite(
        { email, nombre },
        tenant.nombre,
        uso.mes,
        tenant.topeMes,
        nivel,
        uso.periodos.reinicio.mes,
        deps.config.PUBLIC_URL,
      ),
    });
  } catch (err) {
    console.error(`correo limite: ${err instanceof Error ? err.message : 'no se pudo avisar'}`);
  }
}
