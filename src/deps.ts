import { PrismaClient } from '@prisma/client';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import type { Config } from './config';
import { OpenRouterClient, type AiClient } from './ai/openrouter';
import { CanalesClient, type MessengerClient } from './messaging/canales';
import { MercadoPagoClient, type PaymentsGateway } from './billing/mercadopago';
import { crearCorreo, type Correo } from './correo/correo';
import { QUEUE_GENERACION, QUEUE_TAREAS } from './lib/keys';

export interface Deps {
  config: Config;
  prisma: PrismaClient;
  redis: Redis;
  colaGeneracion: Queue;
  colaTareas: Queue;
  ai: AiClient;
  mensajeria: MessengerClient;
  mercadopago: PaymentsGateway;
  correo: Correo;
  now: () => Date;
}

export function bullConnection(config: Config): Redis {
  return new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
}

export function createDeps(config: Config, overrides: Partial<Deps> = {}): Deps {
  const redis = overrides.redis ?? new Redis(config.REDIS_URL);
  const bull = bullConnection(config);
  return {
    config,
    prisma: overrides.prisma ?? new PrismaClient(),
    redis,
    colaGeneracion: overrides.colaGeneracion ?? new Queue(QUEUE_GENERACION, { connection: bull }),
    colaTareas: overrides.colaTareas ?? new Queue(QUEUE_TAREAS, { connection: bull }),
    ai: overrides.ai ?? new OpenRouterClient(config.OPENROUTER_BASE_URL, config.OPENROUTER_API_KEY),
    mensajeria:
      overrides.mensajeria ??
      new CanalesClient({
        metaGraphUrl: config.META_GRAPH_URL,
        instagramGraphUrl: config.INSTAGRAM_GRAPH_URL,
        metaVersion: config.META_API_VERSION,
        tiktokUrl: config.TIKTOK_API_URL,
      }),
    mercadopago: overrides.mercadopago ?? new MercadoPagoClient(config.MP_ACCESS_TOKEN, config.MP_WEBHOOK_SECRET),
    correo: overrides.correo ?? crearCorreo(config),
    now: overrides.now ?? (() => new Date()),
  };
}

export async function closeDeps(deps: Deps): Promise<void> {
  await deps.colaGeneracion.close();
  await deps.colaTareas.close();
  await deps.prisma.$disconnect();
  deps.redis.disconnect();
}
