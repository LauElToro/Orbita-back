import type { Config } from '../config';

export interface NumeroWhatsapp {
  display_phone_number?: string;
  verified_name?: string;
  code_verification_status?: string;
  name_status?: string;
  status?: string;
}

/** Graph API de la app de Orbita: canjea el código del comercio, suscribe el webhook y lee el número. */
export interface MetaGraph {
  intercambiarCodigo(code: string): Promise<string>;
  suscribirApp(wabaId: string, token: string): Promise<void>;
  leerNumero(phoneNumberId: string, token: string): Promise<NumeroWhatsapp>;
  registrarNumero(phoneNumberId: string, token: string, pin: string): Promise<void>;
}

export class MetaGraphClient implements MetaGraph {
  constructor(private readonly cfg: Config) {}

  private url(path: string): string {
    return `${this.cfg.META_GRAPH_URL}/${this.cfg.META_API_VERSION}/${path}`;
  }

  async intercambiarCodigo(code: string): Promise<string> {
    const q = new URLSearchParams({
      client_id: this.cfg.META_APP_ID,
      client_secret: this.cfg.META_APP_SECRET,
      code,
    });
    const json = await this.leer(`${this.url('oauth/access_token')}?${q}`);
    const token = (json as { access_token?: string }).access_token;
    if (!token) throw new Error('Meta no devolvió el token');
    return token;
  }

  async suscribirApp(wabaId: string, token: string): Promise<void> {
    await this.enviar(`${wabaId}/subscribed_apps`, token, {});
  }

  async leerNumero(phoneNumberId: string, token: string): Promise<NumeroWhatsapp> {
    const fields = 'display_phone_number,verified_name,code_verification_status,name_status,status';
    return (await this.leer(`${this.url(phoneNumberId)}?fields=${fields}`, token)) as NumeroWhatsapp;
  }

  async registrarNumero(phoneNumberId: string, token: string, pin: string): Promise<void> {
    await this.enviar(`${phoneNumberId}/register`, token, { messaging_product: 'whatsapp', pin });
  }

  private async leer(url: string, token?: string): Promise<unknown> {
    const res = await fetch(url, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(10_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Meta ${res.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text) as unknown;
  }

  private async enviar(path: string, token: string, body: unknown): Promise<void> {
    const res = await fetch(this.url(path), {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Meta ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
}
