import type { CanalTipo, Conversation } from '@prisma/client';
import { z } from 'zod';
import type { Deps } from '../deps';
import { agregarAlHistorial, leerHistorial } from '../ai/prompt';
import { addHours } from '../lib/dates';
import { conflict, notFound } from '../lib/errors';
import { destinoDe } from './destino';
import type { Canal } from './canales';
import { getTenant } from '../tenants/repo';

export const VENTANA_IG_MS = 24 * 3_600_000;
export const VENTANA_WA_MS = 24 * 3_600_000;
export const AVISO_IG_MS = 4 * 3_600_000;
export const VENTANA_TT_MS = 48 * 3_600_000;
export const TOPE_TIKTOK = 10;
export const AVISO_TIKTOK = 8;

type VentanaPrevia = { ventanaDesde: Date | null; respuestasVentana: number } | null;

/** Al llegar un mensaje del cliente se abre (o se renueva) la ventana de esa plataforma. */
export function datosVentana(canal: Canal, previa: VentanaPrevia, ahora: Date) {
  if (canal === 'tiktok') {
    const abierta = Boolean(previa?.ventanaDesde && ahora.getTime() - previa.ventanaDesde.getTime() < VENTANA_TT_MS);
    return {
      ultimoClienteAt: ahora,
      ventanaDesde: abierta ? previa!.ventanaDesde : ahora,
      respuestasVentana: abierta ? previa!.respuestasVentana : 0,
    };
  }
  if (canal === 'instagram') return { ultimoClienteAt: ahora };
  return {};
}

const CANALES_BANDEJA = ['whatsapp', 'instagram', 'tiktok'] as const;
type CanalBandeja = (typeof CANALES_BANDEJA)[number];

export interface AvisoVentana {
  id: string;
  /** UUID público de la charla. */
  codigo: string;
  canal: CanalBandeja;
  nombre: string;
  /** Teléfono en WhatsApp, o el id de la persona en Instagram y TikTok. */
  numero: string;
  /** Aviso de la ventana, o vacío si la charla está tranquila. */
  texto: string;
  puedeResponder: boolean;
  ultimo: string;
  /** Textos de la charla, para buscar un mensaje que no sea el último. */
  corpus: string;
  at: string;
  pausada: boolean;
}

export interface MensajeCharla {
  rol: 'user' | 'assistant';
  texto: string;
  at: string;
  herramientas?: { nombre: string; imagen: string }[];
}

export interface Charla {
  id: string;
  codigo: string;
  canal: CanalBandeja;
  nombre: string;
  numero: string;
  aviso: string | null;
  puedeResponder: boolean;
  pausada: boolean;
  mensajes: MensajeCharla[];
}

/** El dato con el que se busca la charla: el teléfono en WhatsApp y el id de la persona en las otras redes. */
export function numeroDe(c: { canal: string | null; destino: string | null; subscriberId: string }): string {
  const crudo = (c.canal === 'whatsapp' ? c.destino || c.subscriberId : c.subscriberId).trim();
  const digitos = crudo.replace(/\D/g, '');
  if (digitos.length >= 8 && digitos.length === crudo.replace(/[+\s()-]/g, '').length) return `+${digitos}`;
  return crudo;
}

/** Nombre, último mensaje, número (aunque venga con +, espacios o guiones) o UUID. */
function plano(valor: string): string {
  return valor.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

export function coincideBusqueda(
  item: { nombre: string; ultimo: string; numero: string; codigo: string; id?: string; corpus?: string },
  q: string,
): boolean {
  const consulta = plano(q.trim());
  if (!consulta) return true;
  const bolsa = plano(`${item.nombre} ${item.ultimo} ${item.corpus ?? ''} ${item.numero} ${item.codigo} ${item.id ?? ''}`);
  if (bolsa.includes(consulta)) return true;
  const digitos = consulta.replace(/\D/g, '');
  return digitos.length >= 4 && item.numero.replace(/\D/g, '').includes(digitos);
}

function esBandeja(canal: CanalTipo | null): canal is CanalBandeja {
  return canal === 'whatsapp' || canal === 'instagram' || canal === 'tiktok';
}

function pausadaDe(hasta: Date | null, ahora: Date): boolean {
  return Boolean(hasta && hasta > ahora);
}

function ultimoDe(c: { historial?: unknown }): string {
  return leerHistorial(c.historial).at(-1)?.texto ?? '';
}

function corpusDe(c: { historial?: unknown }): string {
  return leerHistorial(c.historial)
    .map((m) => m.texto)
    .filter(Boolean)
    .join('\n')
    .slice(0, 4000);
}

/** La lista muestra cuándo fue el último mensaje, no cuándo se tocó la fila. */
function momentoDe(c: { historial?: unknown; updatedAt: Date }): string {
  const at = [...leerHistorial(c.historial)].reverse().find((m) => m.at)?.at;
  const fecha = at ? new Date(at) : c.updatedAt;
  return Number.isNaN(fecha.getTime()) ? c.updatedAt.toISOString() : fecha.toISOString();
}

function herramientasDe(raw: unknown): { nombre: string; imagen: string }[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const nombre = (item as { nombre?: unknown }).nombre;
    const imagen = (item as { imagen?: unknown }).imagen;
    if (typeof imagen !== 'string' || !/^https:\/\//.test(imagen)) return [];
    return [{ nombre: typeof nombre === 'string' ? nombre.slice(0, 120) : '', imagen }];
  });
}

function mensajesDe(raw: unknown): MensajeCharla[] {
  return leerHistorial(raw).flatMap((m) => {
    if ((m.rol !== 'user' && m.rol !== 'assistant') || !m.texto) return [];
    const herramientas = herramientasDe(m.herramientas);
    return [{ rol: m.rol, texto: m.texto, at: m.at ?? '', ...(herramientas.length ? { herramientas } : {}) }];
  });
}

export function avisoDe(
  c: Pick<Conversation, 'id' | 'canal' | 'nombre' | 'ultimoClienteAt' | 'ventanaDesde' | 'respuestasVentana'> & { historial?: unknown },
  ahora: Date,
): Pick<AvisoVentana, 'id' | 'canal' | 'nombre' | 'texto' | 'puedeResponder' | 'ultimo'> | null {
  const nombre = c.nombre || 'Sin nombre';
  if (c.canal === 'instagram' && c.ultimoClienteAt) {
    const restante = VENTANA_IG_MS - (ahora.getTime() - c.ultimoClienteAt.getTime());
    if (restante > 0 && restante <= AVISO_IG_MS) {
      const min = Math.max(1, Math.ceil(restante / 60_000));
      return {
        id: c.id,
        canal: 'instagram',
        nombre,
        texto: `Quedan ${min} min para que se cierre la ventana de 24 horas de Instagram.`,
        puedeResponder: true,
        ultimo: ultimoDe(c),
      };
    }
  }
  if (c.canal === 'tiktok' && c.ventanaDesde && ahora.getTime() - c.ventanaDesde.getTime() < VENTANA_TT_MS) {
    if (c.respuestasVentana >= AVISO_TIKTOK) {
      const restantes = Math.max(0, TOPE_TIKTOK - c.respuestasVentana);
      return {
        id: c.id,
        canal: 'tiktok',
        nombre,
        texto: restantes
          ? `TikTok: van ${c.respuestasVentana} de ${TOPE_TIKTOK} respuestas en esta charla.`
          : `TikTok ya usó las ${TOPE_TIKTOK} respuestas de esta charla. Hay que esperar a que la persona vuelva a escribir.`,
        puedeResponder: restantes > 0,
        ultimo: ultimoDe(c),
      };
    }
  }
  return null;
}

/** Todas las charlas vivas, las más nuevas primero. Con `q` busca en el nombre, el número y el UUID. */
export async function listarAvisos(deps: Deps, tenantId: string, q?: string): Promise<AvisoVentana[]> {
  const ahora = deps.now();
  const consulta = q?.trim() ?? '';
  const convs = await deps.prisma.conversation.findMany({
    where: { tenantId, canal: { in: [...CANALES_BANDEJA] } },
    orderBy: { updatedAt: 'desc' },
    take: consulta ? 400 : 80,
  });
  const items = convs.flatMap((c) => {
    if (!esBandeja(c.canal)) return [];
    const aviso = avisoDe(c, ahora);
    return [
      {
        id: c.id,
        codigo: c.codigo,
        canal: c.canal,
        nombre: c.nombre || 'Sin nombre',
        numero: numeroDe(c),
        texto: aviso?.texto ?? '',
        puedeResponder: !ventanaCerrada(c, ahora),
        ultimo: ultimoDe(c),
        corpus: corpusDe(c),
        at: momentoDe(c),
        pausada: pausadaDe(c.handoffHasta, ahora),
      },
    ];
  });
  if (!consulta) return items;
  return items.filter((a) => coincideBusqueda(a, consulta)).slice(0, 80);
}

/** La charla guardada de ese cliente, con el aviso de la ventana si sigue abierto. */
export async function obtenerCharla(deps: Deps, tenantId: string, id: string): Promise<Charla> {
  const conv = await cargarCharla(deps, tenantId, id);
  if (!esBandeja(conv.canal)) throw notFound('Conversación');
  const ahora = deps.now();
  const aviso = avisoDe(conv, ahora);
  return {
    id: conv.id,
    codigo: conv.codigo,
    canal: conv.canal,
    nombre: conv.nombre || 'Sin nombre',
    numero: numeroDe(conv),
    aviso: aviso?.texto ?? null,
    puedeResponder: !ventanaCerrada(conv, ahora),
    pausada: pausadaDe(conv.handoffHasta, ahora),
    mensajes: mensajesDe(conv.historial),
  };
}

/** La IA deja de contestar esta charla para que la atienda el comercio. */
export async function pausarCharla(deps: Deps, tenantId: string, id: string): Promise<Charla> {
  const conv = await cargarCharla(deps, tenantId, id);
  await deps.prisma.conversation.update({
    where: { id: conv.id },
    data: { handoffHasta: addHours(deps.now(), deps.config.HANDOFF_HORAS) },
  });
  return obtenerCharla(deps, tenantId, id);
}

/** La IA vuelve a contestar esta charla. */
export async function devolverCharla(deps: Deps, tenantId: string, id: string): Promise<Charla> {
  const conv = await cargarCharla(deps, tenantId, id);
  await deps.prisma.conversation.update({ where: { id: conv.id }, data: { handoffHasta: null } });
  return obtenerCharla(deps, tenantId, id);
}

async function cargarCharla(deps: Deps, tenantId: string, id: string) {
  const conv = await deps.prisma.conversation.findFirst({
    where: { tenantId, OR: [{ id }, { codigo: id }] },
  });
  if (!conv || !esBandeja(conv.canal)) throw notFound('Conversación');
  return conv;
}

function ventanaCerrada(conv: Pick<Conversation, 'canal' | 'ultimoClienteAt' | 'ventanaDesde' | 'respuestasVentana'>, ahora: Date): string | null {
  if (conv.canal === 'whatsapp') {
    if (!conv.ultimoClienteAt) return 'Esta charla de WhatsApp no tiene un mensaje reciente del cliente';
    if (ahora.getTime() - conv.ultimoClienteAt.getTime() >= VENTANA_WA_MS) return 'La ventana de 24 horas de WhatsApp ya se cerró';
  }
  if (conv.canal === 'instagram') {
    if (!conv.ultimoClienteAt) return 'Esta charla de Instagram no tiene un mensaje reciente del cliente';
    if (ahora.getTime() - conv.ultimoClienteAt.getTime() >= VENTANA_IG_MS) {
      return 'La ventana de 24 horas de Instagram ya se cerró';
    }
  }
  if (conv.canal === 'tiktok') {
    if (!conv.ventanaDesde || ahora.getTime() - conv.ventanaDesde.getTime() >= VENTANA_TT_MS) {
      return 'Pasaron 48 horas sin un mensaje nuevo en TikTok';
    }
    if (conv.respuestasVentana >= TOPE_TIKTOK) return `TikTok permite ${TOPE_TIKTOK} respuestas cada 48 horas`;
  }
  return null;
}

/** El comercio contesta desde el panel, dentro de la ventana que todavía está abierta. */
export async function responderEnVentana(deps: Deps, tenantId: string, conversationId: string, raw: unknown) {
  const { texto } = z.object({ texto: z.string().trim().min(1).max(1000) }).parse(raw);
  const conv = await cargarCharla(deps, tenantId, conversationId);
  const cierre = ventanaCerrada(conv, deps.now());
  if (cierre) throw conflict(cierre);
  const tenant = await getTenant(deps.prisma, tenantId);
  const destino = destinoDe(deps, tenant, conv);
  if (!destino) throw conflict('El canal no está conectado');
  await deps.mensajeria.enviar(destino, texto);
  const historial = agregarAlHistorial(leerHistorial(conv.historial), {
    rol: 'assistant',
    texto,
    at: deps.now().toISOString(),
  });
  await deps.prisma.conversation.update({
    where: { id: conv.id },
    data: { historial: historial as object },
  });
  if (conv.canal === 'tiktok') await contarRespuestaSaliente(deps, tenantId, conv.subscriberId);
  return { ok: true as const };
}

/** Cada mensaje que sale por TikTok cuenta para el tope de 10 cada 48 horas. */
export async function contarRespuestaSaliente(deps: Deps, tenantId: string, subscriberId: string, canal?: CanalTipo | null) {
  if (canal && canal !== 'tiktok') return;
  await deps.prisma.conversation.updateMany({
    where: { tenantId, subscriberId, canal: 'tiktok' },
    data: { respuestasVentana: { increment: 1 } },
  });
}
