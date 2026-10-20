// Receptor de diagnosticos de las clinicas. Sin dependencias (Node 18+).
// POST /diagnostico  (JSON)  -> guarda DATA_DIR/<fecha>_<host>.json y avisa a NTFY_URL si existe.
// POST /latido       (JSON)  -> estado de una instalacion (cada pocos minutos y al cambiar de estado).
// GET  /clinicas     -> estado de cada clinica: ok / con problemas / conectando / desconectado / sin señal / apagada.
// GET  /diagnosticos -> listado web de informes (ver / descargar / borrar).
// GET  /             -> lleva a /clinicas. Las paginas requieren ADMIN_PASS (Basic auth); sin ella quedan desactivadas.
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || '/data';
const NTFY_URL = process.env.NTFY_URL || ''; // opcional: https://ntfy.tudominio/tema
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || '';
const ZONA = process.env.TZ || 'Europe/Madrid';
const MAX_BYTES = 256 * 1024;
const MAX_POR_HORA = 10; // por IP
const MAX_FICHEROS = 1000;
const OFFLINE_MS = (Number(process.env.OFFLINE_MIN) || 12) * 60000; // sin latidos (llegan cada 5 min) = sin señal
const CONECTANDO_MAX_MS = 10 * 60000; // 'conectando' durante mas de esto ya es un problema
const MAX_CLINICAS = 500;
const REFRESCO_S = Number(process.env.REFRESCO_S) || 5; // cada cuantos segundos se actualiza la pagina de clinicas

fs.mkdirSync(DATA_DIR, { recursive: true });
// Estado de las clinicas: en una subcarpeta, para que no se mezcle con los informes (que son *.json de DATA_DIR)
const ESTADO_DIR = path.join(DATA_DIR, 'estado');
fs.mkdirSync(ESTADO_DIR, { recursive: true });
const CLINICAS_PATH = path.join(ESTADO_DIR, 'clinicas.json');
let clinicas = (() => { try { return JSON.parse(fs.readFileSync(CLINICAS_PATH, 'utf8')); } catch (_) { return {}; } })();
const guardarClinicas = () => fs.writeFileSync(CLINICAS_PATH, JSON.stringify(clinicas));
const visitas = new Map(); // ip -> timestamps; ponytail: en memoria, se pierde al reiniciar
const visitasLatido = new Map(); // 'ip:..' / 'id:..' -> timestamps
const fallos = new Map(); // ip -> timestamps de logins fallidos

// true si la clave ha superado max peticiones en la ultima hora
function limitar(mapa, clave, max) {
  const ahora = Date.now();
  const ts = (mapa.get(clave) || []).filter((t) => ahora - t < 3600e3);
  ts.push(ahora);
  mapa.set(clave, ts);
  return ts.length > max;
}
const limitado = (ip) => limitar(visitas, ip, MAX_POR_HORA);

// El Origin, si viene, tiene que ser esta misma pagina (cualquier web abierta en el navegador podria
// mandar un POST/DELETE con las credenciales ya guardadas)
function origenPropio(req) {
  const origen = req.headers.origin;
  if (!origen) return true;
  try { return new URL(origen).host === req.headers.host; } catch { return false; }
}

const iguales = (a, b) => {
  const x = crypto.createHash('sha256').update(a).digest();
  const y = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(x, y);
};
const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
// Detras de Cloudflare la IP real va en CF-Connecting-IP (no falsificable); X-Forwarded-For lo controla el cliente.
const ipDe = (req) => String(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress).split(',')[0].trim();

// Devuelve true si la peticion esta autorizada; si no, ya ha respondido.
function autorizar(req, res) {
  if (!ADMIN_PASS) { responder(res, 403, 'interfaz desactivada: define ADMIN_PASS'); return false; }
  const ip = ipDe(req);
  const recientes = (fallos.get(ip) || []).filter((t) => Date.now() - t < 3600e3);
  // el bloqueo va ANTES de comparar: si no, un intento acertado pasaria durante la fuerza bruta
  if (recientes.length >= MAX_POR_HORA) { responder(res, 429, 'demasiados intentos'); return false; }
  const [u = '', p = ''] = Buffer.from((req.headers.authorization || '').replace(/^Basic /, ''), 'base64').toString().split(/:(.*)/s);
  if (iguales(u, ADMIN_USER) && iguales(p, ADMIN_PASS)) return true;
  if (req.headers.authorization) { recientes.push(Date.now()); fallos.set(ip, recientes); }
  res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="soporte"', 'Content-Type': 'text/plain' });
  res.end('autenticacion requerida');
  return false;
}

const ESTILO = `body{font:14px system-ui;margin:16px;max-width:1100px}table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:6px 10px;border-bottom:1px solid #ddd;vertical-align:top}small{color:#666}
nav{margin-bottom:14px;font-size:15px}nav a{margin-right:14px;color:#2b6cb0;text-decoration:none}nav a.activa{font-weight:700;color:#111;border-bottom:2px solid #2b6cb0}
.chip{display:inline-block;padding:2px 10px;border-radius:12px;font-weight:600;font-size:13px;white-space:nowrap}
.ok{background:#dcfce7;color:#166534}.warning{background:#fef3c7;color:#92400e}.conectando{background:#dbeafe;color:#1e40af}
.desconectado{background:#fee2e2;color:#991b1b}.offline{background:#4b5563;color:#fff}.apagada{background:#e5e7eb;color:#374151}
.resumen{margin:0 0 14px}.resumen .chip{margin-right:8px}a.accion{font-size:12px;margin-left:8px;color:#2b6cb0}`;

function plantilla(titulo, activa, cuerpo, extra = '') {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(titulo)}</title><style>${ESTILO}</style>
<nav><a href="/clinicas"${activa === 'clinicas' ? ' class="activa"' : ''}>Clínicas</a><a href="/diagnosticos"${activa === 'diagnosticos' ? ' class="activa"' : ''}>Diagnósticos</a></nav>
${cuerpo}${extra}`;
}

function paginaListado() {
  const todos = fs.readdirSync(DATA_DIR).filter((n) => /^[\w.-]+\.json$/.test(n));
  const kb = Math.round(todos.reduce((t, n) => t + fs.statSync(path.join(DATA_DIR, n)).size, 0) / 1024);
  const filas = todos.sort().reverse().slice(0, 200).map((n) => {
    let d = {};
    try { d = JSON.parse(fs.readFileSync(path.join(DATA_DIR, n), 'utf8')); } catch (_) { /* fichero ilegible */ }
    const fecha = fs.statSync(path.join(DATA_DIR, n)).mtime.toLocaleString('es-ES', { timeZone: ZONA });
    const u = encodeURIComponent(n);
    return `<tr><td>${esc(d.host)}<br><small>${esc(d._ip)}</small></td><td>${esc(fecha)}</td><td>${esc(d.version)}</td>`
      + `<td>${esc(d.estado)}${d.ultimoError ? `<br><small>${esc(String(d.ultimoError).slice(0, 80))}</small>` : ''}</td>`
      + `<td><a href="/f/${u}">ver</a> · <a href="/f/${u}?d=1">descargar</a> · <a href="#" data-borrar="${esc(n)}">borrar</a></td></tr>`;
  });
  return plantilla('Diagnósticos', 'diagnosticos', `<h1>Diagnósticos recibidos (${todos.length}, ${kb} KB)</h1>
<table><tr><th>Origen</th><th>Fecha</th><th>Versión</th><th>Estado</th><th></th></tr>${filas.join('') || '<tr><td colspan=5>Sin informes todavía</td></tr>'}</table>`, `
<script>
document.addEventListener('click', async (e) => {
  const n = e.target.dataset && e.target.dataset.borrar;
  if (!n) return;
  e.preventDefault();
  if (!confirm('¿Borrar ' + n + '? No se puede deshacer.')) return;
  const r = await fetch('/f/' + encodeURIComponent(n), { method: 'DELETE' });
  if (r.ok) location.reload(); else alert('No se pudo borrar (' + r.status + ')');
});
</script>`);
}

// ---------- Estado de las clinicas ----------
const ORDEN = { offline: 0, desconectado: 1, warning: 2, conectando: 3, ok: 4, apagada: 5 };
const ETIQUETA = { ok: 'OK', warning: 'Con problemas', conectando: 'Conectando', desconectado: 'Desconectado', offline: 'Sin señal', apagada: 'Apagada' };

function hace(ms) {
  const m = Math.round(ms / 60000);
  if (m < 1) return 'ahora';
  if (m < 60) return `hace ${m} min`;
  const h = Math.round(m / 60);
  return h < 48 ? `hace ${h} h` : `hace ${Math.round(h / 24)} d`;
}

// Lo que se muestra: el estado que dijo la app, salvo que haya dejado de dar señales
function estadoVisible(c, ahora = Date.now()) {
  if (c.estado === 'apagada') return 'apagada'; // la cerraron ellos: no es una caida
  if (ahora - c.ultimo > OFFLINE_MS) return 'offline';
  if (c.estado === 'conectado') return 'ok';
  if (c.estado === 'degradado') return 'warning';
  if (c.estado === 'conectando') return ahora - (c.desdeEstado || c.ultimo) > CONECTANDO_MAX_MS ? 'warning' : 'conectando';
  return 'desconectado'; // desconectado | error
}

function detalle(c, v, ahora) {
  if (v === 'offline') return `Sin latidos ${hace(ahora - c.ultimo)}: equipo apagado, sin internet o aplicación cerrada a la fuerza`;
  if (v === 'warning') return c.estado === 'conectando' ? `Lleva ${hace(ahora - c.desdeEstado).replace('hace ', '')} conectando` : (c.causa || 'Conexión con problemas');
  if (v === 'desconectado') return c.ultimoError || 'Sin conexión con WhatsApp';
  if (v === 'apagada') return 'Cerrada con «Apagar»';
  return '';
}

function validarLatido(d) {
  const ESTADOS = ['conectado', 'degradado', 'conectando', 'desconectado', 'error', 'apagada'];
  const cad = (v, n) => (typeof v === 'string' ? v.slice(0, n) : null);
  if (!d || typeof d !== 'object' || typeof d.id !== 'string' || !/^[a-f0-9-]{16,40}$/.test(d.id) || !ESTADOS.includes(d.estado)) return null;
  return {
    id: d.id, estado: d.estado, host: cad(d.host, 60), version: cad(d.version, 20), canal: cad(d.canal, 20), motor: cad(d.motor, 20),
    causa: cad(d.causa, 200), ultimoError: cad(d.ultimoError, 200),
    ultimoOk: Number.isFinite(d.ultimoOk) ? d.ultimoOk : null, arranqueHaceSeg: Number.isFinite(d.arranqueHaceSeg) ? Math.round(d.arranqueHaceSeg) : null
  };
}

// false si ya hay MAX_CLINICAS instalaciones y esta es nueva
function registrarLatido(l, ip) {
  const ahora = Date.now();
  let c = clinicas[l.id];
  if (!c) {
    if (Object.keys(clinicas).length >= MAX_CLINICAS) return false;
    c = clinicas[l.id] = { id: l.id, alias: null, primero: ahora, cambios: [] };
  }
  const cambio = c.estado !== l.estado;
  Object.assign(c, l, { ip, ultimo: ahora });
  if (cambio) {
    c.desdeEstado = ahora;
    c.cambios = [...c.cambios, { t: ahora, estado: l.estado }].slice(-20);
  }
  guardarClinicas();
  return true;
}

// Solo lo que cambia (resumen y tabla): la pagina lo pide cada pocos segundos y lo sustituye
function contenidoClinicas() {
  const ahora = Date.now();
  const filas = Object.values(clinicas)
    .map((c) => ({ c, v: estadoVisible(c, ahora) }))
    .sort((a, b) => ORDEN[a.v] - ORDEN[b.v] || String(a.c.alias || a.c.host).localeCompare(String(b.c.alias || b.c.host)));
  const cuenta = {};
  for (const { v } of filas) cuenta[v] = (cuenta[v] || 0) + 1;
  const resumen = Object.keys(ORDEN).filter((v) => cuenta[v]).map((v) => `<span class="chip ${v}">${cuenta[v]} ${esc(ETIQUETA[v])}</span>`).join('');
  const html = filas.map(({ c, v }) => `<tr>
<td><span class="chip ${v}">${esc(ETIQUETA[v])}</span></td>
<td><b>${esc(c.alias || c.host || 'sin nombre')}</b>${c.alias ? `<br><small>${esc(c.host)}</small>` : ''}<br><small title="${esc(c.id)}">${esc(c.id.slice(0, 8))}</small>
<a href="#" class="accion" data-renombrar="${esc(c.id)}" data-alias="${esc(c.alias || '')}">renombrar</a><a href="#" class="accion" data-olvidar="${esc(c.id)}">olvidar</a></td>
<td>${esc(detalle(c, v, ahora))}</td>
<td>${esc(c.version)}<br><small>${esc(c.motor)}${c.canal && c.canal !== 'main' ? ' · canal ' + esc(c.canal) : ''}</small></td>
<td>${esc(hace(ahora - c.ultimo))}</td>
<td>${esc(c.desdeEstado ? hace(ahora - c.desdeEstado) : '')}</td>
<td><small>${esc(c.ip)}</small></td></tr>`);
  return `<h1>Clínicas (${filas.length})</h1>
<p class="resumen">${resumen || 'Aún no ha llegado ningún latido.'}</p>
<table><tr><th>Estado</th><th>Clínica</th><th>Detalle</th><th>Versión</th><th>Último latido</th><th>En este estado</th><th>IP</th></tr>${html.join('') || '<tr><td colspan=7>Sin clínicas todavía: aparecen cuando una aplicación 2.4 o posterior manda su primer latido.</td></tr>'}</table>
<p><small>Cada aplicación avisa cada 5 minutos y al cambiar de estado. «Sin señal» = ${Math.round(OFFLINE_MS / 60000)} min sin latidos.</small></p>`;
}

function paginaClinicas() {
  return plantilla('Clínicas', 'clinicas', `<div id="contenido">${contenidoClinicas()}</div>
<p><small id="actualizado">Se actualiza sola cada ${REFRESCO_S} s.</small></p>`, `
<script>
document.addEventListener('click', async (e) => {
  const d = e.target.dataset || {};
  if (!d.renombrar && !d.olvidar) return;
  e.preventDefault();
  let r;
  if (d.renombrar) {
    const alias = prompt('Nombre para esta clínica (vacío = usar el del equipo):', d.alias);
    if (alias === null) return;
    r = await fetch('/clinicas/' + d.renombrar, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ alias }) });
  } else {
    if (!confirm('¿Olvidar esta instalación? Volverá a aparecer si sigue mandando latidos.')) return;
    r = await fetch('/clinicas/' + d.olvidar, { method: 'DELETE' });
  }
  if (r.ok) refrescar(); else alert('No se pudo (' + r.status + ')');
});

// Actualizacion en vivo: pide solo la tabla cada pocos segundos y la sustituye (sin perder el scroll).
// En segundo plano no pide nada, y al volver a la pestaña se actualiza al momento.
let fallos = 0;
async function refrescar() {
  if (document.hidden) return;
  try {
    const r = await fetch('/clinicas?parcial=1', { cache: 'no-store' });
    if (r.status === 401) { document.getElementById('actualizado').textContent = 'La sesión ha caducado: recarga la página.'; return; }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    document.getElementById('contenido').innerHTML = await r.text();
    fallos = 0;
    document.getElementById('actualizado').textContent = 'Actualizado a las ' + new Date().toLocaleTimeString('es-ES') + ' · se actualiza sola cada ${REFRESCO_S} s.';
  } catch (e) {
    if (++fallos >= 2) document.getElementById('actualizado').textContent = 'No se puede contactar con el servidor de soporte (¿sin conexión?). Se sigue intentando.';
  }
}
setInterval(refrescar, ${REFRESCO_S * 1000});
document.addEventListener('visibilitychange', refrescar);
</script>`);
}

function podar() {
  const f = fs.readdirSync(DATA_DIR).filter((n) => n.endsWith('.json')).sort();
  f.slice(0, Math.max(0, f.length - MAX_FICHEROS)).forEach((n) => fs.rmSync(path.join(DATA_DIR, n), { force: true }));
}

const responder = (res, code, texto) => { res.writeHead(code, { 'Content-Type': 'text/plain' }); res.end(texto); };

// Lee un cuerpo JSON de hasta max bytes y llama a alTerminar(objeto); si no, ya ha respondido (413 / 400)
function leerJson(req, res, max, alTerminar) {
  let cuerpo = '';
  let excedido = false;
  req.on('data', (c) => {
    cuerpo += c;
    if (cuerpo.length > max && !excedido) { excedido = true; responder(res, 413, 'demasiado grande'); req.destroy(); }
  });
  req.on('end', () => {
    if (excedido) return;
    try { alTerminar(JSON.parse(cuerpo)); } catch { responder(res, 400, 'json invalido'); }
  });
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'GET' && url.pathname === '/health') return responder(res, 200, 'ok');
  if (req.method === 'GET' && url.pathname === '/') {
    if (!autorizar(req, res)) return;
    res.writeHead(302, { Location: '/clinicas' });
    return res.end();
  }
  if (req.method === 'GET' && (url.pathname === '/clinicas' || url.pathname === '/diagnosticos')) {
    if (!autorizar(req, res)) return;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    if (url.pathname === '/clinicas' && url.searchParams.has('parcial')) return res.end(contenidoClinicas());
    return res.end(url.pathname === '/clinicas' ? paginaClinicas() : paginaListado());
  }
  if (req.method === 'POST' && url.pathname === '/latido') {
    if (limitar(visitasLatido, 'ip:' + ipDe(req), 120)) return responder(res, 429, 'demasiadas peticiones');
    return leerJson(req, res, 4096, (d) => {
      const l = validarLatido(d);
      if (!l) return responder(res, 400, 'formato invalido');
      if (limitar(visitasLatido, 'id:' + l.id, 40)) return responder(res, 429, 'demasiados latidos');
      if (!registrarLatido(l, ipDe(req))) return responder(res, 429, 'limite de instalaciones');
      responder(res, 200, 'ok');
    });
  }
  const mc = (req.method === 'POST' || req.method === 'DELETE') && url.pathname.match(/^\/clinicas\/([a-f0-9-]{16,40})$/);
  if (mc) {
    if (!origenPropio(req)) return responder(res, 403, 'origen no permitido');
    if (!autorizar(req, res)) return;
    const c = clinicas[mc[1]];
    if (!c) return responder(res, 404, 'no');
    if (req.method === 'DELETE') { delete clinicas[mc[1]]; guardarClinicas(); return responder(res, 200, 'ok'); }
    return leerJson(req, res, 1024, (d) => {
      c.alias = typeof d.alias === 'string' && d.alias.trim() ? d.alias.trim().slice(0, 60) : null;
      guardarClinicas();
      responder(res, 200, 'ok');
    });
  }
  const m = req.method === 'GET' && url.pathname.match(/^\/f\/([\w.-]+\.json)$/);
  if (m) {
    if (!autorizar(req, res)) return;
    const ruta = path.join(DATA_DIR, path.basename(m[1]));
    if (!fs.existsSync(ruta)) return responder(res, 404, 'no');
    const cab = { 'Content-Type': 'application/json; charset=utf-8' };
    if (url.searchParams.has('d')) cab['Content-Disposition'] = `attachment; filename="${path.basename(ruta)}"`;
    res.writeHead(200, cab);
    return res.end(fs.readFileSync(ruta));
  }
  const d = req.method === 'DELETE' && url.pathname.match(/^\/f\/([\w.-]+\.json)$/);
  if (d) {
    // DELETE cross-origin ya exige preflight (que no respondemos); el Origin se comprueba ademas por si acaso
    if (!origenPropio(req)) return responder(res, 403, 'origen no permitido');
    if (!autorizar(req, res)) return;
    const ruta = path.join(DATA_DIR, path.basename(d[1]));
    if (!fs.existsSync(ruta)) return responder(res, 404, 'no');
    fs.rmSync(ruta);
    console.log('borrado', path.basename(ruta));
    return responder(res, 200, 'ok');
  }
  if (req.method !== 'POST' || url.pathname !== '/diagnostico') return responder(res, 404, 'no');

  const ip = ipDe(req);
  if (limitado(ip)) return responder(res, 429, 'demasiadas peticiones');

  let cuerpo = '';
  let excedido = false;
  req.on('data', (c) => {
    cuerpo += c;
    if (cuerpo.length > MAX_BYTES && !excedido) { excedido = true; responder(res, 413, 'demasiado grande'); req.destroy(); }
  });
  req.on('end', () => {
    if (excedido) return;
    let d;
    try { d = JSON.parse(cuerpo); } catch { return responder(res, 400, 'json invalido'); }
    if (!d || typeof d.version !== 'string' || !Array.isArray(d.log)) return responder(res, 400, 'formato invalido');

    const host = String(d.host || 'sin-host').replace(/[^\w.-]/g, '_').slice(0, 40);
    const nombre = `${new Date().toISOString().replace(/[:.]/g, '-')}_${host}.json`;
    fs.writeFileSync(path.join(DATA_DIR, nombre), JSON.stringify({ ...d, _ip: ip }, null, 2));
    podar();
    console.log('recibido', nombre);

    if (NTFY_URL) {
      fetch(NTFY_URL, {
        method: 'POST',
        headers: { Title: `Diagnostico ${host} v${String(d.version).slice(0, 12)}` },
        body: `Estado: ${String(d.estado).slice(0, 30)}\nError: ${String(d.ultimoError || '-').slice(0, 200)}\nFichero: ${nombre}`
      }).catch(() => {});
    }
    responder(res, 200, 'ok');
  });
}).listen(PORT, () => console.log('soporte-server en puerto', PORT));
