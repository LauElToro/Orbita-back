import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../deps';
import { safeEqual } from '../lib/crypto';
import { HttpError } from '../lib/errors';
import { procesarEntrada } from './entrada';
import { esperarRespuesta, type RespuestaWaiter } from './respuestas';

const salidaQuery = z.object({
  messageId: z.string().uuid(),
  esperaMs: z.coerce.number().int().min(0).optional(),
});

function apiKeyDe(headers: Record<string, unknown>): string | undefined {
  const v = headers['x-orbita-key'];
  return typeof v === 'string' ? v : undefined;
}

export function registerMessagingRoutes(app: FastifyInstance, deps: Deps, waiter: RespuestaWaiter): void {
  app.post('/webhooks/manychat/entrada', async (req) => {
    return procesarEntrada(deps, req.body, apiKeyDe(req.headers));
  });

  app.get('/webhooks/manychat/salida', async (req, reply) => {
    const { messageId, esperaMs } = salidaQuery.parse(req.query);
    const espera = Math.min(esperaMs ?? deps.config.LONG_POLL_MS, deps.config.LONG_POLL_MS);

    const apiKey = apiKeyDe(req.headers);
    const resp = await esperarRespuesta(deps.redis, waiter, messageId, 0);
    if (!resp) return reply.code(404).send({ ok: false, messageId, estado: 'desconocido', texto: '' });

    const tenant = await deps.prisma.tenant.findUnique({
      where: { id: resp.tenantId },
      select: { apiKey: true },
    });
    if (!tenant || !apiKey || !safeEqual(apiKey, tenant.apiKey)) {
      throw new HttpError(401, 'X-Orbita-Key inválida');
    }

    const final = (await esperarRespuesta(deps.redis, waiter, messageId, espera)) ?? resp;
    return { ok: true, messageId, estado: final.estado, texto: final.texto, handoff: final.handoff };
  });
}
