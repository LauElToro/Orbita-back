import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../deps';
import { tenantDeSesion } from '../admin/auth';
import { simular } from '../ai/simulador';
import { darDeBaja, iniciarCobroExtra, iniciarSuscripcionMp } from '../billing/service';
import { HttpError } from '../lib/errors';
import { rateLimit } from '../lib/rateLimit';
import { registerDemoRoutes } from '../demo/routes';
import { documentosPendientes, registrarAceptacion } from '../legal/legal';
import { getTenant } from '../tenants/repo';
import { actualizarTenant } from '../tenants/service';
import { leerUso, resumenExtras } from '../usage/usage';
import { completarRed, esRed, iniciarRed } from '../messaging/redes';
import { conectarWhatsapp, refrescarWhatsapp } from '../messaging/whatsapp';
import { devolverCharla, listarAvisos, obtenerCharla, pausarCharla, responderEnVentana } from '../messaging/ventanas';
import { completarCalendario, desconectarCalendario, prepararCalendario } from '../modules/turnos/calendario';
import { guardarWeb, rotarClaveWeb } from '../web/service';
import { darDeBajaAvisos } from '../correo/envios';
import { activarAfiliadoCliente, actualizarAfiliadoCliente, afiliadoDeCliente, cargarReferido } from '../afiliados/service';
import { guardarEnOrbita } from '../archivos/blob';
import { completarGoogle, prepararGoogle } from './google';
import {
  activarPropio,
  avanzarOnboarding,
  cambiarPassword,
  cambiarPlan,
  canalesSchema,
  checkoutPublico,
  completarOnboarding,
  cuentaDto,
  guardarDatosNegocio,
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
  '/cuenta/web',
  '/cuenta/web/clave',
  '/cuenta/onboarding',
  '/cuenta/onboarding/completar',
  '/cuenta/pausar',
  '/cuenta/activar',
  '/cuenta/probar',
  '/cuenta/whatsapp',
  '/cuenta/whatsapp/estado',
  '/cuenta/redes/:red/iniciar',
  '/cuenta/redes/callback',
  '/cuenta/calendario/iniciar',
  '/cuenta/calendario/callback',
]);

export function registerCuentaRoutes(app: FastifyInstance, deps: Deps): void {
  const firmar = (s: { userId: string; tenantId: string }) =>
    app.jwt.sign({ sub: s.userId, rol: 'cliente', tenantId: s.tenantId }, { expiresIn: '7d' });

  app.get('/cuenta/avisos/baja', async (req, reply) => {
    const token = typeof (req.query as { t?: unknown }).t === 'string' ? (req.query as { t: string }).t : '';
    const ok = token ? await darDeBajaAvisos(deps, token) : false;
    reply.type('text/html; charset=utf-8');
    const titulo = ok ? 'Listo, no te mandamos más novedades' : 'Ese link no sirve';
    const texto = ok
      ? 'Los avisos del plan, la contraseña y los pagos siguen llegando. Solo dimos de baja la newsletter y las promociones.'
      : 'El link está incompleto o ya no es válido.';
    return `<!doctype html><html lang="es"><meta charset="utf-8"><title>${titulo}</title><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#1d2330"><h1 style="font-size:1.4rem">${titulo}</h1><p>${texto}</p></body></html>`;
  });

  app.post('/cuenta/registro', async (req, reply) => {
    await rateLimit(deps.redis, 'registro', req.ip, 5, 3600);
    const sesion = await registrar(deps, req.body, evidencia(req));
    return reply.code(201).send({ token: firmar(sesion) });
  });

  app.post('/checkout', async (req) => {
    await rateLimit(deps.redis, 'checkout', req.ip, 10, 3600);
    return checkoutPublico(deps, req.body, evidencia(req));
  });

  app.post('/cuenta/login', async (req) => {
    await rateLimit(deps.redis, 'login-cliente', req.ip, 10, 900);
    return { token: firmar(await login(deps, req.body, req.ip)) };
  });

  app.post('/cuenta/google/iniciar', async (req) => {
    await rateLimit(deps.redis, 'google', req.ip, 20, 3600);
    return prepararGoogle(deps, req.body);
  });

  app.post('/cuenta/google/callback', async (req) => {
    await rateLimit(deps.redis, 'google-vuelta', req.ip, 20, 3600);
    return { token: firmar(await completarGoogle(deps, req.body, req.ip)) };
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

    const responder = async (req: FastifyRequest, tenantId: string) => {
      const tenant = await getTenant(deps.prisma, tenantId);
      return cuentaDto(deps, tenant, await documentosPendientes(deps.prisma, tenantDeSesion(req).userId), await resumenExtras(deps, tenant));
    };

    cuenta.get('/cuenta/me', async (req) => responder(req, tenantDeSesion(req).tenantId));

    registerDemoRoutes(cuenta, deps);

    cuenta.post('/cuenta/archivos', { bodyLimit: 12 * 1024 * 1024 }, async (req, reply) => {
      const { tenantId } = tenantDeSesion(req);
      await rateLimit(deps.redis, 'archivos', tenantId, 60, 3600);
      const cuerpo = z
        .object({
          nombre: z.string().trim().min(1).max(160),
          archivo: z.string().min(1).max(12_000_000),
          carpeta: z.string().trim().max(80).optional(),
        })
        .parse(req.body);
      const guardado = await guardarEnOrbita(deps.config.BLOB_READ_WRITE_TOKEN, cuerpo.nombre, cuerpo.archivo, cuerpo.carpeta ?? tenantId);
      return reply.code(201).send(guardado);
    });

    cuenta.post('/cuenta/legal/aceptar', async (req) => {
      const { userId, tenantId } = tenantDeSesion(req);
      const pendientes = await documentosPendientes(deps.prisma, userId);
      if (pendientes.length) await registrarAceptacion(deps.prisma, userId, pendientes, evidencia(req));
      return responder(req, tenantId);
    });

    cuenta.patch('/cuenta/negocio', async (req) => {
      const { tenantId } = tenantDeSesion(req);
      await guardarDatosNegocio(deps, tenantId, req.body);
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

    cuenta.post('/cuenta/referido', async (req) => {
      const { userId, tenantId } = tenantDeSesion(req);
      await rateLimit(deps.redis, 'cargar-referido', tenantId, 10, 3600);
      await cargarReferido(deps, tenantId, userId, req.body);
      return responder(req, tenantId);
    });

    cuenta.get('/cuenta/afiliado', async (req) => ({ afiliado: await afiliadoDeCliente(deps, tenantDeSesion(req).userId) }));

    cuenta.post('/cuenta/afiliado', async (req) => activarAfiliadoCliente(deps, tenantDeSesion(req).userId, req.body));

    cuenta.patch('/cuenta/afiliado', async (req) => actualizarAfiliadoCliente(deps, tenantDeSesion(req).userId, req.body));

    cuenta.post('/cuenta/baja', async (req) => {
      const { tenantId } = tenantDeSesion(req);
      await darDeBaja(deps, tenantId);
      return responder(req, tenantId);
    });

    cuenta.post('/cuenta/extras', async (req) => {
      const tenant = await getTenant(deps.prisma, tenantDeSesion(req).tenantId);
      return iniciarCobroExtra(deps, tenant);
    });

    cuenta.post('/cuenta/whatsapp', async (req) => {
      const { tenantId } = tenantDeSesion(req);
      await conectarWhatsapp(deps, tenantId, req.body);
      return responder(req, tenantId);
    });

    cuenta.post('/cuenta/whatsapp/estado', async (req) => {
      const { tenantId } = tenantDeSesion(req);
      await refrescarWhatsapp(deps, tenantId);
      return responder(req, tenantId);
    });

    cuenta.post('/cuenta/redes/:red/iniciar', async (req) => {
      const { red } = z.object({ red: z.string() }).parse(req.params);
      if (!esRed(red)) throw new HttpError(404, 'Esa red no se conecta desde acá');
      return iniciarRed(deps, tenantDeSesion(req).tenantId, red);
    });

    cuenta.post('/cuenta/redes/callback', async (req) => {
      const { tenantId } = tenantDeSesion(req);
      await completarRed(deps, tenantId, req.body);
      return responder(req, tenantId);
    });

    cuenta.get('/cuenta/ventanas', async (req) => {
      const { q } = z.object({ q: z.string().trim().max(80).optional() }).parse(req.query);
      return listarAvisos(deps, tenantDeSesion(req).tenantId, q);
    });

    cuenta.get('/cuenta/ventanas/:id', async (req) => {
      const { tenantId } = tenantDeSesion(req);
      const { id } = z.object({ id: z.string().min(1) }).parse(req.params);
      return obtenerCharla(deps, tenantId, id);
    });

    cuenta.post('/cuenta/ventanas/:id/responder', async (req) => {
      const { tenantId } = tenantDeSesion(req);
      const { id } = z.object({ id: z.string().min(1) }).parse(req.params);
      return responderEnVentana(deps, tenantId, id, req.body);
    });

    cuenta.post('/cuenta/ventanas/:id/pausar', async (req) => {
      const { tenantId } = tenantDeSesion(req);
      const { id } = z.object({ id: z.string().min(1) }).parse(req.params);
      return pausarCharla(deps, tenantId, id);
    });

    cuenta.post('/cuenta/ventanas/:id/devolver', async (req) => {
      const { tenantId } = tenantDeSesion(req);
      const { id } = z.object({ id: z.string().min(1) }).parse(req.params);
      return devolverCharla(deps, tenantId, id);
    });

    cuenta.post('/cuenta/calendario/iniciar', async (req) => prepararCalendario(deps, tenantDeSesion(req).tenantId));

    cuenta.post('/cuenta/calendario/callback', async (req) => {
      const { tenantId } = tenantDeSesion(req);
      await completarCalendario(deps, tenantId, req.body);
      return responder(req, tenantId);
    });

    cuenta.delete('/cuenta/calendario', async (req) => {
      const { tenantId } = tenantDeSesion(req);
      await desconectarCalendario(deps, tenantId);
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

    cuenta.put('/cuenta/web', async (req) => {
      const { tenantId } = tenantDeSesion(req);
      await guardarWeb(deps, tenantId, req.body);
      return responder(req, tenantId);
    });

    cuenta.post('/cuenta/web/clave', async (req) => {
      const { tenantId } = tenantDeSesion(req);
      await rotarClaveWeb(deps, tenantId);
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
