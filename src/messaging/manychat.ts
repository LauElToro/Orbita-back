export interface MessengerClient {
  sendText(appToken: string, subscriberId: string, texto: string): Promise<void>;
}

/** Envío directo por la API de ManyChat. Se usa para mensajes que no responden a un mensaje entrante (recordatorios). */
export class ManyChatClient implements MessengerClient {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs = 8_000,
  ) {}

  async sendText(appToken: string, subscriberId: string, texto: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/fb/sending/sendContent`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${appToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        subscriber_id: subscriberId,
        data: { version: 'v2', content: { messages: [{ type: 'text', text: texto }] } },
        message_tag: 'ACCOUNT_UPDATE',
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`ManyChat ${res.status}: ${await res.text()}`);
  }
}
