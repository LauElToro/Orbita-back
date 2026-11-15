import { localParts, localToUtc, fmt } from '../../lib/dates';
import type { Modulo } from '../types';

const RE_RESERVAR = /\[TURNO_RESERVAR\s+(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})\]/gi;
const RE_CANCELAR = /\[TURNO_CANCELAR\s+([a-z0-9]+)\]/gi;

export interface EtiquetasTurno {
  reservas: string[];
  cancelaciones: string[];
  limpio: string;
}

export function parsearEtiquetas(texto: string): EtiquetasTurno {
  const reservas = [...texto.matchAll(RE_RESERVAR)].map((m) => m[1].replace(/\s+/, ' '));
  const cancelaciones = [...texto.matchAll(RE_CANCELAR)].map((m) => m[1]);
  const limpio = texto.replace(RE_RESERVAR, '').replace(RE_CANCELAR, '').replace(/\s{2,}/g, ' ').trim();
  return { reservas, cancelaciones, limpio };
}

export function formatearTurno(fecha: Date, timezone: string): string {
  const l = localParts(fecha, timezone);
  return `${fmt(l.y, l.m, l.d)} ${String(l.hh).padStart(2, '0')}:${String(l.mm).padStart(2, '0')}`;
}

export const turnos: Modulo = {
  id: 'turnos',
  async instrucciones(ctx) {
    const proximos = await ctx.deps.prisma.turno.findMany({
      where: {
        tenantId: ctx.tenant.id,
        subscriberId: ctx.subscriberId,
        estado: { in: ['reservado', 'confirmado'] },
        fecha: { gte: ctx.deps.now() },
      },
      orderBy: { fecha: 'asc' },
      take: 5,
    });
    const lista = proximos.length
      ? proximos.map((t) => `- id ${t.id}: ${formatearTurno(t.fecha, ctx.tenant.timezone)} (${t.estado})`).join('\n')
      : '- ninguno';
    return [
      'Podés sacar, consultar y cancelar turnos según los horarios del negocio.',
      'Para reservar, confirmá día y hora con la persona y agregá al final la etiqueta [TURNO_RESERVAR AAAA-MM-DD HH:mm].',
      'Para cancelar, agregá [TURNO_CANCELAR id]. Las etiquetas no se muestran al cliente.',
      'Turnos próximos de esta persona:',
      lista,
    ].join('\n');
  },
  async procesar(ctx, salida) {
    const { reservas, cancelaciones, limpio } = parsearEtiquetas(salida.texto);
    if (!reservas.length && !cancelaciones.length) return salida;
    const { prisma } = ctx.deps;
    let texto = limpio;

    for (const id of cancelaciones) {
      await prisma.turno.updateMany({
        where: { id, tenantId: ctx.tenant.id, subscriberId: ctx.subscriberId },
        data: { estado: 'cancelado' },
      });
    }

    for (const cuando of reservas) {
      const fecha = localToUtc(cuando, ctx.tenant.timezone);
      if (!fecha || fecha <= ctx.deps.now()) {
        texto = 'No pude agendar ese horario. ¿Me pasás otro día y hora?';
        continue;
      }
      const ocupado = await prisma.turno.findFirst({
        where: { tenantId: ctx.tenant.id, fecha, estado: { in: ['reservado', 'confirmado'] } },
      });
      if (ocupado) {
        texto = 'Ese horario ya está tomado. ¿Te sirve otro?';
        continue;
      }
      await prisma.turno.create({
        data: {
          tenantId: ctx.tenant.id,
          subscriberId: ctx.subscriberId,
          nombre: ctx.nombre || 'Sin nombre',
          fecha,
        },
      });
    }
    return { ...salida, texto };
  },
};
