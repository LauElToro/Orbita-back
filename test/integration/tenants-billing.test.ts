import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { revisarVencimientos } from '../../src/billing/service';
import { enviarRecordatorios } from '../../src/modules/recordatorios';
import { alta, altaBase, createTestEnv, type TestEnv } from './helpers';

let env: TestEnv;

beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => env.close());
beforeEach(async () => env.reset());

const req = (method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, payload?: unknown) =>
  env.app.inject({ method, url, headers: env.auth(), payload: payload as Record<string, unknown> });

describe('auth del equipo', () => {
  it('rechaza credenciales inválidas y rutas sin token', async () => {
    const login = await env.app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'admin@test.local', password: 'mal' },
    });
    expect(login.statusCode).toBe(401);
    expect((await env.app.inject({ method: 'GET', url: '/clientes' })).statusCode).toBe(401);
  });

  it('health responde', async () => {
    expect((await env.app.inject({ method: 'GET', url: '/health' })).json()).toEqual({ ok: true });
  });
});

describe('fichas', () => {
  it('alta crea ficha con módulos y topes del plan, sin exponer el appToken', async () => {
    const ficha = await alta(env);
    expect(ficha).toMatchObject({
      id: 'pizzeria-norte',
      modulos: ['faq', 'handoff', 'turnos'],
      topeDia: 200,
      appTokenMask: '****oken',
      importe: 80_000,
    });
    expect(ficha.appTokenEnc).toBeUndefined();
    expect(JSON.stringify(ficha)).not.toContain('manychat-secret-token');
    expect(ficha.linkPublico).toBe(`https://orbita.test/p/${ficha.publicToken}`);

    const lista = (await req('GET', '/clientes')).json();
    expect(lista).toEqual([
      expect.objectContaining({ id: 'pizzeria-norte', estado: 'activo', estadoPago: 'pendiente' }),
    ]);
    expect((await req('GET', '/planes')).json()).toHaveLength(4);
  });

  it('valida canales del plan, duplicados y plan personalizado', async () => {
    const dosCanales = [
      { tipo: 'whatsapp', endpointId: 'a', etiqueta: 'a' },
      { tipo: 'instagram', endpointId: 'b', etiqueta: 'b' },
    ];
    expect((await req('POST', '/clientes', { ...altaBase, planId: 'mensajes', canales: dosCanales })).statusCode).toBe(400);
    expect((await req('POST', '/clientes', { ...altaBase, planId: 'personalizado' })).statusCode).toBe(400);
    expect((await req('POST', '/clientes', { ...altaBase, timezone: 'Marte/Base' })).statusCode).toBe(400);
    await alta(env);
    expect((await req('POST', '/clientes', altaBase)).statusCode).toBe(409);
    expect((await req('POST', '/clientes', { ...altaBase, clientId: 'otro' })).statusCode).toBe(409);
    expect((await req('GET', '/clientes/nope')).statusCode).toBe(404);
  });

  it('cambiar de plan reescribe topes y módulos y controla canales', async () => {
    await alta(env, {
      canales: [
        { tipo: 'whatsapp', endpointId: 'a', etiqueta: 'a' },
        { tipo: 'instagram', endpointId: 'b', etiqueta: 'b' },
      ],
    });
    expect((await req('PATCH', '/clientes/pizzeria-norte', { planId: 'mensajes' })).statusCode).toBe(400);

    const ok = await req('PATCH', '/clientes/pizzeria-norte', {
      planId: 'mensajes',
      canales: [{ tipo: 'whatsapp', endpointId: 'a', etiqueta: 'a' }],
      mensajes: { tope: 'Nuevo tope' },
      appToken: 'nuevo-token-9999',
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({
      planId: 'mensajes',
      modulos: ['faq', 'handoff'],
      topeMes: 2_000,
      appTokenMask: '****9999',
      mensajes: { tope: 'Nuevo tope', handoff: 'Te paso con alguien del local.' },
    });
    expect(await env.deps.redis.hget('idx:endpoints', 'b')).toBeNull();

    const prompt = await req('PUT', '/clientes/pizzeria-norte/prompt', { prompt: 'Nuevo prompt' });
    expect(prompt.json().prompt).toBe('Nuevo prompt');

    const medio = await req('PATCH', '/clientes/pizzeria-norte', { medio: 'mercadopago' });
    expect(medio.json()).toMatchObject({ importe: 42_000, subscription: { medio: 'mercadopago' } });
  });
});

describe('cobros', () => {
  it('transferencia: marcar pago, pausar, activar y pausa automática por impago', async () => {
    await alta(env);
    expect((await req('POST', '/clientes/pizzeria-norte/activar')).statusCode).toBe(409);

    const pagada = (await req('POST', '/clientes/pizzeria-norte/transferencia')).json();
    expect(pagada.subscription).toMatchObject({ estadoPago: 'al_dia', vencimiento: '2026-12-14T15:00:00.000Z' });
    expect((await req('GET', '/clientes/pizzeria-norte/pagos')).json()).toHaveLength(1);

    expect((await req('POST', '/clientes/pizzeria-norte/pausar')).json()).toMatchObject({ estado: 'pausado' });
    expect((await req('POST', '/clientes/pizzeria-norte/activar')).json()).toMatchObject({ estado: 'activo' });

    env.clock.now = new Date('2026-12-15T15:00:00Z');
    expect(await revisarVencimientos(env.deps)).toEqual({ pendientes: 1, impagos: 0 });
    env.clock.now = new Date('2026-12-22T15:00:00Z');
    expect(await revisarVencimientos(env.deps)).toEqual({ pendientes: 0, impagos: 1 });
    const pausada = (await req('GET', '/clientes/pizzeria-norte')).json();
    expect(pausada).toMatchObject({ estado: 'pausado', pausaMotivo: 'impago', subscription: { estadoPago: 'impago' } });

    const reactivada = (await req('POST', '/clientes/pizzeria-norte/transferencia')).json();
    expect(reactivada).toMatchObject({ estado: 'activo', subscription: { estadoPago: 'al_dia' } });
  });

  it('transferencia no aplica a fichas de Mercado Pago', async () => {
    await alta(env, { medio: 'mercadopago' });
    expect((await req('POST', '/clientes/pizzeria-norte/transferencia')).statusCode).toBe(409);
  });

  it('webhook de Mercado Pago registra el pago una sola vez', async () => {
    await alta(env, { medio: 'mercadopago' });
    env.mp.obtenerPago.mockResolvedValue({
      id: '555',
      aprobado: true,
      importe: 84_000,
      externalReference: 'pizzeria-norte',
      fecha: new Date('2026-11-14T16:00:00Z'),
    });
    const hook = () =>
      env.app.inject({ method: 'POST', url: '/webhooks/mercadopago', payload: { type: 'payment', data: { id: '555' } } });
    expect((await hook()).statusCode).toBe(200);
    expect((await hook()).statusCode).toBe(200);
    const pagos = await env.deps.prisma.payment.findMany();
    expect(pagos).toHaveLength(1);
    expect(pagos[0]).toMatchObject({ medio: 'mercadopago', importe: 84_000, externalId: 'mp:555' });
    expect(pagos[0].acreditaEn?.toISOString()).toBe('2026-12-02T16:00:00.000Z');

    env.mp.obtenerPago.mockResolvedValue({ id: '556', aprobado: false, importe: 1, fecha: new Date() });
    await env.app.inject({ method: 'POST', url: '/webhooks/mercadopago', payload: { type: 'payment', data: { id: '556' } } });
    expect(await env.deps.prisma.payment.count()).toBe(1);
  });
});

describe('página del cliente', () => {
  it('muestra plan, importe y uso sin datos sensibles', async () => {
    const ficha = await alta(env);
    const res = await env.app.inject({ method: 'GET', url: `/publico/${ficha.publicToken}` });
    const body = res.json();
    expect(body).toMatchObject({
      nombre: 'Pizzería Norte',
      plan: { id: 'turnos' },
      importe: 80_000,
      transferencia: { alias: 'orbita.test.alias', importe: 80_000, concepto: 'pizzeria-norte' },
      mercadopago: null,
      uso: { mes: 0, tope: 4_000 },
    });
    expect(JSON.stringify(body)).not.toMatch(/prompt|appToken|apiKey|manychat-secret/);
    expect((await env.app.inject({ method: 'GET', url: '/publico/nope' })).statusCode).toBe(404);
  });

  it('genera el link de suscripción de Mercado Pago', async () => {
    const ficha = await alta(env, { medio: 'mercadopago' });
    env.mp.crearSuscripcion.mockResolvedValue({ id: 'pre-1', initPoint: 'https://mp.test/init' });
    const url = `/publico/${ficha.publicToken}/suscripcion`;
    expect((await env.app.inject({ method: 'POST', url, payload: {} })).statusCode).toBe(400);
    const res = await env.app.inject({ method: 'POST', url, payload: { email: 'dueño@pizza.com'.replace('ñ', 'n') } });
    expect(res.json()).toEqual({ initPoint: 'https://mp.test/init' });
    expect(env.mp.crearSuscripcion.mock.calls[0][0]).toMatchObject({ importe: 84_000, externalReference: 'pizzeria-norte' });
    await env.app.inject({ method: 'POST', url, payload: {} });
    expect(env.mp.crearSuscripcion).toHaveBeenCalledTimes(1);
  });
});

describe('recordatorios', () => {
  it('avisa el día anterior a los turnos de mañana', async () => {
    await alta(env, { planId: 'completo' });
    await env.deps.prisma.turno.createMany({
      data: [
        { tenantId: 'pizzeria-norte', subscriberId: '999', nombre: 'Ana', fecha: new Date('2026-11-15T23:30:00Z') },
        { tenantId: 'pizzeria-norte', subscriberId: '998', nombre: 'Leo', fecha: new Date('2026-11-17T23:30:00Z') },
      ],
    });
    expect(await enviarRecordatorios(env.deps)).toBe(1);
    expect(env.manychat.sendText).toHaveBeenCalledWith(
      'manychat-secret-token',
      '999',
      'Mañana tenés turno a las 20:30. Respondé SI para confirmar.',
    );
    expect(await enviarRecordatorios(env.deps)).toBe(0);
  });
});
