import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { firmaMetaValida, firmaTiktokValida, leerMeta, leerTiktok } from '../../src/messaging/webhooks';

const firmar = (secret: string, texto: string) => createHmac('sha256', secret).update(texto).digest('hex');

describe('firma de Meta', () => {
  const raw = '{"object":"whatsapp_business_account"}';
  it('acepta la firma del App Secret sobre el cuerpo crudo', () => {
    expect(firmaMetaValida(raw, `sha256=${firmar('sec', raw)}`, 'sec')).toBe(true);
  });
  it('rechaza firma ajena, cuerpo alterado, header faltante o secreto vacío', () => {
    expect(firmaMetaValida(raw, `sha256=${firmar('otro', raw)}`, 'sec')).toBe(false);
    expect(firmaMetaValida(`${raw} `, `sha256=${firmar('sec', raw)}`, 'sec')).toBe(false);
    expect(firmaMetaValida(raw, undefined, 'sec')).toBe(false);
    expect(firmaMetaValida(raw, `sha256=${firmar('', raw)}`, '')).toBe(false);
  });
});

describe('firma de TikTok', () => {
  const raw = '{"event":"im_receive_msg"}';
  const t = 1_800_000_000;
  it('acepta t.cuerpo firmado con el App Secret dentro de 5 minutos', () => {
    expect(firmaTiktokValida(raw, `t=${t},s=${firmar('sec', `${t}.${raw}`)}`, 'sec', t + 60)).toBe(true);
  });
  it('rechaza firmas viejas, alteradas o mal formadas', () => {
    const s = firmar('sec', `${t}.${raw}`);
    expect(firmaTiktokValida(raw, `t=${t},s=${s}`, 'sec', t + 301)).toBe(false);
    expect(firmaTiktokValida(raw, `t=${t + 1},s=${s}`, 'sec', t)).toBe(false);
    expect(firmaTiktokValida(raw, `s=${s}`, 'sec', t)).toBe(false);
    expect(firmaTiktokValida(raw, `t=${t},s=${s}`, '', t)).toBe(false);
  });
});

describe('leerMeta', () => {
  it('toma los textos de WhatsApp con nombre del contacto e ignora estados y adjuntos', () => {
    const body = {
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: 'PN1' },
                contacts: [{ wa_id: '5491111', profile: { name: 'Ana' } }],
                messages: [
                  { id: 'wamid.1', from: '5491111', type: 'text', text: { body: ' hola ' } },
                  { id: 'wamid.2', from: '5491111', type: 'image', image: { id: 'x' } },
                ],
              },
            },
            { field: 'messages', value: { metadata: { phone_number_id: 'PN1' }, statuses: [{ id: 'wamid.0' }] } },
          ],
        },
      ],
    };
    expect(leerMeta(body)).toEqual([
      { canal: 'whatsapp', endpointId: 'PN1', subscriberId: '5491111', destino: '5491111', texto: 'hola', nombre: 'Ana', externalId: 'wamid.1' },
    ]);
  });

  it('toma los mensajes de Instagram y descarta los ecos de la propia cuenta', () => {
    const body = {
      object: 'instagram',
      entry: [
        {
          id: 'IG1',
          messaging: [
            { sender: { id: 'IGSID' }, recipient: { id: 'IG1' }, message: { mid: 'm1', text: '¿precio?' } },
            { sender: { id: 'IG1' }, recipient: { id: 'IGSID' }, message: { mid: 'm2', text: 'eco', is_echo: true } },
          ],
        },
      ],
    };
    expect(leerMeta(body)).toEqual([
      { canal: 'instagram', endpointId: 'IG1', subscriberId: 'IGSID', destino: 'IGSID', texto: '¿precio?', nombre: '', externalId: 'm1' },
    ]);
  });

  it('ignora objetos desconocidos o cuerpos vacíos', () => {
    expect(leerMeta({ object: 'page' })).toEqual([]);
    expect(leerMeta(null)).toEqual([]);
  });
});

describe('leerTiktok', () => {
  const evento = (content: Record<string, unknown>, event = 'im_receive_msg') => ({
    client_key: 'app',
    event,
    create_time: 1,
    user_openid: 'BIZ',
    content: JSON.stringify(content),
  });
  const texto = {
    from: 'ana.tt',
    from_user: { id: 'U1', role: 'personal_account' },
    to_user: { id: 'BIZ', role: 'business_account' },
    conversation_id: 'CONV',
    message_id: 'MSG',
    type: 'text',
    text: { body: 'hola' },
  };

  it('usa la conversación como destino y la persona como suscriptor', () => {
    expect(leerTiktok(evento(texto))).toEqual([
      { canal: 'tiktok', endpointId: 'BIZ', subscriberId: 'U1', destino: 'CONV', texto: 'hola', nombre: 'ana.tt', externalId: 'MSG' },
    ]);
  });

  it('ignora lo que manda el comercio, otros eventos, imágenes y contenido roto', () => {
    expect(leerTiktok(evento({ ...texto, from_user: { id: 'BIZ', role: 'business_account' } }))).toEqual([]);
    expect(leerTiktok(evento(texto, 'im_send_msg'))).toEqual([]);
    expect(leerTiktok(evento({ ...texto, type: 'image', text: undefined }))).toEqual([]);
    expect(leerTiktok({ event: 'im_receive_msg', user_openid: 'BIZ', content: '{roto' })).toEqual([]);
  });
});
