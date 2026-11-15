import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../deps';
import { rateLimit } from '../lib/rateLimit';
import { configWeb, contactoWeb, mensajeWeb } from './service';
import { WIDGET_JS } from './widget';

const params = z.object({ clave: z.string().min(10).max(80) });

/**
 * Integración web: el widget, o cualquier sitio o servidor, le pega directo a la API con la clave pública de la ficha.
 * Responde en el mismo pedido porque no hay un canal por donde mandar la respuesta después.
 */
export function registerWebRoutes(app: FastifyInstance, deps: Deps): void {
  app.get('/web/widget.js', async (_req, reply) =>
    reply.type('application/javascript; charset=utf-8').header('Cache-Control', 'public, max-age=3600').send(WIDGET_JS),
  );

  app.get('/web/:clave', async (req) => {
    await rateLimit(deps.redis, 'web-config', req.ip, 120, 60);
    const { clave } = params.parse(req.params);
    return configWeb(deps, clave, req.headers.origin);
  });

  app.post('/web/:clave/mensajes', async (req) => {
    const { clave } = params.parse(req.params);
    const sesion = String((req.body as { sesion?: unknown } | null)?.sesion ?? '');
    await rateLimit(deps.redis, 'web-ip', req.ip, 30, 60);
    await rateLimit(deps.redis, 'web-sesion', `${clave}:${sesion}`, 12, 60);
    return mensajeWeb(deps, clave, req.headers.origin, req.body);
  });

  app.post('/web/:clave/contacto', async (req) => {
    const { clave } = params.parse(req.params);
    await rateLimit(deps.redis, 'web-contacto', req.ip, 5, 3600);
    return contactoWeb(deps, clave, req.headers.origin, req.body);
  });
}
