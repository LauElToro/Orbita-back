import { PLANES } from '../billing/plans';
import { plantillaOrbita, type MensajeCorreo } from './correo';

export interface Destinatario {
  email: string;
  nombre: string;
}

const ZONA = 'America/Argentina/Buenos_Aires';

function pesos(importe: number): string {
  return `$${importe.toLocaleString('es-AR', { maximumFractionDigits: 0 })}`;
}

function fecha(cuando: Date): string {
  return new Intl.DateTimeFormat('es-AR', { timeZone: ZONA, day: 'numeric', month: 'long', year: 'numeric' }).format(cuando);
}

function fechaHora(cuando: Date): string {
  return new Intl.DateTimeFormat('es-AR', {
    timeZone: ZONA,
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(cuando);
}

/** "2026-12-19" → "19 de diciembre de 2026". */
function fechaDeClave(clave: string): string {
  const [y, m, d] = clave.split('-').map(Number);
  if (!y || !m || !d) return clave;
  return fecha(new Date(Date.UTC(y, m - 1, d, 15)));
}

export function mensajeBienvenida(para: Destinatario, negocio: string, url: string): MensajeCorreo {
  return plantillaOrbita({
    para: para.email,
    asunto: `Bienvenido a órbita, ${para.nombre}`,
    previa: `La cuenta de ${negocio} ya está lista. Te contamos cómo seguir.`,
    etiqueta: 'Cuenta creada',
    titulo: `Bienvenido a órbita, ${para.nombre}`,
    parrafos: [
      `La cuenta de ${negocio} ya está lista. Desde el panel armás la IA que va a contestar a tus clientes en WhatsApp, Instagram y TikTok, a cualquier hora.`,
    ],
    pasos: [
      'Probá la demo con la información de tu negocio. Es gratis.',
      'Elegí un plan y pagalo con Mercado Pago.',
      'Conectá tus canales y la IA empieza a contestar sola.',
    ],
    boton: { texto: 'Entrar al panel', url: `${url}/cuenta` },
    nota: 'La demo no le contesta a clientes reales. Eso empieza cuando se acredita el pago del plan.',
  });
}

export function mensajeBienvenidaGoogle(para: Destinatario, url: string): MensajeCorreo {
  return plantillaOrbita({
    para: para.email,
    asunto: `Bienvenido a órbita, ${para.nombre}`,
    previa: 'Tu cuenta ya está lista. Te contamos cómo seguir.',
    etiqueta: 'Cuenta creada',
    titulo: `Bienvenido a órbita, ${para.nombre}`,
    parrafos: ['Creamos tu cuenta con Google. En unos minutos podés tener una IA que conteste a tus clientes en WhatsApp, Instagram y TikTok.'],
    pasos: [
      'Cargá el nombre y el rubro de tu negocio.',
      'Probá la demo y elegí un plan.',
      'Conectá tus canales y la IA empieza a contestar sola.',
    ],
    boton: { texto: 'Entrar al panel', url: `${url}/cuenta` },
    nota: 'Para entrar, usá siempre el botón "Continuar con Google" con esta misma cuenta.',
  });
}

export function mensajeDefinirContrasena(email: string, link: string, dias: number): MensajeCorreo {
  return plantillaOrbita({
    para: email,
    asunto: 'Elegí tu contraseña de órbita',
    previa: 'Un paso más para entrar al panel.',
    etiqueta: 'Tu cuenta',
    titulo: 'Elegí tu contraseña',
    parrafos: ['Creamos tu cuenta de órbita con este email. Definí una contraseña para entrar al panel y seguir con la configuración de tu IA.'],
    boton: { texto: 'Definir mi contraseña', url: link },
    nota: `El link vence en ${dias} días y sirve una sola vez. La IA se habilita cuando se acredita el pago con Mercado Pago.`,
  });
}

export function mensajeRestablecer(para: Destinatario, link: string): MensajeCorreo {
  return plantillaOrbita({
    para: para.email,
    asunto: 'Cambiá tu contraseña de órbita',
    previa: 'El link vence en 24 horas.',
    etiqueta: 'Seguridad',
    titulo: 'Cambiá tu contraseña',
    parrafos: [`Hola ${para.nombre}, recibimos un pedido para cambiar la contraseña de tu cuenta de órbita.`],
    boton: { texto: 'Elegir una contraseña nueva', url: link },
    nota: 'El link vence en 24 horas y sirve una sola vez. Si no pediste el cambio, ignorá este correo: tu contraseña sigue igual.',
  });
}

export function mensajeCompra(
  para: Destinatario,
  negocio: string,
  plan: string,
  importe: number,
  vencimiento: Date,
  primera: boolean,
  url: string,
): MensajeCorreo {
  return plantillaOrbita({
    para: para.email,
    asunto: primera ? `Tu plan ${plan} ya está activo` : `Recibimos tu pago del plan ${plan}`,
    previa: `${pesos(importe)} acreditados. Próximo vencimiento: ${fecha(vencimiento)}.`,
    etiqueta: 'Pago acreditado',
    tono: 'verde',
    titulo: primera ? `Tu plan ${plan} ya está activo` : '¡Gracias! Recibimos tu pago',
    parrafos: [
      primera
        ? `Hola ${para.nombre}, se acreditó el primer pago de ${negocio}. Ya podés configurar la IA y conectarla a tus canales.`
        : `Hola ${para.nombre}, se acreditó el pago del plan ${plan} de ${negocio}. Tu IA sigue atendiendo sin cortes.`,
    ],
    datos: [
      { k: 'Negocio', v: negocio },
      { k: 'Plan', v: plan },
      { k: 'Importe', v: pesos(importe) },
      { k: 'Próximo vencimiento', v: fecha(vencimiento) },
    ],
    boton: { texto: primera ? 'Configurar mi IA' : 'Ver mis pagos', url: primera ? `${url}/cuenta` : `${url}/cuenta/plan` },
    nota: 'El débito de Mercado Pago se renueva solo cada mes. Sin permanencia: podés darlo de baja cuando quieras.',
  });
}

export function mensajeSesion(para: Destinatario, cuando: Date, ip: string | undefined, url: string): MensajeCorreo {
  return plantillaOrbita({
    para: para.email,
    asunto: 'Nuevo inicio de sesión en órbita',
    previa: `Entraste el ${fechaHora(cuando)}.`,
    etiqueta: 'Seguridad',
    titulo: 'Entraste a tu cuenta',
    parrafos: [`Hola ${para.nombre}, registramos un inicio de sesión en tu cuenta de órbita.`],
    datos: [{ k: 'Cuándo', v: fechaHora(cuando) }, ...(ip ? [{ k: 'Dirección IP', v: ip }] : [])],
    boton: { texto: 'No fui yo: cambiar contraseña', url: `${url}/olvide` },
    nota: 'Si fuiste vos, no tenés que hacer nada.',
  });
}

export function mensajeVencimiento(
  para: Destinatario,
  negocio: string,
  plan: string,
  vencimiento: Date,
  momento: 'previo' | 'vencio' | 'impago',
  url: string,
): MensajeCorreo {
  const datos = [
    { k: 'Negocio', v: negocio },
    { k: 'Plan', v: plan },
    { k: 'Vencimiento', v: fecha(vencimiento) },
  ];
  if (momento === 'previo') {
    return plantillaOrbita({
      para: para.email,
      asunto: `Tu plan ${plan} vence el ${fecha(vencimiento)}`,
      previa: 'Si el débito está activo, no tenés que hacer nada.',
      etiqueta: 'Recordatorio',
      tono: 'ambar',
      titulo: `Tu plan vence el ${fecha(vencimiento)}`,
      parrafos: [
        `Hola ${para.nombre}, en unos días vence el plan ${plan} de ${negocio}.`,
        'Si el débito de Mercado Pago sigue activo, se cobra solo y no tenés que hacer nada. Si lo diste de baja, renovalo antes para que la IA no deje de contestar.',
      ],
      datos,
      boton: { texto: 'Ver mi plan', url: `${url}/cuenta/plan` },
    });
  }
  if (momento === 'vencio') {
    return plantillaOrbita({
      para: para.email,
      asunto: `Venció tu plan ${plan}`,
      previa: 'Tenés 7 días para regularizarlo antes de que pausemos la IA.',
      etiqueta: 'Pago pendiente',
      tono: 'ambar',
      titulo: `Hoy venció tu plan ${plan}`,
      parrafos: [
        `Hola ${para.nombre}, no pudimos registrar el pago del plan de ${negocio}.`,
        'Tenés 7 días para regularizarlo. Mientras tanto la IA sigue contestando. Pasado ese plazo la pausamos hasta que se acredite el pago.',
      ],
      datos,
      boton: { texto: 'Pagar el plan', url: `${url}/cuenta/plan` },
    });
  }
  return plantillaOrbita({
    para: para.email,
    asunto: `Pausamos la IA de ${negocio}`,
    previa: 'Vuelve a contestar apenas se acredite el pago.',
    etiqueta: 'IA pausada',
    tono: 'rojo',
    titulo: `Pausamos la IA de ${negocio}`,
    parrafos: [
      `Hola ${para.nombre}, pasaron 7 días desde el vencimiento y todavía no se acreditó el pago del plan ${plan}.`,
      'La IA dejó de contestar a tus clientes. Toda la configuración queda guardada: cuando pagues, vuelve a atender al instante.',
    ],
    datos,
    boton: { texto: 'Reactivar mi plan', url: `${url}/cuenta/plan` },
  });
}

export function mensajeLimite(
  para: Destinatario,
  negocio: string,
  usadas: number,
  tope: number,
  nivel: 80 | 100,
  reinicia: string,
  url: string,
): MensajeCorreo {
  const datos = [
    { k: 'Respuestas usadas', v: `${usadas.toLocaleString('es-AR')} de ${tope.toLocaleString('es-AR')}` },
    { k: 'El contador se renueva', v: fechaDeClave(reinicia) },
  ];
  const pct = tope ? (usadas / tope) * 100 : 100;
  if (nivel === 80) {
    return plantillaOrbita({
      para: para.email,
      asunto: `${negocio} usó el 80% de sus respuestas`,
      previa: `Quedan ${(tope - usadas).toLocaleString('es-AR')} respuestas hasta el ${fechaDeClave(reinicia)}.`,
      etiqueta: 'Consumo del mes',
      tono: 'ambar',
      titulo: 'Usaste el 80% de tus respuestas',
      parrafos: [
        `Hola ${para.nombre}, la IA de ${negocio} viene trabajando mucho este mes.`,
        'Si llega al tope antes de que se renueve el contador, deja de contestar sola hasta esa fecha.',
      ],
      progreso: pct,
      datos,
      boton: { texto: 'Ver el consumo', url: `${url}/cuenta` },
      nota: '¿Te quedás corto todos los meses? Escribinos y armamos un plan a medida.',
    });
  }
  return plantillaOrbita({
    para: para.email,
    asunto: `${negocio} llegó al tope de respuestas`,
    previa: `La IA vuelve a contestar el ${fechaDeClave(reinicia)}.`,
    etiqueta: 'Tope alcanzado',
    tono: 'rojo',
    titulo: 'Llegaste al tope de respuestas',
    parrafos: [
      `Hola ${para.nombre}, la IA de ${negocio} usó todas las respuestas de este período.`,
      'Hasta que se renueve el contador, tus clientes reciben el mensaje de tope y la charla queda para que la atiendas vos.',
    ],
    progreso: 100,
    datos,
    boton: { texto: 'Quiero más respuestas', url: `${url}/contacto` },
  });
}

const IDEAS: { titulo: string; texto: string }[] = [
  { titulo: 'Probá tu IA fuera de horario', texto: 'Pedile a alguien de confianza que escriba a la noche. Si la IA responde con tus precios y horarios, el plan ya está trabajando mientras el local está cerrado.' },
  { titulo: 'Completá lo que la IA no supo', texto: 'Revisá en el panel las preguntas que quedaron sin respuesta. Cada una que completes es una venta que no se pierde.' },
  { titulo: 'Un solo cerebro, todos tus canales', texto: 'Si vendés por WhatsApp y por Instagram, conectá los dos. Es la misma IA y el cliente no tiene que repetir el pedido.' },
  { titulo: 'Horarios reales, feriados incluidos', texto: 'Dejá cargados los horarios reales. Así la IA no ofrece turnos cuando el local está cerrado.' },
  { titulo: 'Precios al día', texto: 'Un precio viejo hace que la IA confirme mal. Conviene revisar la información una vez por mes.' },
  { titulo: 'Respondé las derivaciones en el día', texto: 'Cuando alguien pide hablar con una persona, te llega un mail. Si contestás en el día, ese cliente no se va.' },
  { titulo: 'Usá la demo como laboratorio', texto: 'Antes de cambiar precios o servicios, probalos en la demo. Ves cómo responde la IA sin tocar lo que ven tus clientes.' },
  { titulo: 'Adelantate a la temporada', texto: 'Si tu rubro tiene temporadas, actualizá el texto de la IA al empezar cada una. No hace falta esperar a que pregunten.' },
  { titulo: 'Mirá la agenda a la mañana', texto: 'Un turno que la IA confirmó a las 23 vale igual que uno tomado en el mostrador. Arrancá el día revisando la agenda.' },
  { titulo: 'Revisá tus conexiones', texto: 'Si un canal se desconecta, la IA de ese canal deja de contestar. En Conexión ves cuáles están activos.' },
  { titulo: 'Vigilá el consumo', texto: 'El tope de respuestas es mensual. Si un mes viene cargado, conviene verlo antes de que la IA se detenga.' },
  { titulo: 'Dale tu tono', texto: 'Contale a la IA cómo querés que salude y qué no debe prometer. El tono se nota desde la primera respuesta.' },
];

export function mensajeNewsletter(para: Destinatario, negocio: string, mes: number, url: string, bajaUrl: string): MensajeCorreo {
  const idea = IDEAS[((mes % IDEAS.length) + IDEAS.length) % IDEAS.length];
  return plantillaOrbita({
    para: para.email,
    asunto: `${idea.titulo} · Idea del mes para ${negocio}`,
    previa: idea.texto,
    etiqueta: 'Idea del mes',
    titulo: idea.titulo,
    parrafos: [`Hola ${para.nombre}, una idea corta para sacarle más provecho a la IA de ${negocio}.`, idea.texto],
    boton: { texto: 'Abrir el panel', url: `${url}/cuenta` },
    nota: 'Te mandamos una sola idea por mes.',
    bajaUrl,
  });
}

export function mensajeSeguimiento(para: Destinatario, negocio: string, plan: string, url: string): MensajeCorreo {
  return plantillaOrbita({
    para: para.email,
    asunto: `¿Cómo viene ${negocio} con órbita?`,
    previa: 'Tres cosas para revisar en tus primeros días.',
    etiqueta: 'Primeros días',
    titulo: `¿Cómo viene ${negocio}?`,
    parrafos: [`Hola ${para.nombre}, hace unos días activaste el plan ${plan}. Para que la IA rinda desde la primera semana, revisá estas tres cosas:`],
    pasos: [
      'Conectá WhatsApp, Instagram o TikTok desde Conexión.',
      'Completá horarios, precios y preguntas frecuentes en Mi IA.',
      'Probá la IA en el simulador como si fueras un cliente.',
    ],
    boton: { texto: 'Abrir el panel', url: `${url}/cuenta` },
    nota: '¿Algo no cierra? Escribinos desde orbita-emp.com/contacto y te ayudamos a dejarlo andando.',
  });
}

export function mensajePromoGratis(para: Destinatario, negocio: string, url: string, bajaUrl: string): MensajeCorreo {
  const planes = PLANES.filter((p) => p.id !== 'personalizado');
  return plantillaOrbita({
    para: para.email,
    asunto: 'Tu IA ya está lista para atender clientes',
    previa: `Pasá ${negocio} de la demo a tus clientes reales.`,
    etiqueta: 'Tu demo',
    titulo: 'Tu IA está lista para atender clientes',
    parrafos: [
      `Hola ${para.nombre}, la cuenta de ${negocio} sigue en modo demo.`,
      'Con un plan, esa misma IA contesta a tus clientes en WhatsApp, Instagram y TikTok las 24 horas, toma turnos y te pasa la charla cuando hace falta una persona.',
    ],
    datos: planes.map((p) => ({ k: `Plan ${p.nombre}`, v: `${pesos(p.precioMercadoPago)}/mes` })),
    boton: { texto: 'Elegir mi plan', url: `${url}/cuenta/plan` },
    nota: 'Sin permanencia. Pagás con Mercado Pago y tenés 10 días para arrepentirte.',
    bajaUrl,
  });
}
