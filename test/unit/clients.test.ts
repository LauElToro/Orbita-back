import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenRouterClient } from '../../src/ai/openrouter';
import { MercadoPagoClient } from '../../src/billing/mercadopago';
import { ManyChatClient } from '../../src/messaging/manychat';

function mockFetch(body: unknown, status = 200) {
  const fn = vi.fn().mockResolvedValue(
    new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }),
  );
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

describe('OpenRouterClient', () => {
  it('devuelve el contenido del primer choice', async () => {
    const fetch = mockFetch({ choices: [{ message: { content: ' hola ' } }] });
    const client = new OpenRouterClient('https://or.test/api/v1', 'key');
    await expect(client.chat('m', [{ role: 'user', content: 'x' }])).resolves.toBe('hola');
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://or.test/api/v1/chat/completions');
    expect(init.headers.Authorization).toBe('Bearer key');
    expect(JSON.parse(init.body).model).toBe('m');
  });
  it('falla sin clave, con error HTTP o con respuesta vacía', async () => {
    await expect(new OpenRouterClient('u', '').chat('m', [])).rejects.toThrow('OPENROUTER_API_KEY');
    mockFetch('boom', 500);
    await expect(new OpenRouterClient('u', 'k').chat('m', [])).rejects.toThrow('OpenRouter 500');
    mockFetch({ choices: [] });
    await expect(new OpenRouterClient('u', 'k').chat('m', [])).rejects.toThrow('vacía');
  });
});

describe('ManyChatClient', () => {
  it('envía sendContent con el token de la ficha', async () => {
    const fetch = mockFetch({ status: 'success' });
    await new ManyChatClient('https://mc.test').sendText('tok', '999', 'hola');
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://mc.test/fb/sending/sendContent');
    expect(init.headers.Authorization).toBe('Bearer tok');
    expect(JSON.parse(init.body).data.content.messages[0].text).toBe('hola');
  });
  it('propaga errores', async () => {
    mockFetch('nope', 401);
    await expect(new ManyChatClient('u').sendText('t', '1', 'x')).rejects.toThrow('ManyChat 401');
  });
});

describe('MercadoPagoClient', () => {
  const mp = new MercadoPagoClient('tok', '');

  it('crea la suscripción mensual', async () => {
    const fetch = mockFetch({ id: 'pre-1', init_point: 'https://mp/init' });
    await expect(
      mp.crearSuscripcion({ reason: 'r', externalReference: 'c', payerEmail: 'a@b.c', importe: 100, backUrl: 'u' }),
    ).resolves.toEqual({ id: 'pre-1', initPoint: 'https://mp/init' });
    expect(JSON.parse(fetch.mock.calls[0][1].body).auto_recurring.frequency_type).toBe('months');
  });

  it('lee pagos y pagos autorizados', async () => {
    mockFetch({ id: 5, status: 'approved', transaction_amount: 42000, external_reference: 'c1' });
    await expect(mp.obtenerPago('payment', '5')).resolves.toMatchObject({
      id: '5',
      aprobado: true,
      importe: 42000,
      externalReference: 'c1',
    });
    mockFetch({ id: 9, preapproval_id: 'pre-1', transaction_amount: 42000, payment: { id: 77, status: 'approved' } });
    await expect(mp.obtenerPago('subscription_authorized_payment', '9')).resolves.toMatchObject({
      id: '77',
      aprobado: true,
      preapprovalId: 'pre-1',
    });
    await expect(mp.obtenerPago('otro', '1')).resolves.toBeNull();
  });

  it('sin secreto acepta la firma; sin token no está habilitado', () => {
    expect(mp.verificarFirma({}, '1')).toBe(true);
    expect(mp.habilitado).toBe(true);
    expect(new MercadoPagoClient('', '').habilitado).toBe(false);
  });
});
