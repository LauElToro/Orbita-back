import type { Deps } from '../../deps';
import { addDays, fmt, localParts } from '../../lib/dates';
import { destinoDe } from '../../messaging/destino';
import { leerMensajes } from '../../tenants/defaults';
import type { Modulo } from '../types';

export function esConfirmacion(texto: string): boolean {
  return /^\s*(si|sí|confirmo|dale|ok)(?=$|[\s,.!])/i.test(texto);
}

export function textoRecordatorio(plantilla: string, hora: string): string {
  return plantilla.replace(/\{\{\s*hora\s*\}\}/g, hora);
}

export const recordatorios: Modulo = {
  id: 'recordatorios',
  instrucciones: () =>
    'Si la persona confirma un turno que se le recordó, agradecé y confirmá. El sistema marca la confirmación.',
  async procesar(ctx, salida) {
    if (!esConfirmacion(ctx.textoUsuario)) return salida;
    await ctx.deps.prisma.turno.updateMany({
      where: {
        tenantId: ctx.tenant.id,
        subscriberId: ctx.subscriberId,
        estado: 'reservado',
        recordatorioEnviado: true,
        fecha: { gte: ctx.deps.now() },
      },
      data: { estado: 'confirmado' },
    });
    return salida;
  },
};

/**
 * Envía el aviso del día anterior a los turnos de mañana (en la zona horaria de cada ficha),
 * por el canal de la última charla de esa persona.
 */
export async function enviarRecordatorios(deps: Deps): Promise<number> {
  const now = deps.now();
  const tenants = await deps.prisma.tenant.findMany({
    where: { estado: 'activo', modulos: { has: 'recordatorios' } },
    include: { canales: true },
  });
  let enviados = 0;
  for (const tenant of tenants) {
    const manana = localParts(addDays(now, 1), tenant.timezone);
    const clave = fmt(manana.y, manana.m, manana.d);
    const candidatos = await deps.prisma.turno.findMany({
      where: {
        tenantId: tenant.id,
        estado: 'reservado',
        recordatorioEnviado: false,
        fecha: { gte: now, lte: addDays(now, 2) },
      },
    });
    const mensajes = leerMensajes(tenant.mensajes);
    for (const turno of candidatos) {
      const l = localParts(turno.fecha, tenant.timezone);
      if (fmt(l.y, l.m, l.d) !== clave) continue;
      const hora = `${String(l.hh).padStart(2, '0')}:${String(l.mm).padStart(2, '0')}`;
      const conv = await deps.prisma.conversation.findUnique({
        where: { tenantId_subscriberId: { tenantId: tenant.id, subscriberId: turno.subscriberId } },
      });
      const destino = destinoDe(deps, tenant, conv);
      if (!destino) continue;
      try {
        await deps.mensajeria.enviar(destino, textoRecordatorio(mensajes.recordatorio, hora));
        await deps.prisma.turno.update({ where: { id: turno.id }, data: { recordatorioEnviado: true } });
        enviados++;
      } catch (err) {
        console.error(`recordatorio ${turno.id} falló`, err);
      }
    }
  }
  return enviados;
}
