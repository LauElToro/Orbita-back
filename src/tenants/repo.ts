import type { Prisma, PrismaClient } from '@prisma/client';
import type Redis from 'ioredis';
import { keys } from '../lib/keys';
import { notFound } from '../lib/errors';

export const tenantInclude = {
  plan: true,
  planPendiente: true,
  subscription: true,
  canales: true,
  calendario: true,
  usuario: { select: { id: true, email: true, nombre: true, ultimoLogin: true, createdAt: true } },
  referido: { select: { affiliate: { select: { codigo: true } } } },
  _count: { select: { payments: true } },
} satisfies Prisma.TenantInclude;

export type TenantFull = Prisma.TenantGetPayload<{ include: typeof tenantInclude }>;

export async function getTenant(prisma: PrismaClient, id: string): Promise<TenantFull> {
  const tenant = await prisma.tenant.findUnique({ where: { id }, include: tenantInclude });
  if (!tenant) throw notFound('Cliente');
  return tenant;
}

export function diaAbonoDe(tenant: Pick<TenantFull, 'subscription' | 'createdAt'>): number {
  return tenant.subscription?.diaAbono ?? tenant.createdAt.getUTCDate();
}

/** Índice endpointId -> clientId. Se reconstruye al arrancar y cada vez que cambian los canales. */
export async function rebuildIndex(prisma: PrismaClient, redis: Redis): Promise<number> {
  const canales = await prisma.channel.findMany({ select: { endpointId: true, tenantId: true } });
  const multi = redis.multi().del(keys.endpointIndex);
  if (canales.length) {
    multi.hset(keys.endpointIndex, Object.fromEntries(canales.map((c) => [c.endpointId, c.tenantId])));
  }
  await multi.exec();
  return canales.length;
}

export async function resolveEndpoint(redis: Redis, endpointId: string): Promise<string | null> {
  return redis.hget(keys.endpointIndex, endpointId);
}
