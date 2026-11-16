import { PDFParse } from 'pdf-parse';
import { HttpError } from '../lib/errors';

export type TipoFuente = 'texto' | 'pdf' | 'tabla';

export const LIMITES = {
  fuentes: 6,
  bytesArchivo: 5 * 1024 * 1024,
  caracteresFuente: 25_000,
  caracteresTotal: 60_000,
  filasTabla: 400,
  paginasPdf: 60,
};

export interface FuenteLeida {
  tipo: TipoFuente;
  contenido: string;
  filas: number;
}

const recortar = (texto: string, max = LIMITES.caracteresFuente) => (texto.length > max ? texto.slice(0, max) : texto);

export function normalizarTexto(texto: string): string {
  return texto
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function detectarSeparador(linea: string): string {
  const candidatos = ['\t', ';', ','];
  const cuenta = (sep: string) => linea.split(sep).length - 1;
  return candidatos.reduce((mejor, sep) => (cuenta(sep) > cuenta(mejor) ? sep : mejor), '\t');
}

/** CSV/TSV con comillas dobles (`"a, b"` y `""` como comilla escapada). */
export function parsearTabla(texto: string): string[][] {
  const limpio = texto.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const primera = limpio.split('\n').find((l) => l.trim()) ?? '';
  const sep = detectarSeparador(primera);
  const filas: string[][] = [];
  let fila: string[] = [];
  let celda = '';
  let comillas = false;
  for (let i = 0; i < limpio.length; i++) {
    const c = limpio[i];
    if (comillas) {
      if (c === '"' && limpio[i + 1] === '"') {
        celda += '"';
        i++;
      } else if (c === '"') comillas = false;
      else celda += c;
    } else if (c === '"' && celda === '') comillas = true;
    else if (c === sep) {
      fila.push(celda);
      celda = '';
    } else if (c === '\n') {
      fila.push(celda);
      filas.push(fila);
      fila = [];
      celda = '';
    } else celda += c;
  }
  if (celda || fila.length) {
    fila.push(celda);
    filas.push(fila);
  }
  return filas
    .map((f) => f.map((v) => v.replace(/\s+/g, ' ').trim()))
    .filter((f) => f.some(Boolean));
}

export function leerTabla(texto: string): FuenteLeida {
  const [encabezado, ...resto] = parsearTabla(texto);
  if (!encabezado || !resto.length) throw new HttpError(400, 'La planilla necesita una fila de encabezados y al menos una fila de datos');
  const filas = resto.slice(0, LIMITES.filasTabla);
  const lineas = [encabezado, ...filas].map((f) => f.join('\t'));
  let contenido = '';
  let incluidas = -1;
  for (const linea of lineas) {
    if (contenido.length + linea.length + 1 > LIMITES.caracteresFuente) break;
    contenido += (contenido ? '\n' : '') + linea;
    incluidas++;
  }
  return { tipo: 'tabla', contenido, filas: incluidas };
}

export async function leerPdf(buffer: Buffer): Promise<FuenteLeida> {
  if (buffer.subarray(0, 5).toString('latin1') !== '%PDF-') throw new HttpError(400, 'El archivo no es un PDF válido');
  const parser = new PDFParse({ data: buffer });
  try {
    const { text } = await parser.getText({ first: LIMITES.paginasPdf, pageJoiner: '' });
    const contenido = recortar(normalizarTexto(text));
    if (contenido.length < 20) {
      throw new HttpError(400, 'No encontramos texto en el PDF. Si es un escaneo o una imagen, pegá el contenido como texto.');
    }
    return { tipo: 'pdf', contenido, filas: 0 };
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, 'No pudimos leer el PDF. Probá exportarlo de nuevo o pegá el texto.');
  } finally {
    await parser.destroy().catch(() => undefined);
  }
}

export function leerTexto(texto: string): FuenteLeida {
  const contenido = recortar(normalizarTexto(texto));
  if (contenido.length < 10) throw new HttpError(400, 'Escribí un poco más de información (al menos 10 caracteres)');
  return { tipo: 'texto', contenido, filas: 0 };
}

const EXTENSIONES: Record<string, 'pdf' | 'tabla' | 'texto'> = {
  pdf: 'pdf',
  tsv: 'tabla',
  csv: 'tabla',
  tab: 'tabla',
  txt: 'texto',
  md: 'texto',
};

export async function leerArchivo(nombre: string, base64: string): Promise<FuenteLeida> {
  const ext = nombre.toLowerCase().split('.').pop() ?? '';
  const tipo = EXTENSIONES[ext];
  if (!tipo) throw new HttpError(400, 'Formato no soportado. Subí un PDF, una planilla TSV o CSV, o un TXT.');
  const buffer = Buffer.from(base64, 'base64');
  if (!buffer.length) throw new HttpError(400, 'El archivo está vacío');
  if (buffer.length > LIMITES.bytesArchivo) throw new HttpError(413, 'El archivo supera los 5 MB');
  if (tipo === 'pdf') return leerPdf(buffer);
  const texto = buffer.toString('utf8');
  return tipo === 'tabla' ? leerTabla(texto) : leerTexto(texto);
}
