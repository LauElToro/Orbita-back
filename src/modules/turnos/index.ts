import { localParts, localToUtc, fmt } from '../../lib/dates';
import type { Modulo } from '../types';
import { volcarTurno } from './calendario';

const RE_RESERVAR = /\[TURNO_RESERVAR\s+(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})\]/gi;
const RE_MOVER = /\[TURNO_REPROGRAMAR\s+([a-z0-9]+)\s+(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})\]/gi;
const RE_CANCELAR = /\[TURNO_CANCELAR\s+([a-z0-9]+)\]/gi;

export interface EtiquetasTurno {
  reservas: string[];
  reprogramaciones: { id: string; cuando: string }[];
  cancelaciones: string[];
  limpio: string;
}

export function parsearEtiquetas(texto: string): EtiquetasTurno {
  const reservas = [...texto.matchAll(RE_RESERVAR)].map((m) => m[1].replace(/\s+/, ' '));
  const reprogramaciones = [...texto.matchAll(RE_MOVER)].map((m) => ({ id: m[1], cuando: m[2].replace(/\s+/, ' ') }));
  const cancelaciones = [...texto.matchAll(RE_CANCELAR)].map((m) => m[1]);
  const limpio = texto
    .replace(RE_RESERVAR, '')
    .replace(RE_MOVER, '')
    .replace(RE_CANCELAR, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return { reservas, reprogramaciones, cancelaciones, limpio };
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
      'Podés sacar, consultar, reprogramar y cancelar turnos según los horarios del negocio.',
      'Para reservar, confirmá día y hora con la persona y agregá al final la etiqueta [TURNO_RESERVAR AAAA-MM-DD HH:mm].',
      'Para mover un turno, agregá [TURNO_REPROGRAMAR id AAAA-MM-DD HH:mm].',
      'Para cancelar, agregá [TURNO_CANCELAR id]. Las etiquetas no se muestran al cliente.',
      'Turnos próximos de esta persona:',
      lista,
    ].join('\n');
  },
  async procesar(ctx, salida) {
    const { reservas, reprogramaciones, cancelaciones, limpio } = parsearEtiquetas(salida.texto);
    if (!reservas.length && !reprogramaciones.length && !cancelaciones.length) return salida;
    const { prisma } = ctx.deps;
    let texto = limpio;
    const activos = { in: ['reservado', 'confirmado'] as ('reservado' | 'confirmado')[] };

    for (const id of cancelaciones) {
      const turno = await prisma.turno.findFirst({ where: { id, tenantId: ctx.tenant.id, subscriberId: ctx.subscriberId } });
      if (!turno) continue;
      await prisma.turno.update({ where: { id: turno.id }, data: { estado: 'cancelado' } });
      await volcarTurno(ctx.deps, ctx.tenant, turno, 'cancelar');
    }

    for (const mov of reprogramaciones) {
      const fecha = localToUtc(mov.cuando, ctx.tenant.timezone);
      if (!fecha || fecha <= ctx.deps.now()) {
        texto = 'No pude mover ese turno. ¿Me indica otro día y otro horario?';
        continue;
      }
      const ocupado = await prisma.turno.findFirst({
        where: { tenantId: ctx.tenant.id, fecha, estado: activos, NOT: { id: mov.id } },
      });
      if (ocupado) {
        texto = 'Ese horario ya está ocupado. ¿Prefiere otro?';
        continue;
      }
      const actual = await prisma.turno.findFirst({
        where: { id: mov.id, tenantId: ctx.tenant.id, subscriberId: ctx.subscriberId, estado: activos },
      });
      if (!actual) continue;
      const turno = await prisma.turno.update({
        where: { id: actual.id },
        data: { fecha, recordatorioEnviado: false },
      });
      await volcarTurno(ctx.deps, ctx.tenant, turno, 'mover');
    }

    for (const cuando of reservas) {
      const fecha = localToUtc(cuando, ctx.tenant.timezone);
      if (!fecha || fecha <= ctx.deps.now()) {
        texto = 'No pude agendar ese horario. ¿Me indica otro día y otro horario?';
        continue;
      }
      const ocupado = await prisma.turno.findFirst({
        where: { tenantId: ctx.tenant.id, fecha, estado: activos },
      });
      if (ocupado) {
        texto = 'Ese horario ya está ocupado. ¿Prefiere otro?';
        continue;
      }
      const turno = await prisma.turno.create({
        data: {
          tenantId: ctx.tenant.id,
          subscriberId: ctx.subscriberId,
          nombre: ctx.nombre || 'Sin nombre',
          fecha,
        },
      });
      await volcarTurno(ctx.deps, ctx.tenant, turno, 'crear');
    }
    return { ...salida, texto };
  },
};
