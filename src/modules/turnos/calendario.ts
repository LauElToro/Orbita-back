import type { Turno } from '@prisma/client';
import type { Config } from '../../config';
import type { Deps } from '../../deps';
import { decrypt, encrypt, randomToken } from '../../lib/crypto';
import { HttpError } from '../../lib/errors';
import { keys } from '../../lib/keys';
import { getTenant, type TenantFull } from '../../tenants/repo';

const AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/calendar.events';
const DURACION_MS = 30 * 60 * 1000;

export interface EventoCalendario {
  eventoId: string | null;
  titulo: string;
  inicio: Date;
  fin: Date;
  zona: string;
}

/** Copia el turno a un calendario externo. Si no hay uno conectado, no hace nada. */
export interface AgendaExterna {
  aplicar(refreshToken: string, accion: 'crear' | 'mover' | 'cancelar', evento: EventoCalendario): Promise<string | null>;
}

export function redirectCalendario(config: Config): string {
  return `${config.PUBLIC_URL.replace(/\/$/, '')}/calendario/vuelta`;
}

export function urlCalendario(config: Config, state: string): string {
  const q = new URLSearchParams({
    client_id: config.GOOGLE_CLIENT_ID,
    redirect_uri: redirectCalendario(config),
    response_type: 'code',
    scope: SCOPE,
    state,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
  });
  return `${AUTH}?${q}`;
}

export class GoogleAgenda implements AgendaExterna {
  constructor(private readonly cfg: Config) {}

  async aplicar(refreshToken: string, accion: 'crear' | 'mover' | 'cancelar', evento: EventoCalendario): Promise<string | null> {
    const access = await accessDe(this.cfg, refreshToken);
    const base = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
    if (accion === 'cancelar') {
      if (evento.eventoId) await pedir(`${base}/${evento.eventoId}`, access, 'DELETE');
      return null;
    }
    const body = {
      summary: evento.titulo,
      description: 'Agendado por Orbita. El recordatorio lo manda Orbita.',
      start: { dateTime: evento.inicio.toISOString(), timeZone: evento.zona },
      end: { dateTime: evento.fin.toISOString(), timeZone: evento.zona },
    };
    if (accion === 'mover' && evento.eventoId) {
      await pedir(`${base}/${evento.eventoId}`, access, 'PATCH', body);
      return evento.eventoId;
    }
    const creado = (await pedir(base, access, 'POST', body)) as { id?: string };
    if (!creado.id) throw new Error('Google Calendar no devolvió el evento');
    return creado.id;
  }
}

async function accessDe(cfg: Config, refreshToken: string): Promise<string> {
  const res = await fetch(TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: cfg.GOOGLE_CLIENT_ID,
      client_secret: cfg.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Google ${res.status}`);
  const json = (await res.json()) as { access_token?: string };
  if (!json.access_token) throw new Error('Google no devolvió access token');
  return json.access_token;
}

async function pedir(url: string, access: string, method: string, body?: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (method === 'DELETE') {
    if (!res.ok && res.status !== 404) throw new Error(`Calendar ${res.status}`);
    return null;
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`Calendar ${res.status}: ${text.slice(0, 300)}`);
  return text ? (JSON.parse(text) as unknown) : {};
}

export async function prepararCalendario(deps: Deps, tenantId: string): Promise<{ url: string }> {
  if (!deps.config.GOOGLE_CLIENT_ID || !deps.config.GOOGLE_CLIENT_SECRET) {
    throw new HttpError(503, 'Google Calendar no está configurado');
  }
  const tenant = await getTenant(deps.prisma, tenantId);
  if (!tenant.modulos.includes('turnos')) throw new HttpError(409, 'Tu plan no incluye agenda');
  const state = randomToken(24);
  await deps.redis.set(keys.calendarioState(state), tenantId, 'EX', 600);
  return { url: urlCalendario(deps.config, state) };
}

export async function completarCalendario(deps: Deps, tenantId: string, raw: unknown) {
  const body = raw as { code?: unknown; state?: unknown };
  if (typeof body?.code !== 'string' || typeof body.state !== 'string' || !body.code || !body.state) {
    throw new HttpError(400, 'Faltan datos de Google');
  }
  const guardado = await deps.redis.get(keys.calendarioState(body.state));
  if (guardado !== tenantId) throw new HttpError(400, 'La conexión con Google venció. Probá de nuevo.');
  await deps.redis.del(keys.calendarioState(body.state));
  const token = await canjearCodigo(deps.config, body.code);
  if (!token.refresh_token) throw new HttpError(400, 'Google no dio permiso para actualizar el calendario. Volvé a conectar y aceptá el acceso.');
  await deps.prisma.calendario.upsert({
    where: { tenantId },
    create: { tenantId, refreshEnc: encrypt(token.refresh_token, deps.config.ENCRYPTION_KEY), email: token.email },
    update: { refreshEnc: encrypt(token.refresh_token, deps.config.ENCRYPTION_KEY), email: token.email },
  });
  return getTenant(deps.prisma, tenantId);
}

export async function desconectarCalendario(deps: Deps, tenantId: string) {
  await deps.prisma.calendario.deleteMany({ where: { tenantId } });
  return getTenant(deps.prisma, tenantId);
}

async function canjearCodigo(cfg: Config, code: string): Promise<{ refresh_token?: string; email: string | null }> {
  const res = await fetch(TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: cfg.GOOGLE_CLIENT_ID,
      client_secret: cfg.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectCalendario(cfg),
      grant_type: 'authorization_code',
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new HttpError(401, 'Google no aceptó la conexión del calendario');
  const json = (await res.json()) as { refresh_token?: string; access_token?: string };
  let email: string | null = null;
  if (json.access_token) {
    const info = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { Authorization: `Bearer ${json.access_token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (info.ok) email = ((await info.json()) as { email?: string }).email ?? null;
  }
  return { refresh_token: json.refresh_token, email };
}

/** Crea, mueve o borra el evento. Un fallo del calendario no deshace el turno en Orbita. */
export async function volcarTurno(
  deps: Deps,
  tenant: TenantFull,
  turno: Pick<Turno, 'id' | 'nombre' | 'fecha' | 'eventoExternoId'>,
  accion: 'crear' | 'mover' | 'cancelar',
): Promise<void> {
  const cal = tenant.calendario;
  if (!cal) return;
  try {
    const refresh = decrypt(cal.refreshEnc, deps.config.ENCRYPTION_KEY);
    const eventoId = await deps.agenda.aplicar(
      refresh,
      accion === 'mover' && !turno.eventoExternoId ? 'crear' : accion,
      {
        eventoId: turno.eventoExternoId,
        titulo: `Turno de ${turno.nombre}`,
        inicio: turno.fecha,
        fin: new Date(turno.fecha.getTime() + DURACION_MS),
        zona: tenant.timezone,
      },
    );
    const siguiente = accion === 'cancelar' ? null : eventoId;
    if (siguiente !== turno.eventoExternoId) {
      await deps.prisma.turno.update({ where: { id: turno.id }, data: { eventoExternoId: siguiente } });
    }
  } catch (err) {
    console.error(`calendario ${turno.id}`, err instanceof Error ? err.message : err);
  }
}
