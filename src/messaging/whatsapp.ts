import { randomInt } from 'node:crypto';
import type { VerificacionWhatsapp } from '@prisma/client';
import { z } from 'zod';
import type { Deps } from '../deps';
import { decrypt, encrypt } from '../lib/crypto';
import { badRequest, HttpError } from '../lib/errors';
import { rebuildIndex, getTenant } from '../tenants/repo';
import type { NumeroWhatsapp } from './meta';

const conectarSchema = z.object({
  code: z.string().trim().min(4),
  phoneNumberId: z.string().trim().min(4),
  wabaId: z.string().trim().min(4),
});

export function metaListo(deps: Deps): boolean {
  return Boolean(deps.config.META_APP_ID && deps.config.META_EMBEDDED_CONFIG_ID && deps.config.META_APP_SECRET);
}

/** Lo que ve el comercio: Meta revisa el número; Orbita no le pide un token. */
export function verificacionDe(n: NumeroWhatsapp): { estado: VerificacionWhatsapp; detalle: string } {
  const code = n.code_verification_status;
  const name = n.name_status;
  const status = n.status;
  const numero = n.display_phone_number;
  if (code === 'EXPIRED' || name === 'DECLINED' || name === 'EXPIRED') {
    return { estado: 'rechazado', detalle: 'Meta rechazó la verificación del número' };
  }
  const nombreOk = !name || name === 'APPROVED' || name === 'AVAILABLE_WITHOUT_REVIEW';
  if (code === 'VERIFIED' && nombreOk && (!status || status === 'CONNECTED')) {
    return { estado: 'verificado', detalle: numero ? `Número verificado ${numero}` : 'Número verificado' };
  }
  if (name === 'PENDING_REVIEW' || status === 'PENDING') {
    return { estado: 'en_revision', detalle: 'Meta está revisando el número' };
  }
  if (code === 'NOT_VERIFIED') return { estado: 'pendiente', detalle: 'Falta verificar el número' };
  return { estado: 'pendiente', detalle: 'Conectado, esperando la verificación de Meta' };
}

function pinAleatorio(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

/**
 * Embedded Signup: el comercio aprueba en el popup de Meta.
 * Orbita canjea el código, suscribe el webhook de la app a esa cuenta y guarda el token.
 */
export async function conectarWhatsapp(deps: Deps, tenantId: string, raw: unknown) {
  if (!metaListo(deps)) throw new HttpError(503, 'La conexión con Meta no está configurada');
  const input = conectarSchema.parse(raw);
  const tenant = await getTenant(deps.prisma, tenantId);
  const token = await deps.meta.intercambiarCodigo(input.code);
  await deps.meta.suscribirApp(input.wabaId, token);
  let numero = await deps.meta.leerNumero(input.phoneNumberId, token);
  if (numero.status && numero.status !== 'CONNECTED') {
    try {
      await deps.meta.registrarNumero(input.phoneNumberId, token, pinAleatorio());
      numero = await deps.meta.leerNumero(input.phoneNumberId, token);
    } catch (err) {
      console.error('no se pudo registrar el número de WhatsApp', err instanceof Error ? err.message : err);
    }
  }
  const ver = verificacionDe(numero);
  const ya = tenant.canales.find((c) => c.tipo === 'whatsapp');
  if (!ya && tenant.canales.length >= tenant.plan.maxCanales) {
    throw badRequest(`El plan ${tenant.plan.nombre} admite hasta ${tenant.plan.maxCanales} canal(es)`);
  }
  const data = {
    tenantId,
    tipo: 'whatsapp' as const,
    endpointId: input.phoneNumberId,
    etiqueta: numero.display_phone_number || numero.verified_name || 'WhatsApp',
    tokenEnc: encrypt(token, deps.config.ENCRYPTION_KEY),
    wabaId: input.wabaId,
    verificacion: ver.estado,
    verificacionDetalle: ver.detalle,
    displayPhone: numero.display_phone_number ?? null,
  };
  await deps.prisma.$transaction(async (tx) => {
    if (ya) await tx.channel.delete({ where: { id: ya.id } });
    await tx.channel.create({ data });
  });
  await rebuildIndex(deps.prisma, deps.redis);
  return getTenant(deps.prisma, tenantId);
}

/** Vuelve a leer el estado del número en Meta y lo muestra en el panel. */
export async function refrescarWhatsapp(deps: Deps, tenantId: string) {
  const tenant = await getTenant(deps.prisma, tenantId);
  const canal = tenant.canales.find((c) => c.tipo === 'whatsapp' && c.tokenEnc);
  if (!canal?.tokenEnc) throw new HttpError(404, 'Todavía no hay un WhatsApp conectado');
  const token = decrypt(canal.tokenEnc, deps.config.ENCRYPTION_KEY);
  const numero = await deps.meta.leerNumero(canal.endpointId, token);
  const ver = verificacionDe(numero);
  await deps.prisma.channel.update({
    where: { id: canal.id },
    data: {
      verificacion: ver.estado,
      verificacionDetalle: ver.detalle,
      displayPhone: numero.display_phone_number ?? canal.displayPhone,
      etiqueta: numero.display_phone_number || canal.etiqueta,
    },
  });
  return getTenant(deps.prisma, tenantId);
}
