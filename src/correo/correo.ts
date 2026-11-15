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

/** Aviso de la empresa. El remitente visible es Orbita, no una casilla genérica. */
export function avisoOrbita(
  para: string,
  asunto: string,
  intro: string,
  detalle: string,
  enlace?: { texto: string; url: string },
): MensajeCorreo {
  const texto = [intro, '', detalle, enlace ? `${enlace.texto}: ${enlace.url}` : '', '', 'Orbita', 'Asistentes con IA para comercios'].join('\n');
  const boton = enlace
    ? `<p style="margin:24px 0"><a href="${esc(enlace.url)}" style="background:#5b4cf0;color:#fff;text-decoration:none;padding:12px 18px;border-radius:10px;display:inline-block;font-weight:700">${esc(enlace.texto)}</a></p>`
    : '';
  const html = `<div style="font-family:system-ui,sans-serif;color:#1d2330;max-width:520px;line-height:1.5">
<p style="font-weight:800;color:#5b4cf0;font-size:18px;margin:0 0 16px">Orbita</p>
<p style="margin:0 0 12px">${esc(intro)}</p>
<p style="margin:0 0 12px">${esc(detalle)}</p>
${boton}
<p style="color:#6b7385;font-size:13px;margin-top:28px">Orbita · Asistentes con IA para comercios</p>
</div>`;
  return { para, asunto, texto, html };
}

export function crearCorreo(config: Config): Correo {
  if (!config.SMTP_USER || !config.SMTP_PASS) return { async enviar() {} };
  const transport = nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: config.SMTP_PORT === 465,
    auth: { user: config.SMTP_USER, pass: config.SMTP_PASS.replace(/\s+/g, '') },
    connectionTimeout: 8_000,
    greetingTimeout: 8_000,
    socketTimeout: 12_000,
  });
  const from = config.SMTP_FROM || `Orbita <${config.SMTP_USER}>`;
  return {
    async enviar(mensaje) {
      await transport.sendMail({
        from,
        to: mensaje.para,
        replyTo: config.SMTP_USER,
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
