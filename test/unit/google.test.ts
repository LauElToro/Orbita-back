import { describe, expect, it, vi } from 'vitest';
import type { Deps } from '../../src/deps';
import { completarGoogle, prepararGoogle, redirectDeGoogle } from '../../src/cuenta/google';
import type { Config } from '../../src/config';

function depsGoogle() {
  const store = new Map<string, string>();
  const usuarios = new Map<string, { id: string; tenantId: string; email: string; nombre: string }>();
  const tenants: { id: string; nombre: string; rubro: string | null; planId: string; planElegido: boolean }[] = [];
  let seq = 0;
  const deps = {
    config: {
      GOOGLE_CLIENT_ID: 'client',
      GOOGLE_CLIENT_SECRET: 'secret',
      GOOGLE_REDIRECT_URI: 'https://orbita-ai.duckdns.org/google/vuelta',
      PUBLIC_URL: 'https://orbita-ai.duckdns.org',
    } as Config,
    redis: {
      set: async (_k: string, v: string) => {
        store.set(_k, v);
        return 'OK';
      },
      get: async (k: string) => store.get(k) ?? null,
      del: async (k: string) => {
        store.delete(k);
        return 1;
      },
    },
    prisma: {
      plan: { findUniqueOrThrow: async () => ({ id: 'mensajes', modulos: ['faq'], topeDia: 1, topeSemana: 2, topeMes: 3 }) },
      tenant: {
        findUnique: async ({ where }: { where: { id: string } }) => (tenants.some((t) => t.id === where.id) ? { id: where.id } : null),
        create: async ({ data }: { data: { id: string; nombre: string; rubro: string | null; planId: string; planElegido: boolean; emailContacto: string; usuario: { create: { email: string; nombre: string } } } }) => {
          tenants.push({ id: data.id, nombre: data.nombre, rubro: data.rubro, planId: data.planId, planElegido: data.planElegido });
          const user = { id: `u${++seq}`, tenantId: data.id, email: data.usuario.create.email, nombre: data.usuario.create.nombre };
          usuarios.set(user.email, user);
          return { ...data, usuario: user };
        },
        update: async () => tenants[0],
      },
      clientUser: {
        findUnique: async ({ where }: { where: { email: string } }) => usuarios.get(where.email) ?? null,
        update: async () => usuarios.values().next().value,
      },
    },
    correo: { enviar: vi.fn(async () => undefined) },
    now: () => new Date('2026-11-16T15:00:00Z'),
  };
  return { deps: deps as unknown as Deps, tenants, usuarios };
}

describe('ingreso con Google', () => {
  it('arma la vuelta pública del sitio', () => {
    expect(redirectDeGoogle({ GOOGLE_REDIRECT_URI: '', PUBLIC_URL: 'https://orbita-ai.duckdns.org/' } as Config)).toBe(
      'https://orbita-ai.duckdns.org/google/vuelta',
    );
  });

  it('el registro no pide el formulario y la cuenta nueva queda sin plan', async () => {
    const { deps, tenants } = depsGoogle();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('oauth2.googleapis.com/token')) return new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 });
      if (url.includes('userinfo')) {
        return new Response(JSON.stringify({ email: 'Ana@Gmail.com', email_verified: true, name: 'Ana Gómez' }), { status: 200 });
      }
      throw new Error(url);
    });

    const inicio = await prepararGoogle(deps, { modo: 'registro' });
    expect(inicio.url).toContain('redirect_uri=https%3A%2F%2Forbita-ai.duckdns.org%2Fgoogle%2Fvuelta');
    const state = new URL(inicio.url).searchParams.get('state');
    const sesion = await completarGoogle(deps, { code: 'abc', state });
    expect(sesion.userId).toBe('u1');
    expect(tenants[0]).toMatchObject({ nombre: 'Mi negocio', rubro: null, planId: 'mensajes', planElegido: false });

    const otra = await prepararGoogle(deps, { modo: 'login' });
    const stateLogin = new URL(otra.url).searchParams.get('state');
    const deNuevo = await completarGoogle(deps, { code: 'abc', state: stateLogin });
    expect(deNuevo).toEqual(sesion);
    expect(tenants).toHaveLength(1);
    fetchMock.mockRestore();
  });

  it('rechaza un pedido que no es login ni registro', async () => {
    const { deps } = depsGoogle();
    await expect(prepararGoogle(deps, { modo: 'otro' })).rejects.toThrow('Pedido inválido');
  });
});
