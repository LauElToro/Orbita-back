import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { JobGeneracion } from '../../src/messaging/entrada';
import { procesarMensaje } from '../../src/worker/procesar';
import { alta, createTestEnv, mensajeWhatsapp, webhookMeta, type TestEnv } from './helpers';

let env: TestEnv;

async function encolados(): Promise<JobGeneracion[]> {
  const jobs = await env.deps.colaGeneracion.getJobs(['waiting', 'delayed', 'prioritized']);
  return jobs.map((j) => j.data as JobGeneracion);
}

/** Recibe el mensaje por el webhook de Meta y devuelve el job que quedó encolado. */
async function recibir(texto = 'tienen mesa para dos el sábado?', extra: Parameters<typeof mensajeWhatsapp>[1] = {}) {
  const antes = new Set((await encolados()).map((j) => j.messageId));
  const res = await webhookMeta(env, mensajeWhatsapp(texto, extra));
  expect(res.statusCode).toBe(200);
  return (await encolados()).find((j) => !antes.has(j.messageId));
}

beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => env.close());
beforeEach(async () => {
  await env.reset();
  await alta(env);
});

describe('webhook de Meta', () => {
  it('verifica la suscripción con el verify token', async () => {
    const ok = await env.app.inject({
      method: 'GET',
      url: '/webhooks/meta?hub.mode=subscribe&hub.verify_token=verificar-orbita&hub.challenge=12345',
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBe('12345');
    const mal = await env.app.inject({ method: 'GET', url: '/webhooks/meta?hub.mode=subscribe&hub.verify_token=otro&hub.challenge=1' });
    expect(mal.statusCode).toBe(403);
  });

  it('rechaza cuerpos sin firma o firmados con otro secreto', async () => {
    const sinFirma = await env.app.inject({ method: 'POST', url: '/webhooks/meta', payload: mensajeWhatsapp('hola') });
    expect(sinFirma.statusCode).toBe(401);
    expect((await webhookMeta(env, mensajeWhatsapp('hola'), 'otro-secreto')).statusCode).toBe(401);
    expect(await encolados()).toHaveLength(0);
  });

  it('encola el mensaje, guarda a dónde responder y deduplica los reintentos de Meta', async () => {
    const inicio = Date.now();
    const job = await recibir('hola', { id: 'wamid.A' });
    expect(Date.now() - inicio).toBeLessThan(1000);
    expect(job).toMatchObject({ tenantId: 'pizzeria-norte', subscriberId: '5491100000999', texto: 'hola', nombre: 'Ana', canal: 'whatsapp' });

    expect(await recibir('hola', { id: 'wamid.A' })).toBeUndefined();
    expect(await encolados()).toHaveLength(1);

    const conv = await env.deps.prisma.conversation.findFirstOrThrow({ where: { subscriberId: '5491100000999' } });
    expect(conv).toMatchObject({ canal: 'whatsapp', endpointId: 'PN-NORTE', destino: '5491100000999', nombre: 'Ana' });
  });

  it('ignora números que no son de ninguna ficha y fichas pausadas', async () => {
    expect(await recibir('hola', { phoneId: 'PN-OTRO' })).toBeUndefined();
    await env.deps.prisma.tenant.update({ where: { id: 'pizzeria-norte' }, data: { estado: 'pausado' } });
    expect(await recibir('hola')).toBeUndefined();
  });
});

describe('webhook de TikTok', () => {
  it('exige la firma t.cuerpo y encola el mensaje de la conversación', async () => {
    await env.app.inject({
      method: 'PATCH',
      url: '/clientes/pizzeria-norte',
      headers: env.auth(),
      payload: {
        canales: [
          { tipo: 'whatsapp', endpointId: 'PN-NORTE', etiqueta: 'WhatsApp' },
          { tipo: 'tiktok', endpointId: 'BIZ-NORTE', etiqueta: 'TikTok', token: 'tiktok-access-token' },
        ],
      },
    });
    const raw = JSON.stringify({
      event: 'im_receive_msg',
      user_openid: 'BIZ-NORTE',
      content: JSON.stringify({
        from: 'ana.tt',
        from_user: { id: 'U-1', role: 'personal_account' },
        conversation_id: 'CONV-1',
        message_id: 'MSG-1',
        type: 'text',
        text: { body: '¿hacen envíos?' },
      }),
    });
    const t = Math.floor(env.clock.now.getTime() / 1000);
    const enviar = (firma: string) =>
      env.app.inject({
        method: 'POST',
        url: '/webhooks/tiktok',
        headers: { 'content-type': 'application/json', 'tiktok-signature': firma },
        payload: raw,
      });
    expect((await enviar(`t=${t},s=deadbeef`)).statusCode).toBe(401);
    const s = createHmac('sha256', 'tiktok-secret').update(`${t}.${raw}`).digest('hex');
    expect((await enviar(`t=${t},s=${s}`)).statusCode).toBe(200);

    const [job] = await encolados();
    expect(job).toMatchObject({ canal: 'tiktok', subscriberId: 'U-1', texto: '¿hacen envíos?' });
    const conv = await env.deps.prisma.conversation.findFirstOrThrow({ where: { subscriberId: 'U-1' } });
    expect(conv).toMatchObject({ endpointId: 'BIZ-NORTE', destino: 'CONV-1' });

    env.ai.chat.mockResolvedValue('Sí, enviamos a todo el país.');
    await procesarMensaje(env.deps, job);
    expect(env.mensajeria.enviar).toHaveBeenCalledWith(
      { canal: 'tiktok', endpointId: 'BIZ-NORTE', destino: 'CONV-1', token: 'tiktok-access-token' },
      'Sí, enviamos a todo el país.',
    );
  });
});

describe('worker', () => {
  it('genera la respuesta y la manda por WhatsApp con el token del canal', async () => {
    env.ai.chat.mockResolvedValue('¡Sí! Tenemos mesa el sábado.');
    const job = await recibir();
    const r = await procesarMensaje(env.deps, job!);

    expect(r).toMatchObject({ estado: 'enviado', texto: '¡Sí! Tenemos mesa el sábado.', handoff: false });
    expect(env.mensajeria.enviar).toHaveBeenCalledWith(
      { canal: 'whatsapp', endpointId: 'PN-NORTE', destino: '5491100000999', token: 'whatsapp-secret-token' },
      '¡Sí! Tenemos mesa el sábado.',
    );
    const [modelo, msgs] = env.ai.chat.mock.calls[0];
    expect(modelo).toBe(env.deps.config.MODELO_BARATO);
    expect(msgs[0].content).toContain('Vendemos pizzas');

    const uso = await env.app.inject({ method: 'GET', url: '/clientes/pizzeria-norte/uso', headers: env.auth() });
    expect(uso.json()).toMatchObject({ dia: { usado: 1 }, semana: { usado: 1 }, mes: { usado: 1 } });
    const conv = await env.deps.prisma.conversation.findFirstOrThrow({ where: { subscriberId: '5491100000999' } });
    expect(conv.historial).toHaveLength(2);
  });

  it('si el canal no tiene token no envía nada', async () => {
    await env.app.inject({
      method: 'PATCH',
      url: '/clientes/pizzeria-norte',
      headers: env.auth(),
      payload: { canales: [{ tipo: 'whatsapp', endpointId: 'PN-NUEVO', etiqueta: 'WhatsApp' }] },
    });
    const job = await recibir('hola', { phoneId: 'PN-NUEVO' });
    env.ai.chat.mockResolvedValue('Hola');
    expect((await procesarMensaje(env.deps, job!)).estado).toBe('sin_canal');
    expect(env.mensajeria.enviar).not.toHaveBeenCalled();
  });

  it('si la plataforma rechaza el envío lo registra sin reintentar la generación', async () => {
    env.ai.chat.mockResolvedValue('Hola');
    env.mensajeria.enviar.mockRejectedValue(new Error('WhatsApp 401'));
    const job = await recibir();
    expect((await procesarMensaje(env.deps, job!)).estado).toBe('error_envio');
    expect(env.ai.chat).toHaveBeenCalledTimes(1);
  });

  it('si OpenRouter falla dos veces deriva a una persona, no suma uso y silencia la charla', async () => {
    env.ai.chat.mockRejectedValue(new Error('caído'));
    const job = await recibir();
    const r = await procesarMensaje(env.deps, job!);
    expect(r).toMatchObject({ estado: 'enviado', texto: 'Te paso con alguien del local.', handoff: true });
    expect(env.ai.chat).toHaveBeenCalledTimes(2);
    expect(await env.deps.prisma.usage.count()).toBe(0);

    expect(await recibir('¿siguen ahí?')).toBeUndefined();
    env.clock.now = new Date(env.clock.now.getTime() + 13 * 3_600_000);
    expect(await recibir('¿y ahora?')).toBeDefined();
  });

  it('el modelo puede pedir handoff con la etiqueta', async () => {
    env.ai.chat.mockResolvedValue('[HANDOFF]');
    const job = await recibir('quiero hablar con alguien');
    expect(await procesarMensaje(env.deps, job!)).toMatchObject({ texto: 'Te paso con alguien del local.', handoff: true });
  });

  it('el worker vuelve a leer estado y topes', async () => {
    const job = await recibir();
    await env.deps.prisma.tenant.update({ where: { id: 'pizzeria-norte' }, data: { topeMes: 0 } });
    expect(await procesarMensaje(env.deps, job!)).toMatchObject({ texto: 'En este momento te deriva una persona del local.', handoff: true });
    await env.deps.prisma.tenant.update({ where: { id: 'pizzeria-norte' }, data: { estado: 'pausado' } });
    expect((await procesarMensaje(env.deps, job!)).estado).toBe('ignorado');
    expect(env.ai.chat).not.toHaveBeenCalled();
  });

  it('el módulo turnos reserva y cancela', async () => {
    env.ai.chat.mockResolvedValue('Listo, te anoté. [TURNO_RESERVAR 2026-11-20 20:30]');
    const r = await procesarMensaje(env.deps, (await recibir('quiero turno el 20 a las 20:30'))!);
    expect(r.texto).toBe('Listo, te anoté.');

    const turnos = await env.app.inject({ method: 'GET', url: '/clientes/pizzeria-norte/turnos', headers: env.auth() });
    expect(turnos.json()).toHaveLength(1);
    const turno = turnos.json()[0];
    expect(turno).toMatchObject({ nombre: 'Ana', estado: 'reservado', fecha: '2026-11-20T23:30:00.000Z' });

    env.ai.chat.mockResolvedValue('Ese ya está. [TURNO_RESERVAR 2026-11-20 20:30]');
    const otro = await recibir('otro turno igual', { from: '5491100001000' });
    expect((await procesarMensaje(env.deps, otro!)).texto).toContain('ya está tomado');

    env.ai.chat.mockResolvedValue(`Cancelado. [TURNO_CANCELAR ${turno.id}]`);
    await procesarMensaje(env.deps, (await recibir('cancelá mi turno'))!);
    const final = await env.deps.prisma.turno.findUniqueOrThrow({ where: { id: turno.id } });
    expect(final.estado).toBe('cancelado');
  });
});
