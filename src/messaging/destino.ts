import type { Conversation } from '@prisma/client';
import type { Deps } from '../deps';
import { decrypt } from '../lib/crypto';
import type { TenantFull } from '../tenants/repo';
import type { Destino } from './canales';

/** Arma el destino con el canal por el que escribió la persona. `null` si el canal ya no existe o no tiene token. */
export function destinoDe(
  deps: Deps,
  tenant: Pick<TenantFull, 'canales'>,
  conv: Pick<Conversation, 'canal' | 'endpointId' | 'destino'> | null,
): Destino | null {
  if (!conv?.canal || conv.canal === 'telegram' || !conv.endpointId || !conv.destino) return null;
  const canal = tenant.canales.find((c) => c.endpointId === conv.endpointId && c.tipo === conv.canal);
  if (!canal?.tokenEnc) return null;
  return {
    canal: conv.canal,
    endpointId: conv.endpointId,
    destino: conv.destino,
    token: decrypt(canal.tokenEnc, deps.config.ENCRYPTION_KEY),
    apiBase: canal.apiBase,
  };
}
