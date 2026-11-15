import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Deps } from '../deps';
import { tenantDeSesion } from '../admin/auth';
import { simular } from '../ai/simulador';
import { iniciarSuscripcionMp } from '../billing/service';
import { HttpError } from '../lib/errors';
import { rateLimit } from '../lib/rateLimit';
import { documentosPendientes, registrarAceptacion } from '../legal/legal';
import { getTenant } from '../tenants/repo';
import { actualizarTenant } from '../tenants/service';
import { leerUso } from '../usage/usage';
import { completarGoogle, prepararGoogle } from './google';
import {
  activarPropio,
  actualizarManychat,
  avanzarOnboarding,
  cambiarPassword,
  cambiarPlan,
  canalesSchema,
  completarOnboarding,
  cuentaDto,
  guardarPerfil,
  login,
  pausarPropio,
  promptSchema,
  registrar,
  pedirRestablecimiento,
  restablecer,
  textosSchema,
} from './service';

const evidencia = (req: FastifyRequest) => ({ ip: req.ip, userAgent: req.headers['user-agent'] });

const SIN_GUARDA_LEGAL = new Set(['/cuenta/me', '/cuenta/legal/aceptar']);
const SOLO_CON_PAGO = new Set([
  '/cuenta/perfil',
  '/cuenta/prompt',
  '/cuenta/textos',
  '/cuenta/canales',
  '/cuenta/manychat',
  '/cuenta/onboarding',
  '/cuenta/onboarding/completar',
  '/cuenta/pausar',
  '/cuenta/activar',
  '/cuenta/probar',
]);

export function registerCuentaRoutes(app: FastifyInstance, deps: Deps): void {
  const firmar = (s: { userId: string; tenantId: string }) =>
    app.jwt.sign({ sub: s.userId, rol: 'cliente', tenantId: s.tenantId }, { expiresIn: '7d' });

  app.post('/cuenta/registro', async (req, reply) => {
    await rateLimit(deps.redis, 'registro', req.ip, 5, 3600);
    const sesion = await registrar(deps, req.body, evidencia(req));
    return reply.code(201).send({ token: firmar(sesion) });
  });

  app.post('/cuenta/login', async (req) => {
    await rateLimit(deps.redis, 'login-cliente', req.ip, 10, 900);
    return { token: firmar(await login(deps, req.body)) };
  });

  app.post('/cuenta/google/iniciar', async (req) => {
    await rateLimit(deps.redis, 'google', req.ip, 20, 3600);
    return prepararGoogle(deps, req.body);
  });

  app.post('/cuenta/google/callback', async (req) => {
    await rateLimit(deps.redis, 'google-vuelta', req.ip, 20, 3600);
    return { token: firmar(await completarGoogle(deps, req.body, evidencia(req))) };
  });

  app.post('/cuenta/olvide', async (req) => {
    await rateLimit(deps.redis, 'olvide', req.ip, 5, 3600);
    await pedirRestablecimiento(deps, req.body);
    return { ok: true };
  });

  app.post('/cuenta/restablecer', async (req) => {
    await rateLimit(deps.redis, 'restablecer', req.ip, 10, 3600);
    await restablecer(deps, req.body);
    return { ok: true };
  });

  app.register(async (cuenta) => {
    cuenta.addHook('onRequest', cuenta.requireCliente);
    cuenta.addHook('preHandler', async (req) => {
      const url = req.routeOptions.url ?? '';
      if (!SIN_GUARDA_LEGAL.has(url)) {
        const pendientes = await documentosPendientes(deps.prisma, tenantDeSesion(req).userId);
        if (pendientes.length) throw new HttpError(428, 'Tenés que aceptar la versión vigente de los documentos legales');
      }
      if (SOLO_CON_PAGO.has(url)) {
        const tenant = await getTenant(deps.prisma, tenantDeSesion(req).tenantId);
        const pago = tenant.subscription?.estadoPago === 'al_dia';
        if (!pago && !tenant.onboardingCompletado) {
          throw new HttpError(402, 'Esta parte se habilita cuando se acredita el pago con Mercado Pago');
        }
      }
    });

    const responder = async (req: FastifyRequest, tenantId: string) =>
      cuentaDto(
        deps,
        await getTenant(deps.prisma, tenantId),
        await documentosPendientes(deps.prisma, tenantDeSesion(req).userId),
      );

    cuenta.get('/cuenta/me', async (req) => responder(req, tenantDeSesion(req).tenantId));

    cuenta.post('/cuenta/legal/aceptar', async (req) => {
      const { userId, tenantId } = tenantDeSesion(req);
      const pendientes = await documentosPendientes(deps.prisma, userId);
      if (pendientes.length) await registrarAceptacion(deps.prisma, userId, pendientes, evidencia(req));
      return responder(req, tenantId);
    });

    cuenta.post('/cuenta/password', async (req) => {
      await cambiarPassword(deps, tenantDeSesion(req).userId, req.body);
      return { ok: true };
    });

    cuenta.patch('/cuenta/plan', async (req) => {
      const { tenantId } = tenantDeSesion(req);
      await cambiarPlan(deps, tenantId, req.body);
      return responder(req, tenantId);
    });

    cuenta.post('/cuenta/suscripcion', async (req) => {
      const tenant = await getTenant(deps.prisma, tenantDeSesion(req).tenantId);
      return iniciarSuscripcionMp(deps, tenant, undefined, `${deps.config.PUBLIC_URL}/cuenta`);
    });

    cuenta.put('/cuenta/perfil', async (req) => {
      const { tenantId } = tenantDeSesion(req);
      await guardarPerfil(deps, tenantId, req.body);
      return responder(req, tenantId);
    });

    cuenta.put('/cuenta/prompt', async (req) => {
      const { tenantId } = tenantDeSesion(req);
      const { prompt } = promptSchema.parse(req.body);
      await deps.prisma.tenant.update({ where: { id: tenantId }, data: { prompt } });
      return responder(req, tenantId);
    });

    cuenta.patch('/cuenta/textos', async (req) => {
      const { tenantId } = tenantDeSesion(req);
      await actualizarTenant(deps, tenantId, { mensajes: textosSchema.parse(req.body) });
      return responder(req, tenantId);
    });

    cuenta.put('/cuenta/canales', async (req) => {
      const { tenantId } = tenantDeSesion(req);
      await actualizarTenant(deps, tenantId, canalesSchema.parse(req.body));
      return responder(req, tenantId);
    });

    cuenta.put('/cuenta/manychat', async (req) => {
      const { tenantId } = tenantDeSesion(req);
      await actualizarManychat(deps, tenantId, req.body);
      return responder(req, tenantId);
    });

    cuenta.post('/cuenta/onboarding', async (req) => {
      const { tenantId } = tenantDeSesion(req);
      await avanzarOnboarding(deps, tenantId, req.body);
      return responder(req, tenantId);
    });

    cuenta.post('/cuenta/onboarding/completar', async (req) => {
      const { tenantId } = tenantDeSesion(req);
      await completarOnboarding(deps, tenantId);
      return responder(req, tenantId);
    });

    cuenta.post('/cuenta/pausar', async (req) => {
      const { tenantId } = tenantDeSesion(req);
      await pausarPropio(deps, tenantId);
      return responder(req, tenantId);
    });

    cuenta.post('/cuenta/activar', async (req) => {
      const { tenantId } = tenantDeSesion(req);
      await activarPropio(deps, tenantId);
      return responder(req, tenantId);
    });

    cuenta.post('/cuenta/probar', async (req) => {
      const { tenantId } = tenantDeSesion(req);
      await rateLimit(deps.redis, 'simulador', tenantId, 60, 3600);
      const tenant = await getTenant(deps.prisma, tenantId);
      if (tenant.subscription?.estadoPago !== 'al_dia') {
        throw new HttpError(402, 'El simulador se habilita cuando se acredita el pago del plan');
      }
      try {
        return await simular(deps, tenant, req.body);
      } catch (err) {
        if (err instanceof Error && err.name === 'ZodError') throw err;
        req.log.error(err);
        throw new HttpError(502, 'La IA no respondió. Probá de nuevo en unos segundos.');
      }
    });

    cuenta.get('/cuenta/uso', async (req) => {
      const tenant = await getTenant(deps.prisma, tenantDeSesion(req).tenantId);
      const uso = await leerUso(deps, tenant);
      return {
        dia: { usado: uso.dia, tope: tenant.topeDia, reinicia: uso.periodos.reinicio.dia },
        semana: { usado: uso.semana, tope: tenant.topeSemana, reinicia: uso.periodos.reinicio.semana },
        mes: { usado: uso.mes, tope: tenant.topeMes, reinicia: uso.periodos.reinicio.mes },
      };
    });

    cuenta.get('/cuenta/turnos', async (req) => {
      const { tenantId } = tenantDeSesion(req);
      return deps.prisma.turno.findMany({
        where: { tenantId, fecha: { gte: new Date(deps.now().getTime() - 7 * 86_400_000) } },
        orderBy: { fecha: 'asc' },
        select: { id: true, nombre: true, fecha: true, estado: true, recordatorioEnviado: true },
      });
    });

    cuenta.get('/cuenta/pagos', async (req) =>
      deps.prisma.payment.findMany({
        where: { tenantId: tenantDeSesion(req).tenantId },
        orderBy: { createdAt: 'desc' },
        take: 24,
        select: { id: true, medio: true, importe: true, periodo: true, createdAt: true },
      }),
    );
  });
}
