import cors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import type { Deps } from './deps';
import { registerAuth } from './admin/auth';
import { HttpError } from './lib/errors';
import { registerMessagingRoutes } from './messaging/routes';
import { registerTenantRoutes } from './tenants/routes';
import { registerBillingRoutes } from './billing/routes';
import { registerTicketRoutes } from './tickets/routes';
import { registerPublicRoutes } from './tenants/public';
import { registerCuentaRoutes } from './cuenta/routes';
import { registerMetricasRoutes } from './admin/metricas';
import { registerWebRoutes } from './web/routes';

export interface AppOptions {
  logger?: boolean;
}

export async function buildApp(deps: Deps, opts: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false, trustProxy: true });

  const panel = deps.config.CORS_ORIGIN.split(',').map((o) => o.trim());
  // La integración web se llama desde la web de cada comercio; los dominios se validan por ficha en la ruta.
  await app.register(cors, {
    delegator: (req, cb) => cb(null, { origin: (req.url ?? '').startsWith('/web/') ? true : panel }),
  });

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

  app.get('/health', async () => {
    await deps.redis.ping();
    await deps.prisma.$queryRaw`SELECT 1`;
    return { ok: true };
  });

  await registerAuth(app, deps);
  registerMessagingRoutes(app, deps);
  registerTenantRoutes(app, deps);
  registerBillingRoutes(app, deps);
  registerTicketRoutes(app, deps);
  registerPublicRoutes(app, deps);
  registerCuentaRoutes(app, deps);
  registerMetricasRoutes(app, deps);
  registerWebRoutes(app, deps);

  return app;
}
