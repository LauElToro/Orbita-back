import type { Config } from '../config';
import type { Deps } from '../deps';
import { describirAhora } from '../lib/dates';
import { modulosActivos } from '../modules';
import type { Modulo, ModuloCtx } from '../modules/types';
import type { TenantFull } from '../tenants/repo';
import type { ChatMessage } from './openrouter';
import { construirMensajes, type Intervencion } from './prompt';

export function modeloPara(tenant: Pick<TenantFull, 'modelo' | 'plan'>, config: Config): string {
  if (!tenant.plan.modeloCapaz) return config.MODELO_BARATO;
  if (tenant.modelo === 'capaz') return config.MODELO_CAPAZ;
  if (tenant.modelo.includes('/')) return tenant.modelo;
  return config.MODELO_BARATO;
}

export interface ContextoIA {
  modulos: Modulo[];
  mensajes: ChatMessage[];
  modelo: string;
}

/** Prompt del negocio + instrucciones de los módulos + historial: lo mismo para el bot real y el simulador. */
export async function armarContexto(deps: Deps, ctx: ModuloCtx, historial: Intervencion[]): Promise<ContextoIA> {
  const { tenant } = ctx;
  const modulos = modulosActivos(tenant.modulos);
  const instrucciones = await Promise.all(modulos.map((m) => m.instrucciones(ctx)));
  const mensajes = construirMensajes({
    nombreNegocio: tenant.nombre,
    promptNegocio: tenant.prompt,
    instruccionesModulos: instrucciones,
    ahora: describirAhora(deps.now(), tenant.timezone),
    nombreContacto: ctx.nombre,
    historial,
    texto: ctx.textoUsuario,
  });
  return { modulos, mensajes, modelo: modeloPara(tenant, deps.config) };
}
