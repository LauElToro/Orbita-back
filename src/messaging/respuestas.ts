import type Redis from 'ioredis';
import { keys } from '../lib/keys';

export type EstadoRespuesta = 'pendiente' | 'listo' | 'ignorado';

export interface Respuesta {
  estado: EstadoRespuesta;
  texto: string;
  handoff: boolean;
  tenantId: string;
}

const TTL_RESPUESTA = 600;

export async function guardarRespuesta(redis: Redis, messageId: string, r: Respuesta): Promise<void> {
  await redis.set(keys.respuesta(messageId), JSON.stringify(r), 'EX', TTL_RESPUESTA);
}

/** Guarda la respuesta final y avisa a los long-polls que estén esperando ese mensaje. */
export async function completarRespuesta(redis: Redis, messageId: string, r: Respuesta): Promise<void> {
  await guardarRespuesta(redis, messageId, r);
  await redis.publish(keys.canalRespuestas, messageId);
}

export async function leerRespuesta(redis: Redis, messageId: string): Promise<Respuesta | null> {
  const raw = await redis.get(keys.respuesta(messageId));
  return raw ? (JSON.parse(raw) as Respuesta) : null;
}

/** Una sola suscripción Pub/Sub por proceso; cada long-poll registra un waiter en memoria. */
export class RespuestaWaiter {
  private readonly sub: Redis;
  private readonly waiters = new Map<string, Set<() => void>>();
  private suscripcion?: Promise<unknown>;

  constructor(redis: Redis) {
    this.sub = redis.duplicate({ lazyConnect: true });
    this.sub.on('message', (_canal: string, messageId: string) => {
      const set = this.waiters.get(messageId);
      if (!set) return;
      this.waiters.delete(messageId);
      for (const resolve of set) resolve();
    });
  }

  /** Se suscribe al canal la primera vez que alguien espera una respuesta. */
  listo(): Promise<unknown> {
    this.suscripcion ??= this.sub.subscribe(keys.canalRespuestas);
    return this.suscripcion;
  }

  esperar(messageId: string, ms: number): { promise: Promise<void>; cancelar: () => void } {
    let timer: NodeJS.Timeout | undefined;
    let resolver: () => void = () => undefined;
    const promise = new Promise<void>((resolve) => {
      resolver = () => {
        clearTimeout(timer);
        resolve();
      };
      const set = this.waiters.get(messageId) ?? new Set();
      set.add(resolver);
      this.waiters.set(messageId, set);
      timer = setTimeout(resolver, ms);
    });
    const cancelar = () => {
      const set = this.waiters.get(messageId);
      set?.delete(resolver);
      if (set && set.size === 0) this.waiters.delete(messageId);
      resolver();
    };
    return { promise, cancelar };
  }

  get pendientes(): number {
    return this.waiters.size;
  }

  async close(): Promise<void> {
    this.sub.disconnect();
  }
}

/** Devuelve la respuesta si ya está lista; si no, espera hasta `ms` a que el worker la complete. */
export async function esperarRespuesta(
  redis: Redis,
  waiter: RespuestaWaiter,
  messageId: string,
  ms: number,
): Promise<Respuesta | null> {
  const actual = await leerRespuesta(redis, messageId);
  if (!actual || actual.estado !== 'pendiente' || ms <= 0) return actual;
  await waiter.listo();
  const espera = waiter.esperar(messageId, ms);
  const otraVez = await leerRespuesta(redis, messageId);
  if (otraVez && otraVez.estado !== 'pendiente') {
    espera.cancelar();
    return otraVez;
  }
  await espera.promise;
  espera.cancelar();
  return leerRespuesta(redis, messageId);
}
