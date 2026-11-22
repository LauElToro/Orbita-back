import { randomUUID } from 'node:crypto';
import type { Deps } from '../deps';
import { keys } from '../lib/keys';
import { getTenant, resolveEndpoint } from '../tenants/repo';
import type { Canal } from './canales';
import { datosVentana } from './ventanas';
import type { Entrante } from './webhooks';

export interface JobGeneracion {
  messageId: string;
  tenantId: string;
  subscriberId: string;
  texto: string;
  nombre: string;
  canal: Canal;
}

export type ResultadoEntrada = { estado: 'encolado'; messageId: string } | { estado: 'ignorado' | 'duplicado' };

/** Meta y TikTok reintentan durante horas si no reciben 200: el id del mensaje se recuerda un día. */
const DEDUPE_SEG = 24 * 3600;

/**
 * Valida que el mensaje sea de una ficha activa, guarda a dónde responder y lo encola.
 * La respuesta la manda el worker; el webhook contesta 200 enseguida.
 */
export async function recibirMensaje(deps: Deps, e: Entrante): Promise<ResultadoEntrada> {
  const tenantId = await resolveEndpoint(deps.redis, e.endpointId);
  if (!tenantId) return { estado: 'ignorado' };
  const tenant = await getTenant(deps.prisma, tenantId);
  const canal = tenant.canales.find((c) => c.endpointId === e.endpointId);
  if (!canal || canal.tipo !== e.canal || tenant.estado === 'pausado') return { estado: 'ignorado' };

  const messageId = randomUUID();
  const nuevo = await deps.redis.set(keys.dedupe(e.canal, e.externalId), messageId, 'EX', DEDUPE_SEG, 'NX');
  if (!nuevo) return { estado: 'duplicado' };

  const where = { tenantId_subscriberId: { tenantId, subscriberId: e.subscriberId } };
  const previa = await deps.prisma.conversation.findUnique({ where });
  const contacto = {
    canal: e.canal,
    endpointId: e.endpointId,
    destino: e.destino,
    ...(e.nombre ? { nombre: e.nombre } : {}),
    ...datosVentana(e.canal, previa, deps.now()),
  };
  const conversacion = await deps.prisma.conversation.upsert({
    where,
    create: { tenantId, subscriberId: e.subscriberId, historial: [], ...contacto },
    update: contacto,
  });
  if (conversacion.handoffHasta && conversacion.handoffHasta > deps.now()) return { estado: 'ignorado' };

  const job: JobGeneracion = {
    messageId,
    tenantId,
    subscriberId: e.subscriberId,
    texto: e.texto,
    nombre: e.nombre || conversacion.nombre || '',
    canal: e.canal,
  };
  await deps.colaGeneracion.add('responder', job, {
    jobId: messageId,
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: 1000,
    removeOnFail: 1000,
  });
  return { estado: 'encolado', messageId };
}
