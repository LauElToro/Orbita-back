import mammoth from 'mammoth';
import { leerPdf, normalizarTexto } from '../demo/fuentes';
import { HttpError } from '../lib/errors';

const TEXTO = new Set(['txt', 'md', 'csv', 'tsv', 'json']);
const MAX = 20_000;

function extension(nombre: string): string {
  return nombre.toLowerCase().split('.').pop() ?? '';
}

/** Texto para el prompt. Null si el archivo no es un documento (por ejemplo, una foto). */
export async function textoDeArchivo(nombre: string, datos: Buffer): Promise<string | null> {
  const ext = extension(nombre);
  if (ext === 'doc') throw new HttpError(400, 'El Word tiene que estar en formato .docx.');
  if (ext === 'pdf') return (await leerPdf(datos)).contenido.slice(0, MAX);
  if (ext === 'docx') {
    const { value } = await mammoth.extractRawText({ buffer: datos });
    const texto = normalizarTexto(value).slice(0, MAX);
    if (texto.length < 10) throw new HttpError(400, 'No encontramos texto en el Word.');
    return texto;
  }
  if (!TEXTO.has(ext)) return null;
  const texto = normalizarTexto(datos.toString('utf8')).slice(0, MAX);
  if (!texto) throw new HttpError(400, 'El archivo de texto está vacío.');
  return texto;
}
