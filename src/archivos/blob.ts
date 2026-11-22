import { createFolder, put } from '@vercel/blob';
import { HttpError } from '../lib/errors';
import { textoDeArchivo } from './texto';

export const CARPETA_ORBITA = 'Orbita';

const MAX_BYTES = 8 * 1024 * 1024;

const TIPOS: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  txt: 'text/plain; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  tsv: 'text/tab-separated-values; charset=utf-8',
  json: 'application/json',
  md: 'text/markdown; charset=utf-8',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
  webm: 'video/webm',
  zip: 'application/zip',
};

let carpetaLista = false;

function segmento(valor: string): string {
  return valor.replace(/[^\w.\- ()áéíóúüñÁÉÍÓÚÜÑ]+/g, '_').replace(/^\.+/, '').slice(0, 120);
}

/** Ruta dentro del store. Siempre empieza por Orbita/ y no sale de esa carpeta. */
export function rutaEnOrbita(nombre: string, carpeta?: string): string {
  const partes = [carpeta, nombre]
    .filter((p): p is string => Boolean(p))
    .flatMap((p) => p.split(/[\\/]+/))
    .map((p) => segmento(p.trim()))
    .filter((p) => p && p !== '.' && p !== '..' && p.toLowerCase() !== 'orbita');
  const archivo = partes.pop();
  if (!archivo || !archivo.includes('.')) throw new HttpError(400, 'El archivo necesita un nombre y una extensión');
  return [CARPETA_ORBITA, ...partes, archivo].join('/');
}

export function prepararArchivo(nombre: string, archivo: string, carpeta?: string): { ruta: string; datos: Buffer; tipo: string } {
  const base64 = archivo.includes(',') && archivo.trim().startsWith('data:') ? archivo.slice(archivo.indexOf(',') + 1) : archivo;
  const datos = Buffer.from(base64, 'base64');
  if (!datos.length) throw new HttpError(400, 'El archivo está vacío');
  if (datos.length > MAX_BYTES) throw new HttpError(413, 'El archivo supera los 8 MB');
  const ruta = rutaEnOrbita(nombre, carpeta);
  const extension = ruta.split('.').pop()?.toLowerCase() ?? '';
  return { ruta, datos, tipo: TIPOS[extension] ?? 'application/octet-stream' };
}

export async function asegurarCarpetaOrbita(token: string): Promise<void> {
  if (!token || carpetaLista) return;
  await createFolder(`${CARPETA_ORBITA}/`, { access: 'public', token });
  carpetaLista = true;
}

export async function guardarEnOrbita(token: string, nombre: string, archivo: string, carpeta?: string) {
  if (!token) throw new HttpError(503, 'El almacenamiento de archivos no está configurado');
  const { ruta, datos, tipo } = prepararArchivo(nombre, archivo, carpeta);
  const texto = await textoDeArchivo(nombre, datos);
  await asegurarCarpetaOrbita(token);
  const blob = await put(ruta, datos, { access: 'public', token, contentType: tipo, addRandomSuffix: true });
  return { url: blob.url, pathname: blob.pathname, tipo, nombre, texto };
}
