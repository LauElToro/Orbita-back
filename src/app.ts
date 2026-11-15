import cors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import type { Deps } from './deps';
import { registerAuth } from './admin/auth';
import { HttpError } from './lib/errors';
import { registerMessagingRoutes } from './messaging/routes';
import { RespuestaWaiter } from './messaging/respuestas';
import { registerTenantRoutes } from './tenants/routes';
import { registerBillingRoutes } from './billing/routes';
import { registerTicketRoutes } from './tickets/routes';
import { registerPublicRoutes } from './tenants/public';
import { registerCuentaRoutes } from './cuenta/routes';
import { registerMetricasRoutes } from './admin/metricas';

export interface AppOptions {
  logger?: boolean;
  waiter?: RespuestaWaiter;
}

export async function buildApp(deps: Deps, opts: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false, trustProxy: true });

  await app.register(cors, { origin: deps.config.CORS_ORIGIN.split(',').map((o) => o.trim()) });

  app.setErrorHandler((error, req, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({ error: 'Datos inválidos', detalles: error.issues });
    }
    if (error instanceof HttpError) {
      return reply.code(error.statusCode).send({ error: error.message });
    }
    const status = (error as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.code(status).send({ error: (error as Error).message });
    req.log.error(error);
    return reply.code(500).send({ error: 'Error interno' });
  });

  const waiter = opts.waiter ?? new RespuestaWaiter(deps.redis);
  app.addHook('onClose', async () => {
    if (!opts.waiter) await waiter.close();
  });

  app.get('/health', async () => {
    await deps.redis.ping();
    await deps.prisma.$queryRaw`SELECT 1`;
    return { ok: true };
  });

  await registerAuth(app, deps);
  registerMessagingRoutes(app, deps, waiter);
  registerTenantRoutes(app, deps);
  registerBillingRoutes(app, deps);
  registerTicketRoutes(app, deps);
  registerPublicRoutes(app, deps);
  registerCuentaRoutes(app, deps);
  registerMetricasRoutes(app, deps);

  return app;
}
