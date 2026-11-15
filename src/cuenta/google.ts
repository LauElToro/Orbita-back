import type { Config } from '../config';
import type { Deps } from '../deps';
import { randomToken } from '../lib/crypto';
import { HttpError } from '../lib/errors';
import { keys } from '../lib/keys';
import type { Evidencia } from '../legal/legal';
import { registrar } from './service';

const AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN = 'https://oauth2.googleapis.com/token';
const USERINFO = 'https://openidconnect.googleapis.com/v1/userinfo';

export function redirectDeGoogle(config: Config): string {
  return config.GOOGLE_REDIRECT_URI || `${config.PUBLIC_URL.replace(/\/$/, '')}/google/vuelta`;
}

export function urlAutorizacionGoogle(config: Config, state: string): string {
  const q = new URLSearchParams({
    client_id: config.GOOGLE_CLIENT_ID,
    redirect_uri: redirectDeGoogle(config),
    response_type: 'code',
    scope: 'openid email profile',
    state,
    prompt: 'select_account',
  });
  return `${AUTH}?${q}`;
}

interface PerfilGoogle {
  email: string;
  email_verified: boolean;
  nombre: string;
}

async function perfilDeCodigo(config: Config, code: string): Promise<PerfilGoogle> {
  const tokenRes = await fetch(TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: config.GOOGLE_CLIENT_ID,
      client_secret: config.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectDeGoogle(config),
      grant_type: 'authorization_code',
    }),
  });
  if (!tokenRes.ok) throw new HttpError(401, 'Google no aceptó el ingreso');
  const token = (await tokenRes.json()) as { access_token?: string };
  if (!token.access_token) throw new HttpError(401, 'Google no aceptó el ingreso');

  const infoRes = await fetch(USERINFO, { headers: { Authorization: `Bearer ${token.access_token}` } });
  if (!infoRes.ok) throw new HttpError(401, 'Google no devolvió el perfil');
  const info = (await infoRes.json()) as { email?: string; email_verified?: boolean; name?: string };
  if (!info.email) throw new HttpError(400, 'La cuenta de Google no tiene email');
  return { email: info.email.toLowerCase(), email_verified: info.email_verified === true, nombre: info.name?.trim() || '' };
}

type PedidoGoogle =
  | { modo: 'login' }
  | { modo: 'registro'; negocio: string; rubro: string; nombre: string; planId?: 'mensajes' | 'turnos' | 'completo' };

export async function prepararGoogle(deps: Deps, raw: unknown): Promise<{ url: string }> {
  if (!deps.config.GOOGLE_CLIENT_ID || !deps.config.GOOGLE_CLIENT_SECRET) {
    throw new HttpError(503, 'El ingreso con Google no está configurado');
  }
  const pedido = parsePedido(raw);
  const state = randomToken(24);
  await deps.redis.set(keys.googleState(state), JSON.stringify(pedido), 'EX', 600);
  return { url: urlAutorizacionGoogle(deps.config, state) };
}

export async function completarGoogle(deps: Deps, raw: unknown, evidencia: Evidencia) {
  const { code, state } = parseVuelta(raw);
  const guardado = await deps.redis.get(keys.googleState(state));
  if (!guardado) throw new HttpError(400, 'El ingreso con Google venció. Probá de nuevo.');
  await deps.redis.del(keys.googleState(state));
  const pedido = parsePedido(JSON.parse(guardado));
  const perfil = await perfilDeCodigo(deps.config, code);
  if (!perfil.email_verified) throw new HttpError(400, 'Google no confirmó ese email');

  const existente = await deps.prisma.clientUser.findUnique({ where: { email: perfil.email } });
  if (existente) {
    await deps.prisma.clientUser.update({ where: { id: existente.id }, data: { ultimoLogin: deps.now() } });
    return { userId: existente.id, tenantId: existente.tenantId };
  }
  if (pedido.modo === 'login') {
    throw new HttpError(404, 'No hay una cuenta de Orbita con ese Google. Registrate primero.');
  }
  return registrar(
    deps,
    {
      negocio: pedido.negocio,
      rubro: pedido.rubro,
      nombre: pedido.nombre || perfil.nombre || 'Titular',
      email: perfil.email,
      password: randomToken(24),
      planId: pedido.planId,
      medio: 'mercadopago',
      aceptaTerminos: true,
      aceptaPrivacidad: true,
    },
    evidencia,
  );
}

function parsePedido(raw: unknown): PedidoGoogle {
  if (!raw || typeof raw !== 'object') throw new HttpError(400, 'Pedido inválido');
  const body = raw as Record<string, unknown>;
  if (body.modo === 'login') return { modo: 'login' };
  if (body.modo !== 'registro') throw new HttpError(400, 'Pedido inválido');
  const negocio = texto(body.negocio, 2, 120);
  const rubro = texto(body.rubro, 2, 80);
  const nombre = texto(body.nombre, 2, 120);
  const planId = body.planId ?? undefined;
  if (planId !== undefined && planId !== 'mensajes' && planId !== 'turnos' && planId !== 'completo') {
    throw new HttpError(400, 'Ese plan no existe');
  }
  if (body.aceptaTerminos !== true || body.aceptaPrivacidad !== true) {
    throw new HttpError(400, 'Tenés que aceptar los términos y la privacidad');
  }
  return { modo: 'registro', negocio, rubro, nombre, planId };
}

function parseVuelta(raw: unknown): { code: string; state: string } {
  if (!raw || typeof raw !== 'object') throw new HttpError(400, 'Faltan datos de Google');
  const body = raw as Record<string, unknown>;
  if (typeof body.code !== 'string' || typeof body.state !== 'string' || !body.code || !body.state) {
    throw new HttpError(400, 'Faltan datos de Google');
  }
  return { code: body.code, state: body.state };
}

function texto(v: unknown, min: number, max: number): string {
  if (typeof v !== 'string') throw new HttpError(400, 'Completá los datos del negocio');
  const s = v.trim();
  if (s.length < min || s.length > max) throw new HttpError(400, 'Completá los datos del negocio');
  return s;
}
