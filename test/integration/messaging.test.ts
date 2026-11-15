import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { procesarMensaje } from '../../src/worker/procesar';
import { alta, createTestEnv, type TestEnv } from './helpers';

let env: TestEnv;
let apiKey: string;

const mensaje = (texto = 'tienen mesa para dos el sábado?', extra: Record<string, unknown> = {}) => ({
  pageId: '123',
  subscriberId: '999',
  canal: 'whatsapp',
  endpointId: '54911XXXX',
  texto,
  nombre: 'Ana',
  ...extra,
});

async function entrada(payload: unknown, key: string | undefined = apiKey) {
  return env.app.inject({
    method: 'POST',
    url: '/webhooks/manychat/entrada',
    headers: key ? { 'x-orbita-key': key } : {},
    payload: payload as Record<string, unknown>,
  });
}

async function salida(messageId: string, esperaMs?: number, key = apiKey) {
  const q = esperaMs === undefined ? '' : `&esperaMs=${esperaMs}`;
  return env.app.inject({
    method: 'GET',
    url: `/webhooks/manychat/salida?messageId=${messageId}${q}`,
    headers: { 'x-orbita-key': key },
  });
}

beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => env.close());
beforeEach(async () => {
  await env.reset();
  apiKey = (await alta(env)).apiKey;
});

describe('entrada', () => {
  it('rechaza cuerpos inválidos con 400', async () => {
    const res = await entrada({ pageId: '123' });
    expect(res.statusCode).toBe(400);
  });

  it('ignora extremos desconocidos y pageId que no coincide', async () => {
    expect((await entrada(mensaje('hola', { endpointId: 'otro' }))).json()).toMatchObject({ estado: 'ignorado' });
    expect((await entrada(mensaje('hola', { pageId: '456' }))).json()).toMatchObject({ estado: 'ignorado' });
  });

  it('exige la X-Orbita-Key de la ficha', async () => {
    expect((await entrada(mensaje(), '')).statusCode).toBe(401);
    expect((await entrada(mensaje(), 'mala')).statusCode).toBe(401);
  });

  it('responde pendiente al instante, encola y deduplica reintentos', async () => {
    const inicio = Date.now();
    const r1 = (await entrada(mensaje())).json();
    expect(Date.now() - inicio).toBeLessThan(1000);
    expect(r1).toMatchObject({ ok: true, estado: 'pendiente' });
    expect(r1.messageId).toMatch(/^[0-9a-f-]{36}$/);

    const r2 = (await entrada(mensaje())).json();
    expect(r2.messageId).toBe(r1.messageId);
    expect(await env.deps.colaGeneracion.getJobCounts('waiting')).toMatchObject({ waiting: 1 });
  });

  it('no contesta si la ficha está pausada', async () => {
    await env.deps.prisma.tenant.update({ where: { id: 'pizzeria-norte' }, data: { estado: 'pausado' } });
    expect((await entrada(mensaje())).json()).toMatchObject({ estado: 'ignorado', messageId: null });
  });

  it('al llegar al tope devuelve el texto fijo sin encolar', async () => {
    await env.deps.prisma.tenant.update({ where: { id: 'pizzeria-norte' }, data: { topeDia: 0 } });
    const r = (await entrada(mensaje())).json();
    expect(r).toMatchObject({ estado: 'listo', texto: 'En este momento te deriva una persona del local.' });
    expect((await salida(r.messageId)).json()).toMatchObject({ estado: 'listo', handoff: true });
  });
});

describe('salida y worker', () => {
  it('el long-poll devuelve la respuesta en cuanto el worker termina', async () => {
    env.ai.chat.mockResolvedValue('¡Sí! Tenemos mesa el sábado.');
    const { messageId } = (await entrada(mensaje())).json();

    const poll = salida(messageId);
    await new Promise((r) => setTimeout(r, 150));
    await procesarMensaje(env.deps, await env.job(messageId));
    const res = await poll;

    expect(res.json()).toMatchObject({ estado: 'listo', texto: '¡Sí! Tenemos mesa el sábado.', handoff: false });
    const [modelo, msgs] = env.ai.chat.mock.calls[0];
    expect(modelo).toBe(env.deps.config.MODELO_BARATO);
    expect(msgs[0].content).toContain('Vendemos pizzas');

    const uso = await env.app.inject({ method: 'GET', url: '/clientes/pizzeria-norte/uso', headers: env.auth() });
    expect(uso.json()).toMatchObject({ dia: { usado: 1 }, semana: { usado: 1 }, mes: { usado: 1 } });

    const conv = await env.deps.prisma.conversation.findFirstOrThrow({ where: { subscriberId: '999' } });
    expect(conv.historial).toHaveLength(2);
  });

  it('si la respuesta no está lista vuelve pendiente al vencer la espera', async () => {
    const { messageId } = (await entrada(mensaje())).json();
    expect((await salida(messageId, 0)).json()).toMatchObject({ estado: 'pendiente' });
    const inicio = Date.now();
    expect((await salida(messageId, 300)).json()).toMatchObject({ estado: 'pendiente' });
    expect(Date.now() - inicio).toBeGreaterThanOrEqual(250);
  });

  it('salida valida messageId y clave', async () => {
    expect((await salida('00000000-0000-4000-8000-000000000000')).statusCode).toBe(404);
    const { messageId } = (await entrada(mensaje())).json();
    expect((await salida(messageId, 0, 'otra')).statusCode).toBe(401);
  });

  it('si OpenRouter falla dos veces manda handoff y no suma uso', async () => {
    env.ai.chat.mockRejectedValue(new Error('caído'));
    const { messageId } = (await entrada(mensaje())).json();
    const r = await procesarMensaje(env.deps, await env.job(messageId));
    expect(r).toMatchObject({ estado: 'listo', texto: 'Te paso con alguien del local.', handoff: true });
    expect(env.ai.chat).toHaveBeenCalledTimes(2);
    expect(await env.deps.prisma.usage.count()).toBe(0);
  });

  it('el modelo puede pedir handoff con la etiqueta', async () => {
    env.ai.chat.mockResolvedValue('[HANDOFF]');
    const { messageId } = (await entrada(mensaje('quiero hablar con alguien'))).json();
    const r = await procesarMensaje(env.deps, await env.job(messageId));
    expect(r).toMatchObject({ texto: 'Te paso con alguien del local.', handoff: true });
  });

  it('el worker vuelve a leer estado y topes', async () => {
    const { messageId } = (await entrada(mensaje())).json();
    await env.deps.prisma.tenant.update({ where: { id: 'pizzeria-norte' }, data: { topeMes: 0 } });
    expect((await procesarMensaje(env.deps, await env.job(messageId))).handoff).toBe(true);
    await env.deps.prisma.tenant.update({ where: { id: 'pizzeria-norte' }, data: { estado: 'pausado' } });
    expect((await procesarMensaje(env.deps, await env.job(messageId))).estado).toBe('ignorado');
    expect(env.ai.chat).not.toHaveBeenCalled();
  });

  it('el módulo turnos reserva y cancela', async () => {
    env.ai.chat.mockResolvedValue('Listo, te anoté. [TURNO_RESERVAR 2026-11-20 20:30]');
    const { messageId } = (await entrada(mensaje('quiero turno el 20 a las 20:30'))).json();
    const r = await procesarMensaje(env.deps, await env.job(messageId));
    expect(r.texto).toBe('Listo, te anoté.');

    const turnos = await env.app.inject({ method: 'GET', url: '/clientes/pizzeria-norte/turnos', headers: env.auth() });
    expect(turnos.json()).toHaveLength(1);
    const turno = turnos.json()[0];
    expect(turno).toMatchObject({ nombre: 'Ana', estado: 'reservado', fecha: '2026-11-20T23:30:00.000Z' });

    env.ai.chat.mockResolvedValue('Ese ya está. [TURNO_RESERVAR 2026-11-20 20:30]');
    const otro = (await entrada(mensaje('otro turno igual', { subscriberId: '1000' }))).json();
    expect((await procesarMensaje(env.deps, await env.job(otro.messageId))).texto).toContain('ya está tomado');

    env.ai.chat.mockResolvedValue(`Cancelado. [TURNO_CANCELAR ${turno.id}]`);
    const canc = (await entrada(mensaje('cancelá mi turno'))).json();
    await procesarMensaje(env.deps, await env.job(canc.messageId));
    const final = await env.deps.prisma.turno.findUniqueOrThrow({ where: { id: turno.id } });
    expect(final.estado).toBe('cancelado');
  });
});
