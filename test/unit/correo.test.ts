import { describe, expect, it } from 'vitest';
import { tokenBaja, userIdDeBaja } from '../../src/correo/envios';
import { mensajeBienvenida, mensajeCompra, mensajeLimite, mensajeVencimiento } from '../../src/correo/plantillas';

describe('avisos de correo', () => {
  it('firma el link de baja y rechaza uno alterado', () => {
    const token = tokenBaja('secreto-de-prueba', 'usuario-1');
    expect(userIdDeBaja('secreto-de-prueba', token)).toBe('usuario-1');
    expect(userIdDeBaja('otro-secreto', token)).toBeNull();
    expect(userIdDeBaja('secreto-de-prueba', `${token}x`)).toBeNull();
  });

  it('arma la bienvenida, la compra, el vencimiento y el tope', () => {
    const persona = { email: 'ana@kiosco.com', nombre: 'Ana' };
    expect(mensajeBienvenida(persona, 'Kiosco Ana', 'https://orbita-emp.com').asunto).toBe('Bienvenido a órbita, Ana');
    expect(mensajeCompra(persona, 'Kiosco Ana', 'Turnos', 84000, new Date('2026-12-19T15:00:00Z'), true, 'https://orbita-emp.com').texto).toContain('84.000');
    expect(mensajeVencimiento(persona, 'Kiosco Ana', 'Turnos', new Date('2026-12-19T15:00:00Z'), 'impago', 'https://orbita-emp.com').asunto).toContain('Pausamos');
    expect(mensajeLimite(persona, 'Kiosco Ana', 4000, 4000, 100, '2027-01-19', 'https://orbita-emp.com').asunto).toContain('tope');
  });
});
