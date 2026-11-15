import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../deps';
import { activar, marcarTransferencia, pausar } from '../billing/service';
import { generarReset, invitarCliente } from '../cuenta/service';
import { leerUso } from '../usage/usage';
import { getTenant } from './repo';
import { actualizarPrompt, actualizarTenant, crearTenant, fichaDto, listarTenants } from './service';

const idParams = z.object({ id: z.string().min(1) });

export function registerTenantRoutes(app: FastifyInstance, deps: Deps): void {
  app.register(async (admin) => {
    admin.addHook('onRequest', admin.requireAdmin);

    admin.get('/planes', async () => deps.prisma.plan.findMany({ orderBy: { precioTransferencia: 'asc' } }));

    admin.get('/clientes', async () => listarTenants(deps));

    admin.post('/clientes', async (req, reply) => {
      const tenant = await crearTenant(deps, req.body);
      return reply.code(201).send(fichaDto(deps, tenant));
    });

    admin.get('/clientes/:id', async (req) => {
      const { id } = idParams.parse(req.params);
      return fichaDto(deps, await getTenant(deps.prisma, id));
    });

    admin.patch('/clientes/:id', async (req) => {
      const { id } = idParams.parse(req.params);
      return fichaDto(deps, await actualizarTenant(deps, id, req.body));
    });

    admin.put('/clientes/:id/prompt', async (req) => {
      const { id } = idParams.parse(req.params);
      return fichaDto(deps, await actualizarPrompt(deps, id, req.body));
    });

    admin.post('/clientes/:id/pausar', async (req) => {
      const { id } = idParams.parse(req.params);
      return fichaDto(deps, await pausar(deps, id));
    });

    admin.post('/clientes/:id/activar', async (req) => {
      const { id } = idParams.parse(req.params);
      return fichaDto(deps, await activar(deps, id));
    });

    admin.post('/clientes/:id/transferencia', async (req) => {
      const { id } = idParams.parse(req.params);
      return fichaDto(deps, await marcarTransferencia(deps, id));
    });

    admin.get('/clientes/:id/uso', async (req) => {
      const { id } = idParams.parse(req.params);
      const tenant = await getTenant(deps.prisma, id);
      const uso = await leerUso(deps, tenant);
      return {
        dia: { usado: uso.dia, tope: tenant.topeDia, reinicia: uso.periodos.reinicio.dia },
        semana: { usado: uso.semana, tope: tenant.topeSemana, reinicia: uso.periodos.reinicio.semana },
        mes: { usado: uso.mes, tope: tenant.topeMes, reinicia: uso.periodos.reinicio.mes },
      };
    });

    admin.get('/clientes/:id/turnos', async (req) => {
      const { id } = idParams.parse(req.params);
      await getTenant(deps.prisma, id);
      return deps.prisma.turno.findMany({
        where: { tenantId: id, fecha: { gte: new Date(deps.now().getTime() - 7 * 86_400_000) } },
        orderBy: { fecha: 'asc' },
      });
    });

    admin.post('/clientes/:id/reset-password', async (req) => {
      const { id } = idParams.parse(req.params);
      return generarReset(deps, id);
    });

    admin.post('/clientes/:id/acceso', async (req, reply) => {
      const { id } = idParams.parse(req.params);
      return reply.code(201).send(await invitarCliente(deps, id, req.body));
    });

    admin.get('/clientes/:id/pagos', async (req) => {
      const { id } = idParams.parse(req.params);
      return deps.prisma.payment.findMany({ where: { tenantId: id }, orderBy: { createdAt: 'desc' }, take: 24 });
    });
  });
}
