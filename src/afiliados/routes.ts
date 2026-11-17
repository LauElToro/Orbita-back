import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../deps';
import { HttpError } from '../lib/errors';
import { rateLimit } from '../lib/rateLimit';
import {
  cambiarEstadoComision,
  datosCobro,
  listarAfiliados,
  listarComisiones,
  loginAfiliado,
  panelAfiliado,
  pedirRestablecimientoAfiliado,
  registrarAfiliado,
  restablecerAfiliado,
} from './service';

function afiliadoDeSesion(req: FastifyRequest): string {
  if (req.user?.rol !== 'afiliado') throw new HttpError(401, 'No autorizado');
  return req.user.sub;
}

const idParams = z.object({ id: z.string().min(1) });

export function registerAfiliadoRoutes(app: FastifyInstance, deps: Deps): void {
  const firmar = (id: string) => app.jwt.sign({ sub: id, rol: 'afiliado' }, { expiresIn: '7d' });

  app.post('/afiliados/registro', async (req, reply) => {
    await rateLimit(deps.redis, 'registro-afiliado', req.ip, 5, 3600);
    const afiliado = await registrarAfiliado(deps, req.body);
    return reply.code(201).send({ token: firmar(afiliado.id) });
  });

  app.post('/afiliados/login', async (req) => {
    await rateLimit(deps.redis, 'login-afiliado', req.ip, 10, 900);
    return { token: firmar((await loginAfiliado(deps, req.body)).id) };
  });

  app.post('/afiliados/olvide', async (req) => {
    await rateLimit(deps.redis, 'olvide-afiliado', req.ip, 5, 3600);
    await pedirRestablecimientoAfiliado(deps, req.body);
    return { ok: true };
  });

  app.post('/afiliados/restablecer', async (req) => {
    await rateLimit(deps.redis, 'restablecer-afiliado', req.ip, 10, 3600);
    await restablecerAfiliado(deps, req.body);
    return { ok: true };
  });

  app.register(async (afiliado) => {
    afiliado.addHook('onRequest', afiliado.requireAfiliado);

    afiliado.get('/afiliados/me', async (req) => panelAfiliado(deps, afiliadoDeSesion(req)));

    afiliado.patch('/afiliados/me', async (req) => {
      const id = afiliadoDeSesion(req);
      await datosCobro(deps, id, req.body);
      return panelAfiliado(deps, id);
    });
  });

  app.register(async (admin) => {
    admin.addHook('onRequest', admin.requireAdmin);

    admin.get('/admin/afiliados', async () => listarAfiliados(deps));

    admin.get('/admin/comisiones', async (req) => listarComisiones(deps, req.query));

    admin.post('/admin/comisiones/:id/pagada', async (req) => {
      const { id } = idParams.parse(req.params);
      return cambiarEstadoComision(deps, id, 'pagada');
    });

    admin.post('/admin/comisiones/:id/anular', async (req) => {
      const { id } = idParams.parse(req.params);
      return cambiarEstadoComision(deps, id, 'anulada');
    });
  });
}
