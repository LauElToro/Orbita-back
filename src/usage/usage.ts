import type { Deps } from '../deps';
import { periodos, type Periodos } from '../lib/dates';
import { keys } from '../lib/keys';
import { diaAbonoDe, type TenantFull } from '../tenants/repo';

export interface Topes {
  dia: number;
  semana: number;
  mes: number;
}

export interface UsoActual {
  dia: number;
  semana: number;
  mes: number;
  periodos: Periodos;
}

const TTL_USO = 40 * 86_400;

export function topesDe(tenant: Pick<TenantFull, 'topeDia' | 'topeSemana' | 'topeMes'>): Topes {
  return { dia: tenant.topeDia, semana: tenant.topeSemana, mes: tenant.topeMes };
}

export function alcanzoTope(uso: Pick<UsoActual, 'dia' | 'semana' | 'mes'>, topes: Topes): boolean {
  return uso.dia >= topes.dia || uso.semana >= topes.semana || uso.mes >= topes.mes;
}

function periodosDe(deps: Deps, tenant: TenantFull): Periodos {
  return periodos(deps.now(), tenant.timezone, diaAbonoDe(tenant));
}

/** Lee de Redis; si la clave no existe la siembra desde Postgres. */
async function leerPeriodo(deps: Deps, tenantId: string, periodo: string): Promise<number> {
  const key = keys.uso(tenantId, periodo);
  const cached = await deps.redis.get(key);
  if (cached !== null) return Number(cached);
  const row = await deps.prisma.usage.findUnique({ where: { tenantId_periodo: { tenantId, periodo } } });
  const count = row?.count ?? 0;
  await deps.redis.set(key, count, 'EX', TTL_USO, 'NX');
  return Number((await deps.redis.get(key)) ?? count);
}

export async function leerUso(deps: Deps, tenant: TenantFull): Promise<UsoActual> {
  const p = periodosDe(deps, tenant);
  const [dia, semana, mes] = await Promise.all(
    [p.dia, p.semana, p.mes].map((periodo) => leerPeriodo(deps, tenant.id, periodo)),
  );
  return { dia, semana, mes, periodos: p };
}

/** Suma una respuesta del bot a los tres contadores: atómico en Redis y persistido en Postgres. */
export async function sumarUso(deps: Deps, tenant: TenantFull): Promise<void> {
  const p = periodosDe(deps, tenant);
  const lista = [p.dia, p.semana, p.mes];
  await Promise.all(lista.map((periodo) => leerPeriodo(deps, tenant.id, periodo)));
  const multi = deps.redis.multi();
  for (const periodo of lista) multi.incr(keys.uso(tenant.id, periodo));
  await multi.exec();
  await deps.prisma.$transaction(
    lista.map((periodo) =>
      deps.prisma.usage.upsert({
        where: { tenantId_periodo: { tenantId: tenant.id, periodo } },
        create: { tenantId: tenant.id, periodo, count: 1 },
        update: { count: { increment: 1 } },
      }),
    ),
  );
}
