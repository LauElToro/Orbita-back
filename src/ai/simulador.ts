import { z } from 'zod';
import type { Deps } from '../deps';
import { pideHandoff } from '../modules/handoff';
import { parsearEtiquetas } from '../modules/turnos';
import { leerMensajes } from '../tenants/defaults';
import type { TenantFull } from '../tenants/repo';
import { responderDesdeDatos } from './charla';
import { armarContexto } from './contexto';
import { perfilSchema } from './perfil';
import { limpiarFormato } from './prompt';

export const simulacionSchema = z.object({
  texto: z.string().trim().min(1).max(1000),
  historial: z
    .array(z.object({ rol: z.enum(['user', 'assistant']), texto: z.string().max(4000) }))
    .max(20)
    .default([]),
});

export interface ResultadoSimulacion {
  texto: string;
  handoff: boolean;
  acciones: string[];
  imagen?: string;
}

/**
 * Prueba la IA con el prompt y los módulos de la ficha sin efectos: no reserva turnos,
 * no suma uso y no guarda historial. Las acciones que haría se devuelven como texto.
 */
export async function simular(deps: Deps, tenant: TenantFull, raw: unknown): Promise<ResultadoSimulacion> {
  const { texto, historial } = simulacionSchema.parse(raw);
  const perfil = perfilSchema.safeParse(tenant.perfil);
  if (perfil.success && perfil.data.catalogo.length > 0) {
    const directo = responderDesdeDatos({
      nombreNegocio: tenant.nombre,
      perfil: perfil.data,
      modulos: tenant.modulos,
      nombreCliente: '',
      texto,
      historial,
      textoHandoff: leerMensajes(tenant.mensajes).handoff,
      ahora: deps.now(),
      timezone: tenant.timezone,
    });
    if (directo) {
      if (directo.handoff) {
        return {
          texto: directo.texto,
          handoff: true,
          acciones: ['Derivaría la conversación a una persona del local'],
          ...(directo.imagen ? { imagen: directo.imagen } : {}),
        };
      }
      const etiquetas = parsearEtiquetas(directo.texto);
      const acciones = tenant.modulos.includes('turnos')
        ? [...etiquetas.reservas.map((r) => `Reservaría un turno el ${r}`), ...etiquetas.cancelaciones.map((c) => `Cancelaría el turno ${c}`)]
        : [];
      return { texto: limpiarFormato(etiquetas.limpio), handoff: false, acciones, ...(directo.imagen ? { imagen: directo.imagen } : {}) };
    }
  }
  const { mensajes, modelo } = await armarContexto(
    deps,
    { deps, tenant, subscriberId: '__simulador__', nombre: '', textoUsuario: texto },
    historial.map((h) => ({ ...h, at: '' })),
  );
  const salida = await deps.ai.chat(modelo, mensajes);

  if (tenant.modulos.includes('handoff') && pideHandoff(salida)) {
    return {
      texto: leerMensajes(tenant.mensajes).handoff,
      handoff: true,
      acciones: ['Derivaría la conversación a una persona del local'],
    };
  }
  const { reservas, cancelaciones, limpio } = parsearEtiquetas(salida);
  const acciones = tenant.modulos.includes('turnos')
    ? [...reservas.map((r) => `Reservaría un turno el ${r}`), ...cancelaciones.map((c) => `Cancelaría el turno ${c}`)]
    : [];
  return { texto: limpiarFormato(limpio), handoff: false, acciones };
}
