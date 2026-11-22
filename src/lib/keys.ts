import { sha256 } from './crypto';

export const keys = {
  endpointIndex: 'idx:endpoints',
  dedupe: (canal: string, externalId: string) => `dedupe:${canal}:${sha256(externalId)}`,
  lock: (tenantId: string) => `lock:tenant:${tenantId}`,
  uso: (tenantId: string, periodo: string) => `uso:${tenantId}:${periodo}`,
  rateLimit: (scope: string, id: string) => `rl:${scope}:${id}`,
  googleState: (state: string) => `google:state:${state}`,
  calendarioState: (state: string) => `calendario:state:${state}`,
  redesState: (state: string) => `redes:state:${state}`,
};

export const QUEUE_GENERACION = 'generacion';
export const QUEUE_TAREAS = 'tareas';
