import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { encrypt } from '../../src/lib/crypto';
import { revisarVencimientos } from '../../src/billing/service';
import { destinoDe } from '../../src/messaging/destino';
import type { JobGeneracion } from '../../src/messaging/entrada';
import { getTenant } from '../../src/tenants/repo';
import { procesarMensaje } from '../../src/worker/procesar';
import { alta, createTestEnv, mensajeWhatsapp, registrarCliente, webhookMeta, type TestEnv } from './helpers';

let env: TestEnv;

async function encolados(): Promise<JobGeneracion[]> {
  const jobs = await env.deps.colaGeneracion.getJobs(['waiting', 'delayed', 'prioritized']);
  return jobs.map((j) => j.data as JobGeneracion);
}

async function recibir(texto: string, extra: Parameters<typeof mensajeWhatsapp>[1] = {}) {
  const antes = new Set((await encolados()).map((j) => j.messageId));
  const res = await webhookMeta(env, mensajeWhatsapp(texto, extra));
  expect(res.statusCode).toBe(200);
  return (await encolados()).find((j) => !antes.has(j.messageId));
}

beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => env.close());
beforeEach(async () => env.reset());

describe('conexión de WhatsApp sin token previo', () => {
  it('deja el canal contestando y muestra la verificación', async () => {
    const { headers } = await registrarCliente(env);
    await env.deps.prisma.tenant.update({ where: { id: 'peluqueria-luna' }, data: { estado: 'activo', pausaMotivo: null } });
    await env.deps.prisma.subscription.update({ where: { tenantId: 'peluqueria-luna' }, data: { estadoPago: 'al_dia' } });
    env.meta.intercambiarCodigo.mockResolvedValue('token-de-meta-123456');
    env.meta.suscribirApp.mockResolvedValue(undefined);
    env.meta.leerNumero.mockResolvedValue({
      display_phone_number: '+54 9 11 5555-5555',
      code_verification_status: 'VERIFIED',
      name_status: 'APPROVED',
      status: 'CONNECTED',
    });

    const res = await env.app.inject({
      method: 'POST',
      url: '/cuenta/whatsapp',
      headers,
      payload: { code: 'codigo-meta', phoneNumberId: 'PN-LUNA', wabaId: 'WABA-1' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().canales[0]).toMatchObject({
      tipo: 'whatsapp',
      endpointId: 'PN-LUNA',
      conectado: true,
      verificacion: 'verificado',
      displayPhone: '+54 9 11 5555-5555',
    });
    expect(JSON.stringify(res.json())).not.toMatch(/token-de-meta/);
    expect(env.meta.suscribirApp).toHaveBeenCalledWith('WABA-1', 'token-de-meta-123456');
    expect(env.meta.registrarNumero).not.toHaveBeenCalled();

    env.ai.chat.mockResolvedValue('Hola, te ayudo');
    const data = await recibir('hola', { phoneId: 'PN-LUNA', id: 'wamid.luna' });
    expect(data).toBeTruthy();
    await procesarMensaje(env.deps, data!);
    expect(env.mensajeria.enviar).toHaveBeenCalledWith(
      expect.objectContaining({ canal: 'whatsapp', endpointId: 'PN-LUNA', token: 'token-de-meta-123456' }),
      'Hola, te ayudo',
    );
  });
});

describe('conexión de Facebook, Instagram y TikTok en un toque', () => {
  it('abre la autorización y guarda el canal sin mostrar el token', async () => {
    const { headers } = await registrarCliente(env);
    await env.deps.prisma.tenant.update({ where: { id: 'peluqueria-luna' }, data: { estado: 'activo', pausaMotivo: null } });
    await env.deps.prisma.subscription.update({ where: { tenantId: 'peluqueria-luna' }, data: { estadoPago: 'al_dia' } });
    env.redes.completar.mockResolvedValue({
      tipo: 'instagram',
      endpointId: '1784',
      etiqueta: '@luna',
      token: 'page-token-secreto',
      apiBase: 'https://graph.facebook.com',
    });

    const inicio = await env.app.inject({ method: 'POST', url: '/cuenta/redes/facebook/iniciar', headers });
    expect(inicio.statusCode).toBe(200);
    const state = new URL(inicio.json().url).searchParams.get('state');
    expect(inicio.json().url).toBe(`https://auth.test/facebook?state=${state}`);

    env.redes.listo.mockImplementation((red: string) => red !== 'tiktok');
    const tiktok = await env.app.inject({ method: 'POST', url: '/cuenta/redes/tiktok/iniciar', headers });
    expect(tiktok.statusCode).toBe(503);

    const vuelta = await env.app.inject({
      method: 'POST',
      url: '/cuenta/redes/callback',
      headers,
      payload: { code: 'codigo#_', state },
    });
    expect(vuelta.statusCode).toBe(200);
    expect(vuelta.json().canales).toEqual([
      expect.objectContaining({ tipo: 'instagram', endpointId: '1784', etiqueta: '@luna', conectado: true }),
    ]);
    expect(JSON.stringify(vuelta.json())).not.toContain('page-token-secreto');
    expect(vuelta.json().redes).toEqual({
      facebook: { listo: true },
      instagram: { listo: true },
      tiktok: { listo: false },
    });
    expect(env.redes.completar).toHaveBeenCalledWith('facebook', 'codigo#_');

    const canal = await env.deps.prisma.channel.findFirstOrThrow({ where: { tenantId: 'peluqueria-luna' } });
    expect(canal.apiBase).toBe('https://graph.facebook.com');
    const destino = destinoDe(env.deps, await getTenant(env.deps.prisma, 'peluqueria-luna'), {
      canal: 'instagram',
      endpointId: '1784',
      destino: 'cliente',
    });
    expect(destino).toMatchObject({ apiBase: 'https://graph.facebook.com', token: 'page-token-secreto', endpointId: '1784' });

    const repetido = await env.app.inject({
      method: 'POST',
      url: '/cuenta/redes/callback',
      headers,
      payload: { code: 'codigo', state },
    });
    expect(repetido.statusCode).toBe(400);
  });
});

describe('calendario, ventanas y baja', () => {
  it('crear, mover y cancelar un turno actualiza el calendario', async () => {
    await alta(env);
    await env.deps.prisma.calendario.create({
      data: { tenantId: 'pizzeria-norte', refreshEnc: encrypt('refresh-1', 'b'.repeat(64)) },
    });
    env.ai.chat.mockResolvedValue('Listo. [TURNO_RESERVAR 2026-11-20 20:30]');
    await procesarMensaje(env.deps, (await recibir('turno', { id: 'm1' }))!);
    const turno = await env.deps.prisma.turno.findFirstOrThrow();
    expect(env.agenda.aplicar).toHaveBeenCalledWith('refresh-1', 'crear', expect.objectContaining({ titulo: 'Turno de Ana' }));
    expect(turno.eventoExternoId).toBe('evt-1');

    env.ai.chat.mockResolvedValue(`Movido. [TURNO_REPROGRAMAR ${turno.id} 2026-11-21 21:00]`);
    await procesarMensaje(env.deps, (await recibir('movelo', { id: 'm2' }))!);
    expect(env.agenda.aplicar).toHaveBeenCalledWith('refresh-1', 'mover', expect.objectContaining({ eventoId: 'evt-1' }));

    env.ai.chat.mockResolvedValue(`Listo. [TURNO_CANCELAR ${turno.id}]`);
    await procesarMensaje(env.deps, (await recibir('cancelá', { id: 'm3' }))!);
    expect(env.agenda.aplicar).toHaveBeenCalledWith('refresh-1', 'cancelar', expect.anything());
    expect((await env.deps.prisma.turno.findUniqueOrThrow({ where: { id: turno.id } })).estado).toBe('cancelado');
  });

  it('junta el aviso de Instagram y el de TikTok en el mismo panel', async () => {
    const { headers } = await registrarCliente(env);
    const ahora = env.clock.now;
    await env.deps.prisma.conversation.createMany({
      data: [
        {
          tenantId: 'peluqueria-luna',
          subscriberId: 'ig-ana',
          canal: 'instagram',
          endpointId: 'ig',
          destino: 'ig-ana',
          nombre: 'Ana',
          historial: [],
          ultimoClienteAt: new Date(ahora.getTime() - 21 * 3_600_000),
        },
        {
          tenantId: 'peluqueria-luna',
          subscriberId: 'tt-leo',
          canal: 'tiktok',
          endpointId: 'tt',
          destino: 'conv-leo',
          nombre: 'Leo',
          historial: [],
          ventanaDesde: new Date(ahora.getTime() - 3_600_000),
          respuestasVentana: 9,
        },
        {
          tenantId: 'peluqueria-luna',
          subscriberId: 'wa-sol',
          canal: 'whatsapp',
          endpointId: 'wa',
          destino: '5491100000000',
          nombre: 'Sol',
          historial: [{ rol: 'user', texto: 'Hola', at: '2026-11-21T14:00:00.000Z' }],
          ultimoClienteAt: new Date(ahora.getTime() - 3_600_000),
        },
      ],
    });
    const ana = await env.deps.prisma.conversation.findFirstOrThrow({ where: { subscriberId: 'ig-ana' } });
    await env.deps.prisma.conversation.update({
      where: { id: ana.id },
      data: { historial: [{ rol: 'user', texto: '¿Tenés turno mañana?', at: '2026-11-21T17:00:00.000Z' }] },
    });
    const lista = await env.app.inject({ method: 'GET', url: '/cuenta/ventanas', headers });
    const items = lista.json() as { nombre: string; texto: string; puedeResponder: boolean }[];
    expect(items.map((a) => a.nombre).sort()).toEqual(['Ana', 'Leo', 'Sol']);
    const textos = items.map((a) => a.texto).join(' ');
    expect(textos).toMatch(/ventana de 24 horas de Instagram/);
    expect(textos).toMatch(/9 de 10/);
    expect(items.find((a) => a.nombre === 'Sol')?.puedeResponder).toBe(true);
    const solItem = items.find((a) => a.nombre === 'Sol') as { numero: string; codigo: string };
    expect(solItem.numero).toBe('+5491100000000');
    expect(solItem.codigo).toMatch(/^[0-9a-f-]{36}$/i);
    const porNumero = await env.app.inject({ method: 'GET', url: '/cuenta/ventanas?q=%2B54%209%2011%200000-0000', headers });
    expect(porNumero.statusCode).toBe(200);
    expect((porNumero.json() as { nombre: string }[]).map((a) => a.nombre)).toEqual(['Sol']);
    const porCodigo = await env.app.inject({ method: 'GET', url: `/cuenta/ventanas/${solItem.codigo}`, headers });
    expect(porCodigo.statusCode).toBe(200);
    expect(porCodigo.json().nombre).toBe('Sol');
    expect(porCodigo.json().codigo).toBe(solItem.codigo);
    const ajena = await env.app.inject({ method: 'GET', url: '/cuenta/ventanas/00000000-0000-4000-8000-000000000000', headers });
    expect(ajena.statusCode).toBe(404);
    const charla = await env.app.inject({ method: 'GET', url: `/cuenta/ventanas/${ana.id}`, headers });
    expect(charla.statusCode).toBe(200);
    expect(charla.json().mensajes).toEqual([{ rol: 'user', texto: '¿Tenés turno mañana?', at: '2026-11-21T17:00:00.000Z' }]);
    expect(charla.json().puedeResponder).toBe(true);

    const sol = items.length ? await env.deps.prisma.conversation.findFirstOrThrow({ where: { subscriberId: 'wa-sol' } }) : null;
    const pausa = await env.app.inject({ method: 'POST', url: `/cuenta/ventanas/${sol!.id}/pausar`, headers });
    expect(pausa.json().pausada).toBe(true);
    const devuelta = await env.app.inject({ method: 'POST', url: `/cuenta/ventanas/${sol!.id}/devolver`, headers });
    expect(devuelta.json().pausada).toBe(false);
  });

  it('la baja cancela el débito al instante y deja el plan hasta el vencimiento', async () => {
    const { headers } = await registrarCliente(env);
    const { registrarPago } = await import('../../src/billing/service');
    await registrarPago(env.deps, 'peluqueria-luna', { medio: 'mercadopago', externalId: 'mp:abono' });
    await env.deps.prisma.tenant.update({ where: { id: 'peluqueria-luna' }, data: { estado: 'activo', pausaMotivo: null } });
    await env.deps.prisma.subscription.update({
      where: { tenantId: 'peluqueria-luna' },
      data: { mpPreapprovalId: 'pre-1', mpEstado: 'authorized' },
    });
    const antes = await env.deps.prisma.subscription.findUniqueOrThrow({ where: { tenantId: 'peluqueria-luna' } });
    const baja = await env.app.inject({ method: 'POST', url: '/cuenta/baja', headers });
    expect(baja.statusCode).toBe(200);
    expect(env.mp.cancelarSuscripcion).toHaveBeenCalledWith('pre-1');
    const despues = await env.deps.prisma.subscription.findUniqueOrThrow({ where: { tenantId: 'peluqueria-luna' } });
    expect(despues.vencimiento.toISOString()).toBe(antes.vencimiento.toISOString());
    expect(despues.canceladaEn).toBeTruthy();
    expect(despues.mpPreapprovalId).toBeNull();
    expect(await env.deps.prisma.payment.count()).toBe(1);
    expect(baja.json().negocio.estado).toBe('activo');

    env.clock.now = new Date(antes.vencimiento.getTime() + 3_600_000);
    await revisarVencimientos(env.deps);
    const tenant = await env.deps.prisma.tenant.findUniqueOrThrow({ where: { id: 'peluqueria-luna' } });
    expect(tenant).toMatchObject({ estado: 'pausado', pausaMotivo: 'baja' });
  });
});
