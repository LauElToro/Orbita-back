import { createHmac } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { Deps } from '../deps';
import { safeEqual } from '../lib/crypto';
import type { MensajeCorreo } from './correo';
import { mensajeSesion } from './plantillas';

export function tokenBaja(secret: string, userId: string): string {
  const mac = createHmac('sha256', secret).update(userId).digest('base64url');
  return `${userId}.${mac}`;
}

export function userIdDeBaja(secret: string, token: string): string | null {
  const corte = token.lastIndexOf('.');
  if (corte <= 0) return null;
  const userId = token.slice(0, corte);
  const mac = token.slice(corte + 1);
  const esperado = createHmac('sha256', secret).update(userId).digest('base64url');
  if (mac.length !== esperado.length || !safeEqual(mac, esperado)) return null;
  return userId;
}

export function urlBaja(deps: Deps, userId: string): string {
  return `${deps.config.PUBLIC_URL.replace(/\/$/, '')}/api/cuenta/avisos/baja?t=${encodeURIComponent(tokenBaja(deps.config.JWT_SECRET, userId))}`;
}

/** Manda el mail una sola vez por email, tipo y clave. Si es comercial, respeta la baja. */
export async function enviarUnaVez(
  deps: Deps,
  datos: { email: string; tenantId?: string; tipo: string; clave: string; mensaje: MensajeCorreo; comercial?: boolean },
): Promise<boolean> {
  try {
    if (datos.comercial) {
      const usuario = await deps.prisma.clientUser.findUnique({
        where: { email: datos.email },
        select: { avisosComerciales: true },
      });
      if (usuario && !usuario.avisosComerciales) return false;
    }
    await deps.prisma.correoEnviado.create({
      data: { email: datos.email, tenantId: datos.tenantId ?? null, tipo: datos.tipo, clave: datos.clave },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return false;
    console.error(`correo ${datos.tipo}: ${err instanceof Error ? err.message : 'no se pudo registrar'}`);
    return false;
  }
  try {
    await deps.correo.enviar(datos.mensaje);
  } catch (err) {
    await deps.prisma.correoEnviado.deleteMany({ where: { email: datos.email, tipo: datos.tipo, clave: datos.clave } });
    console.error(`correo ${datos.tipo}: ${err instanceof Error ? err.message : 'no se pudo enviar'}`);
    return false;
  }
  return true;
}

/** Un aviso por ingreso, como máximo cada 30 minutos, para no duplicar un doble click. */
export async function avisarSesion(
  deps: Deps,
  usuario: { id: string; tenantId: string; email: string; nombre: string },
  ip?: string,
): Promise<void> {
  try {
    const franja = Math.floor(deps.now().getTime() / (30 * 60_000));
    await enviarUnaVez(deps, {
      email: usuario.email,
      tenantId: usuario.tenantId,
      tipo: 'sesion',
      clave: String(franja),
      mensaje: mensajeSesion(usuario, deps.now(), ip && ip !== '127.0.0.1' ? ip : undefined, deps.config.PUBLIC_URL),
    });
  } catch (err) {
    console.error(`correo sesion: ${err instanceof Error ? err.message : 'no se pudo avisar'}`);
  }
}

export async function darDeBajaAvisos(deps: Deps, token: string): Promise<boolean> {
  const userId = userIdDeBaja(deps.config.JWT_SECRET, token);
  if (!userId) return false;
  const { count } = await deps.prisma.clientUser.updateMany({ where: { id: userId }, data: { avisosComerciales: false } });
  return count === 1;
}
