import { z } from 'zod';
import { MEDIOS, MEDIO_LABEL, juntar, pesos } from './mediosdepago';

const texto = (max: number) => z.string().trim().max(max).default('');

export const itemCatalogoSchema = z.object({
  nombre: z.string().trim().min(1).max(120),
  detalle: texto(400),
  categoria: texto(80),
  imagen: z.string().trim().max(500).default(''),
  precio: z.number().int().nonnegative(),
  precioEfectivo: z.number().int().nonnegative().optional(),
  stock: z.number().int().min(0).nullable().default(null),
  medios: z.array(z.enum(MEDIOS)).max(6).default([]),
});

export type ItemCatalogo = z.infer<typeof itemCatalogoSchema>;

export const perfilSchema = z.object({
  descripcion: z.string().trim().min(10, 'Contá en al menos una frase qué hace tu negocio').max(1500),
  productos: texto(4000),
  horarios: texto(1000),
  ubicacion: texto(500),
  pagosEnvios: texto(1000),
  tono: z.enum(['cercano', 'formal', 'divertido']).default('cercano'),
  derivar: texto(1000),
  preguntas: z
    .array(z.object({ pregunta: z.string().trim().min(1).max(300), respuesta: z.string().trim().min(1).max(1000) }))
    .max(30)
    .default([]),
  turnos: z
    .object({
      servicios: texto(2000),
      horarios: texto(1000),
      duracionMin: z.number().int().min(5).max(480).default(30),
      anticipacionHoras: z.number().int().min(0).max(720).default(2),
    })
    .optional(),
  catalogo: z.array(itemCatalogoSchema).max(80).default([]),
});

export type Perfil = z.infer<typeof perfilSchema>;

export const TONOS: Record<Perfil['tono'], string> = {
  cercano: 'Cercano y amable, en español argentino neutro, sin jerga.',
  formal: 'Formal y profesional, de usted, claro y preciso.',
  divertido: 'Cálido, con un emoji ocasional, en español argentino neutro y sin jerga.',
};

/** Los casos que el comercio escribió para que la IA pase la charla a una persona. */
export function criterioDerivacion(raw: unknown): string {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return '';
  const valor = (raw as { derivar?: unknown }).derivar;
  return typeof valor === 'string' ? valor.trim() : '';
}

function seccion(titulo: string, contenido: string): string {
  return contenido.trim() ? `### ${titulo}\n${contenido.trim()}` : '';
}

/** Arma el prompt del negocio a partir del perfil guiado. Las secciones vacías no se incluyen. */
export function compilarPrompt(perfil: Perfil, modulos: string[]): string {
  const faq = perfil.preguntas.map((p) => `- ${p.pregunta}\n  ${p.respuesta}`).join('\n');
  const t = perfil.turnos;
  const turnos =
    t && modulos.includes('turnos')
      ? [
          t.servicios && `Servicios que se reservan: ${t.servicios}`,
          t.horarios && `Horarios disponibles para turnos: ${t.horarios}`,
          `Cada turno dura ${t.duracionMin} minutos.`,
          `Solo se toman turnos con al menos ${t.anticipacionHoras} horas de anticipación.`,
        ]
          .filter(Boolean)
          .join('\n')
      : '';
  const catalogo = perfil.catalogo
    .map((it) => {
      const medios = it.medios.map((m) => MEDIO_LABEL[m]);
      const otros = it.medios.filter((m) => m !== 'efectivo').map((m) => MEDIO_LABEL[m]);
      const precios =
        it.precioEfectivo != null && it.precioEfectivo !== it.precio && otros.length
          ? `Con ${juntar(otros)}: ${pesos(it.precio)}. En efectivo: ${pesos(it.precioEfectivo)}.`
          : it.precioEfectivo != null && it.precioEfectivo !== it.precio
            ? `Precio: ${pesos(it.precio)}. En efectivo: ${pesos(it.precioEfectivo)}.`
            : `Precio: ${pesos(it.precio)}.`;
      return [
        it.categoria ? `${it.nombre} (${it.categoria})` : it.nombre,
        it.detalle,
        precios,
        medios.length ? `Medios de pago: ${juntar(medios)}.` : '',
        it.stock != null ? `Stock: ${it.stock}.` : '',
        it.imagen ? `Foto: ${it.imagen}` : '',
      ]
        .filter(Boolean)
        .join(' ');
    })
    .join('\n');

  return [
    seccion('Qué hacemos', perfil.descripcion),
    seccion('Catálogo', catalogo),
    seccion('Productos, servicios y precios', perfil.productos),
    seccion('Horarios de atención', perfil.horarios),
    seccion('Dónde estamos', perfil.ubicacion),
    seccion('Medios de pago y envíos', perfil.pagosEnvios),
    seccion('Turnos', turnos),
    seccion('Preguntas frecuentes', faq),
    seccion('Tono', TONOS[perfil.tono]),
    seccion('Cuándo derivar automáticamente', perfil.derivar),
  ]
    .filter(Boolean)
    .join('\n\n');
}
