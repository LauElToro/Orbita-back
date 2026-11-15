import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  PUBLIC_URL: z.string().default('http://localhost'),
  CORS_ORIGIN: z.string().default('http://localhost'),
  JWT_SECRET: z.string().min(8),
  ENCRYPTION_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, 'ENCRYPTION_KEY debe ser 32 bytes en hex'),
  ADMIN_EMAIL: z.string().default('admin@orbita.local'),
  ADMIN_PASSWORD: z.string().min(1),
  OPENROUTER_API_KEY: z.string().default(''),
  OPENROUTER_BASE_URL: z.string().default('https://openrouter.ai/api/v1'),
  MODELO_BARATO: z.string().default('nvidia/nemotron-3.5-lightning:free'),
  MODELO_CAPAZ: z.string().default('nvidia/nemotron-3-ultra-550b-a55b:free'),
  LONG_POLL_MS: z.coerce.number().min(0).max(9000).default(8000),
  MP_ACCESS_TOKEN: z.string().default(''),
  MP_WEBHOOK_SECRET: z.string().default(''),
  TRANSFER_ALIAS: z.string().default('orbita.alias'),
  MANYCHAT_BASE_URL: z.string().default('https://api.manychat.com'),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return schema.parse(env);
}
