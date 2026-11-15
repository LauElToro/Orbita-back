import { createHmac } from 'node:crypto';
import { safeEqual } from '../lib/crypto';
import type { Canal } from './canales';

/** Un mensaje de texto entrante, igual para las tres plataformas. */
export interface Entrante {
  canal: Canal;
  /** Cuenta del comercio: phone_number_id de WhatsApp, id de la cuenta de Instagram o business_id de TikTok. */
  endpointId: string;
  /** Identidad estable de la persona, para historial y turnos. */
  subscriberId: string;
  /** A dónde se responde: número en WhatsApp, IGSID en Instagram, conversation_id en TikTok. */
  destino: string;
  texto: string;
  nombre: string;
  /** Id del mensaje en la plataforma; deduplica los reintentos. */
  externalId: string;
}

const MAX_TEXTO = 4000;
const TIKTOK_TOLERANCIA_SEG = 300;

/** Meta firma el cuerpo crudo con el App Secret: `X-Hub-Signature-256: sha256=<hex>`. */
export function firmaMetaValida(raw: string, header: unknown, secret: string): boolean {
  if (!secret || typeof header !== 'string' || !header.startsWith('sha256=')) return false;
  const esperada = createHmac('sha256', secret).update(raw, 'utf8').digest('hex');
  return safeEqual(header.slice(7), esperada);
}

/** TikTok firma `t + "." + cuerpo crudo` con el App Secret: `TikTok-Signature: t=<seg>,s=<hex>`. */
export function firmaTiktokValida(raw: string, header: unknown, secret: string, ahoraSeg: number): boolean {
  if (!secret || typeof header !== 'string') return false;
  const partes = Object.fromEntries(
    header.split(',').map((p) => {
      const i = p.indexOf('=');
      return [p.slice(0, i).trim(), p.slice(i + 1).trim()];
    }),
  );
  const t = partes.t;
  if (!t || !/^\d+$/.test(t) || !partes.s) return false;
  if (Math.abs(ahoraSeg - Number(t)) > TIKTOK_TOLERANCIA_SEG) return false;
  const esperada = createHmac('sha256', secret).update(`${t}.${raw}`, 'utf8').digest('hex');
  return safeEqual(partes.s, esperada);
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' ? (v as Obj) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === 'string' || typeof v === 'number' ? String(v) : '');
const texto = (v: unknown): string => str(v).trim().slice(0, MAX_TEXTO);

/** WhatsApp Cloud API (`whatsapp_business_account`) e Instagram (`instagram`). Ignora estados, ecos y adjuntos. */
export function leerMeta(body: unknown): Entrante[] {
  const b = obj(body);
  const salida: Entrante[] = [];
  if (b.object === 'whatsapp_business_account') {
    for (const entry of arr(b.entry)) {
      for (const change of arr(obj(entry).changes)) {
        const value = obj(obj(change).value);
        const endpointId = str(obj(value.metadata).phone_number_id);
        const contactos = new Map(arr(value.contacts).map((c) => [str(obj(c).wa_id), str(obj(obj(c).profile).name)]));
        for (const m of arr(value.messages)) {
          const msg = obj(m);
          const cuerpo = texto(obj(msg.text).body);
          const de = str(msg.from);
          if (msg.type !== 'text' || !cuerpo || !de || !endpointId) continue;
          salida.push({
            canal: 'whatsapp',
            endpointId,
            subscriberId: de,
            destino: de,
            texto: cuerpo,
            nombre: contactos.get(de) ?? '',
            externalId: str(msg.id) || `${de}:${str(msg.timestamp)}`,
          });
        }
      }
    }
  }
  if (b.object === 'instagram') {
    for (const entry of arr(b.entry)) {
      const e = obj(entry);
      for (const ev of arr(e.messaging)) {
        const evento = obj(ev);
        const message = obj(evento.message);
        const cuerpo = texto(message.text);
        const de = str(obj(evento.sender).id);
        const endpointId = str(obj(evento.recipient).id) || str(e.id);
        if (message.is_echo || message.is_deleted || !cuerpo || !de || !endpointId || de === endpointId) continue;
        salida.push({
          canal: 'instagram',
          endpointId,
          subscriberId: de,
          destino: de,
          texto: cuerpo,
          nombre: '',
          externalId: str(message.mid) || `${de}:${str(evento.timestamp)}`,
        });
      }
    }
  }
  return salida;
}

/** TikTok Business Messaging: solo `im_receive_msg` de texto enviado por una persona (no por la cuenta del comercio). */
export function leerTiktok(body: unknown): Entrante[] {
  const b = obj(body);
  if (b.event !== 'im_receive_msg') return [];
  let content: Obj;
  try {
    content = typeof b.content === 'string' ? obj(JSON.parse(b.content)) : obj(b.content);
  } catch {
    return [];
  }
  const from = obj(content.from_user);
  const cuerpo = texto(obj(content.text).body);
  const endpointId = str(b.user_openid);
  const conversacion = str(content.conversation_id);
  const persona = str(from.id) || str(content.unique_identifier);
  if (content.type !== 'text' || from.role === 'business_account' || !cuerpo || !endpointId || !conversacion || !persona) {
    return [];
  }
  return [
    {
      canal: 'tiktok',
      endpointId,
      subscriberId: persona,
      destino: conversacion,
      texto: cuerpo,
      nombre: str(content.from),
      externalId: str(content.message_id) || `${conversacion}:${str(content.timestamp)}`,
    },
  ];
}
