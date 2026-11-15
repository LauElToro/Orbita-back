import type { CanalTipo } from '@prisma/client';

export type Canal = Exclude<CanalTipo, 'telegram'>;

/** A quién se le responde: la cuenta del comercio (endpointId + token) y la persona o conversación del otro lado. */
export interface Destino {
  canal: Canal;
  endpointId: string;
  token: string;
  destino: string;
}

export interface MessengerClient {
  enviar(d: Destino, texto: string): Promise<void>;
}

export interface CanalesConfig {
  metaGraphUrl: string;
  instagramGraphUrl: string;
  metaVersion: string;
  tiktokUrl: string;
}

/** Límites de largo de cada plataforma. Instagram mide en bytes UTF-8, no en caracteres. */
const LIMITE: Record<Canal, { max: number; bytes: boolean }> = {
  whatsapp: { max: 4096, bytes: false },
  instagram: { max: 1000, bytes: true },
  tiktok: { max: 6000, bytes: false },
};

export function partirTexto(texto: string, max: number, bytes: boolean): string[] {
  const medir = (s: string) => (bytes ? Buffer.byteLength(s, 'utf8') : [...s].length);
  if (medir(texto) <= max) return [texto];
  const partes: string[] = [];
  let actual = '';
  for (const palabra of texto.split(/(\s+)/)) {
    if (medir(actual + palabra) <= max) {
      actual += palabra;
      continue;
    }
    if (actual.trim()) partes.push(actual.trim());
    actual = palabra.trimStart();
    while (medir(actual) > max) {
      let corte = actual.length;
      while (medir(actual.slice(0, corte)) > max) corte--;
      partes.push(actual.slice(0, corte));
      actual = actual.slice(corte);
    }
  }
  if (actual.trim()) partes.push(actual.trim());
  return partes;
}

/** Envía directo por la API oficial de cada plataforma, con el token del canal del comercio. */
export class CanalesClient implements MessengerClient {
  constructor(
    private readonly cfg: CanalesConfig,
    private readonly timeoutMs = 10_000,
  ) {}

  async enviar(d: Destino, texto: string): Promise<void> {
    const { max, bytes } = LIMITE[d.canal];
    for (const parte of partirTexto(texto, max, bytes)) await this.enviarUno(d, parte);
  }

  private async enviarUno(d: Destino, texto: string): Promise<void> {
    const bearer = { Authorization: `Bearer ${d.token}` };
    if (d.canal === 'whatsapp') {
      await this.post('WhatsApp', `${this.cfg.metaGraphUrl}/${this.cfg.metaVersion}/${d.endpointId}/messages`, bearer, {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: d.destino,
        type: 'text',
        text: { preview_url: false, body: texto },
      });
      return;
    }
    if (d.canal === 'instagram') {
      await this.post('Instagram', `${this.cfg.instagramGraphUrl}/${this.cfg.metaVersion}/${d.endpointId}/messages`, bearer, {
        recipient: { id: d.destino },
        message: { text: texto },
      });
      return;
    }
    const json = await this.post(
      'TikTok',
      `${this.cfg.tiktokUrl}/open_api/v1.3/business/message/send/`,
      { 'Access-Token': d.token },
      {
        business_id: d.endpointId,
        recipient_type: 'CONVERSATION',
        recipient: d.destino,
        message_type: 'TEXT',
        text: { body: texto },
      },
    );
    const code = (json as { code?: number }).code;
    if (code !== undefined && code !== 0) throw new Error(`TikTok ${code}: ${JSON.stringify(json).slice(0, 300)}`);
  }

  private async post(plataforma: string, url: string, headers: Record<string, string>, body: unknown) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${plataforma} ${res.status}: ${text.slice(0, 300)}`);
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return {};
    }
  }
}
