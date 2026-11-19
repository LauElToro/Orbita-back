import { lookup as dnsLookup } from 'node:dns';
import nodemailer from 'nodemailer';
import type { Config } from '../config';

export interface MensajeCorreo {
  para: string;
  asunto: string;
  texto: string;
  html: string;
}

export interface Correo {
  enviar(mensaje: MensajeCorreo): Promise<void>;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);

export type Tono = 'azul' | 'verde' | 'ambar' | 'rojo';

export interface Plantilla {
  para: string;
  asunto: string;
  /** Texto que Gmail muestra al lado del asunto en la bandeja. */
  previa?: string;
  etiqueta?: string;
  tono?: Tono;
  titulo: string;
  parrafos: string[];
  datos?: { k: string; v: string }[];
  /** Porcentaje de 0 a 100 para la barra de consumo. */
  progreso?: number;
  pasos?: string[];
  boton?: { texto: string; url: string };
  nota?: string;
  bajaUrl?: string;
}

const TONOS: Record<Tono, { fuerte: string; suave: string }> = {
  azul: { fuerte: '#4577fe', suave: '#eaf0ff' },
  verde: { fuerte: '#16a34a', suave: '#e6f6ec' },
  ambar: { fuerte: '#c27803', suave: '#fdf3df' },
  rojo: { fuerte: '#dc3545', suave: '#fdecee' },
};

const FUENTE = "'Manrope','Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const sitio = () => (process.env.PUBLIC_URL || 'https://orbita-emp.com').replace(/\/$/, '');

function filasDatos(datos: { k: string; v: string }[]): string {
  const filas = datos
    .map(
      (d, i) => `<tr>
<td style="padding:13px 18px;${i ? 'border-top:1px solid #e6eaf2;' : ''}font:400 14px/1.4 ${FUENTE};color:#6b7385">${esc(d.k)}</td>
<td align="right" style="padding:13px 18px;${i ? 'border-top:1px solid #e6eaf2;' : ''}font:700 15px/1.4 ${FUENTE};color:#0a0a0e">${esc(d.v)}</td>
</tr>`,
    )
    .join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f8fc;border:1px solid #e6eaf2;border-radius:14px;margin:26px 0 4px;border-collapse:separate">${filas}</table>`;
}

function barra(pct: number, color: string): string {
  const lleno = Math.max(2, Math.min(100, Math.round(pct)));
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:24px 0 0">
<tr><td style="font:700 13px/1 ${FUENTE};color:${color};padding-bottom:10px">${lleno}% usado</td></tr>
<tr><td style="background:#eceff5;border-radius:999px;height:10px;line-height:10px;font-size:0">
<table role="presentation" width="${lleno}%" cellpadding="0" cellspacing="0"><tr><td style="background:${color};border-radius:999px;height:10px;line-height:10px;font-size:0">&nbsp;</td></tr></table>
</td></tr></table>`;
}

function listaPasos(pasos: string[], color: string): string {
  const filas = pasos
    .map(
      (p, i) => `<tr>
<td valign="top" width="40" style="padding:0 0 16px">
<table role="presentation" cellpadding="0" cellspacing="0"><tr><td align="center" width="28" height="28" style="background:${color};border-radius:999px;font:800 13px/28px ${FUENTE};color:#fff">${i + 1}</td></tr></table>
</td>
<td valign="top" style="padding:4px 0 16px;font:400 15px/1.55 ${FUENTE};color:#2b3244">${esc(p)}</td>
</tr>`,
    )
    .join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:26px 0 0">${filas}</table>`;
}

function botonHtml(b: { texto: string; url: string }, color: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:30px 0 0"><tr>
<td align="center" bgcolor="${color}" style="border-radius:12px;background:${color}">
<!--[if mso]><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" href="${esc(b.url)}" style="height:50px;v-text-anchor:middle;width:260px" arcsize="24%" stroke="f" fillcolor="${color}"><center style="color:#ffffff;font-family:Arial,sans-serif;font-size:15px;font-weight:bold">${esc(b.texto)}</center></v:roundrect><![endif]-->
<!--[if !mso]><!--><a href="${esc(b.url)}" style="display:inline-block;padding:15px 28px;font:700 15px/20px ${FUENTE};color:#ffffff;text-decoration:none;border-radius:12px">${esc(b.texto)}&nbsp;&rarr;</a><!--<![endif]-->
</td></tr></table>
<p style="margin:16px 0 0;font:400 12px/1.5 ${FUENTE};color:#8a90a2">Si el botón no abre, copiá este link:<br><a href="${esc(b.url)}" style="color:#8a90a2;word-break:break-all">${esc(b.url)}</a></p>`;
}

/** Plantilla de los mails de Orbita: tarjeta centrada, compatible con Gmail, Outlook y Apple Mail. */
export function plantillaOrbita(p: Plantilla): MensajeCorreo {
  const tono = TONOS[p.tono ?? 'azul'];
  const base = sitio();
  const previa = p.previa ?? p.parrafos[0] ?? '';

  const html = `<!doctype html>
<html lang="es" xmlns:v="urn:schemas-microsoft-com:vml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${esc(p.asunto)}</title>
<link href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;600;700;800&display=swap" rel="stylesheet">
<style>
@media (max-width:600px){.tarjeta{padding:30px 22px 26px!important}.titulo{font-size:24px!important}}
a{color:${tono.fuerte}}
</style>
</head>
<body style="margin:0;padding:0;background:#eef1f7;-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:#eef1f7">${esc(previa)}${'&#8204;&nbsp;'.repeat(60)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#eef1f7" style="background:#eef1f7">
<tr><td align="center" style="padding:36px 14px 40px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px">

<tr><td style="padding:0 6px 22px">
<a href="${base}" style="text-decoration:none">
<table role="presentation" cellpadding="0" cellspacing="0"><tr>
<td valign="middle"><img src="${base}/api/mail/logo.png" width="34" height="30" alt="" style="display:block;border:0;width:34px;height:30px"></td>
<td valign="middle" style="padding-left:10px;font:800 23px/1 ${FUENTE};letter-spacing:-0.8px;color:#0a0a0e">órbita</td>
</tr></table>
</a>
</td></tr>

<tr><td bgcolor="#ffffff" style="background:#ffffff;border:1px solid #e3e7f0;border-radius:22px;box-shadow:0 18px 40px -24px rgba(20,30,80,.25)">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0">
<tr><td height="5" style="height:5px;line-height:5px;font-size:0;background:${tono.fuerte};border-radius:22px 22px 0 0">&nbsp;</td></tr>
<tr><td class="tarjeta" style="padding:38px 42px 34px">
${
  p.etiqueta
    ? `<table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="background:${tono.suave};color:${tono.fuerte};border-radius:999px;padding:7px 13px;font:800 11px/1 ${FUENTE};letter-spacing:1.4px;text-transform:uppercase">${esc(p.etiqueta)}</td></tr></table>`
    : ''
}
<h1 class="titulo" style="margin:${p.etiqueta ? '20px' : '0'} 0 16px;font:800 28px/1.22 ${FUENTE};letter-spacing:-0.7px;color:#0a0a0e">${esc(p.titulo)}</h1>
${p.parrafos.map((t) => `<p style="margin:0 0 14px;font:400 16px/1.65 ${FUENTE};color:#3d4456">${esc(t)}</p>`).join('\n')}
${p.progreso !== undefined ? barra(p.progreso, tono.fuerte) : ''}
${p.datos?.length ? filasDatos(p.datos) : ''}
${p.pasos?.length ? listaPasos(p.pasos, tono.fuerte) : ''}
${p.boton ? botonHtml(p.boton, tono.fuerte) : ''}
${
  p.nota
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:30px 0 0"><tr><td style="border-top:1px solid #edf0f5;padding-top:20px;font:400 13px/1.6 ${FUENTE};color:#6b7385">${esc(p.nota)}</td></tr></table>`
    : ''
}
</td></tr>
</table>
</td></tr>

<tr><td align="center" style="padding:28px 20px 0;font:400 12px/1.7 ${FUENTE};color:#8a90a2">
<strong style="color:#4b5263;font-weight:700">órbita</strong> · Asistentes con IA para comercios<br>
<a href="${base}" style="color:#8a90a2;text-decoration:underline">orbita-emp.com</a> &nbsp;·&nbsp; <a href="${base}/contacto" style="color:#8a90a2;text-decoration:underline">Ayuda</a> &nbsp;·&nbsp; <a href="https://www.instagram.com/orbita.emp/" style="color:#8a90a2;text-decoration:underline">Instagram</a><br>
Este correo sale de una casilla que no recibe respuestas.${p.bajaUrl ? `<br><a href="${esc(p.bajaUrl)}" style="color:#8a90a2;text-decoration:underline">No quiero recibir novedades</a>` : ''}
</td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;

  const texto = [
    p.etiqueta ? p.etiqueta.toUpperCase() : '',
    p.titulo,
    '',
    ...p.parrafos.flatMap((t) => [t, '']),
    ...(p.progreso !== undefined ? [`${Math.round(p.progreso)}% usado`, ''] : []),
    ...(p.datos?.length ? [...p.datos.map((d) => `${d.k}: ${d.v}`), ''] : []),
    ...(p.pasos?.length ? [...p.pasos.map((t, i) => `${i + 1}. ${t}`), ''] : []),
    ...(p.boton ? [`${p.boton.texto}: ${p.boton.url}`, ''] : []),
    ...(p.nota ? [p.nota, ''] : []),
    '—',
    'órbita · Asistentes con IA para comercios',
    `${base}`,
    p.bajaUrl ? `No quiero recibir novedades: ${p.bajaUrl}` : '',
  ]
    .filter((linea, i, todas) => linea !== '' || (i > 0 && todas[i - 1] !== ''))
    .join('\n')
    .trim();

  return { para: p.para, asunto: p.asunto, texto, html };
}

/** Aviso simple: los avisos de afiliados y de derivación lo usan con un párrafo de intro y uno de detalle. */
export function avisoOrbita(
  para: string,
  asunto: string,
  intro: string,
  detalle: string,
  enlace?: { texto: string; url: string },
  bajaUrl?: string,
): MensajeCorreo {
  return plantillaOrbita({ para, asunto, titulo: asunto, parrafos: [intro, detalle], boton: enlace, bajaUrl });
}

export function crearCorreo(config: Config): Correo {
  const pass = config.SMTP_PASS.replace(/\s+/g, '');
  const from = config.SMTP_FROM || (config.SMTP_USER ? `Orbita <${config.SMTP_USER}>` : '');
  if (!from) return { async enviar() {} };
  const transport = nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: config.SMTP_PORT === 465,
    name: 'orbita-emp.com',
    auth: pass && config.SMTP_USER ? { user: config.SMTP_USER, pass } : undefined,
    // El relay de Google autoriza la IPv4 del servidor. La IPv6 no está habilitada.
    lookup: (hostname: string, _options: object, callback: (err: NodeJS.ErrnoException | null, address: string, family: number) => void) => {
      dnsLookup(hostname, { family: 4 }, callback);
    },
    connectionTimeout: 8_000,
    greetingTimeout: 8_000,
    socketTimeout: 12_000,
  } as unknown as Parameters<typeof nodemailer.createTransport>[0]);
  return {
    async enviar(mensaje) {
      await transport.sendMail({
        from,
        to: mensaje.para,
        replyTo: config.SMTP_USER || undefined,
        subject: mensaje.asunto,
        text: mensaje.texto,
        html: mensaje.html,
      });
    },
  };
}

export async function enviarCorreo(correo: Correo, mensaje: MensajeCorreo): Promise<void> {
  try {
    await correo.enviar(mensaje);
  } catch (err) {
    console.error(`correo: ${err instanceof Error ? err.message : 'no se pudo enviar'}`);
  }
}
