export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AiClient {
  chat(model: string, messages: ChatMessage[]): Promise<string>;
}

export class OpenRouterClient implements AiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly timeoutMs = 25_000,
  ) {}

  async chat(model: string, messages: ChatMessage[]): Promise<string> {
    if (!this.apiKey) throw new Error('OPENROUTER_API_KEY no configurada');
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        'X-Title': 'Orbita',
      },
      // Sin razonamiento: responde en menos de un segundo y no gasta el max_tokens pensando (eso dejaba respuestas vacías).
      body: JSON.stringify({ model, messages, temperature: 0.4, max_tokens: 600, reasoning: { effort: 'none' } }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const content = json.choices?.[0]?.message?.content?.trim();
    if (!content) throw new Error('OpenRouter devolvió una respuesta vacía');
    return content;
  }
}
