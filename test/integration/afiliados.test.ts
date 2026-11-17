import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { registrarPago } from '../../src/billing/service';
import type { MensajeCorreo } from '../../src/correo/correo';
import { createTestEnv, registrarCliente, type TestEnv } from './helpers';

let env: TestEnv;
let correos: MensajeCorreo[];

beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => env.close());
beforeEach(async () => {
  await env.reset();
  correos = [];
  vi.spyOn(env.deps.correo, 'enviar').mockImplementation(async (m) => {
    correos.push(m);
  });
});

const checkoutBase = { email: 'ana@kiosco.com', planId: 'turnos', aceptaTerminos: true, aceptaPrivacidad: true };
const checkout = (payload: Record<string, unknown> = {}) =>
  env.app.inject({ method: 'POST', url: '/checkout', payload: { ...checkoutBase, ...payload } });

async function afiliado(nombre = 'Juan Socio', email = 'juan@socio.com') {
  const res = await env.app.inject({
    method: 'POST',
    url: '/afiliados/registro',
    payload: { nombre, email, password: 'clave-socio-1', aceptaTerminos: true },
  });
  expect(res.statusCode).toBe(201);
  const headers = { authorization: `Bearer ${res.json().token}` };
  const panel = (await env.app.inject({ method: 'GET', url: '/afiliados/me', headers })).json();
  return { headers, codigo: panel.codigo as string };
}

const linkDeCorreo = (m: MensajeCorreo) => m.texto.match(/https:\/\/orbita\.test\/restablecer\/\S+/)?.[0];

describe('checkout sin sesión', () => {
  it('crea la cuenta con solo el email, manda el link de contraseña y devuelve el link de Mercado Pago', async () => {
    env.mp.crearSuscripcion.mockResolvedValue({ id: 'pre-1', initPoint: 'https://mp.test/1' });
    const res = await checkout();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ initPoint: 'https://mp.test/1' });
    expect(env.mp.crearSuscripcion.mock.calls[0][0]).toMatchObject({
      payerEmail: 'ana@kiosco.com',
      importe: 84_000,
      backUrl: 'https://orbita.test/checkout/gracias',
    });

    const usuario = await env.deps.prisma.clientUser.findUniqueOrThrow({ where: { email: 'ana@kiosco.com' }, include: { tenant: true } });
    expect(usuario.tenant).toMatchObject({ id: 'ana', planId: 'turnos', planElegido: true, estado: 'pausado', pausaMotivo: 'onboarding' });
    expect(await env.deps.prisma.legalAcceptance.count({ where: { userId: usuario.id } })).toBe(2);
    expect(usuario.resetExpira?.toISOString()).toBe('2026-11-21T15:00:00.000Z');

    expect(correos).toHaveLength(1);
    const link = linkDeCorreo(correos[0]);
    expect(link).toBeTruthy();
    const token = link!.split('/restablecer/')[1];
    expect((await env.app.inject({ method: 'POST', url: '/cuenta/restablecer', payload: { token, password: 'clave-nueva-1' } })).statusCode).toBe(200);
    const login = await env.app.inject({ method: 'POST', url: '/cuenta/login', payload: { email: 'ana@kiosco.com', password: 'clave-nueva-1' } });
    expect(login.statusCode).toBe(200);
  });

  it('valida plan y aceptación legal', async () => {
    expect((await checkout({ planId: 'personalizado' })).statusCode).toBe(400);
    expect((await checkout({ aceptaTerminos: false })).statusCode).toBe(400);
    expect((await checkout({ email: 'no-es-mail' })).statusCode).toBe(400);
  });

  it('retoma el checkout de una cuenta sin pagar y cambia el plan', async () => {
    env.mp.crearSuscripcion.mockResolvedValueOnce({ id: 'pre-1', initPoint: 'https://mp.test/1' });
    await checkout();
    env.mp.crearSuscripcion.mockResolvedValueOnce({ id: 'pre-2', initPoint: 'https://mp.test/2' });
    const otra = await checkout({ planId: 'completo' });
    expect(otra.json()).toEqual({ initPoint: 'https://mp.test/2' });
    expect(env.mp.cancelarSuscripcion).toHaveBeenCalledWith('pre-1');
    expect(await env.deps.prisma.tenant.count()).toBe(1);
    expect((await env.deps.prisma.tenant.findFirstOrThrow()).planId).toBe('completo');

    expect((await checkout({ planId: 'completo' })).json()).toEqual({ initPoint: 'https://mp.test/2' });
  });

  it('rechaza el checkout de una cuenta que ya pagó', async () => {
    env.mp.crearSuscripcion.mockResolvedValue({ id: 'pre-1', initPoint: 'https://mp.test/1' });
    await checkout();
    await registrarPago(env.deps, 'ana', { medio: 'mercadopago' });
    const res = await checkout();
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/Ya tenés una cuenta/);
  });
});

describe('afiliados', () => {
  it('registro, login y separación de roles', async () => {
    const { headers, codigo } = await afiliado();
    expect(codigo).toMatch(/^juan-socio-[0-9a-f]{4}$/);
    const login = (password: string) =>
      env.app.inject({ method: 'POST', url: '/afiliados/login', payload: { email: 'JUAN@socio.com', password } });
    expect((await login('mala')).statusCode).toBe(401);
    expect((await login('clave-socio-1')).json().token).toBeTruthy();

    expect((await env.app.inject({ method: 'GET', url: '/cuenta/me', headers })).statusCode).toBe(403);
    expect((await env.app.inject({ method: 'GET', url: '/admin/comisiones', headers })).statusCode).toBe(403);
    expect((await env.app.inject({ method: 'GET', url: '/afiliados/me', headers: env.auth() })).statusCode).toBe(403);

    const dup = await env.app.inject({
      method: 'POST',
      url: '/afiliados/registro',
      payload: { nombre: 'Otro', email: 'juan@socio.com', password: 'clave-socio-1', aceptaTerminos: true },
    });
    expect(dup.statusCode).toBe(409);

    const cobro = await env.app.inject({ method: 'PATCH', url: '/afiliados/me', headers, payload: { datosCobro: 'juan.socio.mp' } });
    expect(cobro.json()).toMatchObject({ datosCobro: 'juan.socio.mp', link: `https://orbita.test/?ref=${codigo}` });
  });

  it('el primer pago de un referido genera el 50% y los siguientes no', async () => {
    const { headers, codigo } = await afiliado();
    env.mp.crearSuscripcion.mockResolvedValue({ id: 'pre-1', initPoint: 'https://mp.test/1' });
    await checkout({ ref: codigo.toUpperCase() });
    expect(await env.deps.prisma.referral.count()).toBe(1);

    env.mp.obtenerPago.mockResolvedValue({
      id: 'pay-1',
      aprobado: true,
      importe: 84_000,
      preapprovalId: 'pre-1',
      externalReference: 'ana',
      fecha: env.clock.now,
    });
    const webhook = () =>
      env.app.inject({ method: 'POST', url: '/webhooks/mercadopago', payload: { type: 'payment', data: { id: 'pay-1' } } });
    expect((await webhook()).statusCode).toBe(200);
    expect((await webhook()).statusCode).toBe(200);

    const comisiones = await env.deps.prisma.commission.findMany();
    expect(comisiones).toHaveLength(1);
    expect(comisiones[0]).toMatchObject({ importe: 42_000, estado: 'pendiente', tenantId: 'ana' });

    await registrarPago(env.deps, 'ana', { medio: 'mercadopago', externalId: 'mp:pay-2' });
    expect(await env.deps.prisma.commission.count()).toBe(1);

    const panel = (await env.app.inject({ method: 'GET', url: '/afiliados/me', headers })).json();
    expect(panel).toMatchObject({ totales: { pendiente: 42_000, pagada: 0 }, referidos: [{ pago: true }] });

    const pagar = await env.app.inject({ method: 'POST', url: `/admin/comisiones/${comisiones[0].id}/pagada`, headers: env.auth() });
    expect(pagar.json()).toMatchObject({ estado: 'pagada' });
    expect((await env.app.inject({ method: 'POST', url: `/admin/comisiones/${comisiones[0].id}/anular`, headers: env.auth() })).statusCode).toBe(409);

    const lista = (await env.app.inject({ method: 'GET', url: '/admin/afiliados', headers: env.auth() })).json();
    expect(lista).toMatchObject([{ referidos: 1, pendiente: 0, pagada: 42_000 }]);
    const pendientes = (await env.app.inject({ method: 'GET', url: '/admin/comisiones?estado=pendiente', headers: env.auth() })).json();
    expect(pendientes).toEqual([]);
  });

  it('el plan personalizado no comisiona, ni un código desconocido o propio', async () => {
    const { codigo } = await afiliado();
    await registrarCliente(env, { ref: codigo });
    await env.deps.prisma.tenant.update({ where: { id: 'peluqueria-luna' }, data: { planId: 'personalizado', precioPersonalizado: 200_000 } });
    await registrarPago(env.deps, 'peluqueria-luna', { medio: 'mercadopago' });
    expect(await env.deps.prisma.commission.count()).toBe(0);

    await registrarCliente(env, { email: 'otra@luna.com', ref: 'no-existe' });
    await registrarCliente(env, { email: 'juan@socio.com', ref: codigo });
    expect(await env.deps.prisma.referral.count()).toBe(1);
  });

  it('el admin anula una comisión pendiente', async () => {
    const { codigo } = await afiliado();
    await registrarCliente(env, { ref: codigo });
    await registrarPago(env.deps, 'peluqueria-luna', { medio: 'mercadopago' });
    const [comision] = await env.deps.prisma.commission.findMany();
    expect(comision.importe).toBe(42_000);
    const anular = await env.app.inject({ method: 'POST', url: `/admin/comisiones/${comision.id}/anular`, headers: env.auth() });
    expect(anular.json()).toMatchObject({ estado: 'anulada', pagadaEn: null });
  });
});
