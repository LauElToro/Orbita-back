import type { FastifyInstance } from 'fastify';
import type { Deps } from '../deps';
import { tenantDeSesion } from '../admin/auth';
import { HttpError } from '../lib/errors';
import { rateLimit } from '../lib/rateLimit';
import { getTenant } from '../tenants/repo';
import { agregarFuente, borrarFuente, cargarEjemplo, chatDemo, demoDto, guardarConfigDemo } from './service';

/** La demo se puede usar sin pagar: va dentro del alcance de /cuenta (sesión y documentos legales) pero sin la guarda de pago. */
export function registerDemoRoutes(cuenta: FastifyInstance, deps: Deps): void {
  const responder = async (tenantId: string) => demoDto(deps, await getTenant(deps.prisma, tenantId));

  cuenta.get('/cuenta/demo', async (req) => responder(tenantDeSesion(req).tenantId));

  cuenta.put('/cuenta/demo', async (req) => {
    const { tenantId } = tenantDeSesion(req);
    await guardarConfigDemo(deps, await getTenant(deps.prisma, tenantId), req.body);
    return responder(tenantId);
  });

  cuenta.post('/cuenta/demo/fuentes', { bodyLimit: 8 * 1024 * 1024 }, async (req, reply) => {
    const { tenantId } = tenantDeSesion(req);
    await rateLimit(deps.redis, 'demo-fuentes', tenantId, 30, 3600);
    await agregarFuente(deps, tenantId, req.body);
    return reply.code(201).send(await responder(tenantId));
  });

  cuenta.delete<{ Params: { id: string } }>('/cuenta/demo/fuentes/:id', async (req) => {
    const { tenantId } = tenantDeSesion(req);
    await borrarFuente(deps, tenantId, req.params.id);
    return responder(tenantId);
  });

  cuenta.post('/cuenta/demo/ejemplo', async (req) => {
    const { tenantId } = tenantDeSesion(req);
    await rateLimit(deps.redis, 'demo-ejemplo', tenantId, 10, 3600);
    await cargarEjemplo(deps, await getTenant(deps.prisma, tenantId));
    return responder(tenantId);
  });

  cuenta.post('/cuenta/demo/chat', async (req) => {
    const { tenantId } = tenantDeSesion(req);
    await rateLimit(deps.redis, 'demo-chat-hora', tenantId, 40, 3600);
    await rateLimit(deps.redis, 'demo-chat-dia', tenantId, 150, 86_400);
    try {
      return await chatDemo(deps, await getTenant(deps.prisma, tenantId), req.body);
    } catch (err) {
      if (err instanceof Error && err.name === 'ZodError') throw err;
      req.log.error(err);
      throw new HttpError(502, 'La IA no respondió. Probá de nuevo en unos segundos.');
    }
  });
}
