import { describe, expect, it } from 'vitest';
import { agregarAlHistorial, construirMensajes, leerHistorial, MAX_HISTORIAL } from '../../src/ai/prompt';
import { precioDe, PLANES } from '../../src/billing/plans';
import { verificarFirmaMp } from '../../src/billing/mercadopago';
import { decrypt, encrypt, mask, safeEqual } from '../../src/lib/crypto';
import { keys } from '../../src/lib/keys';
import { modulosActivos } from '../../src/modules';
import { pideHandoff } from '../../src/modules/handoff';
import { esConfirmacion, textoRecordatorio } from '../../src/modules/recordatorios';
import { parsearEtiquetas } from '../../src/modules/turnos';
import { leerMensajes, MENSAJES_DEFAULT } from '../../src/tenants/defaults';
import { alcanzoTope } from '../../src/usage/usage';
import { modeloPara } from '../../src/ai/contexto';
import { createHmac } from 'node:crypto';
import type { Config } from '../../src/config';

const KEY = 'a'.repeat(64);

describe('crypto', () => {
  it('cifra y descifra el appToken', () => {
    const enc = encrypt('secreto-123', KEY);
    expect(enc).not.toContain('secreto');
    expect(decrypt(enc, KEY)).toBe('secreto-123');
  });
  it('enmascara y compara en tiempo constante', () => {
    expect(mask('abcdefgh')).toBe('****efgh');
    expect(mask('abc')).toBe('****');
    expect(safeEqual('x', 'x')).toBe(true);
    expect(safeEqual('x', 'xy')).toBe(false);
  });
});

describe('dedupe', () => {
  it('normaliza el texto en la clave', () => {
    expect(keys.dedupe('1', '2', ' Hola ')).toBe(keys.dedupe('1', '2', 'hola'));
    expect(keys.dedupe('1', '2', 'hola')).not.toBe(keys.dedupe('1', '3', 'hola'));
  });
});

describe('topes', () => {
  const topes = { dia: 10, semana: 50, mes: 100 };
  it('frena al alcanzar cualquiera de los tres', () => {
    expect(alcanzoTope({ dia: 9, semana: 9, mes: 9 }, topes)).toBe(false);
    expect(alcanzoTope({ dia: 10, semana: 10, mes: 10 }, topes)).toBe(true);
    expect(alcanzoTope({ dia: 0, semana: 50, mes: 50 }, topes)).toBe(true);
    expect(alcanzoTope({ dia: 0, semana: 0, mes: 100 }, topes)).toBe(true);
  });
});

describe('prompt builder', () => {
  it('pone negocio, reglas, historial y el mensaje nuevo', () => {
    const historial = Array.from({ length: 14 }, (_, i) => ({
      rol: (i % 2 ? 'assistant' : 'user') as 'user' | 'assistant',
      texto: `m${i}`,
      at: '',
    }));
    const msgs = construirMensajes({
      nombreNegocio: 'Pizzería Norte',
      promptNegocio: 'Vendemos pizzas.',
      instruccionesModulos: ['Regla A', ''],
      ahora: 'sábado',
      nombreContacto: 'Ana',
      historial,
      texto: 'hola',
    });
    expect(msgs[0].role).toBe('system');
    expect(msgs[0].content).toContain('Pizzería Norte');
    expect(msgs[0].content).toContain('Vendemos pizzas.');
    expect(msgs[0].content).toContain('Regla A');
    expect(msgs[0].content).toContain('Ana');
    expect(msgs).toHaveLength(1 + MAX_HISTORIAL + 1);
    expect(msgs.at(-1)).toEqual({ role: 'user', content: 'hola' });
  });

  it('el historial guarda solo las últimas 10 intervenciones', () => {
    const h = agregarAlHistorial(
      Array.from({ length: 10 }, (_, i) => ({ rol: 'user' as const, texto: String(i), at: '' })),
      { rol: 'assistant', texto: 'nuevo', at: '' },
    );
    expect(h).toHaveLength(10);
    expect(h.at(-1)?.texto).toBe('nuevo');
    expect(leerHistorial(null)).toEqual([]);
  });
});

describe('módulos', () => {
  it('handoff va último', () => {
    expect(modulosActivos(['handoff', 'faq', 'turnos', 'inexistente']).map((m) => m.id)).toEqual([
      'faq',
      'turnos',
      'handoff',
    ]);
  });
  it('detecta la etiqueta de handoff', () => {
    expect(pideHandoff('[handoff]')).toBe(true);
    expect(pideHandoff('hola')).toBe(false);
  });
  it('parsea etiquetas de turnos y las saca del texto', () => {
    const r = parsearEtiquetas('Listo, te anoto. [TURNO_RESERVAR 2026-11-20 10:30] [TURNO_CANCELAR abc123]');
    expect(r.reservas).toEqual(['2026-11-20 10:30']);
    expect(r.cancelaciones).toEqual(['abc123']);
    expect(r.limpio).toBe('Listo, te anoto.');
  });
  it('recordatorios', () => {
    expect(esConfirmacion('SI')).toBe(true);
    expect(esConfirmacion('sí, ahí voy')).toBe(true);
    expect(esConfirmacion('no puedo')).toBe(false);
    expect(textoRecordatorio('Mañana a las {{hora}}.', '10:30')).toBe('Mañana a las 10:30.');
  });
  it('los textos fijos completan con los defaults', () => {
    expect(leerMensajes({ tope: 'x' })).toEqual({ ...MENSAJES_DEFAULT, tope: 'x' });
    expect(leerMensajes(null)).toEqual(MENSAJES_DEFAULT);
  });
});

describe('planes y modelo', () => {
  it('precio según medio y plan personalizado', () => {
    const turnos = PLANES.find((p) => p.id === 'turnos')!;
    expect(precioDe(turnos, 'transferencia')).toBe(80_000);
    expect(precioDe(turnos, 'mercadopago')).toBe(84_000);
    expect(precioDe(PLANES.find((p) => p.id === 'personalizado')!, 'mercadopago', 250_000)).toBe(250_000);
  });
  it('el modelo capaz solo se usa si el plan lo paga', () => {
    const config = { MODELO_BARATO: 'barato/x', MODELO_CAPAZ: 'capaz/y' } as Config;
    const mensajes = PLANES[0];
    const completo = PLANES[2];
    expect(modeloPara({ modelo: 'capaz', plan: mensajes }, config)).toBe('barato/x');
    expect(modeloPara({ modelo: 'capaz', plan: completo }, config)).toBe('capaz/y');
    expect(modeloPara({ modelo: 'anthropic/claude', plan: completo }, config)).toBe('anthropic/claude');
    expect(modeloPara({ modelo: 'barato', plan: completo }, config)).toBe('barato/x');
  });
});

describe('firma de Mercado Pago', () => {
  it('valida el HMAC del manifest', () => {
    const secret = 's3cret';
    const v1 = createHmac('sha256', secret).update('id:123;request-id:req-1;ts:1700;').digest('hex');
    const headers = { 'x-signature': `ts=1700,v1=${v1}`, 'x-request-id': 'req-1' };
    expect(verificarFirmaMp(secret, headers, '123')).toBe(true);
    expect(verificarFirmaMp(secret, headers, '124')).toBe(false);
    expect(verificarFirmaMp(secret, {}, '123')).toBe(false);
  });
});
