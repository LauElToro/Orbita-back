import type Redis from 'ioredis';
import { keys } from './keys';
import { HttpError } from './errors';

/** Ventana fija en Redis. Lanza 429 al superar `max` dentro de `windowSec`. */
export async function rateLimit(
  redis: Redis,
  scope: string,
  id: string,
  max: number,
  windowSec: number,
): Promise<void> {
  const key = keys.rateLimit(scope, id);
  const [[, count]] = (await redis.multi().incr(key).expire(key, windowSec, 'NX').exec()) as [
    [Error | null, number],
  ];
  if (count > max) throw new HttpError(429, 'Demasiados intentos, probá más tarde');
}
