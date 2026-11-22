import { fmt, localParts, localToUtc } from '../lib/dates';
import type { ItemCatalogo, Perfil } from './perfil';
import { MEDIO_LABEL, juntar, pesos, type Medio } from './mediosdepago';
import { MAX_HISTORIAL } from './prompt';

export interface TurnoCharla {
  rol: 'user' | 'assistant';
  texto: string;
}

export interface HerramientaProducto {
  nombre: string;
  imagen: string;
}

export interface RespuestaDatos {
  texto: string;
  handoff: boolean;
  imagen?: string;
  herramientas?: HerramientaProducto[];
}

export interface ConsultaDatos {
  nombreNegocio: string;
  perfil: Perfil;
  modulos: string[];
  nombreCliente: string;
  texto: string;
  historial: TurnoCharla[];
  textoHandoff: string;
  ahora: Date;
  timezone: string;
}

const NUMEROS: Record<string, number> = { dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10 };
const DIAS = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];
const ALERGENOS = ['gluten', 'tacc', 'lactosa', 'huevo', 'vegano', 'vegana', 'mani', 'nuez', 'leche', 'celiac'];

export function plano(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase();
}

function frase(s: string): string {
  return plano(s)
    .replace(/[¿?¡!.,;:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function nombrados(texto: string, items: ItemCatalogo[]): ItemCatalogo[] {
  let p = ` ${plano(texto)} `;
  const orden = [...items].sort((a, b) => plano(b.nombre).length - plano(a.nombre).length);
  const out: ItemCatalogo[] = [];
  for (const it of orden) {
    const n = plano(it.nombre);
    if (n.length < 4 || !p.includes(n)) continue;
    out.push(it);
    p = p.split(n).join(' ');
  }
  return out;
}

function reciente(actual: string, historial: TurnoCharla[], items: ItemCatalogo[]): ItemCatalogo | undefined {
  const fuentes = [actual, ...[...historial].reverse().map((h) => h.texto)];
  for (const f of fuentes) {
    const n = nombrados(f, items);
    if (n.length) return n[0];
  }
  return undefined;
}

function cantidadDe(texto: string): number | null {
  const p = frase(texto);
  if (/a las \d/.test(p) || /\b\d{1,2} \d{2}\b/.test(p)) {
    const palabra = p.match(/\b(dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)\b/);
    return palabra ? NUMEROS[palabra[1]] : null;
  }
  const palabra = p.match(/\b(dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)\b/);
  if (palabra) return NUMEROS[palabra[1]];
  const n = p.match(/\b(\d{1,2})\b/);
  if (!n) return null;
  const valor = Number(n[1]);
  return valor >= 1 && valor <= 20 ? valor : null;
}

function pidioEfectivo(actual: string, historial: TurnoCharla[]): boolean {
  const previos = historial.filter((h) => h.rol === 'user').slice(-3).map((h) => h.texto);
  return [actual, ...previos].some((t) => frase(t).includes('efectivo'));
}

function lineasPrecio(it: ItemCatalogo): string[] {
  const otros = it.medios.filter((m) => m !== 'efectivo').map((m) => MEDIO_LABEL[m]);
  const todos = it.medios.map((m) => MEDIO_LABEL[m]);
  const lineas: string[] = [];
  if (it.precioEfectivo != null && it.precioEfectivo !== it.precio && otros.length) {
    lineas.push(`Con ${juntar(otros)}: ${pesos(it.precio)}.`);
    lineas.push(`En efectivo: ${pesos(it.precioEfectivo)}.`);
  } else if (it.precioEfectivo != null && it.precioEfectivo !== it.precio) {
    lineas.push(`Precio: ${pesos(it.precio)}.`);
    lineas.push(`En efectivo: ${pesos(it.precioEfectivo)}.`);
  } else {
    lineas.push(`Precio: ${pesos(it.precio)}.`);
  }
  if (todos.length) lineas.push(`Medios de pago: ${juntar(todos)}.`);
  return lineas;
}

function cierre(tono: Perfil['tono'], servicio: boolean): string {
  if (servicio) {
    if (tono === 'divertido') return '¿Lo reservamos? 🙌';
    return '¿Desea reservarlo?';
  }
  if (tono === 'divertido') return '¿Lo retira en el local o se lo enviamos? 🙌';
  return '¿Prefiere retirarlo en el local o recibirlo por envío?';
}

function alternativas(it: ItemCatalogo, items: ItemCatalogo[]): ItemCatalogo[] {
  return items.filter((otro) => otro.nombre !== it.nombre && otro.categoria === it.categoria && otro.stock !== 0).slice(0, 2);
}

function sinStock(it: ItemCatalogo, items: ItemCatalogo[]): string {
  const otras = alternativas(it, items);
  const oferta = otras.length
    ? ` Como alternativa: ${otras.map((o) => `${o.nombre} (${pesos(o.precioEfectivo != null && o.precioEfectivo !== o.precio ? o.precioEfectivo : o.precio)})`).join(' y ')}.`
    : '';
  return `En este momento no hay ${it.nombre}.${oferta}`;
}

function unidad(it: ItemCatalogo, efectivo: boolean): number {
  if (efectivo && it.precioEfectivo != null) return it.precioEfectivo;
  return it.precio;
}

function ficha(it: ItemCatalogo, items: ItemCatalogo[], tono: Perfil['tono'], efectivo: boolean, cantidad: number | null, modo: string): { nombre: string; lineas: string[]; imagen?: string } {
  if (it.stock === 0 && (modo === 'ficha' || modo === 'stock' || cantidad)) return { nombre: it.nombre, lineas: [sinStock(it, items)], imagen: it.imagen || undefined };
  const lineas: string[] = [];
  if (modo === 'foto') {
    lineas.push(it.imagen ? `${it.nombre}.` : `No tengo una foto de ${it.nombre}.`);
    if (it.imagen) lineas.push(`Foto: ${it.imagen}`);
    return { nombre: it.nombre, lineas, imagen: it.imagen || undefined };
  }
  if (modo === 'stock') {
    if (it.stock == null) lineas.push(`No tengo el stock de ${it.nombre} cargado.`);
    else lineas.push(`Hay ${it.stock} unidades de ${it.nombre}.`);
    return { nombre: it.nombre, lineas };
  }
  if (modo === 'efectivo') {
    if (it.precioEfectivo != null && it.precioEfectivo !== it.precio) {
      lineas.push(`En efectivo, ${it.nombre} cuesta ${pesos(it.precioEfectivo)}. Con los otros medios de pago, ${pesos(it.precio)}.`);
    } else {
      lineas.push(`${it.nombre} no tiene un precio distinto en efectivo. El precio es ${pesos(it.precio)}.`);
    }
  } else if (modo === 'medios') {
    const medios = juntar(it.medios.map((m) => MEDIO_LABEL[m]));
    lineas.push(medios ? `${it.nombre} se puede pagar con ${medios}.` : `No tengo medios de pago cargados para ${it.nombre}.`);
  } else if (modo === 'precios') {
    lineas.push(`${it.nombre}.`, ...lineasPrecio(it));
  } else {
    lineas.push(it.detalle ? `${it.nombre}. ${it.detalle}` : `${it.nombre}.`);
    if (it.imagen) lineas.push(`Foto: ${it.imagen}`);
    lineas.push(...lineasPrecio(it));
    if (it.stock != null && it.stock > 0) lineas.push(`Hay ${it.stock} unidades disponibles.`);
    lineas.push(cierre(tono, it.categoria === 'servicio'));
  }
  if (cantidad && it.stock !== 0) {
    if (it.stock != null && cantidad > it.stock) {
      lineas.push(`Solo hay ${it.stock} unidades de ${it.nombre}.`);
    } else {
      const precio = unidad(it, efectivo);
      const como = efectivo && it.precioEfectivo != null ? 'en efectivo' : 'con los otros medios de pago';
      lineas.push(`El total de ${cantidad} ${it.nombre} ${como} es ${pesos(precio * cantidad)}.`);
    }
  }
  return { nombre: it.nombre, lineas, imagen: modo === 'ficha' || modo === 'foto' ? it.imagen || undefined : undefined };
}

function modoDe(p: string): string {
  if (/\b(foto|imagen|mostrame|mostrar)\b/.test(p)) return 'foto';
  if (p.includes('efectivo')) return 'efectivo';
  if (/\b(stock|queda|quedan|disponible)\b/.test(p)) return 'stock';
  if (/\b(precio|sale|vale|cuesta)\b/.test(p) || p.includes('cuanto')) return 'precios';
  if (p.includes('medio de pago') || p.includes('medios de pago') || p.includes('como pago') || p.includes('mercado pago') || /\b(tarjeta|transferencia|debito)\b/.test(p)) return 'medios';
  return 'ficha';
}

function medioPedido(p: string): Medio | null {
  if (p.includes('mercado pago')) return 'mercadopago';
  if (p.includes('transferencia')) return 'transferencia';
  if (p.includes('debito')) return 'debito';
  if (p.includes('tarjeta')) return 'tarjeta';
  if (p.includes('efectivo')) return 'efectivo';
  return null;
}

function sumarDias(y: number, m: number, d: number, dias: number): string {
  const dt = new Date(Date.UTC(y, m - 1, d + dias));
  return fmt(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

function turnoDe(texto: string, perfil: Perfil, modulos: string[], textoHandoff: string, ahora: Date, timezone: string): RespuestaDatos | null {
  const p = frase(texto);
  const pide = /\bturno\b/.test(p) || p.includes('agendar') || p.includes('sacar hora') || p.includes('reservar mesa') || p.includes('mesa para');
  if (!pide) return null;
  if (!modulos.includes('turnos')) {
    return { texto: `${textoHandoff} La reserva la confirma una persona del local.`, handoff: true };
  }
  const hoy = localParts(ahora, timezone);
  let delta: number | null = null;
  if (p.includes('pasado manana')) delta = 2;
  else if (p.includes('manana')) delta = 1;
  else if (/\bhoy\b/.test(p)) delta = 0;
  else {
    const dia = DIAS.findIndex((d) => p.includes(d));
    if (dia >= 0) delta = (dia - hoy.weekday + 7) % 7 || 7;
  }
  const hora = p.match(/a las (\d{1,2})(?: (\d{2}))?/);
  if (delta == null) return { texto: '¿Para qué día?', handoff: false };
  if (!hora) return { texto: '¿A qué hora?', handoff: false };
  const hh = Number(hora[1]);
  const mm = hora[2] ? Number(hora[2]) : 0;
  if (hh > 23 || mm > 59) return { texto: 'No reconozco esa hora. ¿Puede indicarla de nuevo?', handoff: false };
  const fecha = `${sumarDias(hoy.y, hoy.m, hoy.d, delta)} ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  const instante = localToUtc(fecha, timezone);
  const anticipacion = perfil.turnos?.anticipacionHoras ?? 0;
  if (!instante || instante.getTime() <= ahora.getTime()) return { texto: 'Ese horario ya pasó. ¿Me indica otro día y otro horario?', handoff: false };
  if (instante.getTime() < ahora.getTime() + anticipacion * 3_600_000) {
    return { texto: `Para reservar se necesitan al menos ${anticipacion} horas de anticipación.`, handoff: false };
  }
  const aviso = modulos.includes('recordatorios') ? ' El día anterior enviamos un recordatorio.' : '';
  return { texto: `El turno queda reservado para el ${fecha.replace(' ', ' a las ')}.${aviso} [TURNO_RESERVAR ${fecha}]`, handoff: false };
}

function queja(p: string): boolean {
  return /reclamo|queja|horrible|pesim|estafa|indign|denunci|no funciona|nunca llego|intoxic|vencid|verguenza|me cag|estaf|derretid|equivocad|crudo|cruda/.test(p) || /(llego|estaba|vino|quedo) fri/.test(p) || /\b(roto|rota)\b/.test(p);
}

function esSaludo(p: string): boolean {
  const frases = ['buenas tardes', 'buenas noches', 'buenos dias', 'buen dia', 'que tal', 'buenas', 'hola', 'hey'];
  let resto = ` ${p} `;
  let hubo = false;
  for (const frase of frases) {
    const marca = ` ${frase} `;
    if (!resto.includes(marca)) continue;
    hubo = true;
    resto = resto.split(marca).join(' ');
  }
  return hubo && resto.trim().length === 0;
}

/**
 * Responde con el catálogo cargado, sin inventar precios ni stock.
 * Si el mensaje no entra en un caso conocido, devuelve null y sigue el modelo.
 */
export function responderDesdeDatos(input: ConsultaDatos): RespuestaDatos | null {
  const items = input.perfil.catalogo ?? [];
  if (!items.length) return null;
  const historial = input.historial.slice(-MAX_HISTORIAL);
  const p = frase(input.texto);
  if (!p) return null;
  const tono = input.perfil.tono;
  const listo = (texto: string, handoff = false, herramientas: HerramientaProducto[] = [], comoImagen = true): RespuestaDatos => {
    const fotos = herramientas.filter((h) => h.imagen);
    if (!fotos.length) return { texto, handoff };
    return { texto, handoff, herramientas: fotos, ...(comoImagen ? { imagen: fotos[0].imagen } : {}) };
  };
  const fotosDe = (bloques: { nombre: string; imagen?: string }[]): HerramientaProducto[] =>
    bloques.flatMap((b) => (b.imagen ? [{ nombre: b.nombre, imagen: b.imagen }] : []));

  if (queja(p) || /\bfactura\b/.test(p) || p.includes('nota de credito')) return listo(input.textoHandoff, true);
  if (p.includes('hablar con') || p.includes('una persona') || p.includes('alguien del local') || /\b(asesor|humano|encargado|encargada)\b/.test(p)) {
    return listo(input.textoHandoff, true);
  }

  const turno = turnoDe(input.texto, input.perfil, input.modulos, input.textoHandoff, input.ahora, input.timezone);
  if (turno) return turno;

  if (/\b(carta|menu)\b/.test(p) || p.includes('que tienen') || p.includes('que hay')) {
    const lineas = items.map((it) => `${it.nombre}: ${lineasPrecio(it)[0]}`);
    const pregunta = tono === 'divertido' ? 'Dígame cuál y le envío la foto. 🙌' : 'Indique un producto y le envío la foto.';
    return listo(`${lineas.join('\n')}\n${pregunta}`, false, fotosDe(items), false);
  }

  let sinNombres = ` ${p} `;
  for (const it of [...items].sort((a, b) => plano(b.nombre).length - plano(a.nombre).length)) sinNombres = sinNombres.split(plano(it.nombre)).join(' ');
  const alergeno = ALERGENOS.find((a) => new RegExp(`\\b${a}\\b`).test(sinNombres));
  const productos = nombrados(input.texto, items);
  const producto = productos[0] ?? (p.split(' ').length <= 8 ? reciente(input.texto, historial, items) : undefined);
  if (alergeno && producto) {
    const detalle = plano(producto.detalle);
    if (detalle.includes(alergeno) || (alergeno === 'tacc' && detalle.includes('gluten')) || (alergeno === 'celiac' && detalle.includes('gluten'))) {
      return listo(`Sí. ${producto.nombre}: ${producto.detalle}`);
    }
    return listo(`Ese dato no está en la ficha. ${input.textoHandoff}`, true);
  }
  if (alergeno && !producto) return listo('¿Sobre qué producto consulta?');

  const modo = modoDe(p);
  const cantidad = cantidadDe(input.texto);
  const efectivo = pidioEfectivo(input.texto, historial);
  if (productos.length > 1 && modo === 'ficha') {
    const bloques = productos.map((it) => ficha(it, items, tono, efectivo, null, 'ficha'));
    return listo(bloques.flatMap((b) => b.lineas).join('\n'), false, fotosDe(bloques));
  }
  if (producto && (productos.length || modo !== 'ficha' || cantidad)) {
    const pedido = medioPedido(p);
    if (modo === 'medios' && pedido && !producto.medios.includes(pedido)) {
      const medios = juntar(producto.medios.map((m) => MEDIO_LABEL[m]));
      return listo(`${producto.nombre} no admite pago con ${MEDIO_LABEL[pedido]}. Los medios disponibles son ${medios}.`);
    }
    const armado = ficha(producto, items, tono, efectivo, cantidad, productos.length ? modo : cantidad ? 'ficha' : modo);
    return listo(armado.lineas.join('\n'), false, fotosDe([armado]));
  }

  if (!productos.length && modo === 'medios') {
    const vistos = new Map<string, string>();
    for (const it of items) for (const m of it.medios) vistos.set(m, MEDIO_LABEL[m]);
    const lista = juntar([...vistos.values()]);
    return listo(lista ? `Puede pagar con ${lista}.` : 'No tengo medios de pago cargados.');
  }
  if (!producto && modo === 'efectivo') return listo('¿De qué producto necesita el precio en efectivo?');
  if (!producto && modo === 'foto') return listo('¿De qué producto necesita la foto?');
  if (!producto && modo === 'stock') return listo('¿De qué producto consulta el stock?');
  if (!producto && modo === 'precios') return listo('¿De qué producto consulta el precio?');

  if (/\b(caro|carisimo|carisima|salado)\b/.test(p) || p.includes('mas barato') || p.includes('descuento')) {
    if (producto && producto.precioEfectivo != null && producto.precioEfectivo < producto.precio) {
      return listo(`En efectivo, ${producto.nombre} cuesta ${pesos(producto.precioEfectivo)}. Con los otros medios de pago, ${pesos(producto.precio)}.`);
    }
    return listo(producto ? `El precio cargado de ${producto.nombre} es ${pesos(producto.precio)}.` : '¿Cuál producto le parece caro?');
  }

  if (p.includes('envio') || p.includes('delivery')) {
    return listo(input.perfil.pagosEnvios.trim() ? `Sobre el envío: ${input.perfil.pagosEnvios.trim()}` : 'No tengo información del envío.');
  }
  if (p.includes('tarda') || p.includes('demora')) {
    return listo(input.perfil.pagosEnvios.trim() ? `Sobre la demora: ${input.perfil.pagosEnvios.trim()}` : 'La demora se confirma cuando el local acepta el pedido.');
  }

  const pideHorario = p.includes('horario') || /\babren\b/.test(p) || /\bcierran\b/.test(p) || p.includes('hasta que hora') || p.includes('a que hora');
  const pideLugar = p.includes('donde estan') || p.includes('donde queda') || p.includes('direccion') || p.includes('ubicacion') || p.includes('como llego');
  if (pideHorario || pideLugar) {
    const lineas = [
      pideHorario ? (input.perfil.horarios.trim() ? `El horario de atención es: ${input.perfil.horarios.trim()}` : 'No tengo el horario cargado.') : '',
      pideLugar ? (input.perfil.ubicacion.trim() ? `La dirección es ${input.perfil.ubicacion.trim()}.` : 'No tengo la dirección cargada.') : '',
    ].filter(Boolean);
    return listo(lineas.join('\n'));
  }

  if (esSaludo(p)) {
    const saludo = tono === 'formal' ? 'Buen día' : 'Hola';
    const nombre = input.nombreCliente ? `, ${input.nombreCliente}` : '';
    const oferta = tono === 'divertido' ? 'Puedo informarle precios, fotos y medios de pago. 🙌' : 'Puedo informarle precios, fotos, stock y medios de pago.';
    return listo(`${saludo}${nombre}. Soy el asistente de ${input.nombreNegocio}. ${oferta}`);
  }

  if (/\b(tienen|tenes|hay|busco|quiero|necesito|dame)\b/.test(p)) {
    const muestra = items.slice(0, 3).map((it) => it.nombre);
    return listo(`Ese producto no está en el catálogo. Puedo ofrecerle: ${juntar(muestra)}.`);
  }
  return null;
}
