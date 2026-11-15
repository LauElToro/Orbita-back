import { randomUUID } from 'node:crypto';
import type Redis from 'ioredis';

const RELEASE = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Lock exclusivo con expiración. Reintenta hasta `waitMs`; devuelve la función para soltarlo. */
export async function acquireLock(
  redis: Redis,
  key: string,
  ttlMs = 60_000,
  waitMs = 30_000,
): Promise<() => Promise<void>> {
  const token = randomUUID();
  const limite = Date.now() + waitMs;
  while (true) {
    const ok = await redis.set(key, token, 'PX', ttlMs, 'NX');
    if (ok) {
      return async () => {
        await redis.eval(RELEASE, 1, key, token);
      };
    }
    if (Date.now() > limite) throw new Error(`No se pudo tomar el lock ${key}`);
    await sleep(100);
  }
}
