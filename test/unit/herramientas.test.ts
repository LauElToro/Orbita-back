import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { responderDesdeDatos } from '../../src/ai/charla';
import { compilarPrompt, perfilSchema } from '../../src/ai/perfil';
import { textoDeArchivo } from '../../src/archivos/texto';

const perfil = perfilSchema.parse({
  descripcion: 'Parrilla de barrio con platos del día.',
  tono: 'cercano',
  catalogo: [
    { nombre: 'Milanesa napolitana', detalle: 'Con jamón y queso.', precio: 18900, precioEfectivo: 17010, stock: 6, imagen: 'https://imagenes.orbita.test/milanesa.jpg', medios: ['efectivo', 'mercadopago'] },
    { nombre: 'Flan casero', detalle: 'Postre.', precio: 5500, stock: 4, imagen: 'https://imagenes.orbita.test/flan.jpg', medios: ['efectivo'] },
  ],
  documentos: [{ nombre: 'Carta.pdf', url: 'https://blob.vercel-storage.com/carta.pdf', texto: 'La milanesa se retira en el local.' }],
});

describe('fotos del catálogo', () => {
  const base = {
    nombreNegocio: 'La Parrilla',
    perfil,
    modulos: ['faq', 'handoff'],
    nombreCliente: 'Ana',
    historial: [],
    textoHandoff: 'Lo comunico con una persona del local.',
    ahora: new Date('2026-11-22T15:00:00.000Z'),
    timezone: 'America/Argentina/Buenos_Aires',
  };

  it('muestra una tool por cada producto de la carta, sin mandar una sola foto', () => {
    const r = responderDesdeDatos({ ...base, texto: '¿Qué tienen?' });
    expect(r?.imagen).toBeUndefined();
    expect(r?.herramientas).toEqual([
      { nombre: 'Milanesa napolitana', imagen: 'https://imagenes.orbita.test/milanesa.jpg' },
      { nombre: 'Flan casero', imagen: 'https://imagenes.orbita.test/flan.jpg' },
    ]);
  });

  it('muestra la tool y envía la foto cuando piden un producto', () => {
    const r = responderDesdeDatos({ ...base, texto: 'Quiero milanesa napolitana' });
    expect(r?.imagen).toBe('https://imagenes.orbita.test/milanesa.jpg');
    expect(r?.herramientas).toEqual([{ nombre: 'Milanesa napolitana', imagen: 'https://imagenes.orbita.test/milanesa.jpg' }]);
  });

  it('pasa el documento al prompt', () => {
    const prompt = compilarPrompt(perfil, ['faq']);
    expect(prompt).toContain('### Documentos');
    expect(prompt).toContain('Carta.pdf');
    expect(prompt).toContain('La milanesa se retira en el local.');
  });
});

describe('texto de archivos', () => {
  it('lee un texto y un word, y una foto no trae texto', async () => {
    await expect(textoDeArchivo('menu.txt', Buffer.from('Horario de lunes a viernes.'))).resolves.toBe('Horario de lunes a viernes.');
    await expect(textoDeArchivo('foto.png', Buffer.from('no es texto'))).resolves.toBeNull();
    await expect(textoDeArchivo('viejo.doc', Buffer.from('x'))).rejects.toThrow('.docx');

    const zip = new JSZip();
    zip.file(
      'word/document.xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>La milanesa sale dieciocho mil.</w:t></w:r></w:p></w:body></w:document>',
    );
    const docx = await zip.generateAsync({ type: 'nodebuffer' });
    await expect(textoDeArchivo('carta.docx', docx)).resolves.toContain('dieciocho mil');
  });
});
