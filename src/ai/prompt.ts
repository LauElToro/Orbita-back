import type { ChatMessage } from './openrouter';

export interface Intervencion {
  rol: 'user' | 'assistant';
  texto: string;
  at: string;
  herramientas?: { nombre: string; imagen: string }[];
}

export const MAX_HISTORIAL = 10;

export interface PromptInput {
  nombreNegocio: string;
  promptNegocio: string;
  instruccionesModulos: string[];
  ahora: string;
  nombreContacto: string;
  historial: Intervencion[];
  texto: string;
}

export function construirMensajes(input: PromptInput): ChatMessage[] {
  const system = [
    `Sos el asistente virtual de "${input.nombreNegocio}". Atendés por chat a sus clientes.`,
    `Fecha y hora actual del negocio: ${input.ahora}.`,
    input.nombreContacto ? `La persona se llama ${input.nombreContacto}.` : '',
    '## Información del negocio',
    input.promptNegocio.trim() || '(sin información cargada)',
    '## Reglas',
    'Escribí como en un chat: corto, claro y sin Markdown (nada de **, # ni tablas).',
    ...input.instruccionesModulos.filter(Boolean),
  ]
    .filter(Boolean)
    .join('\n');

  const historial: ChatMessage[] = input.historial
    .slice(-MAX_HISTORIAL)
    .map((h) => ({ role: h.rol, content: h.texto }));

  return [{ role: 'system', content: system }, ...historial, { role: 'user', content: input.texto }];
}

/** Los chats no renderizan Markdown: se sacan negritas dobles, títulos y viñetas con asterisco. */
export function limpiarFormato(texto: string): string {
  return texto
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*\*\s+/gm, '- ')
    .trim();
}

export function leerHistorial(raw: unknown): Intervencion[] {
  return Array.isArray(raw) ? (raw as Intervencion[]) : [];
}

export function agregarAlHistorial(historial: Intervencion[], ...nuevas: Intervencion[]): Intervencion[] {
  return [...historial, ...nuevas].slice(-MAX_HISTORIAL);
}
