import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { altaBase, createTestEnv, type TestEnv } from './helpers';

let env: TestEnv;

beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => env.close());
beforeEach(async () => env.reset());

const contacto = {
  nombre: 'Laura Gómez',
  email: 'laura@ferreteria.com',
  empresa: 'Ferretería Sur',
  rubro: 'Ferretería',
  necesidad: 'Queremos un bot que consulte stock en nuestro sistema.',
  aceptaPrivacidad: true,
};

const enviar = (payload: Record<string, unknown>) =>
  env.app.inject({ method: 'POST', url: '/publico/contacto', payload });

describe('tickets de IA personalizada', () => {
  it('el formulario público crea un ticket y descarta bots', async () => {
    expect((await enviar(contacto)).statusCode).toBe(201);
    expect((await enviar({ ...contacto, website: 'spam.com' })).statusCode).toBe(201);
    expect((await enviar({ ...contacto, email: 'no-es-mail' })).statusCode).toBe(400);
    expect((await enviar({ ...contacto, aceptaPrivacidad: false })).statusCode).toBe(400);
    const tickets = await env.deps.prisma.ticket.findMany();
    expect(tickets).toHaveLength(1);
    expect(tickets[0]).toMatchObject({ tipo: 'ia_personalizada', privacidadVersion: '2026-11-22', ip: '127.0.0.1' });
    expect((await env.app.inject({ method: 'GET', url: '/tickets' })).statusCode).toBe(401);
  });

  it('el botón de arrepentimiento devuelve un código de trámite y no se convierte en ficha', async () => {
    const res = await env.app.inject({
      method: 'POST',
      url: '/publico/arrepentimiento',
      payload: { nombre: 'Sofía', email: 'sofia@luna.com', negocio: 'Peluquería Luna', aceptaPrivacidad: true },
    });
    expect(res.statusCode).toBe(201);
    const { codigo } = res.json();
    const ticket = await env.deps.prisma.ticket.findUniqueOrThrow({ where: { id: codigo } });
    expect(ticket).toMatchObject({ tipo: 'arrepentimiento', empresa: 'Peluquería Luna' });

    const lista = await env.app.inject({ method: 'GET', url: '/tickets?tipo=arrepentimiento', headers: env.auth() });
    expect(lista.json()).toHaveLength(1);
    const convertir = await env.app.inject({
      method: 'POST',
      url: `/tickets/${codigo}/convertir`,
      headers: env.auth(),
      payload: {},
    });
    expect(convertir.statusCode).toBe(409);
  });

  it('limita envíos por IP', async () => {
    for (let i = 0; i < 5; i++) expect((await enviar(contacto)).statusCode).toBe(201);
    expect((await enviar(contacto)).statusCode).toBe(429);
  });

  it('el equipo gestiona y convierte el ticket en ficha Personalizado', async () => {
    await enviar(contacto);
    const auth = env.auth();
    const [ticket] = (await env.app.inject({ method: 'GET', url: '/tickets?estado=nuevo', headers: auth })).json();
    expect(ticket).toMatchObject({ estado: 'nuevo', empresa: 'Ferretería Sur' });

    const datosFicha = { ...altaBase, clientId: 'ferreteria-sur', nombre: 'Ferretería Sur' };
    const { planId: _planId, ...sinPlan } = datosFicha;
    const url = `/tickets/${ticket.id}/convertir`;
    expect((await env.app.inject({ method: 'POST', url, headers: auth, payload: sinPlan })).statusCode).toBe(400);

    const cotizado = await env.app.inject({
      method: 'PATCH',
      url: `/tickets/${ticket.id}`,
      headers: auth,
      payload: { estado: 'cotizado', importeMensual: 250_000, notas: 'Integración con su ERP' },
    });
    expect(cotizado.json()).toMatchObject({ estado: 'cotizado', importeMensual: 250_000 });

    const ficha = await env.app.inject({ method: 'POST', url, headers: auth, payload: sinPlan });
    expect(ficha.statusCode).toBe(201);
    expect(ficha.json()).toMatchObject({
      id: 'ferreteria-sur',
      planId: 'personalizado',
      precioPersonalizado: 250_000,
      importe: 250_000,
      emailContacto: 'laura@ferreteria.com',
    });

    const final = (await env.app.inject({ method: 'GET', url: `/tickets/${ticket.id}`, headers: auth })).json();
    expect(final).toMatchObject({ estado: 'contratado', tenantId: 'ferreteria-sur' });
    expect((await env.app.inject({ method: 'POST', url, headers: auth, payload: sinPlan })).statusCode).toBe(409);
    const reabrir = await env.app.inject({
      method: 'PATCH',
      url: `/tickets/${ticket.id}`,
      headers: auth,
      payload: { estado: 'nuevo' },
    });
    expect(reabrir.statusCode).toBe(409);
    expect((await env.app.inject({ method: 'GET', url: '/tickets/nope', headers: auth })).statusCode).toBe(404);
  });
});
