import { describe, expect, it } from 'vitest';
import { CARPETA_ORBITA, prepararArchivo, rutaEnOrbita } from '../../src/archivos/blob';

describe('archivos en Orbita', () => {
  it('guarda cualquier archivo dentro de la carpeta Orbita', () => {
    expect(rutaEnOrbita('carta.pdf')).toBe('Orbita/carta.pdf');
    expect(rutaEnOrbita('foto del plato.png', 'cuentas/local-1')).toBe('Orbita/cuentas/local-1/foto del plato.png');
    expect(rutaEnOrbita('../../secreto.txt')).toBe('Orbita/secreto.txt');
    expect(rutaEnOrbita('Orbita/doble.jpg')).toBe('Orbita/doble.jpg');
    expect(() => rutaEnOrbita('sin-extension')).toThrow('extensión');
  });

  it('acepta una imagen y un pdf, y rechaza el vacío', () => {
    const png = prepararArchivo('plato.png', Buffer.from('png').toString('base64'), 'cuentas/a');
    expect(png.ruta.startsWith(`${CARPETA_ORBITA}/cuentas/a/`)).toBe(true);
    expect(png.tipo).toBe('image/png');
    const pdf = prepararArchivo('menu.pdf', Buffer.from('%PDF').toString('base64'));
    expect(pdf.tipo).toBe('application/pdf');
    const raro = prepararArchivo('backup.bak', Buffer.from('x').toString('base64'));
    expect(raro.tipo).toBe('application/octet-stream');
    expect(() => prepararArchivo('vacio.txt', '')).toThrow('vacío');
  });
});
