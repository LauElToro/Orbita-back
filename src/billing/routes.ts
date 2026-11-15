import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../deps';
import { HttpError, notFound } from '../lib/errors';
import { rateLimit } from '../lib/rateLimit';
import { tenantInclude } from '../tenants/repo';
import { iniciarSuscripcionMp, registrarPago } from './service';

const notificacionSchema = z.object({
  type: z.string().optional(),
  topic: z.string().optional(),
  data: z.object({ id: z.coerce.string() }).optional(),
});

export function registerBillingRoutes(app: FastifyInstance, deps: Deps): void {
  app.post('/webhooks/mercadopago', async (req, reply) => {
    const body = notificacionSchema.parse(req.body ?? {});
    const query = req.query as Record<string, string | undefined>;
    const tipo = body.type ?? body.topic ?? query.type ?? query.topic ?? '';
    const dataId = body.data?.id ?? query['data.id'] ?? query.id;
    if (!dataId) return reply.code(200).send({ ok: true });
    if (!deps.mercadopago.verificarFirma(req.headers, dataId)) throw new HttpError(401, 'Firma inválida');
    if (!deps.mercadopago.habilitado) return { ok: true };

    const pago = await deps.mercadopago.obtenerPago(tipo, dataId);
    if (!pago?.aprobado) return { ok: true };

    const sub = pago.preapprovalId
      ? await deps.prisma.subscription.findUnique({ where: { mpPreapprovalId: pago.preapprovalId } })
      : null;
    const tenantId = sub?.tenantId ?? pago.externalReference;
    if (!tenantId || !(await deps.prisma.tenant.findUnique({ where: { id: tenantId } }))) {
      req.log.warn({ dataId }, 'pago de Mercado Pago sin ficha asociada');
      return { ok: true };
    }
    await registrarPago(deps, tenantId, {
      medio: 'mercadopago',
      importe: pago.importe,
      externalId: `mp:${pago.id}`,
      fecha: pago.fecha,
    });
    return { ok: true };
  });

  app.post('/publico/:token/suscripcion', async (req) => {
    await rateLimit(deps.redis, 'suscripcion', req.ip, 10, 3600);
    const { token } = z.object({ token: z.string().min(1) }).parse(req.params);
    const { email } = z.object({ email: z.string().email().optional() }).parse(req.body ?? {});
    const tenant = await deps.prisma.tenant.findUnique({ where: { publicToken: token }, include: tenantInclude });
    if (!tenant?.subscription) throw notFound('Cliente');
    return iniciarSuscripcionMp(deps, tenant, email, `${deps.config.PUBLIC_URL}/p/${token}`);
  });
}
