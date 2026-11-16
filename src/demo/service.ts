import type { DemoFuente, Prisma } from '@prisma/client';
import { z } from 'zod';
import type { Deps } from '../deps';
import { TONOS } from '../ai/perfil';
import { construirMensajes, limpiarFormato } from '../ai/prompt';
import { simulacionSchema } from '../ai/simulador';
import { describirAhora } from '../lib/dates';
import { HttpError, notFound } from '../lib/errors';
import { leerMensajes } from '../tenants/defaults';
import type { TenantFull } from '../tenants/repo';
import { LIMITES, leerArchivo, leerTexto, parsearTabla, type FuenteLeida } from './fuentes';
import { FUNCIONES_DEMO, INSTRUCCIONES, procesarSalida, type SalidaDemo } from './funciones';

export const configDemoSchema = z.object({
  negocio: z.string().trim().max(120).default(''),
  funciones: z.array(z.enum(FUNCIONES_DEMO)).max(FUNCIONES_DEMO.length),
  horarios: z.string().trim().max(500).default(''),
  tono: z.enum(['cercano', 'formal', 'divertido']).default('cercano'),
});

export type ConfigDemo = z.infer<typeof configDemoSchema>;

interface EstadoDemo extends ConfigDemo {
  mensajes: number;
  ultimoUso: string | null;
}

const DEMO_INICIAL: EstadoDemo = { negocio: '', funciones: ['horarios', 'derivar'], horarios: '', tono: 'cercano', mensajes: 0, ultimoUso: null };

export function leerDemo(raw: unknown): EstadoDemo {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Partial<EstadoDemo>;
  const config = configDemoSchema.safeParse({ ...DEMO_INICIAL, ...obj });
  return {
    ...(config.success ? config.data : DEMO_INICIAL),
    mensajes: typeof obj.mensajes === 'number' ? obj.mensajes : 0,
    ultimoUso: typeof obj.ultimoUso === 'string' ? obj.ultimoUso : null,
  };
}

const nuevaFuenteSchema = z.union([
  z.object({ nombre: z.string().trim().min(1).max(120), texto: z.string().min(1).max(100_000) }),
  z.object({ nombre: z.string().trim().min(1).max(160), archivo: z.string().min(1).max(8_000_000) }),
]);

function fuenteDto(f: DemoFuente) {
  const base = { id: f.id, tipo: f.tipo, nombre: f.nombre, caracteres: f.contenido.length, filas: f.filas, createdAt: f.createdAt };
  if (f.tipo !== 'tabla') return { ...base, vista: f.contenido.slice(0, 280) };
  const [columnas = [], ...filas] = parsearTabla(f.contenido.split('\n').slice(0, 6).join('\n'));
  return { ...base, columnas, muestra: filas };
}

const listarFuentes = (deps: Deps, tenantId: string) =>
  deps.prisma.demoFuente.findMany({ where: { tenantId }, orderBy: { createdAt: 'asc' } });

export async function demoDto(deps: Deps, tenant: TenantFull) {
  const fuentes = await listarFuentes(deps, tenant.id);
  const { negocio, funciones, horarios, tono, mensajes } = leerDemo(tenant.demo);
  return {
    negocio: negocio || tenant.nombre,
    config: { negocio, funciones, horarios, tono },
    mensajes,
    fuentes: fuentes.map(fuenteDto),
    limites: { fuentes: LIMITES.fuentes, megas: LIMITES.bytesArchivo / 1024 / 1024, caracteresTotal: LIMITES.caracteresTotal },
    usados: fuentes.reduce((s, f) => s + f.contenido.length, 0),
  };
}

async function guardarFuente(deps: Deps, tenantId: string, nombre: string, leida: FuenteLeida) {
  const fuentes = await listarFuentes(deps, tenantId);
  if (fuentes.length >= LIMITES.fuentes) throw new HttpError(409, `La demo admite hasta ${LIMITES.fuentes} archivos. Borrá alguno para sumar otro.`);
  const usados = fuentes.reduce((s, f) => s + f.contenido.length, 0);
  const libre = LIMITES.caracteresTotal - usados;
  if (libre < 200) throw new HttpError(409, 'Llegaste al máximo de información de la demo. Borrá algún archivo para sumar otro.');
  await deps.prisma.demoFuente.create({
    data: { tenantId, nombre, tipo: leida.tipo, filas: leida.filas, contenido: leida.contenido.slice(0, libre) },
  });
}

export async function agregarFuente(deps: Deps, tenantId: string, raw: unknown) {
  const input = nuevaFuenteSchema.parse(raw);
  const leida = 'texto' in input ? leerTexto(input.texto) : await leerArchivo(input.nombre, input.archivo);
  await guardarFuente(deps, tenantId, input.nombre, leida);
}

export async function borrarFuente(deps: Deps, tenantId: string, id: string) {
  const { count } = await deps.prisma.demoFuente.deleteMany({ where: { id, tenantId } });
  if (!count) throw notFound('Archivo');
}

export async function guardarConfigDemo(deps: Deps, tenant: TenantFull, raw: unknown) {
  const config = configDemoSchema.parse(raw);
  const actual = leerDemo(tenant.demo);
  await deps.prisma.tenant.update({
    where: { id: tenant.id },
    data: { demo: { ...actual, ...config, funciones: [...new Set(config.funciones)] } as Prisma.InputJsonValue },
  });
}

const ETIQUETA: Record<string, string> = { tabla: 'planilla', pdf: 'PDF', texto: 'texto' };

/** Chat de la demo: usa lo cargado y las funciones prendidas, sin enviar nada ni consumir el plan. */
export async function chatDemo(deps: Deps, tenant: TenantFull, raw: unknown): Promise<SalidaDemo> {
  const { texto, historial } = simulacionSchema.parse(raw);
  const estado = leerDemo(tenant.demo);
  const fuentes = await listarFuentes(deps, tenant.id);
  const documentos = fuentes.map((f) => `### ${f.nombre} (${ETIQUETA[f.tipo] ?? f.tipo})\n${f.contenido}`).join('\n\n');
  const informacion = [
    !estado.negocio && tenant.prompt.trim(),
    documentos && `## Documentos y planillas del negocio\n${documentos}`,
    estado.horarios && `### Horarios de atención\n${estado.horarios}`,
    `### Tono\n${TONOS[estado.tono]}`,
  ]
    .filter(Boolean)
    .join('\n\n');

  const mensajes = construirMensajes({
    nombreNegocio: estado.negocio || tenant.nombre,
    promptNegocio: informacion,
    instruccionesModulos: [
      'Usá solo la información del negocio y de los documentos cargados. Si algo no figura, decí que no tenés ese dato. No inventes precios, stock, horarios ni políticas.',
      ...estado.funciones.map((f) => INSTRUCCIONES[f]),
    ],
    ahora: describirAhora(deps.now(), tenant.timezone),
    nombreContacto: '',
    historial: historial.map((h) => ({ ...h, at: '' })),
    texto,
  });
  const salida = await deps.ai.chat(deps.config.MODELO_BARATO, mensajes);
  const resultado = procesarSalida(salida, estado.funciones, leerMensajes(tenant.mensajes).handoff);

  await deps.prisma.tenant.update({
    where: { id: tenant.id },
    data: { demo: { ...estado, mensajes: estado.mensajes + 1, ultimoUso: deps.now().toISOString() } as Prisma.InputJsonValue },
  });
  return { ...resultado, texto: limpiarFormato(resultado.texto) || 'Listo.' };
}

const EJEMPLO_STOCK = [
  'producto\tcategoría\ttalle\tcolor\tprecio\tstock',
  'Remera básica\tRemeras\tS\tNegro\t$12.000\t8',
  'Remera básica\tRemeras\tM\tNegro\t$12.000\t0',
  'Remera básica\tRemeras\tL\tBlanco\t$12.000\t5',
  'Buzo canguro\tBuzos\tM\tGris\t$32.000\t3',
  'Buzo canguro\tBuzos\tL\tNegro\t$32.000\t0',
  'Jean recto\tPantalones\t38\tAzul\t$45.000\t6',
  'Jean recto\tPantalones\t40\tAzul\t$45.000\t2',
  'Campera de jean\tCamperas\tM\tCeleste\t$68.000\t1',
  'Zapatillas urbanas\tCalzado\t40\tBlanco\t$79.000\t4',
  'Zapatillas urbanas\tCalzado\t42\tBlanco\t$79.000\t0',
  'Gorra trucker\tAccesorios\tÚnico\tNegro\t$15.000\t10',
  'Medias pack x3\tAccesorios\tÚnico\tSurtido\t$7.500\t25',
].join('\n');

const EJEMPLO_POLITICAS = `Tienda Andes es una tienda de ropa urbana en Córdoba capital (Av. Colón 1234) con venta online.
Envíos: a todo el país por Correo Argentino (llega en 3 a 6 días hábiles, $6.500) y en moto dentro de Córdoba capital en el día si comprás antes de las 14 ($3.500). Envío gratis en compras desde $90.000.
Medios de pago: efectivo y transferencia con 10% de descuento, tarjetas de crédito hasta 3 cuotas sin interés, Mercado Pago.
Cambios: dentro de los 30 días con la etiqueta puesta y el ticket. No se hacen devoluciones de dinero, solo cambios o nota de crédito.
Retiro en el local sin cargo. Las reservas de productos se guardan 48 horas.`;

export async function cargarEjemplo(deps: Deps, tenant: TenantFull) {
  await deps.prisma.$transaction([
    deps.prisma.demoFuente.deleteMany({ where: { tenantId: tenant.id } }),
    deps.prisma.demoFuente.createMany({
      data: [
        { tenantId: tenant.id, tipo: 'tabla', nombre: 'stock-tienda-andes.tsv', contenido: EJEMPLO_STOCK, filas: EJEMPLO_STOCK.split('\n').length - 1 },
        { tenantId: tenant.id, tipo: 'texto', nombre: 'Envíos, pagos y cambios', contenido: EJEMPLO_POLITICAS },
      ],
    }),
    deps.prisma.tenant.update({
      where: { id: tenant.id },
      data: {
        demo: {
          ...leerDemo(tenant.demo),
          negocio: 'Tienda Andes',
          funciones: ['stock', 'horarios', 'pedidos', 'derivar'],
          horarios: 'Lunes a viernes de 10 a 20. Sábados de 10 a 14. Domingos y feriados cerrado.',
        } as Prisma.InputJsonValue,
      },
    }),
  ]);
}
