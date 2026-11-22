import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { responderDesdeDatos } from '../../src/ai/charla';
import { pesos } from '../../src/ai/mediosdepago';
import type { ItemCatalogo } from '../../src/ai/perfil';
import { AHORA, HANDOFF, PLAN, ZONA, locales, perfilDe, type Local } from './conversaciones.test';

const NOMBRES = ['Ana', 'Bruno', 'Camila', 'Diego', 'Elena', 'Facundo', 'Gina', 'Hugo', 'Irene', 'Joaquín', 'Karen', 'Luis', 'Mora', 'Nicolás', 'Olga', 'Paula', 'Ramiro', 'Sofía', 'Tomás', 'Valentina', 'Wanda', 'Xavier', 'Yamila', 'Zoe'];
const APELLIDOS = ['López', 'García', 'Pérez', 'Romero', 'Suárez', 'Torres', 'Vega', 'Acosta', 'Benítez', 'Cabrera', 'Domínguez', 'Ferreyra'];
const CANALES = ['WhatsApp', 'Instagram', 'TikTok'] as const;
const JERGA = [/\bquerés\b/i, /\bpasás\b/i, /\bpedime\b/i, /\bmandame\b/i, /\bpor acá\b/i];

interface Linea {
  cliente: string;
  incluye: string[];
  excluye?: string[];
  handoff?: boolean;
  imagen?: string;
  sinImagen?: boolean;
}

interface Guion {
  titulo: string;
  lineas: Linea[];
}

interface Charla {
  id: string;
  titulo: string;
  rubro: string;
  plan: string;
  negocio: string;
  cliente: string;
  telefono: string;
  canal: (typeof CANALES)[number];
  lineas: (Linea & { texto: string; imagen?: string; handoff: boolean; error: string })[];
  ok: boolean;
}

function codigoDe(clave: string): string {
  const b = createHash('sha256').update(clave).digest().subarray(0, 16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = Buffer.from(b).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function persona(i: number): { nombre: string; pila: string; telefono: string } {
  const pila = NOMBRES[i % NOMBRES.length];
  const apellido = APELLIDOS[Math.floor(i / NOMBRES.length) % APELLIDOS.length];
  const telefono = `+54 11 ${String(5200 + (i % 80)).padStart(4, '0')}-${String(1000 + i).padStart(4, '0')}`;
  return { nombre: `${pila} ${apellido}`, pila, telefono };
}

function visible(texto: string): string {
  return texto.replace(/\s*\[TURNO_RESERVAR [^\]]+\]/g, '').trim();
}

function pieza(local: Local) {
  const disponible = local.catalogo.filter((it) => it.stock !== 0);
  const principal = disponible.find((it) => it.imagen) ?? disponible[0] ?? local.catalogo[0];
  const otro = disponible.find((it) => it.nombre !== principal.nombre) ?? principal;
  const agotado = local.catalogo.find((it) => it.stock === 0);
  const alternativa = agotado ? local.catalogo.find((it) => it.nombre !== agotado.nombre && it.categoria === agotado.categoria && it.stock !== 0) : undefined;
  return { principal, otro, agotado, alternativa };
}

function preciosDe(it: ItemCatalogo): string[] {
  if (it.precioEfectivo != null && it.precioEfectivo !== it.precio) return [`En efectivo: ${pesos(it.precioEfectivo)}.`, pesos(it.precio)];
  return [`Precio: ${pesos(it.precio)}.`];
}

function reclamoDe(local: Local): string {
  const texto: Record<string, string> = {
    Restaurante: 'Quiero hacer un reclamo: el pedido llegó frío.',
    Heladería: 'Quiero hacer un reclamo: el helado llegó derretido.',
    Panadería: 'Quiero hacer un reclamo: las medialunas llegaron duras.',
    Indumentaria: 'Quiero hacer un reclamo: la remera llegó rota.',
    Ferretería: 'Quiero hacer un reclamo: el taladro no funciona.',
    Farmacia: 'Quiero hacer un reclamo: el producto llegó vencido.',
    Peluquería: 'Quiero hacer un reclamo: el color quedó horrible.',
    Odontología: 'Quiero hacer un reclamo: la limpieza quedó mal y duele.',
    Veterinaria: 'Quiero hacer un reclamo: la vacuna llegó vencida.',
    'Pet shop': 'Quiero hacer un reclamo: la bolsa llegó rota.',
    Florería: 'Quiero hacer un reclamo: las rosas llegaron marchitas y rotas.',
    Gimnasio: 'Quiero hacer un reclamo: me cobraron el plan y no funciona el acceso.',
    'Taller mecánico': 'Quiero hacer un reclamo: el auto sigue igual, el service no funciona.',
    Vinoteca: 'Quiero hacer un reclamo: la botella llegó rota.',
  };
  return texto[local.rubro] ?? 'Quiero hacer un reclamo.';
}

function guiones(local: Local): Guion[] {
  const { principal, otro, agotado, alternativa } = pieza(local);
  const ficha: Linea = {
    cliente: `Quiero ${principal.nombre}.`,
    incluye: [principal.nombre, ...preciosDe(principal), 'Medios de pago:'],
    imagen: principal.imagen || undefined,
    sinImagen: !principal.imagen,
    handoff: false,
  };
  const pedido: Guion = {
    titulo: `Pide ${principal.nombre}, la foto, el efectivo y el total`,
    lineas: [
      { cliente: 'Hola, buenas', incluye: [`Soy el asistente de ${local.nombre}`] },
      { cliente: '¿Qué tienen?', incluye: [local.catalogo[0].nombre], sinImagen: true },
      ficha,
      principal.imagen
        ? { cliente: '¿Me envía la foto?', incluye: [principal.nombre, `Foto: ${principal.imagen}`], imagen: principal.imagen }
        : { cliente: '¿Me envía la foto?', incluye: [`No tengo una foto de ${principal.nombre}.`], sinImagen: true },
      principal.precioEfectivo != null && principal.precioEfectivo !== principal.precio
        ? { cliente: '¿Y en efectivo?', incluye: [`En efectivo, ${principal.nombre} cuesta ${pesos(principal.precioEfectivo)}.`, pesos(principal.precio)], sinImagen: true }
        : { cliente: '¿Y en efectivo?', incluye: [`El precio es ${pesos(principal.precio)}.`], sinImagen: true },
      {
        cliente: `Quiero 2 ${principal.nombre} en efectivo.`,
        incluye: [`El total de 2 ${principal.nombre} en efectivo es ${pesos((principal.precioEfectivo ?? principal.precio) * 2)}.`],
        sinImagen: true,
      },
      { cliente: '¿Qué medios de pago tienen?', incluye: ['Mercado Pago'], sinImagen: true },
      { cliente: '¿Hacen envíos?', incluye: ['Sobre el envío:', local.pagosEnvios.slice(0, 18)], sinImagen: true },
    ],
  };
  const sinStock: Guion = agotado
    ? {
        titulo: `${agotado.nombre} no tiene stock`,
        lineas: [
          { cliente: 'Buenas tardes', incluye: [`Soy el asistente de ${local.nombre}`] },
          {
            cliente: `¿Tiene ${agotado.nombre}?`,
            incluye: [`En este momento no hay ${agotado.nombre}.`, ...(alternativa ? [alternativa.nombre] : [])],
            excluye: [`Hay ${agotado.stock} unidades`],
          },
          ...(alternativa
            ? [
                {
                  cliente: `Entonces quiero ${alternativa.nombre}.`,
                  incluye: [alternativa.nombre, ...preciosDe(alternativa)],
                  imagen: alternativa.imagen || undefined,
                  sinImagen: !alternativa.imagen,
                } satisfies Linea,
              ]
            : []),
          { cliente: '¿Hacen envíos a domicilio?', incluye: ['Sobre el envío:'], sinImagen: true },
        ],
      }
    : {
        titulo: `Consulta ${otro.nombre}`,
        lineas: [
          { cliente: 'Buenas tardes', incluye: [`Soy el asistente de ${local.nombre}`] },
          { cliente: `¿Cuánto sale ${otro.nombre}?`, incluye: [otro.nombre, pesos(otro.precio)], sinImagen: true },
          otro.stock == null
            ? { cliente: `¿Cuánto queda de ${otro.nombre}?`, incluye: [`No tengo el stock de ${otro.nombre} cargado.`], sinImagen: true }
            : { cliente: `¿Cuánto queda de ${otro.nombre}?`, incluye: [`Hay ${otro.stock} unidades de ${otro.nombre}.`], sinImagen: true },
          { cliente: '¿Cuál es la dirección?', incluye: [`La dirección es ${local.ubicacion}.`], sinImagen: true },
        ],
      };
  const queja: Guion = {
    titulo: 'Reclamo y pide una persona',
    lineas: [
      { cliente: 'Buen día', incluye: [`Soy el asistente de ${local.nombre}`] },
      ficha,
      { cliente: reclamoDe(local), incluye: [HANDOFF], handoff: true, sinImagen: true },
      { cliente: 'Necesito hablar con una persona del local.', incluye: [HANDOFF], handoff: true, sinImagen: true },
    ],
  };
  const objecion: Guion = {
    titulo: `Le parece caro ${principal.nombre}`,
    lineas: [
      { cliente: `¿Cuánto sale ${principal.nombre}?`, incluye: [principal.nombre, pesos(principal.precio)], sinImagen: true },
      {
        cliente: 'Me parece muy caro.',
        incluye:
          principal.precioEfectivo != null && principal.precioEfectivo < principal.precio
            ? [`En efectivo, ${principal.nombre} cuesta ${pesos(principal.precioEfectivo)}.`]
            : [`El precio cargado de ${principal.nombre} es ${pesos(principal.precio)}.`],
        handoff: false,
        sinImagen: true,
      },
      { cliente: '¿Hay descuento en efectivo?', incluye: [principal.nombre], handoff: false, sinImagen: true },
    ],
  };
  const turno: Guion =
    local.plan === 'mensajes'
      ? {
          titulo: 'Pide un turno y el plan no lo reserva',
          lineas: [
            { cliente: 'Hola', incluye: [`Soy el asistente de ${local.nombre}`] },
            { cliente: '¿A qué hora abren?', incluye: [`El horario de atención es: ${local.horarios}`], sinImagen: true },
            {
              cliente: 'Quiero un turno para mañana a las 10.',
              incluye: [HANDOFF, 'La reserva la confirma una persona del local.'],
              handoff: true,
              sinImagen: true,
            },
          ],
        }
      : {
          titulo: 'Reserva un turno para mañana',
          lineas: [
            { cliente: 'Hola', incluye: [`Soy el asistente de ${local.nombre}`] },
            { cliente: '¿A qué hora abren?', incluye: [`El horario de atención es: ${local.horarios}`], sinImagen: true },
            { cliente: 'Quiero un turno para hoy a las 13.', incluye: ['anticipación'], handoff: false, sinImagen: true },
            {
              cliente: 'Quiero un turno para mañana a las 10.',
              incluye: ['El turno queda reservado para el 2026-11-23 a las 10:00.', ...(local.plan === 'completo' || local.plan === 'personalizado' ? ['El día anterior enviamos un recordatorio.'] : [])],
              excluye: local.plan === 'turnos' ? ['El día anterior enviamos un recordatorio.'] : [],
              handoff: false,
              sinImagen: true,
            },
          ],
        };
  const factura: Guion = {
    titulo: 'Pide factura y después una persona',
    lineas: [
      { cliente: `Quiero consultar por ${principal.nombre}.`, incluye: [principal.nombre], imagen: principal.imagen || undefined, sinImagen: !principal.imagen },
      { cliente: 'Necesito una factura.', incluye: [HANDOFF], handoff: true, sinImagen: true },
      { cliente: 'Necesito hablar con el encargado.', incluye: [HANDOFF], handoff: true, sinImagen: true },
    ],
  };
  const carta: Guion = {
    titulo: 'Pide algo que no existe y después elige de la carta',
    lineas: [
      { cliente: 'Buenas', incluye: [`Soy el asistente de ${local.nombre}`] },
      { cliente: '¿Tienen zafiro lunar?', incluye: ['Ese producto no está en el catálogo.', local.catalogo[0].nombre], handoff: false, sinImagen: true },
      { cliente: '¿Me pasa la carta?', incluye: [otro.nombre], sinImagen: true },
      {
        cliente: `Me quedo con ${otro.nombre}.`,
        incluye: [otro.nombre, ...preciosDe(otro)],
        imagen: otro.imagen || undefined,
        sinImagen: !otro.imagen,
        handoff: false,
      },
    ],
  };
  const extras: Guion[] = [];
  if (local.id === 'parrilla') {
    extras.push({
      titulo: 'Pregunta por gluten, leche y después ya no queda el primer plato en la memoria',
      lineas: [
        { cliente: '¿La milanesa napolitana tiene gluten?', incluye: ['Sí.', 'Milanesa napolitana'], sinImagen: true },
        { cliente: '¿El flan casero tiene leche?', incluye: ['Sí.', 'Flan casero'], sinImagen: true },
        { cliente: '¿El flan casero es vegano?', incluye: ['Ese dato no está en la ficha.', HANDOFF], handoff: true, sinImagen: true },
        { cliente: '¿A qué hora abren?', incluye: ['El horario de atención es:'], sinImagen: true },
        { cliente: '¿Cuál es la dirección?', incluye: [`La dirección es ${local.ubicacion}.`], sinImagen: true },
        { cliente: 'Hola', incluye: [`Soy el asistente de ${local.nombre}`] },
        { cliente: '¿Hacen envíos?', incluye: ['Sobre el envío:'], sinImagen: true },
        { cliente: 'Buenas noches', incluye: [`Soy el asistente de ${local.nombre}`] },
        { cliente: '¿Y en efectivo?', incluye: ['¿De qué producto necesita el precio en efectivo?'], excluye: ['Flan casero', '$4.950'], sinImagen: true },
      ],
    });
  }
  if (local.id === 'farmacia') {
    extras.push({
      titulo: 'Pregunta si el ibuprofeno se paga con tarjeta',
      lineas: [
        { cliente: 'Hola', incluye: [`Soy el asistente de ${local.nombre}`] },
        { cliente: '¿Tiene Ibuprofeno 400?', incluye: ['Ibuprofeno 400', 'Medios de pago:'], imagen: principal.imagen || undefined },
        { cliente: '¿Puedo pagar el Ibuprofeno 400 con tarjeta?', incluye: ['no admite pago con tarjeta', 'débito'], sinImagen: true },
        { cliente: '¿Cuánto queda de Ibuprofeno 400?', incluye: ['Hay 25 unidades de Ibuprofeno 400.'], sinImagen: true },
      ],
    });
  }
  if (local.id === 'andes') {
    extras.push({
      titulo: 'Pide ocho remeras y solo hay cinco',
      lineas: [
        { cliente: 'Hola', incluye: [`Soy el asistente de ${local.nombre}`] },
        { cliente: '¿Tiene remera negra talle M?', incluye: ['En este momento no hay Remera negra talle M.', 'Remera negra talle L'], },
        { cliente: 'Quiero 8 remera negra talle L.', incluye: ['Solo hay 5 unidades de Remera negra talle L.'], excluye: [pesos(12000 * 8)] },
      ],
    });
  }
  return [pedido, sinStock, queja, objecion, turno, factura, carta, ...extras];
}

function correr(local: Local, guion: Guion, i: number): Charla {
  const quien = persona(i);
  const historial: { rol: 'user' | 'assistant'; texto: string }[] = [];
  const lineas: Charla['lineas'] = [];
  let ok = true;
  for (const linea of guion.lineas) {
    const respuesta = responderDesdeDatos({
      nombreNegocio: local.nombre,
      perfil: perfilDe(local),
      modulos: [...PLAN[local.plan]],
      nombreCliente: quien.pila,
      texto: linea.cliente,
      historial,
      textoHandoff: HANDOFF,
      ahora: AHORA,
      timezone: ZONA,
    });
    const texto = visible(respuesta?.texto ?? '');
    let error = '';
    if (!respuesta) error = 'El asistente no contestó con los datos del comercio.';
    else {
      for (const malo of JERGA) if (malo.test(texto)) error = `Usó una expresión que no corresponde: ${malo}`;
      for (const parte of linea.incluye) if (!texto.includes(parte) && !respuesta.texto.includes(parte)) error = `Faltó: ${parte}`;
      for (const parte of linea.excluye ?? []) if (texto.includes(parte) || respuesta.texto.includes(parte)) error = `No debía decir: ${parte}`;
      if ((linea.handoff ?? false) !== respuesta.handoff) error = respuesta.handoff ? 'Derivó y no correspondía.' : 'Tenía que derivar y no lo hizo.';
      if (linea.imagen && respuesta.imagen !== linea.imagen) error = 'No envió la foto del producto.';
      if (linea.sinImagen && respuesta.imagen) error = 'Envió una foto que no correspondía.';
    }
    if (error) ok = false;
    lineas.push({ ...linea, texto: texto || '—', imagen: respuesta?.imagen, handoff: Boolean(respuesta?.handoff), error });
    if (respuesta) historial.push({ rol: 'user', texto: linea.cliente }, { rol: 'assistant', texto: respuesta.texto });
  }
  return {
    id: codigoDe(`${local.id}|${guion.titulo}|${quien.nombre}`),
    titulo: guion.titulo,
    rubro: local.rubro,
    plan: local.plan,
    negocio: local.nombre,
    cliente: quien.nombre,
    telefono: quien.telefono,
    canal: CANALES[i % CANALES.length],
    lineas,
    ok,
  };
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function informe(charlas: Charla[]): string {
  const ok = charlas.filter((c) => c.ok).length;
  const grupos = new Map<string, Charla[]>();
  for (const c of charlas) {
    const lista = grupos.get(c.rubro) ?? [];
    lista.push(c);
    grupos.set(c.rubro, lista);
  }
  const indice = [...grupos.entries()]
    .map(([rubro, lista]) => {
      const links = lista.map((c) => `<li><a href="#${c.id}"><code>${esc(c.id)}</code></a> ${esc(c.negocio)} · ${esc(c.cliente)} · ${esc(c.titulo)}</li>`).join('');
      return `<section><h2>${esc(rubro)}</h2><ol>${links}</ol></section>`;
    })
    .join('');
  const cartas = charlas
    .map((c) => {
      const turnos = c.lineas
        .map((l) => {
          const foto = l.imagen ? `<img src="${esc(l.imagen)}" alt="">` : '';
          return `<div class="turno"><p class="quien">Cliente</p><div class="burbuja cliente">${esc(l.cliente)}</div><p class="quien">Asistente${l.handoff ? ' · deriva a una persona' : ''}</p><div class="burbuja bot">${foto}${esc(l.texto)}</div>${l.error ? `<p class="error">${esc(l.error)}</p>` : ''}</div>`;
        })
        .join('');
      return `<article class="${c.ok ? 'ok' : 'mal'}" id="${c.id}"><header><span class="estado">${c.ok ? 'Pasó' : 'Falló'}</span><p class="id"><span>Identificador</span> <code>${esc(c.id)}</code></p><h3>${esc(c.titulo)}</h3><p class="meta">${esc(c.negocio)} · ${esc(c.rubro)} · Plan ${esc(c.plan)} · ${esc(c.canal)} · ${esc(c.cliente)} · ${esc(c.telefono)}</p></header>${turnos}</article>`;
    })
    .join('');
  return `<!DOCTYPE html>
<html lang="es"><head><meta charset="utf-8"><title>Auditoría de conversaciones</title>
<style>
  :root { --ok:#1f9d55; --mal:#d0342c; --linea:#e4e0d8; --tinta:#241f1a; --papel:#f7f4ee; }
  body { margin:0; font:16px/1.45 Georgia, serif; color:var(--tinta); background:var(--papel); }
  header.top, main { max-width:880px; margin:0 auto; padding:1.5rem; }
  .resumen { display:flex; gap:.75rem; flex-wrap:wrap; }
  .resumen div { background:#fff; border:1px solid var(--linea); border-radius:10px; padding:.6rem .8rem; }
  .registro { background:#fff; border:1px solid var(--linea); border-radius:12px; padding:1rem 1rem 1rem 2rem; }
  .registro section { margin:0 0 1rem; }
  .registro h2 { font-size:1.05rem; margin:0 0 .3rem; }
  .registro ol { margin:0; padding-left:1.1rem; }
  .registro li { margin:.2rem 0; }
  code { font-family:Consolas, monospace; font-size:.92rem; }
  article { background:#fff; border:1px solid var(--linea); border-radius:12px; padding:1rem; margin:0 0 1rem; }
  .id { margin:.2rem 0; }
  .id span, .meta { color:#6b645b; }
  .estado { float:right; font-weight:700; }
  article.ok .estado { color:var(--ok); }
  article.mal .estado { color:var(--mal); }
  .turno { margin-top:.8rem; }
  .quien { margin:0 0 .2rem; font-size:.75rem; letter-spacing:.04em; text-transform:uppercase; color:#6b645b; }
  .burbuja { white-space:pre-wrap; border-radius:12px; padding:.55rem .75rem; margin:0 0 .35rem; }
  .cliente { background:#efeae2; }
  .bot { background:#e7f6ee; }
  .burbuja img { display:block; max-width:220px; border-radius:10px; margin-bottom:.4rem; }
  .error { color:var(--mal); }
</style></head>
<body>
<header class="top">
  <h1>Auditoría de conversaciones</h1>
  <p>Cada ficha es una charla de un cliente con el asistente de un comercio. Se ve el mensaje del cliente y la respuesta, con el identificador de esa conversación.</p>
  <div class="resumen"><div><b>${charlas.length}</b> conversaciones</div><div><b>${ok}</b> pasaron</div><div><b>${charlas.length - ok}</b> fallaron</div></div>
  <h2>Registro</h2>
  <div class="registro">${indice}</div>
</header>
<main>${cartas}</main>
</body></html>`;
}

describe('conversaciones reales', () => {
  const charlas = locales().flatMap((local, li) => guiones(local).map((guion, gi) => correr(local, guion, li * 20 + gi)));

  it('registra al menos 100 conversaciones, cada una con su identificador', () => {
    expect(charlas.length).toBeGreaterThanOrEqual(100);
    expect(new Set(charlas.map((c) => c.id)).size).toBe(charlas.length);
    expect(charlas.every((c) => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(c.id))).toBe(true);
    expect(charlas.every((c) => c.lineas.length >= 3)).toBe(true);
  });

  it('el asistente responde en cada mensaje y las charlas quedan para verlas', () => {
    const html = informe(charlas);
    const destino = path.resolve('e:/orbita/qa');
    fs.mkdirSync(destino, { recursive: true });
    fs.writeFileSync(path.join(destino, 'auditoria-conversaciones.html'), html, 'utf8');
    fs.writeFileSync(path.join(destino, 'auditoria-charlas.html'), html, 'utf8');
    fs.writeFileSync(
      path.join(destino, 'conversaciones.json'),
      JSON.stringify(
        charlas.map((c) => ({
          id: c.id,
          negocio: c.negocio,
          rubro: c.rubro,
          plan: c.plan,
          cliente: c.cliente,
          telefono: c.telefono,
          canal: c.canal,
          titulo: c.titulo,
          ok: c.ok,
          mensajes: c.lineas.map((l) => ({ cliente: l.cliente, asistente: l.texto, deriva: l.handoff, foto: l.imagen ?? null, error: l.error || null })),
        })),
        null,
        2,
      ),
      'utf8',
    );
    const fallas = charlas.filter((c) => !c.ok).map((c) => `${c.id} ${c.negocio} / ${c.titulo}: ${c.lineas.find((l) => l.error)?.error} · cliente: ${c.lineas.find((l) => l.error)?.cliente}`);
    expect(fallas).toEqual([]);
  });
});
