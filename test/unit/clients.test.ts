import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenRouterClient } from '../../src/ai/openrouter';
import { MercadoPagoClient } from '../../src/billing/mercadopago';
import { CanalesClient, partirTexto } from '../../src/messaging/canales';

function mockFetch(body: unknown, status = 200) {
  const fn = vi.fn(async (_url: string, _init: { headers: Record<string, string>; body: string }) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }));
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

describe('CanalesClient', () => {
  const client = new CanalesClient({
    metaGraphUrl: 'https://graph.fb.test',
    instagramGraphUrl: 'https://graph.ig.test',
    metaVersion: 'v26.0',
    tiktokUrl: 'https://tt.test',
  });

  it('WhatsApp manda texto al número con el token del canal', async () => {
    const fetch = mockFetch({ messages: [{ id: 'wamid.1' }] });
    await client.enviar({ canal: 'whatsapp', endpointId: 'PN1', token: 'tok', destino: '5491100000000' }, 'hola');
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://graph.fb.test/v26.0/PN1/messages');
    expect(init.headers.Authorization).toBe('Bearer tok');
    expect(JSON.parse(init.body)).toMatchObject({ messaging_product: 'whatsapp', to: '5491100000000', text: { body: 'hola' } });
  });

  it('Instagram responde al IGSID y parte los textos de más de 1000 bytes', async () => {
    const fetch = mockFetch({ message_id: 'm1' });
    await client.enviar({ canal: 'instagram', endpointId: 'IG1', token: 'tok', destino: 'IGSID' }, 'ñ'.repeat(600));
    expect(fetch).toHaveBeenCalledTimes(2);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://graph.ig.test/v26.0/IG1/messages');
    expect(JSON.parse(init.body).recipient).toEqual({ id: 'IGSID' });
  });

  it('TikTok usa Access-Token y la conversación, y falla si code no es 0', async () => {
    const fetch = mockFetch({ code: 0, data: { message_id: 'x' } });
    await client.enviar({ canal: 'tiktok', endpointId: 'BIZ', token: 'tok', destino: 'CONV' }, 'hola');
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://tt.test/open_api/v1.3/business/message/send/');
    expect(init.headers['Access-Token']).toBe('tok');
    expect(JSON.parse(init.body)).toMatchObject({ business_id: 'BIZ', recipient_type: 'CONVERSATION', recipient: 'CONV' });
    mockFetch({ code: 40001, message: 'token vencido' });
    await expect(client.enviar({ canal: 'tiktok', endpointId: 'B', token: 't', destino: 'C' }, 'x')).rejects.toThrow('TikTok 40001');
  });

  it('propaga errores HTTP con el nombre de la plataforma', async () => {
    mockFetch('nope', 401);
    await expect(client.enviar({ canal: 'whatsapp', endpointId: 'P', token: 't', destino: '1' }, 'x')).rejects.toThrow('WhatsApp 401');
  });

  it('partirTexto respeta el límite y no corta palabras si puede', () => {
    expect(partirTexto('hola', 10, false)).toEqual(['hola']);
    expect(partirTexto('uno dos tres cuatro', 8, false)).toEqual(['uno dos', 'tres', 'cuatro']);
    expect(partirTexto('a'.repeat(25), 10, false)).toEqual(['a'.repeat(10), 'a'.repeat(10), 'a'.repeat(5)]);
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
