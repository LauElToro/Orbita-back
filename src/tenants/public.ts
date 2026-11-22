import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../deps';
import { DIAS_GRACIA } from '../billing/service';
import { LEGAL } from '../legal/legal';
import { notFound } from '../lib/errors';
import { rateLimit } from '../lib/rateLimit';
import { leerUso } from '../usage/usage';
import { tenantInclude } from './repo';
import { importeDe } from './service';

/** Página del cliente: solo plan, importe, vencimiento y uso. Nada de prompt, token ni otras fichas. */
export function registerPublicRoutes(app: FastifyInstance, deps: Deps): void {
  app.get('/publico/planes', async () => {
    const planes = await deps.prisma.plan.findMany({
      where: { id: { not: 'personalizado' } },
      orderBy: { precioTransferencia: 'asc' },
    });
    return planes;
  });

  app.get('/publico/legal', async () => LEGAL);

  app.get('/publico/:token', async (req) => {
    await rateLimit(deps.redis, 'publico', req.ip, 120, 60);
    const { token } = z.object({ token: z.string().min(1) }).parse(req.params);
    const tenant = await deps.prisma.tenant.findUnique({ where: { publicToken: token }, include: tenantInclude });
    if (!tenant?.subscription) throw notFound('Cliente');
    const sub = tenant.subscription;
    const uso = await leerUso(deps, tenant);
    const importe = importeDe(tenant);

    return {
      nombre: tenant.nombre,
      plan: { id: tenant.plan.id, nombre: tenant.plan.nombre },
      medio: sub.medio,
      importe,
      vencimiento: sub.vencimiento,
      estadoPago: sub.estadoPago,
      estado: tenant.estado,
      uso: { mes: uso.mes, tope: tenant.topeMes, reinicia: uso.periodos.reinicio.mes },
      diasGracia: DIAS_GRACIA,
      mercadopago: {
        initPoint: sub.mpInitPoint,
        requiereEmail: !tenant.emailContacto,
        habilitado: deps.mercadopago.habilitado,
      },
    };
  });
}
