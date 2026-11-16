import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { calcularMetricas } from '../../src/admin/metricas';
import { createTestEnv, registrarCliente, type TestEnv } from './helpers';

let env: TestEnv;

beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => env.close());
beforeEach(async () => env.reset());

type Metodo = 'GET' | 'POST' | 'PUT' | 'DELETE';
const llamar = (headers: Record<string, string>, method: Metodo, url: string, payload?: unknown) =>
  env.app.inject({ method, url, headers, payload: payload as Record<string, unknown> });

const base64 = (texto: string) => Buffer.from(texto).toString('base64');

describe('demo', () => {
  it('funciona sin pagar: carga información, prende funciones y responde con eso', async () => {
    const { headers } = await registrarCliente(env);
    expect((await llamar(headers, 'POST', '/cuenta/probar', { texto: 'hola' })).statusCode).toBe(402);

    const vacia = (await llamar(headers, 'GET', '/cuenta/demo')).json();
    expect(vacia).toMatchObject({ negocio: 'Peluquería Luna', fuentes: [], mensajes: 0, config: { funciones: ['horarios', 'derivar'] } });

    const conTabla = await llamar(headers, 'POST', '/cuenta/demo/fuentes', {
      nombre: 'stock.csv',
      archivo: base64('producto,precio,stock\nShampoo,$9.000,4\nTintura,$12.000,0'),
    });
    expect(conTabla.statusCode).toBe(201);
    expect(conTabla.json().fuentes[0]).toMatchObject({ tipo: 'tabla', filas: 2, columnas: ['producto', 'precio', 'stock'], muestra: [['Shampoo', '$9.000', '4'], ['Tintura', '$12.000', '0']] });

    await llamar(headers, 'POST', '/cuenta/demo/fuentes', { nombre: 'Políticas', texto: 'Hacemos envíos en el día dentro de CABA.' });
    const config = await llamar(headers, 'PUT', '/cuenta/demo', { funciones: ['stock', 'derivar'], horarios: 'Lunes a sábado de 9 a 19', tono: 'formal' });
    expect(config.json().config).toMatchObject({ funciones: ['stock', 'derivar'], horarios: 'Lunes a sábado de 9 a 19', tono: 'formal' });

    env.ai.chat.mockResolvedValueOnce('Sí, tenemos 4 shampoo a $9.000. Le separo uno. [STOCK_RESERVAR Shampoo | 1]');
    const chat = await llamar(headers, 'POST', '/cuenta/demo/chat', { texto: '¿Tienen shampoo? Separame uno' });
    expect(chat.json()).toEqual({ texto: 'Sí, tenemos 4 shampoo a $9.000. Le separo uno.', handoff: false, acciones: ['Separaría 1 × Shampoo'] });
    const system = env.ai.chat.mock.calls[0][1][0].content as string;
    expect(system).toContain('Shampoo\t$9.000\t4');
    expect(system).toContain('envíos en el día');
    expect(system).toContain('STOCK_RESERVAR');
    expect(system).not.toContain('TURNO_RESERVAR');
    expect(await env.deps.prisma.usage.count()).toBe(0);

    env.ai.chat.mockResolvedValueOnce('[HANDOFF]');
    expect((await llamar(headers, 'POST', '/cuenta/demo/chat', { texto: 'quiero hablar con alguien' })).json()).toMatchObject({ handoff: true });

    const metricas = await calcularMetricas(env.deps);
    expect(metricas.embudo.probaronDemo).toBe(1);

    env.ai.chat.mockRejectedValueOnce(new Error('caída'));
    expect((await llamar(headers, 'POST', '/cuenta/demo/chat', { texto: 'hola' })).statusCode).toBe(502);
  });

  it('valida formatos, límites y que cada cuenta vea solo lo suyo', async () => {
    const luna = await registrarCliente(env);
    const otra = await registrarCliente(env, { email: 'otra@negocio.com', negocio: 'Otra' });

    expect((await llamar(luna.headers, 'POST', '/cuenta/demo/fuentes', { nombre: 'foto.png', archivo: base64('xx') })).statusCode).toBe(400);
    expect((await llamar(luna.headers, 'POST', '/cuenta/demo/fuentes', { nombre: 'x.pdf', archivo: base64('no soy pdf') })).statusCode).toBe(400);
    expect((await llamar(luna.headers, 'PUT', '/cuenta/demo', { funciones: ['volar'] })).statusCode).toBe(400);

    const ejemplo = (await llamar(luna.headers, 'POST', '/cuenta/demo/ejemplo')).json();
    expect(ejemplo).toMatchObject({ negocio: 'Tienda Andes', config: { funciones: ['stock', 'horarios', 'pedidos', 'derivar'] } });
    expect(ejemplo.fuentes).toHaveLength(2);

    const id = ejemplo.fuentes[0].id;
    expect((await llamar(otra.headers, 'DELETE', `/cuenta/demo/fuentes/${id}`)).statusCode).toBe(404);
    expect((await llamar(otra.headers, 'GET', '/cuenta/demo')).json().fuentes).toEqual([]);
    expect((await llamar(luna.headers, 'DELETE', `/cuenta/demo/fuentes/${id}`)).json().fuentes).toHaveLength(1);

    for (let i = 0; i < 5; i++) {
      await llamar(luna.headers, 'POST', '/cuenta/demo/fuentes', { nombre: `nota ${i}`, texto: `Información de prueba número ${i}` });
    }
    const septima = await llamar(luna.headers, 'POST', '/cuenta/demo/fuentes', { nombre: 'una más', texto: 'Esta ya no entra en la demo' });
    expect(septima.statusCode).toBe(409);
  });
});
