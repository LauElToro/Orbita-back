import { describe, expect, it } from 'vitest';
import { leerArchivo, leerTabla, parsearTabla } from '../../src/demo/fuentes';
import { procesarSalida } from '../../src/demo/funciones';
import { leerDemo } from '../../src/demo/service';

function pdfMinimo(texto: string): Buffer {
  const stream = `BT /F1 18 Tf 20 100 Td (${texto}) Tj ET`;
  const objetos = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 400 144]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>',
    `<</Length ${stream.length}>>\nstream\n${stream}\nendstream`,
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objetos.forEach((o, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objetos.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<</Size ${objetos.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
}

describe('fuentes de la demo', () => {
  it('lee TSV y CSV con comillas y separadores distintos', () => {
    expect(parsearTabla('producto\tstock\nRemera\t8\n')).toEqual([['producto', 'stock'], ['Remera', '8']]);
    expect(parsearTabla('producto;precio\n"Buzo; gris";$32.000')).toEqual([['producto', 'precio'], ['Buzo; gris', '$32.000']]);
    expect(parsearTabla('a,b\n"dice ""hola""",2\n\n')).toEqual([['a', 'b'], ['dice "hola"', '2']]);
  });

  it('normaliza la planilla a TSV y cuenta las filas', () => {
    const t = leerTabla('producto,stock\nRemera,8\nBuzo,0');
    expect(t).toEqual({ tipo: 'tabla', contenido: 'producto\tstock\nRemera\t8\nBuzo\t0', filas: 2 });
    expect(() => leerTabla('solo encabezado')).toThrow(/al menos una fila/);
  });

  it('extrae el texto de un PDF y rechaza formatos desconocidos', async () => {
    const pdf = await leerArchivo('catalogo.pdf', pdfMinimo('Remera negra con stock de 8 unidades').toString('base64'));
    expect(pdf.tipo).toBe('pdf');
    expect(pdf.contenido).toContain('Remera negra');
    await expect(leerArchivo('falso.pdf', Buffer.from('hola mundo').toString('base64'))).rejects.toThrow(/no es un PDF/);
    await expect(leerArchivo('planilla.xlsx', 'AAAA')).rejects.toThrow(/Formato no soportado/);
    const tsv = await leerArchivo('stock.tsv', Buffer.from('producto\tstock\nGorra\t10').toString('base64'));
    expect(tsv).toMatchObject({ tipo: 'tabla', filas: 1 });
  });
});

describe('funciones de la demo', () => {
  it('describe las acciones de las funciones prendidas y limpia las etiquetas', () => {
    const r = procesarSalida(
      'Te separo dos. [STOCK_RESERVAR Remera negra | 2] Te anoto el pedido [PEDIDO 2 remeras, total $24.000] y el turno [TURNO_RESERVAR 2026-11-20 10:00]',
      ['stock', 'pedidos', 'turnos'],
      'Te paso',
    );
    expect(r.texto).toBe('Te separo dos. Te anoto el pedido y el turno');
    expect(r.acciones).toEqual(['Separaría 2 × Remera negra', 'Registraría el pedido: 2 remeras, total $24.000', 'Reservaría un turno el 2026-11-20 10:00']);
  });

  it('las funciones apagadas no generan acciones y la derivación usa el texto fijo', () => {
    expect(procesarSalida('Listo [STOCK_RESERVAR Gorra | 1]', [], 'Te paso').acciones).toEqual([]);
    expect(procesarSalida('[HANDOFF]', ['derivar'], 'Te paso con alguien')).toMatchObject({ texto: 'Te paso con alguien', handoff: true });
  });

  it('lee la configuración guardada con valores por defecto', () => {
    expect(leerDemo(null)).toMatchObject({ funciones: ['horarios', 'derivar'], mensajes: 0, negocio: '' });
    expect(leerDemo({ funciones: ['stock'], mensajes: 3 })).toMatchObject({ funciones: ['stock'], mensajes: 3 });
    expect(leerDemo({ funciones: ['inventada'] }).funciones).toEqual(['horarios', 'derivar']);
  });
});
