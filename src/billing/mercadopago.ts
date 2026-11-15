import { createHmac } from 'node:crypto';
import { safeEqual } from '../lib/crypto';

export interface PreapprovalInput {
  reason: string;
  externalReference: string;
  payerEmail: string;
  importe: number;
  backUrl: string;
}

export interface PagoMp {
  id: string;
  aprobado: boolean;
  importe: number;
  externalReference?: string;
  preapprovalId?: string;
  fecha: Date;
}

export interface PaymentsGateway {
  readonly habilitado: boolean;
  crearSuscripcion(input: PreapprovalInput): Promise<{ id: string; initPoint: string }>;
  cancelarSuscripcion(id: string): Promise<void>;
  obtenerPago(tipo: string, id: string): Promise<PagoMp | null>;
  verificarFirma(headers: Record<string, string | string[] | undefined>, dataId: string): boolean;
}

const API = 'https://api.mercadopago.com';

export class MercadoPagoClient implements PaymentsGateway {
  constructor(
    private readonly accessToken: string,
    private readonly webhookSecret: string,
  ) {}

  get habilitado(): boolean {
    return Boolean(this.accessToken);
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${API}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${this.accessToken}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Mercado Pago ${res.status}: ${await res.text()}`);
    return (await res.json()) as T;
  }

  async crearSuscripcion(input: PreapprovalInput) {
    const body = {
      reason: input.reason,
      external_reference: input.externalReference,
      payer_email: input.payerEmail,
      back_url: input.backUrl,
      status: 'pending',
      auto_recurring: {
        frequency: 1,
        frequency_type: 'months',
        transaction_amount: input.importe,
        currency_id: 'ARS',
      },
    };
    const res = await this.request<{ id: string; init_point: string }>('/preapproval', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    return { id: res.id, initPoint: res.init_point };
  }

  async cancelarSuscripcion(id: string): Promise<void> {
    await this.request(`/preapproval/${id}`, { method: 'PUT', body: JSON.stringify({ status: 'cancelled' }) });
  }

  async obtenerPago(tipo: string, id: string): Promise<PagoMp | null> {
    if (tipo === 'payment') {
      const p = await this.request<{
        id: number;
        status: string;
        transaction_amount: number;
        external_reference?: string;
        date_approved?: string;
        metadata?: { preapproval_id?: string };
      }>(`/v1/payments/${id}`);
      return {
        id: String(p.id),
        aprobado: p.status === 'approved',
        importe: Math.round(p.transaction_amount),
        externalReference: p.external_reference,
        preapprovalId: p.metadata?.preapproval_id,
        fecha: p.date_approved ? new Date(p.date_approved) : new Date(),
      };
    }
    if (tipo === 'subscription_authorized_payment') {
      const a = await this.request<{
        id: number;
        preapproval_id: string;
        transaction_amount: number;
        external_reference?: string;
        payment?: { id: number; status: string };
        last_modified?: string;
      }>(`/authorized_payments/${id}`);
      return {
        id: String(a.payment?.id ?? a.id),
        aprobado: a.payment?.status === 'approved',
        importe: Math.round(a.transaction_amount),
        externalReference: a.external_reference,
        preapprovalId: a.preapproval_id,
        fecha: a.last_modified ? new Date(a.last_modified) : new Date(),
      };
    }
    return null;
  }

  verificarFirma(headers: Record<string, string | string[] | undefined>, dataId: string): boolean {
    if (!this.webhookSecret) return true;
    return verificarFirmaMp(this.webhookSecret, headers, dataId);
  }
}

/** Si cambia el importe o el medio, la suscripción vieja se cancela para que no siga debitando. */
export async function cancelarSuscripcionVieja(
  gateway: PaymentsGateway,
  mpPreapprovalId: string | null | undefined,
): Promise<void> {
  if (!mpPreapprovalId || !gateway.habilitado) return;
  try {
    await gateway.cancelarSuscripcion(mpPreapprovalId);
  } catch (err) {
    console.error(`no se pudo cancelar la suscripción ${mpPreapprovalId}`, err);
  }
}

export function verificarFirmaMp(
  secret: string,
  headers: Record<string, string | string[] | undefined>,
  dataId: string,
): boolean {
  const firma = String(headers['x-signature'] ?? '');
  const requestId = String(headers['x-request-id'] ?? '');
  const partes = Object.fromEntries(
    firma.split(',').map((p) => {
      const [k, v] = p.split('=');
      return [k?.trim(), v?.trim()];
    }),
  );
  if (!partes.ts || !partes.v1) return false;
  const id = /^[a-z0-9]+$/i.test(dataId) ? dataId.toLowerCase() : dataId;
  const manifest = `id:${id};request-id:${requestId};ts:${partes.ts};`;
  const esperado = createHmac('sha256', secret).update(manifest).digest('hex');
  return safeEqual(esperado, partes.v1);
}
