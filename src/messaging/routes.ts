import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Deps } from '../deps';
import { safeEqual } from '../lib/crypto';
import { HttpError } from '../lib/errors';
import { recibirMensaje } from './entrada';
import { firmaMetaValida, firmaTiktokValida, leerMeta, leerTiktok, type Entrante } from './webhooks';

const crudo = new WeakMap<FastifyRequest, string>();

export function registerMessagingRoutes(app: FastifyInstance, deps: Deps): void {
  app.register(async (webhooks) => {
    webhooks.removeContentTypeParser('application/json');
    webhooks.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
      crudo.set(req, String(body));
      try {
        done(null, body ? JSON.parse(String(body)) : {});
      } catch {
        done(new HttpError(400, 'JSON inválido'), undefined);
      }
    });

    const encolar = async (req: FastifyRequest, entrantes: Entrante[]) => {
      for (const e of entrantes) {
        try {
          await recibirMensaje(deps, e);
        } catch (err) {
          req.log.error({ err, canal: e.canal, endpointId: e.endpointId }, 'no se pudo encolar el mensaje');
        }
      }
      return { ok: true };
    };

    webhooks.get('/webhooks/meta', async (req, reply) => {
      const q = req.query as Record<string, string | undefined>;
      const token = q['hub.verify_token'] ?? '';
      const secreto = deps.config.META_VERIFY_TOKEN;
      if (q['hub.mode'] !== 'subscribe' || !secreto || !safeEqual(token, secreto)) {
        throw new HttpError(403, 'Token de verificación inválido');
      }
      return reply.type('text/plain').send(q['hub.challenge'] ?? '');
    });

    webhooks.post('/webhooks/meta', async (req) => {
      if (!deps.config.META_APP_SECRET) throw new HttpError(503, 'Meta no está configurado');
      if (!firmaMetaValida(crudo.get(req) ?? '', req.headers['x-hub-signature-256'], deps.config.META_APP_SECRET)) {
        throw new HttpError(401, 'Firma de Meta inválida');
      }
      return encolar(req, leerMeta(req.body));
    });

    webhooks.post('/webhooks/tiktok', async (req) => {
      if (!deps.config.TIKTOK_APP_SECRET) throw new HttpError(503, 'TikTok no está configurado');
      const ahora = Math.floor(deps.now().getTime() / 1000);
      if (!firmaTiktokValida(crudo.get(req) ?? '', req.headers['tiktok-signature'], deps.config.TIKTOK_APP_SECRET, ahora)) {
        throw new HttpError(401, 'Firma de TikTok inválida');
      }
      return encolar(req, leerTiktok(req.body));
    });
  });
}
