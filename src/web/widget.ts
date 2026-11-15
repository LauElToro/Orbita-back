/**
 * Script embebible. Se usa con:
 *   <script src="{PUBLIC_URL}/api/web/widget.js" data-clave="orb_..." async></script>
 * Opcionales: data-posicion="izquierda", data-abierto="true".
 * Expone window.Orbita.abrir(), .cerrar() y .enviar(texto).
 * Sin template literals ni dependencias: tiene que andar en cualquier sitio.
 */
export const WIDGET_JS = String.raw`(function () {
  'use strict';
  var script = document.currentScript || document.querySelector('script[data-clave][src*="widget.js"]');
  if (!script || window.Orbita) return;
  var clave = script.getAttribute('data-clave');
  if (!clave) { console.error('Orbita: falta data-clave en el script'); return; }
  var base = script.src.replace(/\/widget\.js(\?.*)?$/, '');
  var izquierda = script.getAttribute('data-posicion') === 'izquierda';
  var almacen = 'orbita:' + clave;

  function leer() { try { return JSON.parse(localStorage.getItem(almacen) || '{}'); } catch (e) { return {}; } }
  function guardar(e) { try { localStorage.setItem(almacen, JSON.stringify(e)); } catch (err) { /* modo privado */ } }
  function nuevaSesion() {
    var a = new Uint8Array(16); (window.crypto || window.msCrypto).getRandomValues(a);
    return Array.prototype.map.call(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }
  var estado = leer();
  if (!estado.sesion) estado.sesion = nuevaSesion();
  if (!estado.mensajes) estado.mensajes = [];
  guardar(estado);

  function pedir(metodo, ruta, cuerpo) {
    return fetch(base + '/' + encodeURIComponent(clave) + ruta, {
      method: metodo,
      headers: cuerpo ? { 'Content-Type': 'application/json' } : {},
      body: cuerpo ? JSON.stringify(cuerpo) : undefined
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) throw new Error(j.error || 'Error ' + r.status);
        return j;
      });
    });
  }

  var host = document.createElement('div');
  host.id = 'orbita-chat';
  var raiz = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
  raiz.innerHTML =
    '<style>' +
    ':host{all:initial}' +
    '*{box-sizing:border-box;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif}' +
    '.burbuja{position:fixed;bottom:20px;' + (izquierda ? 'left' : 'right') + ':20px;width:58px;height:58px;border-radius:50%;border:0;cursor:pointer;color:#fff;box-shadow:0 6px 20px rgba(0,0,0,.25);display:flex;align-items:center;justify-content:center;z-index:2147483000}' +
    '.burbuja svg{width:28px;height:28px}' +
    '.panel{position:fixed;bottom:90px;' + (izquierda ? 'left' : 'right') + ':20px;width:360px;max-width:calc(100vw - 24px);height:520px;max-height:calc(100vh - 110px);background:#fff;border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,.25);display:none;flex-direction:column;overflow:hidden;z-index:2147483000}' +
    '.panel.abierto{display:flex}' +
    '.cab{color:#fff;padding:14px 16px;display:flex;align-items:center;justify-content:space-between}' +
    '.cab strong{font-size:15px}.cab small{display:block;opacity:.85;font-size:12px}' +
    '.cerrar{background:none;border:0;color:#fff;font-size:22px;cursor:pointer;line-height:1}' +
    '.msjs{flex:1;overflow-y:auto;padding:14px;background:#f6f7fb;display:flex;flex-direction:column;gap:8px}' +
    '.m{max-width:82%;padding:9px 12px;border-radius:14px;font-size:14px;line-height:1.4;white-space:pre-wrap;word-wrap:break-word}' +
    '.bot{background:#fff;color:#1d1f2b;border:1px solid #e5e7ef;align-self:flex-start;border-bottom-left-radius:4px}' +
    '.yo{color:#fff;align-self:flex-end;border-bottom-right-radius:4px}' +
    '.escribiendo{color:#7a7f93;font-style:italic}' +
    'form{display:flex;gap:8px;padding:10px;border-top:1px solid #e5e7ef;background:#fff}' +
    'input{flex:1;border:1px solid #d6d9e4;border-radius:10px;padding:10px 12px;font-size:14px;outline:none;color:#1d1f2b;background:#fff}' +
    'input:focus{border-color:#9aa0b5}' +
    'button.enviar{border:0;border-radius:10px;padding:0 14px;color:#fff;font-weight:600;cursor:pointer;font-size:14px}' +
    'button:disabled{opacity:.6;cursor:default}' +
    '.contacto{padding:10px;background:#fffbea;border-top:1px solid #f1e3a8;font-size:13px;color:#5c4a00}' +
    '.contacto form{padding:8px 0 0;border:0;background:none}' +
    '.pie{font-size:11px;text-align:center;color:#9aa0b5;padding:0 0 8px;background:#fff}' +
    '</style>' +
    '<button class="burbuja" aria-label="Abrir chat"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M4 4h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H8l-4 4V6a2 2 0 0 1 2-2z"/></svg></button>' +
    '<div class="panel" role="dialog" aria-label="Chat">' +
    '<div class="cab"><div><strong class="titulo">Chat</strong><small>Responde al instante</small></div><button class="cerrar" aria-label="Cerrar">&times;</button></div>' +
    '<div class="msjs" aria-live="polite"></div>' +
    '<div class="contacto" hidden>Dejanos tu WhatsApp o email y te escriben del local.<form class="f-contacto"><input name="contacto" placeholder="WhatsApp o email" required minlength="5" maxlength="120"><button class="enviar">Enviar</button></form></div>' +
    '<form class="f-msj"><input name="texto" placeholder="Escribí tu consulta..." autocomplete="off" maxlength="1000"><button class="enviar">Enviar</button></form>' +
    '<div class="pie">Asistente con IA · Orbita</div>' +
    '</div>';

  var $ = function (s) { return raiz.querySelector(s); };
  var burbuja = $('.burbuja'), panel = $('.panel'), msjs = $('.msjs'), form = $('.f-msj'), input = form.querySelector('input');
  var boton = form.querySelector('button'), caja = $('.contacto'), fContacto = $('.f-contacto');
  var color = '#5b4bff', bienvenida = '';

  function pintar(rol, texto) {
    var d = document.createElement('div');
    d.className = 'm ' + rol;
    d.textContent = texto;
    if (rol === 'yo') d.style.background = color;
    msjs.appendChild(d);
    msjs.scrollTop = msjs.scrollHeight;
    return d;
  }
  function agregar(rol, texto) {
    estado.mensajes.push({ rol: rol, texto: texto });
    estado.mensajes = estado.mensajes.slice(-40);
    guardar(estado);
    pintar(rol, texto);
  }
  function repintar() {
    msjs.innerHTML = '';
    if (bienvenida) pintar('bot', bienvenida);
    estado.mensajes.forEach(function (m) { pintar(m.rol, m.texto); });
    caja.hidden = !estado.pedirContacto;
  }
  function aplicarColor() {
    burbuja.style.background = color;
    $('.cab').style.background = color;
    Array.prototype.forEach.call(raiz.querySelectorAll('button.enviar'), function (b) { b.style.background = color; });
  }

  function abrir() { panel.classList.add('abierto'); setTimeout(function () { input.focus(); }, 50); }
  function cerrar() { panel.classList.remove('abierto'); }
  burbuja.addEventListener('click', function () { panel.classList.contains('abierto') ? cerrar() : abrir(); });
  $('.cerrar').addEventListener('click', cerrar);

  function enviar(texto) {
    texto = (texto || '').trim();
    if (!texto || boton.disabled) return;
    agregar('yo', texto);
    input.value = '';
    boton.disabled = true;
    var esperando = pintar('bot escribiendo', 'Escribiendo...');
    pedir('POST', '/mensajes', { sesion: estado.sesion, texto: texto })
      .then(function (r) {
        esperando.remove();
        if (r.estado === 'no_disponible') { pintar('bot', 'El asistente no está disponible en este momento.'); return; }
        agregar('bot', r.texto);
        if (r.handoff) { estado.pedirContacto = true; guardar(estado); caja.hidden = false; }
      })
      .catch(function (e) { esperando.remove(); pintar('bot', e.message || 'No pudimos responder. Probá de nuevo en un momento.'); })
      .then(function () { boton.disabled = false; input.focus(); });
  }
  form.addEventListener('submit', function (e) { e.preventDefault(); enviar(input.value); });
  fContacto.addEventListener('submit', function (e) {
    e.preventDefault();
    var campo = fContacto.querySelector('input');
    pedir('POST', '/contacto', { sesion: estado.sesion, contacto: campo.value })
      .then(function () {
        estado.pedirContacto = false; guardar(estado); caja.hidden = true; campo.value = '';
        agregar('bot', '¡Gracias! Le pasamos tu contacto al local y te van a escribir a la brevedad.');
      })
      .catch(function (err) { pintar('bot', err.message); });
  });

  pedir('GET', '')
    .then(function (c) {
      color = c.color || color;
      bienvenida = c.bienvenida || '';
      $('.titulo').textContent = c.negocio;
      if (!c.disponible) { input.disabled = true; boton.disabled = true; input.placeholder = 'El asistente no está disponible ahora'; }
      aplicarColor();
      repintar();
      (document.body || document.documentElement).appendChild(host);
      if (script.getAttribute('data-abierto') === 'true') abrir();
    })
    .catch(function (e) { console.error('Orbita: ' + e.message); });

  window.Orbita = { abrir: abrir, cerrar: cerrar, enviar: function (t) { abrir(); enviar(t); } };
})();
`;
