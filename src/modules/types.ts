import type { Deps } from '../deps';
import type { TenantFull } from '../tenants/repo';

export interface ModuloCtx {
  deps: Deps;
  tenant: TenantFull;
  subscriberId: string;
  nombre: string;
  textoUsuario: string;
}

export interface ResultadoModulo {
  texto: string;
  handoff?: boolean;
}

export interface Modulo {
  id: string;
  instrucciones(ctx: ModuloCtx): Promise<string> | string;
  /** Post-procesa la salida del modelo (etiquetas, acciones). Corre en el orden de `modulos`. */
  procesar?(ctx: ModuloCtx, salida: ResultadoModulo): Promise<ResultadoModulo>;
}
