import { describe, expect, it } from 'vitest';
import { responderDesdeDatos } from '../../src/ai/charla';
import { pesos } from '../../src/ai/mediosdepago';
import { compilarPrompt, perfilSchema, type ItemCatalogo, type Perfil } from '../../src/ai/perfil';
import { MAX_HISTORIAL } from '../../src/ai/prompt';

export const HANDOFF = 'Lo comunico con una persona del local.';
export const AHORA = new Date('2026-11-22T15:00:00.000Z');
export const ZONA = 'America/Argentina/Buenos_Aires';
const MED: ItemCatalogo['medios'] = ['efectivo', 'mercadopago', 'tarjeta', 'transferencia'];
const JERGA = [/\bquerés\b/i, /\bpasás\b/i, /\bpedime\b/i, /\bmandame\b/i, /\bpor acá\b/i];

export const PLAN = {
  mensajes: ['faq', 'handoff'],
  turnos: ['faq', 'handoff', 'turnos'],
  completo: ['faq', 'handoff', 'turnos', 'recordatorios'],
  personalizado: ['faq', 'handoff', 'turnos', 'recordatorios'],
} as const;

type PlanId = keyof typeof PLAN;

export interface Local {
  id: string;
  nombre: string;
  rubro: string;
  plan: PlanId;
  tono: Perfil['tono'];
  descripcion: string;
  horarios: string;
  ubicacion: string;
  pagosEnvios: string;
  derivar: string;
  catalogo: ItemCatalogo[];
  turnos?: Perfil['turnos'];
}

interface Paso {
  cliente: string;
  incluye: string[];
  excluye?: string[];
  handoff?: boolean;
  imagen?: string;
  sinImagen?: boolean;
}

interface Escenario {
  id: string;
  titulo: string;
  rubro: string;
  plan: string;
  negocio: string;
  solucion: string;
  local: Local;
  pasos: Paso[];
}

function item(p: Partial<ItemCatalogo> & Pick<ItemCatalogo, 'nombre' | 'precio'>): ItemCatalogo {
  return {
    nombre: p.nombre,
    detalle: p.detalle ?? '',
    categoria: p.categoria ?? '',
    imagen: p.imagen ?? '',
    precio: p.precio,
    precioEfectivo: p.precioEfectivo,
    stock: p.stock === undefined ? null : p.stock,
    medios: p.medios ?? [...MED],
  };
}

function efectivo(precio: number): Pick<ItemCatalogo, 'precio' | 'precioEfectivo'> {
  return { precio, precioEfectivo: Math.round(precio * 0.9) };
}

function foto(local: string, nombre: string): string {
  const slug = nombre
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return `https://imagenes.orbita.test/${local}/${slug}.jpg`;
}

export function perfilDe(local: Local): Perfil {
  return perfilSchema.parse({
    descripcion: local.descripcion,
    horarios: local.horarios,
    ubicacion: local.ubicacion,
    pagosEnvios: local.pagosEnvios,
    tono: local.tono,
    derivar: local.derivar,
    catalogo: local.catalogo,
    turnos: local.turnos,
    productos: '',
  });
}

export function locales(): Local[] {
  const base = (parcial: Omit<Local, 'derivar' | 'descripcion'> & { descripcion?: string }): Local => ({
    derivar: 'Reclamos, quejas y pedidos de factura.',
    descripcion: parcial.descripcion ?? `${parcial.nombre} atiende por WhatsApp con precios y stock cargados.`,
    ...parcial,
  });
  return [
    base({
      id: 'parrilla',
      nombre: 'La Parrilla del Puerto',
      rubro: 'Restaurante',
      plan: 'completo',
      tono: 'cercano',
      horarios: 'Martes a domingo de 12 a 15 y de 20 a 00.',
      ubicacion: 'Av. Caseros 1450, San Telmo',
      pagosEnvios: 'Envío en moto por CABA $2.500. Gratis desde $25.000. Demora de 40 a 70 minutos.',
      turnos: { servicios: 'Reserva de mesa', horarios: 'Martes a domingo', duracionMin: 90, anticipacionHoras: 2 },
      catalogo: [
        item({ nombre: 'Milanesa napolitana', ...efectivo(18900), stock: 6, categoria: 'plato', imagen: foto('parrilla', 'milanesa'), detalle: 'Milanesa con jamón, queso y salsa. Lleva huevo y gluten.' }),
        item({ nombre: 'Suprema napolitana', ...efectivo(16000), stock: 4, categoria: 'plato', imagen: foto('parrilla', 'suprema'), detalle: 'Pechuga con jamón y queso.' }),
        item({ nombre: 'Rabas', ...efectivo(14500), stock: 0, categoria: 'entrada', imagen: foto('parrilla', 'rabas'), detalle: 'Rabas fritas.' }),
        item({ nombre: 'Aritos de cebolla', ...efectivo(7000), stock: 8, categoria: 'entrada', imagen: foto('parrilla', 'aritos'), detalle: 'Aros de cebolla fritos.' }),
        item({ nombre: 'Flan casero', ...efectivo(5500), stock: 10, categoria: 'postre', imagen: foto('parrilla', 'flan'), detalle: 'Lleva huevo y leche.' }),
        item({ nombre: 'Ensalada completa', ...efectivo(9500), stock: 7, categoria: 'plato', imagen: foto('parrilla', 'ensalada'), detalle: 'Lechuga, tomate y huevo.' }),
      ],
    }),
    base({
      id: 'sushi',
      nombre: 'Sushi Bar Norte',
      rubro: 'Restaurante',
      plan: 'mensajes',
      tono: 'formal',
      horarios: 'Miércoles a domingo de 19 a 00.',
      ubicacion: 'Av. Cabildo 2200, Belgrano',
      pagosEnvios: 'Envío propio en Belgrano y Núñez, $3.200. Demora de 50 minutos.',
      catalogo: [
        item({ nombre: 'Roll New York', ...efectivo(14500), stock: 12, categoria: 'roll', imagen: foto('sushi', 'newyork'), detalle: 'Salmón, palta y queso.' }),
        item({ nombre: 'Roll Buenos Aires', ...efectivo(13200), stock: 9, categoria: 'roll', imagen: foto('sushi', 'baires'), detalle: 'Langostino y phila.' }),
        item({ nombre: 'Niguiri de salmón', ...efectivo(9800), stock: 0, categoria: 'niguiri', imagen: foto('sushi', 'nigiri'), detalle: 'Dos piezas de salmón.' }),
        item({ nombre: 'Niguiri de langostino', ...efectivo(11000), stock: 6, categoria: 'niguiri', imagen: foto('sushi', 'langostino'), detalle: 'Dos piezas de langostino.' }),
      ],
    }),
    base({
      id: 'heladeria',
      nombre: 'Heladería Frío Sur',
      rubro: 'Heladería',
      plan: 'mensajes',
      tono: 'divertido',
      horarios: 'Todos los días de 12 a 00.',
      ubicacion: 'Calle 12 nro 450, La Plata',
      pagosEnvios: 'Envío en la ciudad $1.800. Gratis desde $15.000.',
      catalogo: [
        item({ nombre: 'Dulce de leche granizado', ...efectivo(6500), stock: 20, categoria: 'pote', imagen: foto('helado', 'ddl'), detalle: 'Pote de medio kilo.' }),
        item({ nombre: 'Chocolate amargo', ...efectivo(6500), stock: 15, categoria: 'pote', imagen: foto('helado', 'chocolate'), detalle: 'Pote de medio kilo.' }),
        item({ nombre: 'Limón natural', ...efectivo(6000), stock: 0, categoria: 'pote', imagen: foto('helado', 'limon'), detalle: 'Pote de medio kilo.' }),
        item({ nombre: 'Frutilla a la crema', ...efectivo(6800), stock: 11, categoria: 'pote', imagen: foto('helado', 'frutilla'), detalle: 'Pote de medio kilo.' }),
      ],
    }),
    base({
      id: 'panaderia',
      nombre: 'Panadería La Espiga',
      rubro: 'Panadería',
      plan: 'mensajes',
      tono: 'cercano',
      horarios: 'Todos los días de 7 a 13 y de 16 a 20.',
      ubicacion: 'Av. San Martín 800, Quilmes',
      pagosEnvios: 'Reparto en el barrio $1.200, por la mañana.',
      catalogo: [
        item({ nombre: 'Docena de medialunas', ...efectivo(4800), stock: 30, categoria: 'factura', imagen: foto('pan', 'medialunas'), detalle: 'Medialunas de manteca.' }),
        item({ nombre: 'Pan francés', ...efectivo(2200), stock: 18, categoria: 'pan', imagen: foto('pan', 'frances'), detalle: 'Flauta crocante.' }),
        item({ nombre: 'Torta rogel', ...efectivo(18000), stock: 2, categoria: 'torta', imagen: foto('pan', 'rogel'), detalle: 'Para 8 porciones. Lleva dulce de leche.' }),
      ],
    }),
    base({
      id: 'andes',
      nombre: 'Tienda Andes',
      rubro: 'Indumentaria',
      plan: 'completo',
      tono: 'cercano',
      horarios: 'Lunes a viernes de 10 a 20. Sábados de 10 a 14.',
      ubicacion: 'Av. Colón 1234, Córdoba',
      pagosEnvios: 'Envío a todo el país $6.500. En Córdoba capital, $3.500. Gratis desde $90.000.',
      turnos: { servicios: 'Prueba en el local', horarios: 'Lunes a sábado', duracionMin: 30, anticipacionHoras: 2 },
      catalogo: [
        item({ nombre: 'Remera negra talle M', ...efectivo(12000), stock: 0, categoria: 'remera', imagen: foto('andes', 'remera-m'), detalle: 'Algodón negro, talle M.' }),
        item({ nombre: 'Remera negra talle L', ...efectivo(12000), stock: 5, categoria: 'remera', imagen: foto('andes', 'remera-l'), detalle: 'Algodón negro, talle L.' }),
        item({ nombre: 'Jean recto talle 40', ...efectivo(45000), stock: 2, categoria: 'jean', imagen: foto('andes', 'jean'), detalle: 'Jean azul, talle 40.' }),
        item({ nombre: 'Buzo canguro gris', ...efectivo(32000), stock: 3, categoria: 'buzo', imagen: foto('andes', 'buzo'), detalle: 'Buzo gris, talle M.' }),
      ],
    }),
    base({
      id: 'ferreteria',
      nombre: 'Ferretería El Tornillo',
      rubro: 'Ferretería',
      plan: 'turnos',
      tono: 'cercano',
      horarios: 'Lunes a viernes de 8 a 18. Sábados de 8 a 13.',
      ubicacion: 'Av. Rivadavia 5400, Caballito',
      pagosEnvios: 'Envío en CABA $4.000 para compras menores a $40.000.',
      turnos: { servicios: 'Instalación a domicilio', horarios: 'Lunes a viernes', duracionMin: 60, anticipacionHoras: 2 },
      catalogo: [
        item({ nombre: 'Taladro percutor', ...efectivo(89000), stock: 4, categoria: 'herramienta', imagen: foto('ferre', 'taladro'), detalle: 'Taladro de 700 watts.' }),
        item({ nombre: 'Caja de tornillos', ...efectivo(3500), stock: 40, categoria: 'insumo', imagen: foto('ferre', 'tornillos'), detalle: 'Surtido de 200 unidades.' }),
        item({ nombre: 'Instalación de termotanque', precio: 45000, stock: null, categoria: 'servicio', detalle: 'Colocación en domicilio, sin materiales.' }),
      ],
    }),
    base({
      id: 'farmacia',
      nombre: 'Farmacia del Centro',
      rubro: 'Farmacia',
      plan: 'mensajes',
      tono: 'formal',
      horarios: 'Lunes a viernes de 9 a 20. Sábados de 9 a 13.',
      ubicacion: 'San Martín 250, Rosario',
      pagosEnvios: 'Entrega en el microcentro $1.500. No se envían medicamentos que requieren receta fuera de la ciudad.',
      catalogo: [
        item({ nombre: 'Ibuprofeno 400', ...efectivo(2800), stock: 25, categoria: 'medicamento', imagen: foto('farmacia', 'ibuprofeno'), detalle: 'Caja de 10 comprimidos. No reemplaza la consulta médica.', medios: ['efectivo', 'debito', 'mercadopago'] }),
        item({ nombre: 'Alcohol en gel', ...efectivo(1900), stock: 0, categoria: 'higiene', imagen: foto('farmacia', 'alcohol'), detalle: 'Envase de 250 ml.', medios: ['efectivo', 'debito', 'mercadopago'] }),
        item({ nombre: 'Alcohol líquido', ...efectivo(1600), stock: 14, categoria: 'higiene', imagen: foto('farmacia', 'liquido'), detalle: 'Envase de 250 ml.', medios: ['efectivo', 'debito', 'mercadopago'] }),
      ],
    }),
    base({
      id: 'peluqueria',
      nombre: 'Peluquería Corte Fino',
      rubro: 'Peluquería',
      plan: 'turnos',
      tono: 'cercano',
      horarios: 'Martes a sábado de 10 a 19.',
      ubicacion: 'Av. Santa Fe 3100, Palermo',
      pagosEnvios: 'La atención es en el local. No hay envíos.',
      turnos: { servicios: 'Corte y color', horarios: 'Martes a sábado de 10 a 19', duracionMin: 45, anticipacionHoras: 2 },
      catalogo: [
        item({ nombre: 'Corte clásico', ...efectivo(12000), stock: null, categoria: 'servicio', detalle: 'Corte y secado.' }),
        item({ nombre: 'Color completo', ...efectivo(28000), stock: null, categoria: 'servicio', detalle: 'Color y brushing.' }),
      ],
    }),
    base({
      id: 'odonto',
      nombre: 'Odontología Sonrisa',
      rubro: 'Odontología',
      plan: 'completo',
      tono: 'formal',
      horarios: 'Lunes a viernes de 9 a 18.',
      ubicacion: 'Calle Mendoza 120, Mendoza',
      pagosEnvios: 'La consulta se abona en el consultorio.',
      turnos: { servicios: 'Limpieza y consulta', horarios: 'Lunes a viernes', duracionMin: 40, anticipacionHoras: 4 },
      catalogo: [
        item({ nombre: 'Limpieza dental', ...efectivo(22000), stock: null, categoria: 'servicio', detalle: 'Limpieza y control.' }),
        item({ nombre: 'Consulta de urgencia', precio: 15000, stock: null, categoria: 'servicio', detalle: 'Evaluación del dolor.' }),
      ],
    }),
    base({
      id: 'vet',
      nombre: 'Veterinaria Huella',
      rubro: 'Veterinaria',
      plan: 'turnos',
      tono: 'cercano',
      horarios: 'Lunes a sábado de 9 a 20.',
      ubicacion: 'Av. Mitre 900, Avellaneda',
      pagosEnvios: 'Las consultas son en la clínica.',
      turnos: { servicios: 'Consulta clínica', horarios: 'Lunes a sábado', duracionMin: 30, anticipacionHoras: 2 },
      catalogo: [
        item({ nombre: 'Consulta clínica', ...efectivo(15000), stock: null, categoria: 'servicio', detalle: 'Revisión general.' }),
        item({ nombre: 'Vacuna séxtuple', ...efectivo(18000), stock: 8, categoria: 'vacuna', imagen: foto('vet', 'vacuna'), detalle: 'Vacuna para perros.' }),
      ],
    }),
    base({
      id: 'pet',
      nombre: 'Pet Shop Ladrido',
      rubro: 'Pet shop',
      plan: 'mensajes',
      tono: 'cercano',
      horarios: 'Lunes a sábado de 10 a 20.',
      ubicacion: 'Av. Maipú 1500, Vicente López',
      pagosEnvios: 'Envío en zona norte $2.800. Gratis desde $30.000.',
      catalogo: [
        item({ nombre: 'Alimento adulto 15 kilos', ...efectivo(42000), stock: 7, categoria: 'alimento', imagen: foto('pet', 'alimento'), detalle: 'Bolsa de 15 kilos para perro adulto.' }),
        item({ nombre: 'Piedras sanitarias', ...efectivo(8500), stock: 0, categoria: 'higiene', imagen: foto('pet', 'piedras'), detalle: 'Bolsa de 4 kilos.' }),
        item({ nombre: 'Arena aglomerante', ...efectivo(9200), stock: 6, categoria: 'higiene', imagen: foto('pet', 'arena'), detalle: 'Bolsa de 4 kilos.' }),
      ],
    }),
    base({
      id: 'floreria',
      nombre: 'Florería Pétalo',
      rubro: 'Florería',
      plan: 'mensajes',
      tono: 'divertido',
      horarios: 'Lunes a sábado de 9 a 20.',
      ubicacion: 'Av. Pellegrini 1800, Rosario',
      pagosEnvios: 'Envío en el día dentro de Rosario, $3.000.',
      catalogo: [
        item({ nombre: 'Ramo de rosas', ...efectivo(18000), stock: 5, categoria: 'ramo', imagen: foto('flor', 'rosas'), detalle: 'Doce rosas rojas.' }),
        item({ nombre: 'Bouquet de estación', ...efectivo(15000), stock: 4, categoria: 'ramo', imagen: foto('flor', 'bouquet'), detalle: 'Flores de estación.' }),
      ],
    }),
    base({
      id: 'gym',
      nombre: 'Gimnasio Fuerza',
      rubro: 'Gimnasio',
      plan: 'personalizado',
      tono: 'cercano',
      horarios: 'Lunes a viernes de 7 a 22. Sábados de 9 a 13.',
      ubicacion: 'Av. Libertador 4000, Núñez',
      pagosEnvios: 'La actividad es en la sede. No hay envíos.',
      turnos: { servicios: 'Clase de prueba', horarios: 'Lunes a viernes', duracionMin: 60, anticipacionHoras: 4 },
      catalogo: [
        item({ nombre: 'Musculación mensual', ...efectivo(35000), stock: null, categoria: 'servicio', detalle: 'Acceso libre a la sala.' }),
        item({ nombre: 'Plan full', ...efectivo(48000), stock: null, categoria: 'servicio', detalle: 'Sala y clases.' }),
      ],
    }),
    base({
      id: 'taller',
      nombre: 'Taller Ruta 8',
      rubro: 'Taller mecánico',
      plan: 'turnos',
      tono: 'cercano',
      horarios: 'Lunes a viernes de 8 a 17.',
      ubicacion: 'Ruta 8 km 42, Pilar',
      pagosEnvios: 'El vehículo se deja en el taller. No hay envío.',
      turnos: { servicios: 'Service y diagnóstico', horarios: 'Lunes a viernes de 8 a 17', duracionMin: 60, anticipacionHoras: 2 },
      catalogo: [
        item({ nombre: 'Service de aceite', ...efectivo(65000), stock: null, categoria: 'servicio', detalle: 'Cambio de aceite y filtro.' }),
        item({ nombre: 'Diagnóstico electrónico', precio: 25000, stock: null, categoria: 'servicio', detalle: 'Lectura de la computadora del auto.' }),
      ],
    }),
    base({
      id: 'vinoteca',
      nombre: 'Vinoteca Copa',
      rubro: 'Vinoteca',
      plan: 'completo',
      tono: 'formal',
      horarios: 'Lunes a sábado de 11 a 20.',
      ubicacion: 'Av. Alvear 1700, Recoleta',
      pagosEnvios: 'Envío en CABA $3.500. Interior por correo, según destino.',
      turnos: { servicios: 'Degustación', horarios: 'Jueves y viernes de 18 a 20', duracionMin: 60, anticipacionHoras: 2 },
      catalogo: [
        item({ nombre: 'Malbec reserva', ...efectivo(14500), stock: 18, categoria: 'vino', imagen: foto('vino', 'malbec'), detalle: 'Botella de 750 ml, Valle de Uco.' }),
        item({ nombre: 'Chardonnay de guarda', ...efectivo(16000), stock: 0, categoria: 'vino', imagen: foto('vino', 'chardonnay'), detalle: 'Botella de 750 ml.' }),
        item({ nombre: 'Cabernet joven', ...efectivo(9800), stock: 10, categoria: 'vino', imagen: foto('vino', 'cabernet'), detalle: 'Botella de 750 ml.' }),
      ],
    }),
  ];
}

function cierreDe(local: Local, servicio: boolean): string {
  if (servicio) return local.tono === 'divertido' ? '¿Lo reservamos?' : '¿Desea reservarlo?';
  return local.tono === 'divertido' ? '¿Lo retira en el local o se lo enviamos?' : '¿Prefiere retirarlo en el local o recibirlo por envío?';
}

function historias(local: Local): Escenario[] {
  const out: Escenario[] = [];
  const add = (titulo: string, solucion: string, pasos: Paso[]) => {
    out.push({ id: `${local.id}-${out.length + 1}`, titulo: `${local.nombre}: ${titulo}`, solucion, rubro: local.rubro, plan: local.plan, negocio: local.nombre, local, pasos });
  };
  const principal = local.catalogo.find((it) => it.stock !== 0 && it.imagen) ?? local.catalogo.find((it) => it.stock !== 0) ?? local.catalogo[0];
  const agotado = local.catalogo.find((it) => it.stock === 0);
  const conStock = local.catalogo.find((it) => it.stock != null && it.stock > 1);
  const servicio = principal.categoria === 'servicio';

  add(`Piden ${principal.nombre}`, 'Ficha con foto, precio de lista, precio en efectivo y medios de pago. El catálogo de Botmaker muestra el mismo conjunto: imagen, precio y stock.', [
    {
      cliente: `¿Tiene ${principal.nombre}?`,
      incluye: [
        principal.nombre,
        ...(principal.detalle ? [principal.detalle] : []),
        ...(principal.imagen ? [`Foto: ${principal.imagen}`] : []),
        ...(principal.precioEfectivo != null ? [`En efectivo: ${pesos(principal.precioEfectivo)}.`, pesos(principal.precio)] : [`Precio: ${pesos(principal.precio)}.`]),
        'Medios de pago:',
        ...(principal.stock != null && principal.stock > 0 ? [`Hay ${principal.stock} unidades disponibles.`] : []),
        cierreDe(local, servicio),
      ],
      imagen: principal.imagen || undefined,
      sinImagen: !principal.imagen,
      handoff: false,
    },
  ]);

  add(`Consultan el precio de ${principal.nombre}`, 'Precio de lista y, si existe, precio en efectivo, sin inventar un descuento.', [
    {
      cliente: `¿Cuánto sale ${principal.nombre}?`,
      incluye: [principal.nombre, pesos(principal.precio), ...(principal.precioEfectivo != null ? [`En efectivo: ${pesos(principal.precioEfectivo)}.`] : [])],
      sinImagen: true,
    },
  ]);

  if (principal.precioEfectivo != null && principal.precioEfectivo !== principal.precio) {
    add(`Piden el precio en efectivo de ${principal.nombre}`, 'Doble precio: efectivo y otros medios, como en la cartelería local.', [
      {
        cliente: `¿Cuál es el precio en efectivo de ${principal.nombre}?`,
        incluye: [`En efectivo, ${principal.nombre} cuesta ${pesos(principal.precioEfectivo)}.`, pesos(principal.precio)],
        sinImagen: true,
      },
    ]);
  }

  if (principal.imagen) {
    add(`Piden la foto de ${principal.nombre}`, 'La foto sale junto con el nombre. En WhatsApp e Instagram se manda como imagen; en TikTok, como enlace.', [
      { cliente: `¿Me envía la foto de ${principal.nombre}?`, incluye: [principal.nombre, `Foto: ${principal.imagen}`], imagen: principal.imagen },
    ]);
  }

  if (conStock && conStock.stock != null) {
    add(`Consultan el stock de ${conStock.nombre}`, 'El stock se lee del catálogo y no se estima.', [
      { cliente: `¿Cuánto queda de ${conStock.nombre}?`, incluye: [`Hay ${conStock.stock} unidades de ${conStock.nombre}.`], sinImagen: true },
    ]);
    add(`Encargan 2 de ${conStock.nombre}`, 'El total sale de la cantidad por el precio de lista.', [
      {
        cliente: `Quiero 2 ${conStock.nombre}`,
        incluye: [`El total de 2 ${conStock.nombre} con los otros medios de pago es ${pesos(conStock.precio * 2)}.`],
        handoff: false,
      },
    ]);
  }

  if (agotado) {
    const alternativa = local.catalogo.find((it) => it.nombre !== agotado.nombre && it.categoria === agotado.categoria && it.stock !== 0);
    add(`${agotado.nombre} está agotado`, 'Si el stock es 0, se dice y se ofrece una alternativa de la misma categoría.', [
      {
        cliente: `¿Tiene ${agotado.nombre}?`,
        incluye: [`En este momento no hay ${agotado.nombre}.`, ...(alternativa ? [alternativa.nombre] : [])],
        excluye: [`Hay ${agotado.stock} unidades`],
      },
    ]);
  }

  add('Hacen un reclamo', 'El reclamo se deriva a una persona, como el pase a un agente de Botmaker.', [
    { cliente: 'Quiero hacer un reclamo: el pedido llegó frío.', incluye: [HANDOFF], excluye: [pesos(principal.precio)], handoff: true },
  ]);
  add('Piden hablar con una persona', 'Si piden una persona, la charla se deriva.', [
    { cliente: 'Necesito hablar con una persona.', incluye: [HANDOFF], handoff: true },
  ]);
  add('Piden un producto que no existe', 'No se inventa un producto ni un precio.', [
    { cliente: '¿Tienen zafiro lunar?', incluye: ['Ese producto no está en el catálogo.', local.catalogo[0].nombre], handoff: false },
  ]);
  add('Preguntan el horario', 'El horario sale del perfil, sin completar datos que no están.', [
    { cliente: '¿A qué hora abren?', incluye: [`El horario de atención es: ${local.horarios}`], sinImagen: true },
  ]);
  add('Preguntan la dirección', 'La dirección sale del perfil.', [
    { cliente: '¿Cuál es la dirección?', incluye: [`La dirección es ${local.ubicacion}.`], sinImagen: true },
  ]);
  add('Preguntan los medios de pago', 'Se enumeran los medios cargados. El cobro queda en el medio externo, igual que en WhatsApp Payments.', [
    { cliente: '¿Qué medios de pago tienen?', incluye: ['Puede pagar con', 'efectivo'], sinImagen: true },
  ]);
  add('Preguntan por el envío', 'La respuesta usa el texto de envíos cargado.', [
    { cliente: '¿Hacen envíos a domicilio?', incluye: ['Sobre el envío:', local.pagosEnvios.slice(0, 24)], sinImagen: true },
  ]);
  add('Preguntan por la demora', 'La demora no se inventa: se repite el dato cargado.', [
    { cliente: '¿Tarda mucho?', incluye: ['Sobre la demora:'], sinImagen: true, handoff: false },
  ]);
  add('Saludan', 'El saludo se presenta como asistente del comercio, en registro neutro.', [
    { cliente: 'Hola', incluye: [`Soy el asistente de ${local.nombre}`, 'Puedo informarle'], sinImagen: true },
  ]);
  add('Piden factura', 'La factura se deriva a una persona del local.', [
    { cliente: 'Necesito una factura.', incluye: [HANDOFF], handoff: true },
  ]);

  if (local.plan === 'mensajes') {
    add('Piden un turno y el plan no lo reserva', 'Sin el módulo de turnos, la reserva la confirma una persona.', [
      { cliente: 'Quiero un turno para mañana a las 10.', incluye: [HANDOFF, 'La reserva la confirma una persona del local.'], excluye: ['[TURNO_RESERVAR'], handoff: true },
    ]);
  } else {
    add('Reservan un turno para mañana a las 10', 'Con el módulo de turnos, la charla deja la reserva fechada.', [
      {
        cliente: 'Quiero un turno para mañana a las 10.',
        incluye: ['El turno queda reservado para el 2026-11-23 a las 10:00.', '[TURNO_RESERVAR 2026-11-23 10:00]', ...(local.plan === 'completo' || local.plan === 'personalizado' ? ['El día anterior enviamos un recordatorio.'] : [])],
        excluye: local.plan === 'turnos' ? ['El día anterior enviamos un recordatorio.'] : [],
        handoff: false,
      },
    ]);
    add('Piden un turno para hoy con poca anticipación', 'No se agenda un horario más cercano que la anticipación cargada.', [
      { cliente: 'Quiero un turno para hoy a las 13.', incluye: ['anticipación'], handoff: false, sinImagen: true },
    ]);
  }

  if (principal.precioEfectivo != null && principal.precioEfectivo < principal.precio) {
    add(`Objetan el precio de ${principal.nombre}`, 'La objeción se responde con el precio en efectivo y no se deriva.', [
      { cliente: `¿Tiene ${principal.nombre}?`, incluye: [principal.nombre] },
      {
        cliente: 'Me parece muy caro.',
        incluye: [`En efectivo, ${principal.nombre} cuesta ${pesos(principal.precioEfectivo)}.`, pesos(principal.precio)],
        excluye: [HANDOFF],
        handoff: false,
      },
    ]);
  }

  if (principal.imagen) {
    add(`Piden el precio y después la foto de ${principal.nombre}`, 'La foto se envía cuando la piden, aunque el precio ya se haya informado.', [
      { cliente: `¿Cuánto sale ${principal.nombre}?`, incluye: [pesos(principal.precio)], sinImagen: true },
      { cliente: '¿Me envía la foto?', incluye: [`Foto: ${principal.imagen}`], imagen: principal.imagen },
    ]);
  }

  const carta = ['Restaurante', 'Heladería', 'Panadería', 'Vinoteca'].includes(local.rubro);
  if (carta) {
    add('Piden la carta', 'La carta lista los productos. La foto se manda cuando eligen uno, no como carrusel.', [
      { cliente: '¿Me pasa la carta?', incluye: [local.catalogo[0].nombre, local.catalogo[1].nombre, local.tono === 'divertido' ? 'Dígame cuál y le envío la foto.' : 'Indique un producto y le envío la foto.'], sinImagen: true },
    ]);
  }

  return out;
}

function extras(todos: Local[]): Escenario[] {
  const parrilla = todos.find((l) => l.id === 'parrilla')!;
  const andes = todos.find((l) => l.id === 'andes')!;
  const farmacia = todos.find((l) => l.id === 'farmacia')!;
  const flan = parrilla.catalogo.find((it) => it.nombre === 'Flan casero')!;
  const milanesa = parrilla.catalogo.find((it) => it.nombre === 'Milanesa napolitana')!;
  const remera = andes.catalogo.find((it) => it.nombre === 'Remera negra talle L')!;
  const ibu = farmacia.catalogo.find((it) => it.nombre === 'Ibuprofeno 400')!;
  const base = (id: string, titulo: string, solucion: string, local: Local, pasos: Paso[]): Escenario => ({
    id, titulo, solucion, rubro: local.rubro, plan: local.plan, negocio: local.nombre, local, pasos,
  });
  return [
    base('parrilla-gluten', 'Preguntan si la milanesa tiene gluten', 'Si el dato está en la ficha, se responde. No se inventa un alérgeno.', parrilla, [
      { cliente: '¿La milanesa napolitana tiene gluten?', incluye: ['Sí.', 'huevo y gluten'], handoff: false, sinImagen: true },
    ]),
    base('parrilla-vegano', 'Preguntan si el flan es vegano', 'Si el dato no está en la ficha, se dice y se deriva.', parrilla, [
      { cliente: '¿El flan casero es vegano?', incluye: ['Ese dato no está en la ficha.', HANDOFF], handoff: true },
    ]),
    base('parrilla-dos', 'Piden milanesa y flan en el mismo mensaje', 'Dos productos del catálogo se informan juntos. La foto que se adjunta es la del primero.', parrilla, [
      {
        cliente: 'Quiero milanesa napolitana y flan casero.',
        incluye: ['Milanesa napolitana', 'Flan casero', pesos(milanesa.precio), pesos(flan.precio)],
        imagen: milanesa.imagen,
      },
    ]),
    base('parrilla-efectivo-dos', 'Confirman dos milanesas en efectivo', 'La cantidad usa el precio en efectivo cuando lo piden en el mismo mensaje.', parrilla, [
      {
        cliente: 'Quiero 2 milanesa napolitana en efectivo.',
        incluye: [`El total de 2 Milanesa napolitana en efectivo es ${pesos((milanesa.precioEfectivo ?? 0) * 2)}.`],
        handoff: false,
      },
    ]),
    base('parrilla-memoria', 'Después de muchos mensajes ya no recuerda el primer plato', 'La charla usa los últimos 10 mensajes. Un dato anterior no se inventa.', parrilla, [
      { cliente: 'Quiero el flan casero.', incluye: ['Flan casero', pesos(flan.precio)] },
      { cliente: '¿A qué hora abren?', incluye: ['El horario de atención es:'] },
      { cliente: '¿Cuál es la dirección?', incluye: ['La dirección es'] },
      { cliente: 'Hola', incluye: ['Soy el asistente de'] },
      { cliente: '¿Hacen envíos a domicilio?', incluye: ['Sobre el envío:'] },
      { cliente: 'Buenas tardes', incluye: ['Soy el asistente de'] },
      { cliente: '¿Y en efectivo?', incluye: ['¿De qué producto necesita el precio en efectivo?'], excluye: ['Flan casero', pesos(flan.precioEfectivo ?? 0)], sinImagen: true },
    ]),
    base('andes-talle', 'El talle M no tiene stock y se ofrece el L', 'La alternativa es otra variante con stock, no un talle agotado.', andes, [
      { cliente: '¿Tiene remera negra talle M?', incluye: ['En este momento no hay Remera negra talle M.', 'Remera negra talle L'], excluye: ['Hay 0 unidades'] },
    ]),
    base('andes-excede', 'Piden más remeras de las que hay', 'No se confirma una cantidad mayor al stock.', andes, [
      { cliente: 'Quiero 8 remera negra talle L.', incluye: ['Solo hay 5 unidades de Remera negra talle L.'], excluye: [pesos(remera.precio * 8)] },
    ]),
    base('farmacia-tarjeta', 'Quieren pagar el ibuprofeno con tarjeta', 'Si ese medio no está cargado para el producto, se dice y se listan los disponibles.', farmacia, [
      { cliente: '¿Puedo pagar el ibuprofeno 400 con tarjeta?', incluye: ['no admite pago con tarjeta', 'débito', 'Mercado Pago'], excluye: [HANDOFF], handoff: false },
    ]),
    base('farmacia-stock-nulo', 'Consultan stock de un servicio sin stock cargado', 'Si el producto no lleva stock, no se inventa una cantidad.', farmacia, [
      { cliente: '¿Cuánto queda de ibuprofeno 400?', incluye: [`Hay ${ibu.stock} unidades de Ibuprofeno 400.`] },
    ]),
  ];
}

function armarEscenarios(): Escenario[] {
  const todos = locales();
  return [...todos.flatMap(historias), ...extras(todos)];
}

interface PasoHecho extends Paso {
  textoBot: string;
  imagenBot?: string;
  handoffBot: boolean;
  error: string;
}

interface Resultado {
  escenario: Escenario;
  pasos: PasoHecho[];
  ok: boolean;
  error: string;
}

function correr(escenario: Escenario): Resultado {
  const historial: { rol: 'user' | 'assistant'; texto: string }[] = [];
  const pasos: PasoHecho[] = [];
  let error = '';
  for (const paso of escenario.pasos) {
    const respuesta = responderDesdeDatos({
      nombreNegocio: escenario.local.nombre,
      perfil: perfilDe(escenario.local),
      modulos: [...PLAN[escenario.local.plan]],
      nombreCliente: 'Ana',
      texto: paso.cliente,
      historial,
      textoHandoff: HANDOFF,
      ahora: AHORA,
      timezone: ZONA,
    });
    const hecho: PasoHecho = { ...paso, textoBot: respuesta?.texto ?? '', imagenBot: respuesta?.imagen, handoffBot: Boolean(respuesta?.handoff), error: '' };
    try {
      if (!respuesta) throw new Error('no contestó');
      for (const malo of JERGA) if (malo.test(respuesta.texto)) throw new Error(`jerga: ${malo}`);
      for (const parte of paso.incluye) if (!respuesta.texto.includes(parte)) throw new Error(`falta: ${parte}`);
      for (const parte of paso.excluye ?? []) if (respuesta.texto.includes(parte)) throw new Error(`no debía decir: ${parte}`);
      if ((paso.handoff ?? false) !== respuesta.handoff) throw new Error(`derivación ${respuesta.handoff}`);
      if (paso.imagen && respuesta.imagen !== paso.imagen) throw new Error(`foto ${respuesta.imagen ?? 'sin foto'}`);
      if (paso.sinImagen && respuesta.imagen) throw new Error('mandó una foto que no correspondía');
    } catch (e) {
      hecho.error = e instanceof Error ? e.message : String(e);
      error = hecho.error;
    }
    pasos.push(hecho);
    if (respuesta) {
      historial.push({ rol: 'user', texto: paso.cliente }, { rol: 'assistant', texto: respuesta.texto });
      while (historial.length > MAX_HISTORIAL) historial.shift();
    }
    if (error) break;
  }
  return { escenario, pasos, ok: !error, error };
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function informe(resultados: Resultado[]): string {
  const ok = resultados.filter((r) => r.ok).length;
  const grupos = new Map<string, Resultado[]>();
  for (const r of resultados) {
    const lista = grupos.get(r.escenario.rubro) ?? [];
    lista.push(r);
    grupos.set(r.escenario.rubro, lista);
  }
  const cartas = resultados
    .map((r, i) => {
      const n = String(i + 1).padStart(3, '0');
      const burbujas = r.pasos
        .map((p) => {
          const fotoBot = p.imagenBot ? `<img src="${esc(p.imagenBot)}" alt="">` : '';
          return `<div class="turno"><p class="quien">Cliente</p><div class="burbuja cliente">${esc(p.cliente)}</div><p class="quien">Asistente${p.handoffBot ? ' · deriva' : ''}</p><div class="burbuja bot">${fotoBot}${esc(p.textoBot || '—')}</div>${p.error ? `<p class="error">${esc(p.error)}</p>` : ''}</div>`;
        })
        .join('');
      return `<article class="${r.ok ? 'ok' : 'mal'}" id="c${n}"><header><span class="n">${n}</span><span class="grupo">${esc(r.escenario.rubro)} · Plan ${esc(r.escenario.plan)}</span><strong>${esc(r.escenario.titulo)}</strong><span class="estado">${r.ok ? 'Pasó' : 'Falló'}</span></header><p class="negocio">${esc(r.escenario.negocio)}</p><p class="solucion">${esc(r.escenario.solucion)}</p>${burbujas}</article>`;
    })
    .join('');
  const indice = [...grupos.entries()]
    .map(([rubro, lista]) => `<div><b>${lista.filter((r) => r.ok).length}/${lista.length}</b> ${esc(rubro)}</div>`)
    .join('');
  return `<!DOCTYPE html>
<html lang="es"><head><meta charset="utf-8"><title>Auditoría de charlas</title>
<style>
  :root { --ok:#1f9d55; --mal:#d0342c; --linea:#e4e0d8; --tinta:#241f1a; --papel:#f7f4ee; }
  body { margin:0; font:16px/1.45 Georgia, serif; color:var(--tinta); background:var(--papel); }
  header.top, main { max-width:880px; margin:0 auto; padding:1.5rem; }
  .resumen, .indice { display:flex; gap:.75rem; flex-wrap:wrap; }
  .resumen div, .indice div { background:#fff; border:1px solid var(--linea); border-radius:10px; padding:.6rem .8rem; }
  article { background:#fff; border:1px solid var(--linea); border-radius:12px; padding:1rem; margin:0 0 1rem; }
  article header { display:flex; gap:.6rem; align-items:baseline; flex-wrap:wrap; }
  .n { font-weight:700; color:#6b645b; }
  .grupo, .negocio, .solucion { color:#6b645b; }
  .estado { margin-left:auto; font-weight:700; }
  article.ok .estado { color:var(--ok); }
  article.mal .estado { color:var(--mal); }
  .turno { margin-top:.8rem; }
  .quien { margin:0 0 .2rem; font-size:.75rem; letter-spacing:.04em; text-transform:uppercase; color:#6b645b; }
  .burbuja { white-space:pre-wrap; border-radius:12px; padding:.55rem .75rem; margin:0 0 .35rem; }
  .cliente { background:#efeae2; }
  .bot { background:#e7f6ee; }
  .burbuja img { display:block; max-width:180px; border-radius:8px; margin-bottom:.4rem; }
  .error { color:var(--mal); }
  .nota { background:#fff; border:1px solid var(--linea); border-radius:12px; padding:1rem; }
</style></head>
<body>
<header class="top">
  <h1>Auditoría de charlas</h1>
  <p>Conversaciones con comercios inventados. Cada uno tiene catálogo, stock, precio de lista, precio en efectivo y medios de pago. El asistente responde con esos datos, en español argentino neutro.</p>
  <div class="resumen"><div><b>${resultados.length}</b> charlas</div><div><b>${ok}</b> pasaron</div><div><b>${resultados.length - ok}</b> fallaron</div></div>
  <h2>Qué resuelve cada caso</h2>
  <div class="nota">
    <p>La ficha del producto sigue el criterio del catálogo de Botmaker: nombre, descripción, precio, imagen y stock. El precio en efectivo y el de los otros medios repiten la cartelería argentina de doble precio. Los medios se informan; el cobro lo hace el medio externo, como Mercado Pago.</p>
    <p>Un reclamo o un pedido de persona deriva la charla. Una objeción de precio se responde con el valor en efectivo y no se deriva. Si no hay stock, se ofrece otra opción de la misma categoría. Si el dato no está cargado, no se inventa.</p>
    <p>El turno se reserva solo cuando el plan incluye ese módulo. El plan Completo y el Personalizado agregan el recordatorio del día anterior. La charla recuerda los últimos ${MAX_HISTORIAL} mensajes.</p>
    <p>WhatsApp manda la foto como imagen con el texto de epígrafe. Instagram manda la foto y después el texto. TikTok no tiene ese envío de imagen: el enlace queda en el mensaje. No hay carrusel de varias fotos ni precio distinto por zona.</p>
  </div>
  <div class="indice">${indice}</div>
</header>
<main>${cartas}</main>
</body></html>`;
}

describe('charlas de comercios', () => {
  const escenarios = armarEscenarios();

  it('hay al menos 100 conversaciones distintas', () => {
    expect(new Set(escenarios.map((e) => e.titulo)).size).toBe(escenarios.length);
    expect(escenarios.length).toBeGreaterThanOrEqual(100);
  });

  it('el catálogo de la parrilla queda en el prompt con foto y ambos precios', () => {
    const parrilla = escenarios.find((e) => e.local.id === 'parrilla')!;
    const prompt = compilarPrompt(perfilDe(parrilla.local), [...PLAN.completo]);
    expect(prompt).toContain('### Catálogo');
    expect(prompt).toContain('Foto: https://imagenes.orbita.test/parrilla/milanesa.jpg');
    expect(prompt).toContain('En efectivo: $17.010.');
    expect(prompt).toContain('$18.900');
  });

  it('cada charla responde solo con los datos cargados', () => {
    const resultados = escenarios.map(correr);
    const fallas = resultados.filter((r) => !r.ok).map((r) => `${r.escenario.id} ${r.escenario.titulo}: ${r.error}`);
    expect(fallas).toEqual([]);
  });
});
