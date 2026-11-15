import { describe, expect, it } from 'vitest';
import { compilarPrompt, perfilSchema } from '../../src/ai/perfil';
import { LEGAL } from '../../src/legal/legal';
import { hashPassword, verifyPassword } from '../../src/lib/password';
import { slugify } from '../../src/lib/slug';

describe('contraseñas', () => {
  it('hashea con scrypt y verifica', async () => {
    const hash = await hashPassword('clave-segura-1');
    expect(hash).toMatch(/^scrypt\$/);
    expect(hash).not.toContain('clave-segura-1');
    expect(await verifyPassword('clave-segura-1', hash)).toBe(true);
    expect(await verifyPassword('otra', hash)).toBe(false);
    expect(await verifyPassword('x', 'md5$abc')).toBe(false);
  });
});

describe('slugify', () => {
  it('genera ids legibles', () => {
    expect(slugify('Peluquería Luna & Co.')).toBe('peluqueria-luna-co');
    expect(slugify('!!!')).toBe('');
  });
});

describe('perfil del negocio', () => {
  const base = perfilSchema.parse({
    descripcion: 'Pizzería familiar en Palermo.',
    productos: 'Muzza $9.000',
    tono: 'formal',
    preguntas: [{ pregunta: '¿Hacen delivery?', respuesta: 'Sí, hasta 3 km.' }],
    turnos: { servicios: 'Reservas de mesa', horarios: 'Viernes y sábados' },
  });

  it('arma el prompt por secciones y omite las vacías', () => {
    const prompt = compilarPrompt(base, ['faq', 'handoff']);
    expect(prompt).toContain('### Qué hacemos\nPizzería familiar en Palermo.');
    expect(prompt).toContain('- ¿Hacen delivery?\n  Sí, hasta 3 km.');
    expect(prompt).toContain('tratando de usted');
    expect(prompt).not.toContain('### Horarios de atención');
    expect(prompt).not.toContain('### Turnos');
  });

  it('incluye turnos solo si el plan tiene el módulo', () => {
    const prompt = compilarPrompt(base, ['faq', 'turnos']);
    expect(prompt).toContain('Servicios que se reservan: Reservas de mesa');
    expect(prompt).toContain('Cada turno dura 30 minutos.');
    expect(prompt).toContain('al menos 2 horas de anticipación');
  });

  it('valida la descripción mínima', () => {
    expect(perfilSchema.safeParse({ descripcion: 'corto' }).success).toBe(false);
  });
});

describe('versiones legales', () => {
  it('están definidas para términos y privacidad', () => {
    expect(Object.keys(LEGAL).sort()).toEqual(['privacidad', 'terminos']);
  });
});
