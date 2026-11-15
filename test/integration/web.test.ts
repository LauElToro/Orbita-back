import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { alta, createTestEnv, registrarCliente, type TestEnv } from './helpers';

let env: TestEnv;
let clave: string;

const mensaje = (texto: string, extra: Record<string, unknown> = {}, origin?: string) =>
  env.app.inject({
    method: 'POST',
    url: `/web/${clave}/mensajes`,
    headers: origin ? { origin } : {},
    payload: { sesion: 'visitante-0001', texto, ...extra },
  });

beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => env.close());
beforeEach(async () => {
  await env.reset();
  await alta(env, { emailContacto: 'dueno@pizzeria.test' });
  const { headers } = await registrarCliente(env);
  const tenantId = (await env.deps.prisma.clientUser.findFirstOrThrow({ where: { email: 'sofia@luna.com' } })).tenantId;
  await env.deps.prisma.subscription.update({ where: { tenantId }, data: { estadoPago: 'al_dia' } });
  const res = await env.app.inject({
    method: 'PUT',
    url: '/cuenta/web',
    headers,
    payload: { activa: true, origenes: ['https://www.peluluna.com/turnos', 'peluluna.mitiendanube.com'], color: '#ff0066' },
  });
  expect(res.statusCode).toBe(200);
  const web = res.json().web;
  clave = web.clave;
  expect(web).toMatchObject({
    activa: true,
    origenes: ['peluluna.com', 'peluluna.mitiendanube.com'],
    color: '#ff0066',
    endpoint: `https://orbita.test/api/web/${clave}/mensajes`,
  });
  expect(web.script).toBe(`<script src="https://orbita.test/api/web/widget.js" data-clave="${clave}" async></script>`);
  await env.deps.prisma.tenant.update({ where: { id: tenantId }, data: { estado: 'activo', pausaMotivo: null } });
});

describe('integración web', () => {
  it('sirve el widget y la configuración pública', async () => {
    const js = await env.app.inject({ method: 'GET', url: '/web/widget.js' });
    expect(js.statusCode).toBe(200);
    expect(js.headers['content-type']).toContain('application/javascript');
    expect(js.body).toContain('data-clave');

    const cfg = await env.app.inject({ method: 'GET', url: `/web/${clave}`, headers: { origin: 'https://shop.peluluna.com' } });
    expect(cfg.statusCode).toBe(200);
    expect(cfg.headers['access-control-allow-origin']).toBe('https://shop.peluluna.com');
    expect(cfg.json()).toEqual({ negocio: 'Peluquería Luna', bienvenida: expect.stringContaining('Peluquería Luna'), color: '#ff0066', disponible: true });
  });

  it('responde en el mismo pedido, suma uso y recuerda la charla por sesión', async () => {
    env.ai.chat.mockResolvedValueOnce('**Corte $8.000**, abrimos de martes a sábado.').mockResolvedValueOnce('Sí, te espero.');
    const r1 = await mensaje('cuánto sale el corte?', { nombre: 'Ana' }, 'https://peluluna.com');
    expect(r1.statusCode).toBe(200);
    expect(r1.json()).toMatchObject({ ok: true, estado: 'respondido', texto: 'Corte $8.000, abrimos de martes a sábado.', handoff: false });

    await mensaje('y el sábado?');
    const segunda = env.ai.chat.mock.calls[1][1] as { role: string; content: string }[];
    expect(segunda.map((m) => m.content)).toContain('cuánto sale el corte?');

    const conv = await env.deps.prisma.conversation.findFirstOrThrow({ where: { subscriberId: 'web:visitante-0001' } });
    expect(conv).toMatchObject({ nombre: 'Ana', canal: null });
    const usos = await env.deps.prisma.usage.findMany({ where: { tenantId: conv.tenantId } });
    expect(usos.length).toBeGreaterThan(0);
    expect(usos.every((u) => u.count === 2)).toBe(true);
  });

  it('rechaza sitios no habilitados, claves inválidas y datos mal formados', async () => {
    expect((await mensaje('hola', {}, 'https://otro-sitio.com')).statusCode).toBe(403);
    expect((await env.app.inject({ method: 'POST', url: '/web/clave-que-no-existe/mensajes', payload: { sesion: 'visitante-0001', texto: 'hola' } })).statusCode).toBe(404);
    expect((await env.app.inject({ method: 'POST', url: `/web/${clave}/mensajes`, payload: { sesion: 'x', texto: 'hola' } })).statusCode).toBe(400);
    expect(env.ai.chat).not.toHaveBeenCalled();
  });

  it('con la ficha pausada no llama a la IA', async () => {
    await env.deps.prisma.tenant.updateMany({ where: { webClave: clave }, data: { estado: 'pausado', pausaMotivo: 'manual' } });
    const r = await mensaje('hola');
    expect(r.json()).toMatchObject({ estado: 'no_disponible', texto: '' });
    expect(env.ai.chat).not.toHaveBeenCalled();
  });

  it('al derivar pide un contacto y lo manda por mail al comercio', async () => {
    const enviar = vi.spyOn(env.deps.correo, 'enviar').mockResolvedValue(undefined);
    env.ai.chat.mockResolvedValueOnce('[HANDOFF]');
    const r = await mensaje('quiero hacer un reclamo', { nombre: 'Ana' });
    expect(r.json()).toMatchObject({ handoff: true, estado: 'respondido' });

    const c = await env.app.inject({ method: 'POST', url: `/web/${clave}/contacto`, payload: { sesion: 'visitante-0001', contacto: '11 5555-0000' } });
    expect(c.statusCode).toBe(200);
    const mail = enviar.mock.calls.at(-1)![0];
    expect(mail.para).toBe('sofia@luna.com');
    expect(mail.asunto).toBe('Ana quiere hablar con alguien de Peluquería Luna');
    expect(JSON.stringify(mail)).toContain('11 5555-0000');
    expect(JSON.stringify(mail)).toContain('quiero hacer un reclamo');
    enviar.mockRestore();
  });

  it('rotar la clave invalida la anterior y desactivar corta el acceso', async () => {
    const vieja = clave;
    const tenant = await env.deps.prisma.tenant.findFirstOrThrow({ where: { webClave: vieja } });
    const { rotarClaveWeb } = await import('../../src/web/service');
    await rotarClaveWeb(env.deps, tenant.id);
    expect((await env.app.inject({ method: 'GET', url: `/web/${vieja}` })).statusCode).toBe(404);
    const nueva = (await env.deps.prisma.tenant.findUniqueOrThrow({ where: { id: tenant.id } })).webClave!;
    expect((await env.app.inject({ method: 'GET', url: `/web/${nueva}` })).statusCode).toBe(200);
    await env.deps.prisma.tenant.update({ where: { id: tenant.id }, data: { webActiva: false } });
    expect((await env.app.inject({ method: 'GET', url: `/web/${nueva}` })).statusCode).toBe(404);
  });

  it('la integración web activa cumple el requisito de canal para activar la IA', async () => {
    const tenant = await env.deps.prisma.tenant.findFirstOrThrow({ where: { webClave: clave } });
    const { requisitosOnboarding } = await import('../../src/cuenta/service');
    const { getTenant } = await import('../../src/tenants/repo');
    expect(requisitosOnboarding(await getTenant(env.deps.prisma, tenant.id)).canal).toBe(true);
  });
});
