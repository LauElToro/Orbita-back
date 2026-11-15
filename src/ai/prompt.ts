import type { ChatMessage } from './openrouter';

export interface Intervencion {
  rol: 'user' | 'assistant';
  texto: string;
  at: string;
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
    ...input.instruccionesModulos.filter(Boolean),
  ]
    .filter(Boolean)
    .join('\n');

  const historial: ChatMessage[] = input.historial
    .slice(-MAX_HISTORIAL)
    .map((h) => ({ role: h.rol, content: h.texto }));

  return [{ role: 'system', content: system }, ...historial, { role: 'user', content: input.texto }];
}

export function leerHistorial(raw: unknown): Intervencion[] {
  return Array.isArray(raw) ? (raw as Intervencion[]) : [];
}

export function agregarAlHistorial(historial: Intervencion[], ...nuevas: Intervencion[]): Intervencion[] {
  return [...historial, ...nuevas].slice(-MAX_HISTORIAL);
}
