import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { alta, createTestEnv, registrarCliente, registroBase, type TestEnv } from './helpers';

let env: TestEnv;

beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => env.close());
beforeEach(async () => env.reset());

type Metodo = 'GET' | 'POST' | 'PUT' | 'PATCH';
const llamar = (headers: Record<string, string>, method: Metodo, url: string, payload?: unknown) =>
  env.app.inject({ method, url, headers, payload: payload as Record<string, unknown> });

const perfil = {
  descripcion: 'Peluquería de barrio con 10 años de experiencia.',
  productos: 'Corte $8.000, color $20.000',
  horarios: 'Martes a sábado de 10 a 19',
  tono: 'cercano',
  derivar: 'Reclamos o pedidos de novias',
  preguntas: [{ pregunta: '¿Tienen estacionamiento?', respuesta: 'Sí, en la esquina.' }],
  turnos: { servicios: 'Corte y color', horarios: 'Martes a sábado de 10 a 18', duracionMin: 45, anticipacionHoras: 3 },
};

async function pagar(id: string) {
  const res = await llamar(env.auth(), 'POST', `/clientes/${id}/transferencia`);
  expect(res.statusCode).toBe(200);
}

describe('registro y acceso', () => {
  it('exige aceptar términos y privacidad y una contraseña fuerte', async () => {
    const reg = (extra: Record<string, unknown>) =>
      env.app.inject({ method: 'POST', url: '/cuenta/registro', payload: { ...registroBase, ...extra } });
    expect((await reg({ aceptaTerminos: false })).statusCode).toBe(400);
    expect((await reg({ aceptaPrivacidad: undefined })).statusCode).toBe(400);
    expect((await reg({ password: 'corta' })).statusCode).toBe(400);
    expect((await reg({ planId: 'personalizado' })).statusCode).toBe(400);
  });

  it('crea la ficha pausada en onboarding y deja constancia de la aceptación', async () => {
    const { headers } = await registrarCliente(env);
    const me = (await llamar(headers, 'GET', '/cuenta/me')).json();
    expect(me).toMatchObject({
      usuario: { nombre: 'Sofía Pérez', email: 'sofia@luna.com' },
      legalPendiente: [],
      negocio: { id: 'peluqueria-luna', estado: 'pausado', pausaMotivo: 'onboarding', modulos: ['faq', 'handoff', 'turnos'] },
      plan: { id: 'turnos' },
      suscripcion: { estadoPago: 'pendiente', importe: 80_000, medio: 'transferencia' },
      transferencia: { concepto: 'peluqueria-luna' },
      onboarding: { paso: 0, completado: null, requisitos: { pago: false, manychat: false, canal: false, prompt: false } },
    });
    expect(me.manychat.entrada).toBe('https://orbita.test/api/webhooks/manychat/entrada');

    const aceptaciones = await env.deps.prisma.legalAcceptance.findMany({ orderBy: { documento: 'asc' } });
    expect(aceptaciones.map((a) => [a.documento, a.version, a.ip])).toEqual([
      ['privacidad', '2026-11-14', '127.0.0.1'],
      ['terminos', '2026-11-14', '127.0.0.1'],
    ]);

    expect((await env.app.inject({ method: 'POST', url: '/cuenta/registro', payload: registroBase })).statusCode).toBe(409);
    const otro = await registrarCliente(env, { email: 'otra@luna.com' });
    const otroMe = (await llamar(otro.headers, 'GET', '/cuenta/me')).json();
    expect(otroMe.negocio.id).toMatch(/^peluqueria-luna-[0-9a-f]{4}$/);
  });

  it('separa roles: el cliente no entra al panel y el admin no usa /cuenta', async () => {
    const { headers } = await registrarCliente(env);
    expect((await llamar(headers, 'GET', '/clientes')).statusCode).toBe(403);
    expect((await llamar(headers, 'GET', '/admin/metricas')).statusCode).toBe(403);
    expect((await llamar(env.auth(), 'GET', '/cuenta/me')).statusCode).toBe(403);
    expect((await env.app.inject({ method: 'GET', url: '/cuenta/me' })).statusCode).toBe(401);
  });

  it('login, cambio de contraseña y restablecimiento con link del equipo', async () => {
    const { headers } = await registrarCliente(env);
    const login = (password: string) =>
      env.app.inject({ method: 'POST', url: '/cuenta/login', payload: { email: 'SOFIA@luna.com', password } });
    expect((await login('incorrecta')).statusCode).toBe(401);
    expect((await login('clave-segura-1')).json().token).toBeTruthy();

    expect((await llamar(headers, 'POST', '/cuenta/password', { actual: 'mal', nueva: 'otra-clave-2' })).statusCode).toBe(400);
    expect((await llamar(headers, 'POST', '/cuenta/password', { actual: 'clave-segura-1', nueva: 'otra-clave-2' })).statusCode).toBe(200);
    expect((await login('otra-clave-2')).statusCode).toBe(200);

    const reset = (await llamar(env.auth(), 'POST', '/clientes/peluqueria-luna/reset-password')).json();
    const token = reset.link.split('/restablecer/')[1];
    const restablecer = (password: string) =>
      env.app.inject({ method: 'POST', url: '/cuenta/restablecer', payload: { token, password } });
    expect((await restablecer('nueva-clave-3')).statusCode).toBe(200);
    expect((await login('nueva-clave-3')).statusCode).toBe(200);
    expect((await restablecer('otra-mas-4')).statusCode).toBe(400);
    expect((await llamar(env.auth(), 'POST', '/clientes/nope/reset-password')).statusCode).toBe(404);
  });

  it('el equipo invita a una ficha existente y el cliente acepta los documentos al entrar', async () => {
    await alta(env);
    const invitar = (email: string) =>
      llamar(env.auth(), 'POST', '/clientes/pizzeria-norte/acceso', { email, nombre: 'Marta' });
    const { link } = (await invitar('marta@pizza.com')).json();
    expect((await invitar('otra@pizza.com')).statusCode).toBe(409);

    const token = link.split('/restablecer/')[1];
    await env.app.inject({ method: 'POST', url: '/cuenta/restablecer', payload: { token, password: 'pizza-segura-1' } });
    const login = await env.app.inject({
      method: 'POST',
      url: '/cuenta/login',
      payload: { email: 'marta@pizza.com', password: 'pizza-segura-1' },
    });
    const headers = { authorization: `Bearer ${login.json().token}` };
    const me = (await llamar(headers, 'GET', '/cuenta/me')).json();
    expect(me.legalPendiente).toEqual(['terminos', 'privacidad']);
    expect(me.negocio.id).toBe('pizzeria-norte');
    expect((await llamar(headers, 'GET', '/cuenta/uso')).statusCode).toBe(428);
    await llamar(headers, 'POST', '/cuenta/legal/aceptar');
    expect((await llamar(headers, 'GET', '/cuenta/uso')).statusCode).toBe(200);

    await registrarCliente(env);
    expect((await llamar(env.auth(), 'POST', '/clientes/peluqueria-luna/acceso', { email: 'x@y.com', nombre: 'Xx' })).statusCode).toBe(409);
  });

  it('una nueva versión legal bloquea la cuenta hasta aceptarla', async () => {
    const { headers } = await registrarCliente(env);
    await env.deps.prisma.legalAcceptance.updateMany({ where: { documento: 'terminos' }, data: { version: '2020-01-01' } });
    expect((await llamar(headers, 'GET', '/cuenta/uso')).statusCode).toBe(428);
    expect((await llamar(headers, 'GET', '/cuenta/me')).json().legalPendiente).toEqual(['terminos']);
    const aceptado = (await llamar(headers, 'POST', '/cuenta/legal/aceptar')).json();
    expect(aceptado.legalPendiente).toEqual([]);
    expect((await llamar(headers, 'GET', '/cuenta/uso')).statusCode).toBe(200);
  });
});

describe('onboarding', () => {
  it('recorre el tutorial y activa la IA solo con todo listo', async () => {
    const { headers } = await registrarCliente(env);

    expect((await llamar(headers, 'POST', '/cuenta/probar', { texto: 'hola' })).statusCode).toBe(402);
    const sinNada = await llamar(headers, 'POST', '/cuenta/onboarding/completar');
    expect(sinNada.statusCode).toBe(409);
    expect(sinNada.json().error).toContain('el pago del plan acreditado');
    expect((await llamar(headers, 'POST', '/cuenta/pausar')).statusCode).toBe(409);

    await pagar('peluqueria-luna');

    const mc = await llamar(headers, 'PUT', '/cuenta/manychat', { pageId: '555', appToken: 'token-manychat-largo' });
    expect(mc.json().manychat).toMatchObject({ pageId: '555', appTokenMask: '****argo' });

    const tresCanales = ['a', 'b', 'c'].map((e) => ({ tipo: 'whatsapp', endpointId: e, etiqueta: e }));
    expect((await llamar(headers, 'PUT', '/cuenta/canales', { canales: tresCanales })).statusCode).toBe(400);
    const canales = await llamar(headers, 'PUT', '/cuenta/canales', {
      canales: [{ tipo: 'instagram', endpointId: 'ig-luna', etiqueta: 'Instagram' }],
    });
    expect(canales.json().canales).toHaveLength(1);

    expect((await llamar(headers, 'PUT', '/cuenta/perfil', { descripcion: 'corto' })).statusCode).toBe(400);
    const conPerfil = (await llamar(headers, 'PUT', '/cuenta/perfil', perfil)).json();
    expect(conPerfil.negocio.prompt).toContain('### Productos, servicios y precios\nCorte $8.000');
    expect(conPerfil.negocio.prompt).toContain('Cada turno dura 45 minutos.');
    expect(conPerfil.negocio.perfil.tono).toBe('cercano');

    const textos = (await llamar(headers, 'PATCH', '/cuenta/textos', { handoff: 'Ya te atiende Sofi' })).json();
    expect(textos.negocio.mensajes.handoff).toBe('Ya te atiende Sofi');

    await llamar(headers, 'POST', '/cuenta/onboarding', { paso: 4 });
    expect((await llamar(headers, 'POST', '/cuenta/onboarding', { paso: 2 })).json().onboarding.paso).toBe(4);

    env.ai.chat.mockResolvedValueOnce('¡Dale! Te agendo. [TURNO_RESERVAR 2026-11-20 10:00]');
    const sim = (await llamar(headers, 'POST', '/cuenta/probar', { texto: 'quiero turno el 20 a las 10' })).json();
    expect(sim).toEqual({ texto: '¡Dale! Te agendo.', handoff: false, acciones: ['Reservaría un turno el 2026-11-20 10:00'] });
    expect(await env.deps.prisma.turno.count()).toBe(0);
    expect(await env.deps.prisma.usage.count()).toBe(0);
    expect(env.ai.chat.mock.calls[0][1][0].content).toContain('Peluquería de barrio');

    env.ai.chat.mockResolvedValueOnce('[HANDOFF]');
    const handoff = (await llamar(headers, 'POST', '/cuenta/probar', { texto: 'quiero hablar con alguien' })).json();
    expect(handoff).toMatchObject({ texto: 'Ya te atiende Sofi', handoff: true });

    env.ai.chat.mockRejectedValueOnce(new Error('caída'));
    expect((await llamar(headers, 'POST', '/cuenta/probar', { texto: 'hola' })).statusCode).toBe(502);

    const activa = (await llamar(headers, 'POST', '/cuenta/onboarding/completar')).json();
    expect(activa.negocio).toMatchObject({ estado: 'activo', pausaMotivo: null });
    expect(activa.onboarding.completado).toBeTruthy();

    const entrada = await env.app.inject({
      method: 'POST',
      url: '/webhooks/manychat/entrada',
      headers: { 'x-orbita-key': activa.manychat.apiKey },
      payload: { pageId: '555', subscriberId: '1', endpointId: 'ig-luna', texto: 'hola' },
    });
    expect(entrada.json().estado).toBe('pendiente');

    expect((await llamar(headers, 'POST', '/cuenta/pausar')).json().negocio.estado).toBe('pausado');
    expect((await llamar(headers, 'POST', '/cuenta/activar')).json().negocio.estado).toBe('activo');
    expect((await llamar(headers, 'POST', '/cuenta/onboarding/completar')).statusCode).toBe(200);

    expect((await llamar(headers, 'GET', '/cuenta/uso')).json().mes).toMatchObject({ usado: 0, tope: 4_000 });
    expect((await llamar(headers, 'GET', '/cuenta/turnos')).json()).toEqual([]);
    expect((await llamar(headers, 'GET', '/cuenta/pagos')).json()).toHaveLength(1);
    expect((await llamar(headers, 'PUT', '/cuenta/prompt', { prompt: 'Prompt a mano' })).json().negocio.prompt).toBe('Prompt a mano');
  });

  it('activar exige el pago al día', async () => {
    const { headers } = await registrarCliente(env);
    await env.deps.prisma.tenant.update({
      where: { id: 'peluqueria-luna' },
      data: { onboardingCompletado: new Date(), estado: 'pausado', pausaMotivo: 'manual' },
    });
    expect((await llamar(headers, 'POST', '/cuenta/activar')).statusCode).toBe(409);
  });
});

describe('plan y pago del cliente', () => {
  it('cambia de plan y de medio, y la suscripción vieja de Mercado Pago se cancela', async () => {
    const { headers } = await registrarCliente(env, { medio: 'mercadopago' });
    env.mp.crearSuscripcion.mockResolvedValue({ id: 'pre-1', initPoint: 'https://mp.test/1' });
    expect((await llamar(headers, 'POST', '/cuenta/suscripcion')).json()).toEqual({ initPoint: 'https://mp.test/1' });
    expect(env.mp.crearSuscripcion.mock.calls[0][0]).toMatchObject({
      payerEmail: 'sofia@luna.com',
      importe: 84_000,
      backUrl: 'https://orbita.test/cuenta',
    });

    const completo = (await llamar(headers, 'PATCH', '/cuenta/plan', { planId: 'completo' })).json();
    expect(completo).toMatchObject({ plan: { id: 'completo' }, suscripcion: { importe: 115_000, mpInitPoint: null } });
    expect(completo.negocio.modulos).toContain('recordatorios');
    expect(env.mp.cancelarSuscripcion).toHaveBeenCalledWith('pre-1');

    const transf = (await llamar(headers, 'PATCH', '/cuenta/plan', { medio: 'transferencia' })).json();
    expect(transf.suscripcion).toMatchObject({ medio: 'transferencia', importe: 110_000 });
    expect((await llamar(headers, 'PATCH', '/cuenta/plan', { planId: 'personalizado' })).statusCode).toBe(400);

    await env.deps.prisma.tenant.update({
      where: { id: 'peluqueria-luna' },
      data: { planId: 'personalizado', precioPersonalizado: 200_000 },
    });
    expect((await llamar(headers, 'PATCH', '/cuenta/plan', { planId: 'mensajes' })).statusCode).toBe(409);
  });

  it('el admin ve la cuenta del cliente en la ficha', async () => {
    await registrarCliente(env);
    await alta(env, { clientId: 'otro', canales: [{ tipo: 'whatsapp', endpointId: 'x', etiqueta: 'x' }] });
    const ficha = (await llamar(env.auth(), 'GET', '/clientes/peluqueria-luna')).json();
    expect(ficha).toMatchObject({ usuario: { email: 'sofia@luna.com' }, appTokenMask: null, pausaMotivo: 'onboarding' });
    expect(ficha.usuario.passwordHash).toBeUndefined();
  });
});
