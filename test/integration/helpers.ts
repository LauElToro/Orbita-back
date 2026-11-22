import { createHmac } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { inject, vi } from 'vitest';
import { buildApp } from '../../src/app';
import { ensurePlans } from '../../src/billing/plans';
import type { PagoMp, PaymentsGateway, SuscripcionMp } from '../../src/billing/mercadopago';
import { loadConfig } from '../../src/config';
import { closeDeps, createDeps, type Deps } from '../../src/deps';
import type { JobGeneracion } from '../../src/messaging/entrada';
import type { CuentaRed, Red } from '../../src/messaging/redes';
import { rebuildIndex } from '../../src/tenants/repo';

export interface TestEnv {
  deps: Deps;
  app: FastifyInstance;
  clock: { now: Date };
  ai: { chat: ReturnType<typeof vi.fn> };
  mensajeria: { enviar: ReturnType<typeof vi.fn> };
  meta: {
    intercambiarCodigo: ReturnType<typeof vi.fn>;
    suscribirApp: ReturnType<typeof vi.fn>;
    leerNumero: ReturnType<typeof vi.fn>;
    registrarNumero: ReturnType<typeof vi.fn>;
  };
  agenda: { aplicar: ReturnType<typeof vi.fn> };
  redes: {
    listo: ReturnType<typeof vi.fn<(red: Red) => boolean>>;
    url: ReturnType<typeof vi.fn<(red: Red, state: string) => string>>;
    completar: ReturnType<typeof vi.fn<(red: Red, code: string) => Promise<CuentaRed>>>;
  };
  mp: PaymentsGateway & {
    crearSuscripcion: ReturnType<typeof vi.fn>;
    crearPreferencia: ReturnType<typeof vi.fn>;
    cancelarSuscripcion: ReturnType<typeof vi.fn>;
    obtenerPago: ReturnType<typeof vi.fn>;
    obtenerSuscripcion: ReturnType<typeof vi.fn>;
    listarPagosSuscripcion: ReturnType<typeof vi.fn>;
  };
  token: string;
  reset(): Promise<void>;
  close(): Promise<void>;
  auth(): { authorization: string };
  job(messageId: string): Promise<JobGeneracion>;
}

export async function createTestEnv(): Promise<TestEnv> {
  const databaseUrl = inject('databaseUrl');
  const config = loadConfig({
    DATABASE_URL: databaseUrl,
    REDIS_URL: inject('redisUrl'),
    JWT_SECRET: 'test-secret-123',
    ENCRYPTION_KEY: 'b'.repeat(64),
    ADMIN_EMAIL: 'admin@test.local',
    ADMIN_PASSWORD: 'pw',
    META_APP_SECRET: 'meta-secret',
    META_VERIFY_TOKEN: 'verificar-orbita',
    TIKTOK_APP_SECRET: 'tiktok-secret',
    PUBLIC_URL: 'https://orbita.test',
    META_APP_ID: 'app-id',
    META_EMBEDDED_CONFIG_ID: 'cfg-id',
  });
  const clock = { now: new Date('2026-11-14T15:00:00Z') };
  const ai = { chat: vi.fn() };
  const mensajeria = { enviar: vi.fn().mockResolvedValue(undefined) };
  const meta = {
    intercambiarCodigo: vi.fn(),
    suscribirApp: vi.fn(),
    leerNumero: vi.fn(),
    registrarNumero: vi.fn(),
  };
  const agenda = { aplicar: vi.fn().mockResolvedValue('evt-1') };
  const redes = {
    listo: vi.fn<(red: Red) => boolean>(() => true),
    url: vi.fn<(red: Red, state: string) => string>((red, state) => `https://auth.test/${red}?state=${state}`),
    completar: vi.fn<(red: Red, code: string) => Promise<CuentaRed>>(),
  };
  const mp = {
    habilitado: true,
    crearSuscripcion: vi.fn(),
    crearPreferencia: vi.fn(),
    cancelarSuscripcion: vi.fn().mockResolvedValue(undefined),
    obtenerPago: vi.fn<(tipo: string, id: string) => Promise<PagoMp | null>>(),
    obtenerSuscripcion: vi.fn<(id: string) => Promise<SuscripcionMp>>(),
    listarPagosSuscripcion: vi.fn<(id: string) => Promise<PagoMp[]>>(),
    verificarFirma: () => true,
  };
  const deps = createDeps(config, {
    prisma: new PrismaClient({ datasources: { db: { url: databaseUrl } } }),
    ai,
    mensajeria,
    meta,
    redes,
    agenda,
    mercadopago: mp,
    now: () => clock.now,
  });
  await ensurePlans(deps.prisma);
  const app = await buildApp(deps);
  await app.ready();

  const env: TestEnv = {
    deps,
    app,
    clock,
    ai,
    mensajeria,
    meta,
    agenda,
    redes,
    mp,
    token: '',
    auth: () => ({ authorization: `Bearer ${env.token}` }),
    async reset() {
      await deps.prisma.$executeRawUnsafe(
        'TRUNCATE "PagoExtra", "CargoExtra", "Calendario", "CorreoEnviado", "Commission", "Referral", "Affiliate", "LegalAcceptance", "ClientUser", "Ticket", "Turno", "Payment", "Subscription", "Conversation", "Usage", "Channel", "Tenant" CASCADE',
      );
      await deps.colaGeneracion.obliterate({ force: true });
      await deps.redis.flushdb();
      await rebuildIndex(deps.prisma, deps.redis);
      clock.now = new Date('2026-11-14T15:00:00Z');
      ai.chat.mockReset();
      mensajeria.enviar.mockReset();
      mensajeria.enviar.mockResolvedValue(undefined);
      meta.intercambiarCodigo.mockReset();
      meta.suscribirApp.mockReset();
      meta.leerNumero.mockReset();
      meta.registrarNumero.mockReset();
      agenda.aplicar.mockReset();
      agenda.aplicar.mockResolvedValue('evt-1');
      redes.listo.mockReset();
      redes.listo.mockReturnValue(true);
      redes.url.mockReset();
      redes.url.mockImplementation((red, state) => `https://auth.test/${red}?state=${state}`);
      redes.completar.mockReset();
      mp.crearSuscripcion.mockReset();
      mp.cancelarSuscripcion.mockClear();
      mp.obtenerPago.mockReset();
      mp.obtenerSuscripcion.mockReset();
      mp.listarPagosSuscripcion.mockReset();
      const res = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: 'admin@test.local', password: 'pw' },
      });
      env.token = res.json().token;
    },
    async close() {
      await app.close();
      await closeDeps(deps);
    },
    async job(messageId) {
      const job = await deps.colaGeneracion.getJob(messageId);
      if (!job) throw new Error(`job ${messageId} no encolado`);
      return job.data as JobGeneracion;
    },
  };
  return env;
}

export const altaBase = {
  clientId: 'pizzeria-norte',
  nombre: 'Pizzería Norte',
  planId: 'turnos',
  medio: 'mercadopago',
  canales: [{ tipo: 'whatsapp', endpointId: 'PN-NORTE', etiqueta: 'WhatsApp del local', token: 'whatsapp-secret-token' }],
  prompt: 'Vendemos pizzas. Abrimos de 19 a 24.',
};

export const registroBase = {
  negocio: 'Peluquería Luna',
  rubro: 'Estética',
  nombre: 'Sofía Pérez',
  email: 'sofia@luna.com',
  password: 'clave-segura-1',
  planId: 'turnos',
  medio: 'mercadopago',
  aceptaTerminos: true,
  aceptaPrivacidad: true,
};

export async function registrarCliente(env: TestEnv, overrides: Record<string, unknown> = {}) {
  const res = await env.app.inject({
    method: 'POST',
    url: '/cuenta/registro',
    payload: { ...registroBase, ...overrides },
  });
  if (res.statusCode !== 201) throw new Error(`registro falló: ${res.statusCode} ${res.body}`);
  const token: string = res.json().token;
  return { token, headers: { authorization: `Bearer ${token}` } };
}

/** POST firmado como lo manda Meta (X-Hub-Signature-256 sobre el cuerpo crudo). */
export function webhookMeta(env: TestEnv, body: unknown, secret = 'meta-secret') {
  const raw = JSON.stringify(body);
  return env.app.inject({
    method: 'POST',
    url: '/webhooks/meta',
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`,
    },
    payload: raw,
  });
}

export function mensajeWhatsapp(texto: string, extra: { from?: string; id?: string; phoneId?: string; nombre?: string } = {}) {
  const from = extra.from ?? '5491100000999';
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        changes: [
          {
            field: 'messages',
            value: {
              metadata: { phone_number_id: extra.phoneId ?? 'PN-NORTE' },
              contacts: [{ wa_id: from, profile: { name: extra.nombre ?? 'Ana' } }],
              messages: [{ id: extra.id ?? `wamid.${texto}.${from}`, from, type: 'text', text: { body: texto } }],
            },
          },
        ],
      },
    ],
  };
}

export async function alta(env: TestEnv, overrides: Record<string, unknown> = {}) {
  const res = await env.app.inject({
    method: 'POST',
    url: '/clientes',
    headers: env.auth(),
    payload: { ...altaBase, ...overrides },
  });
  if (res.statusCode !== 201) throw new Error(`alta falló: ${res.statusCode} ${res.body}`);
  return res.json();
}
