import { sha256 } from './crypto';

export const keys = {
  endpointIndex: 'idx:endpoints',
  dedupe: (pageId: string, subscriberId: string, texto: string) =>
    `dedupe:${pageId}:${subscriberId}:${sha256(texto.trim().toLowerCase())}`,
  respuesta: (messageId: string) => `resp:${messageId}`,
  canalRespuestas: 'resp:ready',
  lock: (tenantId: string) => `lock:tenant:${tenantId}`,
  uso: (tenantId: string, periodo: string) => `uso:${tenantId}:${periodo}`,
  rateLimit: (scope: string, id: string) => `rl:${scope}:${id}`,
};

export const QUEUE_GENERACION = 'generacion';
export const QUEUE_TAREAS = 'tareas';
