import { z } from 'zod';

const texto = (max: number) => z.string().trim().max(max).default('');

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
});

export type Perfil = z.infer<typeof perfilSchema>;

export const TONOS: Record<Perfil['tono'], string> = {
  cercano: 'Cercano y amable, tuteando, como alguien del local que conoce a sus clientes.',
  formal: 'Formal y profesional, tratando de usted, claro y preciso.',
  divertido: 'Divertido y con buena onda, con algún emoji ocasional, sin perder claridad.',
};

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

  return [
    seccion('Qué hacemos', perfil.descripcion),
    seccion('Productos, servicios y precios', perfil.productos),
    seccion('Horarios de atención', perfil.horarios),
    seccion('Dónde estamos', perfil.ubicacion),
    seccion('Medios de pago y envíos', perfil.pagosEnvios),
    seccion('Turnos', turnos),
    seccion('Preguntas frecuentes', faq),
    seccion('Tono', TONOS[perfil.tono]),
    seccion('Cuándo pasar con una persona', perfil.derivar),
  ]
    .filter(Boolean)
    .join('\n\n');
}
