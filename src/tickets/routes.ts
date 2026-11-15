import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../deps';
import { rateLimit } from '../lib/rateLimit';
import { fichaDto } from '../tenants/service';
import {
  actualizarTicket,
  convertirTicket,
  crearArrepentimiento,
  crearTicket,
  getTicket,
  listarTickets,
} from './service';

const idParams = z.object({ id: z.string().min(1) });

export function registerTicketRoutes(app: FastifyInstance, deps: Deps): void {
  app.post('/publico/contacto', async (req, reply) => {
    await rateLimit(deps.redis, 'contacto', req.ip, 5, 3600);
    await crearTicket(deps, req.body, req.ip);
    return reply.code(201).send({ ok: true });
  });

  app.post('/publico/arrepentimiento', async (req, reply) => {
    await rateLimit(deps.redis, 'arrepentimiento', req.ip, 5, 3600);
    const ticket = await crearArrepentimiento(deps, req.body, req.ip);
    return reply.code(201).send({ ok: true, codigo: ticket?.id ?? null });
  });

  app.register(async (admin) => {
    admin.addHook('onRequest', admin.requireAdmin);

    admin.get('/tickets', async (req) => {
      const { estado, tipo } = z.object({ estado: z.string().optional(), tipo: z.string().optional() }).parse(req.query);
      return listarTickets(deps, estado, tipo);
    });

    admin.get('/tickets/:id', async (req) => getTicket(deps, idParams.parse(req.params).id));

    admin.patch('/tickets/:id', async (req) => actualizarTicket(deps, idParams.parse(req.params).id, req.body));

    admin.post('/tickets/:id/convertir', async (req, reply) => {
      const tenant = await convertirTicket(deps, idParams.parse(req.params).id, req.body);
      return reply.code(201).send(fichaDto(deps, tenant));
    });
  });
}
