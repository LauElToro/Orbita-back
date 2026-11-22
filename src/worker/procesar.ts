import type { Prisma } from '@prisma/client';
import type { Deps } from '../deps';
import { responderDesdeDatos } from '../ai/charla';
import { armarContexto } from '../ai/contexto';
import { perfilSchema } from '../ai/perfil';
import { agregarAlHistorial, leerHistorial, limpiarFormato } from '../ai/prompt';
import { avisarSiLlegoAlLimite } from '../correo/campanas';
import { avisoOrbita, enviarCorreo } from '../correo/correo';
import { addHours } from '../lib/dates';
import { keys } from '../lib/keys';
import { acquireLock } from '../lib/lock';
import { destinoDe } from '../messaging/destino';
import type { JobGeneracion } from '../messaging/entrada';
import { modulosActivos } from '../modules';
import type { ModuloCtx, ResultadoModulo } from '../modules/types';
import { leerMensajes } from '../tenants/defaults';
import { getTenant, type TenantFull } from '../tenants/repo';
import { contarRespuestaSaliente } from '../messaging/ventanas';
import { alcanzoTope, leerUso, registrarExtra, sumarUso, topesDe } from '../usage/usage';

export interface Resultado {
  estado: 'enviado' | 'ignorado' | 'sin_canal' | 'error_envio';
  texto: string;
  handoff: boolean;
}

/** Lo mínimo para responder un mensaje, venga del worker o del endpoint web. */
export interface Consulta {
  messageId: string;
  subscriberId: string;
  texto: string;
  nombre: string;
}

export interface Respuesta {
  texto: string;
  handoff: boolean;
  tope: boolean;
  imagen?: string;
}

async function generar(deps: Deps, ctx: ModuloCtx, intentos = 2): Promise<ResultadoModulo> {
  const conversacion = await deps.prisma.conversation.findUnique({
    where: { tenantId_subscriberId: { tenantId: ctx.tenant.id, subscriberId: ctx.subscriberId } },
  });
  const historial = leerHistorial(conversacion?.historial);
  const perfil = perfilSchema.safeParse(ctx.tenant.perfil);
  if (perfil.success && perfil.data.catalogo.length > 0) {
    const directo = responderDesdeDatos({
      nombreNegocio: ctx.tenant.nombre,
      perfil: perfil.data,
      modulos: ctx.tenant.modulos,
      nombreCliente: ctx.nombre,
      texto: ctx.textoUsuario,
      historial,
      textoHandoff: leerMensajes(ctx.tenant.mensajes).handoff,
      ahora: ctx.deps.now(),
      timezone: ctx.tenant.timezone,
    });
    if (directo) {
      let salida: ResultadoModulo = { texto: directo.texto, handoff: directo.handoff, imagen: directo.imagen, herramientas: directo.herramientas };
      for (const m of modulosActivos(ctx.tenant.modulos)) if (m.procesar) salida = await m.procesar(ctx, salida);
      return { ...salida, texto: limpiarFormato(salida.texto) };
    }
  }
  const { modulos, mensajes, modelo } = await armarContexto(deps, ctx, historial);
  let ultimoError: unknown;
  for (let i = 0; i < intentos; i++) {
    try {
      let salida: ResultadoModulo = { texto: await deps.ai.chat(modelo, mensajes) };
      for (const m of modulos) if (m.procesar) salida = await m.procesar(ctx, salida);
      return { ...salida, texto: limpiarFormato(salida.texto) };
    } catch (err) {
      ultimoError = err;
    }
  }
  throw ultimoError;
}

async function guardarHistorial(
  deps: Deps,
  tenantId: string,
  subscriberId: string,
  usuario: string,
  bot: string,
  herramientas?: { nombre: string; imagen: string }[],
) {
  const where = { tenantId_subscriberId: { tenantId, subscriberId } };
  const previa = await deps.prisma.conversation.findUnique({ where });
  const at = deps.now().toISOString();
  const historial = agregarAlHistorial(
    leerHistorial(previa?.historial),
    { rol: 'user', texto: usuario, at },
    { rol: 'assistant', texto: bot, at, ...(herramientas?.length ? { herramientas } : {}) },
  ) as unknown as Prisma.InputJsonValue;
  await deps.prisma.conversation.upsert({
    where,
    create: { tenantId, subscriberId, historial },
    update: { historial },
  });
}

/** Tope, IA, módulos, uso e historial. No envía nada ni decide qué hacer con la derivación. */
export async function responderConsulta(deps: Deps, tenant: TenantFull, consulta: Consulta): Promise<Respuesta> {
  const fijos = leerMensajes(tenant.mensajes);
  const extra = alcanzoTope(await leerUso(deps, tenant), topesDe(tenant));
  const ctx: ModuloCtx = { deps, tenant, subscriberId: consulta.subscriberId, nombre: consulta.nombre, textoUsuario: consulta.texto };
  try {
    const salida = await generar(deps, ctx);
    await sumarUso(deps, tenant);
    if (extra) await registrarExtra(deps, tenant);
    void avisarSiLlegoAlLimite(deps, tenant);
    await guardarHistorial(deps, tenant.id, consulta.subscriberId, consulta.texto, salida.texto, salida.herramientas);
    return { texto: salida.texto, handoff: Boolean(salida.handoff), tope: extra, imagen: salida.imagen };
  } catch (err) {
    console.error(`generación ${consulta.messageId} falló`, err);
    return { texto: fijos.handoff, handoff: true, tope: false };
  }
}

/** Serializa las respuestas de una ficha: uso, turnos e historial no se pisan entre mensajes simultáneos. */
export async function conLockDeFicha<T>(deps: Deps, tenantId: string, fn: () => Promise<T>): Promise<T> {
  const soltar = await acquireLock(deps.redis, keys.lock(tenantId));
  try {
    return await fn();
  } finally {
    await soltar();
  }
}

/** Mail al comercio para que tome la charla. */
export async function avisarDerivacion(deps: Deps, tenant: TenantFull, canal: string, nombre: string, texto: string, extra: string) {
  if (!tenant.emailContacto) return;
  const quien = nombre || 'Una persona';
  await enviarCorreo(
    deps.correo,
    avisoOrbita(
      tenant.emailContacto,
      `${quien} quiere hablar con alguien de ${tenant.nombre}`,
      `${quien} escribió por ${canal} y pidió atención de una persona.`,
      `Último mensaje: "${texto.slice(0, 300)}". ${extra}`,
    ),
  );
}

const CANAL_NOMBRE = { whatsapp: 'WhatsApp', instagram: 'Instagram', tiktok: 'TikTok' } as const;

/** La IA deja de contestar esa charla por unas horas y el comercio recibe un mail para tomarla. */
async function derivar(deps: Deps, tenant: TenantFull, job: JobGeneracion) {
  await deps.prisma.conversation.update({
    where: { tenantId_subscriberId: { tenantId: tenant.id, subscriberId: job.subscriberId } },
    data: { handoffHasta: addHours(deps.now(), deps.config.HANDOFF_HORAS) },
  });
  await avisarDerivacion(
    deps,
    tenant,
    CANAL_NOMBRE[job.canal],
    job.nombre,
    job.texto,
    `La IA no le va a contestar durante ${deps.config.HANDOFF_HORAS} horas para que lo atiendas vos.`,
  );
}

/** Genera la respuesta del mensaje encolado y la manda por el mismo canal por el que llegó. */
export async function procesarMensaje(deps: Deps, job: JobGeneracion): Promise<Resultado> {
  return conLockDeFicha(deps, job.tenantId, async () => {
    const tenant = await getTenant(deps.prisma, job.tenantId);
    if (tenant.estado === 'pausado') return { estado: 'ignorado', texto: '', handoff: false };

    const { texto, handoff, imagen } = await responderConsulta(deps, tenant, job);
    if (handoff) await derivar(deps, tenant, job);

    const conv = await deps.prisma.conversation.findUnique({
      where: { tenantId_subscriberId: { tenantId: tenant.id, subscriberId: job.subscriberId } },
    });
    const destino = destinoDe(deps, tenant, conv);
    if (!destino) {
      console.error(`mensaje ${job.messageId}: el canal no tiene token cargado`);
      return { estado: 'sin_canal', texto, handoff };
    }
    try {
      await deps.mensajeria.enviar(destino, texto, imagen);
    } catch (err) {
      console.error(`envío ${job.messageId} por ${destino.canal} falló`, err instanceof Error ? err.message : err);
      return { estado: 'error_envio', texto, handoff };
    }
    await contarRespuestaSaliente(deps, tenant.id, job.subscriberId, destino.canal);
    return { estado: 'enviado', texto, handoff };
  });
}
