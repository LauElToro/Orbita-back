import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Deps } from '../deps';
import { safeEqual } from '../lib/crypto';
import { HttpError } from '../lib/errors';
import { keys } from '../lib/keys';
import { leerMensajes } from '../tenants/defaults';
import { getTenant, resolveEndpoint } from '../tenants/repo';
import { alcanzoTope, leerUso, topesDe } from '../usage/usage';
import { guardarRespuesta, leerRespuesta, type EstadoRespuesta } from './respuestas';

export const entradaSchema = z.object({
  pageId: z.coerce.string().min(1),
  subscriberId: z.coerce.string().min(1),
  canal: z.enum(['whatsapp', 'instagram', 'telegram']).optional(),
  endpointId: z.coerce.string().min(1),
  texto: z.string().trim().min(1).max(4000),
  nombre: z.string().optional().default(''),
});

export type EntradaBody = z.infer<typeof entradaSchema>;

export interface JobGeneracion {
  messageId: string;
  tenantId: string;
  subscriberId: string;
  texto: string;
  nombre: string;
  canal?: string;
}

export interface ResultadoEntrada {
  ok: true;
  messageId: string | null;
  estado: EstadoRespuesta;
  texto: string;
}

const DEDUPE_SEG = 30;

const ignorado = (): ResultadoEntrada => ({ ok: true, messageId: null, estado: 'ignorado', texto: '' });

export async function procesarEntrada(
  deps: Deps,
  rawBody: unknown,
  apiKey: string | undefined,
): Promise<ResultadoEntrada> {
  const body = entradaSchema.parse(rawBody);

  const tenantId = await resolveEndpoint(deps.redis, body.endpointId);
  if (!tenantId) return ignorado();
  const tenant = await getTenant(deps.prisma, tenantId);
  if (tenant.pageId !== body.pageId) return ignorado();
  if (!apiKey || !safeEqual(apiKey, tenant.apiKey)) throw new HttpError(401, 'X-Orbita-Key inválida');
  if (tenant.estado === 'pausado') return ignorado();

  const messageId = randomUUID();
  const dedupeKey = keys.dedupe(body.pageId, body.subscriberId, body.texto);
  const nuevo = await deps.redis.set(dedupeKey, messageId, 'EX', DEDUPE_SEG, 'NX');
  if (!nuevo) {
    const previo = await deps.redis.get(dedupeKey);
    const resp = previo ? await leerRespuesta(deps.redis, previo) : null;
    return { ok: true, messageId: previo, estado: resp?.estado ?? 'pendiente', texto: resp?.texto ?? '' };
  }

  const uso = await leerUso(deps, tenant);
  if (alcanzoTope(uso, topesDe(tenant))) {
    const texto = leerMensajes(tenant.mensajes).tope;
    await guardarRespuesta(deps.redis, messageId, { estado: 'listo', texto, handoff: true, tenantId });
    return { ok: true, messageId, estado: 'listo', texto };
  }

  await guardarRespuesta(deps.redis, messageId, { estado: 'pendiente', texto: '', handoff: false, tenantId });
  const job: JobGeneracion = {
    messageId,
    tenantId,
    subscriberId: body.subscriberId,
    texto: body.texto,
    nombre: body.nombre,
    canal: body.canal,
  };
  await deps.colaGeneracion.add('responder', job, {
    jobId: messageId,
    removeOnComplete: 1000,
    removeOnFail: 1000,
  });
  return { ok: true, messageId, estado: 'pendiente', texto: '' };
}
