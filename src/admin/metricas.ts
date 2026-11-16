import type { FastifyInstance } from 'fastify';
import type { Deps } from '../deps';
import { precioDe } from '../billing/plans';
import { leerDemo } from '../demo/service';
import { addDays, fmt, localParts, periodos } from '../lib/dates';

const TZ = 'America/Argentina/Buenos_Aires';

function diaLocal(date: Date): string {
  const l = localParts(date, TZ);
  return fmt(l.y, l.m, l.d);
}

function mesLocal(date: Date): string {
  return diaLocal(date).slice(0, 7);
}

function contar<T extends string>(items: T[]): Record<string, number> {
  return items.reduce<Record<string, number>>((acc, k) => ({ ...acc, [k]: (acc[k] ?? 0) + 1 }), {});
}

export async function calcularMetricas(deps: Deps) {
  const { prisma } = deps;
  const now = deps.now();
  const hace30 = addDays(now, -30);

  const [tenants, pagos, tickets, registros] = await Promise.all([
    prisma.tenant.findMany({ include: { plan: true, subscription: true } }),
    prisma.payment.findMany({ where: { createdAt: { gte: addDays(now, -186) } } }),
    prisma.ticket.findMany({ select: { estado: true, tipo: true, createdAt: true } }),
    prisma.clientUser.findMany({ where: { createdAt: { gte: hace30 } }, select: { createdAt: true } }),
  ]);

  const enOnboarding = tenants.filter((t) => t.pausaMotivo === 'onboarding');
  const operativos = tenants.filter((t) => t.pausaMotivo !== 'onboarding');
  const importe = (t: (typeof tenants)[number]) =>
    precioDe(t.plan, t.subscription?.medio ?? 'transferencia', t.precioPersonalizado);
  const pagando = operativos.filter((t) => t.subscription?.estadoPago === 'al_dia');
  const mrr = pagando.reduce((s, t) => s + importe(t), 0);

  const ingresosPorMes = new Map<string, number>();
  for (let i = 5; i >= 0; i--) {
    const l = localParts(now, TZ);
    const idx = l.y * 12 + (l.m - 1) - i;
    ingresosPorMes.set(`${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`, 0);
  }
  for (const p of pagos) {
    const mes = mesLocal(p.createdAt);
    if (ingresosPorMes.has(mes)) ingresosPorMes.set(mes, (ingresosPorMes.get(mes) ?? 0) + p.importe);
  }

  const dias = Array.from({ length: 30 }, (_, i) => diaLocal(addDays(now, i - 29)));
  const usoDiario = await prisma.usage.groupBy({
    by: ['periodo'],
    where: { periodo: { in: dias.map((d) => `dia:${d}`) } },
    _sum: { count: true },
  });
  const porDia = new Map(usoDiario.map((u) => [u.periodo.slice(4), u._sum.count ?? 0]));
  const serieMensajes = dias.map((dia) => ({ dia, respuestas: porDia.get(dia) ?? 0 }));

  const clavesMes = operativos.map((t) => ({
    t,
    periodo: periodos(now, t.timezone, t.subscription?.diaAbono ?? t.createdAt.getUTCDate()).mes,
  }));
  const usoMes = clavesMes.length
    ? await prisma.usage.findMany({
        where: { OR: clavesMes.map(({ t, periodo }) => ({ tenantId: t.id, periodo })) },
      })
    : [];
  const topUso = clavesMes
    .map(({ t, periodo }) => {
      const usado = usoMes.find((u) => u.tenantId === t.id && u.periodo === periodo)?.count ?? 0;
      return { id: t.id, nombre: t.nombre, usado, tope: t.topeMes, pct: t.topeMes ? Math.round((usado / t.topeMes) * 100) : 0 };
    })
    .sort((a, b) => b.pct - a.pct)
    .slice(0, 5);

  const proximosVencimientos = operativos
    .filter((t) => t.subscription && t.subscription.vencimiento >= now && t.subscription.vencimiento <= addDays(now, 7))
    .map((t) => ({ id: t.id, nombre: t.nombre, vencimiento: t.subscription!.vencimiento, medio: t.subscription!.medio, importe: importe(t) }));

  const ticketsIa = tickets.filter((t) => t.tipo === 'ia_personalizada');
  const contratados = ticketsIa.filter((t) => t.estado === 'contratado').length;

  return {
    clientes: {
      total: tenants.length,
      activos: tenants.filter((t) => t.estado === 'activo').length,
      pausadosManual: tenants.filter((t) => t.pausaMotivo === 'manual').length,
      pausadosImpago: tenants.filter((t) => t.pausaMotivo === 'impago').length,
      enOnboarding: enOnboarding.length,
      porPlan: contar(operativos.map((t) => t.planId)),
    },
    ingresos: {
      mrr,
      arpu: pagando.length ? Math.round(mrr / pagando.length) : 0,
      mrrEnRiesgo: operativos
        .filter((t) => t.subscription && t.subscription.estadoPago !== 'al_dia')
        .reduce((s, t) => s + importe(t), 0),
      cobrado30d: pagos.filter((p) => p.createdAt >= hace30).reduce((s, p) => s + p.importe, 0),
      porAcreditar: pagos.filter((p) => p.acreditaEn && p.acreditaEn > now).reduce((s, p) => s + p.importe, 0),
      porMes: [...ingresosPorMes].map(([mes, total]) => ({ mes, total })),
    },
    cobranza: contar(operativos.map((t) => t.subscription?.estadoPago ?? 'pendiente')),
    mensajes: {
      hoy: serieMensajes.at(-1)?.respuestas ?? 0,
      ultimos30: serieMensajes.reduce((s, d) => s + d.respuestas, 0),
      serie: serieMensajes,
    },
    embudo: {
      registros30d: registros.length,
      enOnboarding: enOnboarding.length,
      onboardingSinPago: enOnboarding.filter((t) => t.subscription?.estadoPago !== 'al_dia').length,
      probaronDemo: enOnboarding.filter((t) => t.subscription?.estadoPago !== 'al_dia' && leerDemo(t.demo).mensajes > 0).length,
      activados30d: tenants.filter((t) => t.onboardingCompletado && t.onboardingCompletado >= hace30).length,
    },
    tickets: {
      porEstado: contar(ticketsIa.map((t) => t.estado)),
      conversion: ticketsIa.length ? Math.round((contratados / ticketsIa.length) * 100) : 0,
      arrepentimientosAbiertos: tickets.filter((t) => t.tipo === 'arrepentimiento' && t.estado !== 'descartado' && t.estado !== 'contratado').length,
    },
    alertas: {
      cercaDelTope: topUso.filter((u) => u.pct >= 80),
      proximosVencimientos,
    },
  };
}

export function registerMetricasRoutes(app: FastifyInstance, deps: Deps): void {
  app.register(async (admin) => {
    admin.addHook('onRequest', admin.requireAdmin);
    admin.get('/admin/metricas', async () => calcularMetricas(deps));
  });
}
