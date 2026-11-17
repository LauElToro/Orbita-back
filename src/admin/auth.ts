import fastifyJwt from '@fastify/jwt';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../deps';
import { safeEqual } from '../lib/crypto';
import { HttpError } from '../lib/errors';
import { rateLimit } from '../lib/rateLimit';

export type Sesion =
  | { sub: string; rol: 'admin' }
  | { sub: string; rol: 'cliente'; tenantId: string }
  | { sub: string; rol: 'afiliado' };

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: Sesion;
    user: Sesion;
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    requireAdmin: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireCliente: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireAfiliado: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1) });

/** TenantId de la sesión de cliente. Solo se llama detrás de `requireCliente`. */
export function tenantDeSesion(req: FastifyRequest): { tenantId: string; userId: string } {
  const user = req.user;
  if (user?.rol !== 'cliente') throw new HttpError(401, 'No autorizado');
  return { tenantId: user.tenantId, userId: user.sub };
}

export async function registerAuth(app: FastifyInstance, deps: Deps): Promise<void> {
  await app.register(fastifyJwt, { secret: deps.config.JWT_SECRET });

  const requireRol = (rol: Sesion['rol']) => async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      await req.jwtVerify();
    } catch {
      return reply.code(401).send({ error: 'No autorizado' });
    }
    if (req.user.rol !== rol) return reply.code(403).send({ error: 'Sin permiso para esta sección' });
  };
  app.decorate('requireAdmin', requireRol('admin'));
  app.decorate('requireCliente', requireRol('cliente'));
  app.decorate('requireAfiliado', requireRol('afiliado'));

  app.post('/auth/login', async (req, reply) => {
    await rateLimit(deps.redis, 'login', req.ip, 10, 900);
    const { email, password } = loginSchema.parse(req.body);
    const ok =
      safeEqual(email.toLowerCase(), deps.config.ADMIN_EMAIL.toLowerCase()) &&
      safeEqual(password, deps.config.ADMIN_PASSWORD);
    if (!ok) return reply.code(401).send({ error: 'Credenciales inválidas' });
    const token = app.jwt.sign({ sub: email, rol: 'admin' }, { expiresIn: '12h' });
    return { token };
  });
}
