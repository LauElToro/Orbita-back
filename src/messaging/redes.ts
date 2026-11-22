import { Prisma } from '@prisma/client';
import type { Config } from '../config';
import type { Deps } from '../deps';
import { encrypt, randomToken } from '../lib/crypto';
import { badRequest, conflict, HttpError } from '../lib/errors';
import { keys } from '../lib/keys';
import { getTenant, rebuildIndex } from '../tenants/repo';

export const REDES = ['facebook', 'instagram', 'tiktok'] as const;
export type Red = (typeof REDES)[number];

export interface CuentaRed {
  tipo: 'instagram' | 'tiktok';
  endpointId: string;
  etiqueta: string;
  token: string;
  apiBase: string | null;
}

/** Abre la autorización de la red y canjea el código por la cuenta del comercio. */
export interface RedesAuth {
  listo(red: Red): boolean;
  url(red: Red, state: string): string;
  completar(red: Red, code: string): Promise<CuentaRed>;
}

export function redirectRedes(config: Config): string {
  return `${config.PUBLIC_URL.replace(/\/$/, '')}/redes/vuelta`;
}

export function esRed(valor: string): valor is Red {
  return (REDES as readonly string[]).includes(valor);
}

function metaListo(cfg: Config): boolean {
  return Boolean(cfg.META_APP_ID && cfg.META_APP_SECRET);
}

export class RedesClient implements RedesAuth {
  constructor(private readonly cfg: Config) {}

  listo(red: Red): boolean {
    if (red === 'tiktok') return Boolean(this.cfg.TIKTOK_APP_ID && this.cfg.TIKTOK_APP_SECRET);
    return metaListo(this.cfg);
  }

  url(red: Red, state: string): string {
    const vuelta = redirectRedes(this.cfg);
    if (red === 'facebook') {
      const q = new URLSearchParams({
        client_id: this.cfg.META_APP_ID,
        redirect_uri: vuelta,
        state,
        response_type: 'code',
        scope: 'pages_show_list,pages_manage_metadata,pages_messaging,instagram_basic,instagram_manage_messages',
      });
      return `https://www.facebook.com/${this.cfg.META_API_VERSION}/dialog/oauth?${q}`;
    }
    if (red === 'instagram') {
      const q = new URLSearchParams({
        client_id: this.cfg.META_APP_ID,
        redirect_uri: vuelta,
        response_type: 'code',
        scope: 'instagram_business_basic,instagram_business_manage_messages',
        enable_fb_login: '0',
        state,
      });
      return `https://www.instagram.com/oauth/authorize?${q}`;
    }
    const q = new URLSearchParams({
      client_key: this.cfg.TIKTOK_APP_ID,
      response_type: 'code',
      scope: 'user.info.basic,user.account.type,message.list.manage',
      redirect_uri: vuelta,
      state,
    });
    return `https://www.tiktok.com/v2/auth/authorize/?${q}`;
  }

  async completar(red: Red, code: string): Promise<CuentaRed> {
    const limpio = code.replace(/#_$/, '');
    if (red === 'facebook') return this.facebook(limpio);
    if (red === 'instagram') return this.instagram(limpio);
    return this.tiktok(limpio);
  }

  private async facebook(code: string): Promise<CuentaRed> {
    const vuelta = redirectRedes(this.cfg);
    const corto = await leer(
      `${this.cfg.META_GRAPH_URL}/${this.cfg.META_API_VERSION}/oauth/access_token?${new URLSearchParams({
        client_id: this.cfg.META_APP_ID,
        client_secret: this.cfg.META_APP_SECRET,
        redirect_uri: vuelta,
        code,
      })}`,
    );
    const usuario = texto(corto, 'access_token');
    if (!usuario) throw new HttpError(401, 'Facebook no aceptó la autorización');
    const largo = await leer(
      `${this.cfg.META_GRAPH_URL}/${this.cfg.META_API_VERSION}/oauth/access_token?${new URLSearchParams({
        grant_type: 'fb_exchange_token',
        client_id: this.cfg.META_APP_ID,
        client_secret: this.cfg.META_APP_SECRET,
        fb_exchange_token: usuario,
      })}`,
    );
    const tokenUsuario = texto(largo, 'access_token') || usuario;
    const paginas = await leer(
      `${this.cfg.META_GRAPH_URL}/${this.cfg.META_API_VERSION}/me/accounts?fields=id,name,access_token,instagram_business_account{id,username}&access_token=${encodeURIComponent(tokenUsuario)}`,
    );
    const elegida = elegirPagina(paginas);
    if (!elegida) throw new HttpError(400, 'No encontramos un Instagram profesional vinculado a una página de Facebook');
    if (elegida.pageId) await suscribir(`${this.cfg.META_GRAPH_URL}/${this.cfg.META_API_VERSION}/${elegida.pageId}/subscribed_apps`, elegida.token);
    await suscribir(`${this.cfg.META_GRAPH_URL}/${this.cfg.META_API_VERSION}/${elegida.igId}/subscribed_apps`, elegida.token);
    return { tipo: 'instagram', endpointId: elegida.igId, etiqueta: elegida.etiqueta, token: elegida.token, apiBase: this.cfg.META_GRAPH_URL };
  }

  private async instagram(code: string): Promise<CuentaRed> {
    const vuelta = redirectRedes(this.cfg);
    const body = new URLSearchParams({
      client_id: this.cfg.META_APP_ID,
      client_secret: this.cfg.META_APP_SECRET,
      grant_type: 'authorization_code',
      redirect_uri: vuelta,
      code,
    });
    const corto = await enviar('https://api.instagram.com/oauth/access_token', body);
    const data = tokenInstagram(corto);
    const cortoToken = data.token;
    if (!cortoToken) throw new HttpError(401, 'Instagram no aceptó la autorización');
    const largo = await leer(
      `${this.cfg.INSTAGRAM_GRAPH_URL}/access_token?${new URLSearchParams({
        grant_type: 'ig_exchange_token',
        client_secret: this.cfg.META_APP_SECRET,
        access_token: cortoToken,
      })}`,
    );
    const token = texto(largo, 'access_token') || cortoToken;
    const perfil = await leer(`${this.cfg.INSTAGRAM_GRAPH_URL}/${this.cfg.META_API_VERSION}/me?fields=user_id,username`, token);
    const id = texto(perfil, 'user_id') || texto(perfil, 'id') || data.userId;
    if (!id) throw new HttpError(401, 'Instagram no devolvió la cuenta');
    await suscribir(`${this.cfg.INSTAGRAM_GRAPH_URL}/${this.cfg.META_API_VERSION}/${id}/subscribed_apps`, token);
    const usuario = texto(perfil, 'username');
    return { tipo: 'instagram', endpointId: id, etiqueta: usuario ? `@${usuario}` : 'Instagram', token, apiBase: null };
  }

  private async tiktok(code: string): Promise<CuentaRed> {
    const vuelta = redirectRedes(this.cfg);
    const tokenJson = await enviar(
      'https://open.tiktokapis.com/v2/oauth/token/',
      new URLSearchParams({
        client_key: this.cfg.TIKTOK_APP_ID,
        client_secret: this.cfg.TIKTOK_APP_SECRET,
        code,
        grant_type: 'authorization_code',
        redirect_uri: vuelta,
      }),
    );
    const { token, openId } = tokenTiktok(tokenJson);
    if (!token || !openId) throw new HttpError(401, 'TikTok no aceptó la autorización');
    let nombre = 'TikTok';
    try {
      const info = await leer('https://open.tiktokapis.com/v2/user/info/?fields=display_name,username', token);
      const user = obj(obj(obj(info).data).user);
      nombre = str(user.username) ? `@${str(user.username)}` : str(user.display_name) || nombre;
    } catch (err) {
      console.error('no se pudo leer el perfil de TikTok', err instanceof Error ? err.message : err);
    }
    return { tipo: 'tiktok', endpointId: openId, etiqueta: nombre, token, apiBase: null };
  }
}

/** Guarda el código de un solo uso y devuelve la pantalla de autorización. */
export async function iniciarRed(deps: Deps, tenantId: string, red: Red): Promise<{ url: string }> {
  if (!deps.redes.listo(red)) throw new HttpError(503, 'Esa red todavía no está lista para conectar');
  const state = randomToken(24);
  await deps.redis.set(keys.redesState(state), JSON.stringify({ tenantId, red }), 'EX', 600);
  return { url: deps.redes.url(red, state) };
}

/** Canjea el código y deja el canal contestando, sin que el comercio pegue un token. */
export async function completarRed(deps: Deps, tenantId: string, raw: unknown) {
  const body = raw as { code?: unknown; state?: unknown };
  if (typeof body?.code !== 'string' || typeof body.state !== 'string' || !body.code || !body.state) {
    throw new HttpError(400, 'Faltan datos de la autorización');
  }
  const guardado = await deps.redis.get(keys.redesState(body.state));
  if (!guardado) throw new HttpError(400, 'La autorización venció. Volvé a apretar Conectar');
  await deps.redis.del(keys.redesState(body.state));
  const parsed = JSON.parse(guardado) as { tenantId?: string; red?: string };
  if (parsed.tenantId !== tenantId || !parsed.red || !esRed(parsed.red)) throw new HttpError(400, 'La autorización no corresponde a esta cuenta');
  const cuenta = await deps.redes.completar(parsed.red, body.code);
  const tenant = await getTenant(deps.prisma, tenantId);
  const ya = tenant.canales.find((c) => c.tipo === cuenta.tipo);
  if (!ya && tenant.canales.length >= tenant.plan.maxCanales) {
    throw badRequest(`El plan ${tenant.plan.nombre} admite hasta ${tenant.plan.maxCanales} canal(es)`);
  }
  const data = {
    tenantId,
    tipo: cuenta.tipo,
    endpointId: cuenta.endpointId,
    etiqueta: cuenta.etiqueta,
    tokenEnc: encrypt(cuenta.token, deps.config.ENCRYPTION_KEY),
    apiBase: cuenta.apiBase,
  };
  try {
    await deps.prisma.$transaction(async (tx) => {
      if (ya) await tx.channel.delete({ where: { id: ya.id } });
      await tx.channel.create({ data });
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw conflict('Esa cuenta ya está conectada en Orbita');
    }
    throw err;
  }
  await rebuildIndex(deps.prisma, deps.redis);
  return getTenant(deps.prisma, tenantId);
}

/** Primera página de Facebook que tiene un Instagram profesional. */
export function elegirPagina(paginas: unknown): { pageId: string; igId: string; token: string; etiqueta: string } | null {
  const lista = Array.isArray((paginas as { data?: unknown }).data) ? (paginas as { data: unknown[] }).data : [];
  for (const item of lista) {
    const pagina = obj(item);
    const ig = obj(pagina.instagram_business_account);
    const igId = str(ig.id);
    const token = str(pagina.access_token);
    if (!igId || !token) continue;
    const usuarioIg = str(ig.username);
    return { pageId: str(pagina.id), igId, token, etiqueta: usuarioIg ? `@${usuarioIg}` : str(pagina.name) || 'Instagram' };
  }
  return null;
}

/** El canje de Instagram Login viene plano o dentro de `data`. */
export function tokenInstagram(corto: unknown): { token: string; userId: string } {
  const data = Array.isArray((corto as { data?: unknown }).data) ? obj((corto as { data: unknown[] }).data[0]) : obj(corto);
  return { token: str(data.access_token), userId: str(data.user_id) };
}

export function tokenTiktok(json: unknown): { token: string; openId: string } {
  return { token: texto(json, 'access_token'), openId: texto(json, 'open_id') };
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});
const str = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v) : '');
const texto = (v: unknown, campo: string) => str(obj(v)[campo]);

async function leer(url: string, token?: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  if (!res.ok) throw new HttpError(401, 'La red no aceptó la autorización');
  return JSON.parse(text) as unknown;
}

async function enviar(url: string, body: URLSearchParams): Promise<unknown> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  if (!res.ok) throw new HttpError(401, 'La red no aceptó la autorización');
  return JSON.parse(text) as unknown;
}

async function suscribir(url: string, token: string): Promise<void> {
  try {
    const res = await fetch(`${url}?subscribed_fields=messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) console.error('no se pudo suscribir el webhook', res.status, (await res.text()).slice(0, 200));
  } catch (err) {
    console.error('no se pudo suscribir el webhook', err instanceof Error ? err.message : err);
  }
}
