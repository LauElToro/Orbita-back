import type { Prisma } from '@prisma/client';
import type { Deps } from '../deps';
import { armarContexto } from '../ai/contexto';
import { agregarAlHistorial, leerHistorial } from '../ai/prompt';
import { keys } from '../lib/keys';
import { acquireLock } from '../lib/lock';
import type { JobGeneracion } from '../messaging/entrada';
import { completarRespuesta, type Respuesta } from '../messaging/respuestas';
import type { ModuloCtx, ResultadoModulo } from '../modules/types';
import { leerMensajes } from '../tenants/defaults';
import { getTenant } from '../tenants/repo';
import { alcanzoTope, leerUso, sumarUso, topesDe } from '../usage/usage';

async function generar(deps: Deps, ctx: ModuloCtx, intentos = 2): Promise<ResultadoModulo> {
  const conversacion = await deps.prisma.conversation.findUnique({
    where: { tenantId_subscriberId: { tenantId: ctx.tenant.id, subscriberId: ctx.subscriberId } },
  });
  const { modulos, mensajes, modelo } = await armarContexto(deps, ctx, leerHistorial(conversacion?.historial));
  let ultimoError: unknown;
  for (let i = 0; i < intentos; i++) {
    try {
      let salida: ResultadoModulo = { texto: await deps.ai.chat(modelo, mensajes) };
      for (const m of modulos) if (m.procesar) salida = await m.procesar(ctx, salida);
      return salida;
    } catch (err) {
      ultimoError = err;
    }
  }
  throw ultimoError;
}

async function guardarHistorial(deps: Deps, tenantId: string, subscriberId: string, usuario: string, bot: string) {
  const where = { tenantId_subscriberId: { tenantId, subscriberId } };
  const previa = await deps.prisma.conversation.findUnique({ where });
  const at = deps.now().toISOString();
  const historial = agregarAlHistorial(
    leerHistorial(previa?.historial),
    { rol: 'user', texto: usuario, at },
    { rol: 'assistant', texto: bot, at },
  ) as unknown as Prisma.InputJsonValue;
  await deps.prisma.conversation.upsert({
    where,
    create: { tenantId, subscriberId, historial },
    update: { historial },
  });
}

/** Procesa un mensaje encolado por la entrada y deja la respuesta lista para la salida. */
export async function procesarMensaje(deps: Deps, job: JobGeneracion): Promise<Respuesta> {
  let soltar: () => Promise<void>;
  try {
    soltar = await acquireLock(deps.redis, keys.lock(job.tenantId));
  } catch (err) {
    const tenant = await deps.prisma.tenant.findUnique({ where: { id: job.tenantId } });
    const respuesta: Respuesta = {
      tenantId: job.tenantId,
      estado: 'listo',
      texto: leerMensajes(tenant?.mensajes).handoff,
      handoff: true,
    };
    await completarRespuesta(deps.redis, job.messageId, respuesta);
    throw err;
  }
  try {
    const tenant = await getTenant(deps.prisma, job.tenantId);
    const mensajesFijos = leerMensajes(tenant.mensajes);
    const base = { tenantId: tenant.id };

    let respuesta: Respuesta;
    if (tenant.estado === 'pausado') {
      respuesta = { ...base, estado: 'ignorado', texto: '', handoff: false };
    } else if (alcanzoTope(await leerUso(deps, tenant), topesDe(tenant))) {
      respuesta = { ...base, estado: 'listo', texto: mensajesFijos.tope, handoff: true };
    } else {
      const ctx: ModuloCtx = {
        deps,
        tenant,
        subscriberId: job.subscriberId,
        nombre: job.nombre,
        textoUsuario: job.texto,
      };
      try {
        const salida = await generar(deps, ctx);
        await sumarUso(deps, tenant);
        await guardarHistorial(deps, tenant.id, job.subscriberId, job.texto, salida.texto);
        respuesta = { ...base, estado: 'listo', texto: salida.texto, handoff: Boolean(salida.handoff) };
      } catch (err) {
        console.error(`generación ${job.messageId} falló`, err);
        respuesta = { ...base, estado: 'listo', texto: mensajesFijos.handoff, handoff: true };
      }
    }

    await completarRespuesta(deps.redis, job.messageId, respuesta);
    return respuesta;
  } finally {
    await soltar();
  }
}
