import { describe, expect, it } from 'vitest';
import { avisoDe, AVISO_IG_MS, VENTANA_IG_MS } from '../../src/messaging/ventanas';
import { verificacionDe } from '../../src/messaging/whatsapp';

const ahora = new Date('2026-11-21T15:00:00Z');

describe('verificación de WhatsApp', () => {
  it('marca verificado cuando Meta ya aprobó el número', () => {
    expect(
      verificacionDe({ code_verification_status: 'VERIFIED', name_status: 'APPROVED', status: 'CONNECTED', display_phone_number: '+54 9 11' }),
    ).toMatchObject({ estado: 'verificado' });
  });

  it('distingue revisión, pendiente y rechazo', () => {
    expect(verificacionDe({ name_status: 'PENDING_REVIEW' }).estado).toBe('en_revision');
    expect(verificacionDe({ code_verification_status: 'NOT_VERIFIED' }).estado).toBe('pendiente');
    expect(verificacionDe({ name_status: 'DECLINED' }).estado).toBe('rechazado');
  });
});

describe('avisos de Instagram y TikTok', () => {
  it('avisa cuando Instagram está por cumplir las 24 horas', () => {
    const lejos = avisoDe(
      { id: '1', canal: 'instagram', nombre: 'Ana', ultimoClienteAt: new Date(ahora.getTime() - 2 * 3_600_000), ventanaDesde: null, respuestasVentana: 0 },
      ahora,
    );
    expect(lejos).toBeNull();
    const cerca = avisoDe(
      {
        id: '1',
        canal: 'instagram',
        nombre: 'Ana',
        ultimoClienteAt: new Date(ahora.getTime() - (VENTANA_IG_MS - AVISO_IG_MS) - 60_000),
        ventanaDesde: null,
        respuestasVentana: 0,
      },
      ahora,
    );
    expect(cerca?.texto).toMatch(/ventana de 24 horas de Instagram/);
    expect(cerca?.puedeResponder).toBe(true);
  });

  it('avisa cuando TikTok se acerca a las 10 respuestas', () => {
    const base = {
      id: '2',
      canal: 'tiktok' as const,
      nombre: 'Leo',
      ultimoClienteAt: ahora,
      ventanaDesde: new Date(ahora.getTime() - 3_600_000),
      respuestasVentana: 7,
    };
    expect(avisoDe(base, ahora)).toBeNull();
    expect(avisoDe({ ...base, respuestasVentana: 9 }, ahora)?.texto).toMatch(/9 de 10/);
    expect(avisoDe({ ...base, respuestasVentana: 10 }, ahora)?.puedeResponder).toBe(false);
  });
});
