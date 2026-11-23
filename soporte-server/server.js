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
const ORDEN_MAX_MS = 24 * 3600e3; // una peticion de diagnostico sin atender caduca al dia
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

const ESTILO = `:root{--bg:#f8fafc;--surface:#fff;--border:#e2e8f0;--text:#0f172a;--text-secondary:#64748b;--primary:#2563eb;--primary-hover:#1d4ed8;--success:#16a34a;--success-bg:#dcfce7;--success-text:#166534;--warning:#d97706;--warning-bg:#fef3c7;--warning-text:#92400e;--danger:#dc2626;--danger-bg:#fee2e2;--danger-text:#991b1b;--info:#2563eb;--info-bg:#dbeafe;--info-text:#1e40af;--gray:#64748b;--gray-bg:#f1f5f9;--radius:8px;--shadow:0 1px 3px rgba(0,0,0,.1),0 1px 2px rgba(0,0,0,.06);--shadow-lg:0 4px 6px rgba(0,0,0,.07),0 2px 4px rgba(0,0,0,.06)}
*{box-sizing:border-box}
body{font:14px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;margin:0;background:var(--bg);color:var(--text)}
.container{max-width:1200px;margin:0 auto;padding:20px}
header{background:var(--surface);border-bottom:1px solid var(--border);padding:16px 20px;margin-bottom:24px;box-shadow:var(--shadow)}
header h1{margin:0 0 4px;font-size:20px;font-weight:700;color:var(--text)}
header p{margin:0;font-size:13px;color:var(--text-secondary)}
nav{display:flex;gap:24px;margin-top:12px}
nav a{color:var(--text-secondary);text-decoration:none;font-weight:500;padding:4px 0;border-bottom:2px solid transparent;transition:all .15s}
nav a:hover{color:var(--primary)}
nav a.activa{color:var(--primary);border-bottom-color:var(--primary);font-weight:600}
h1{font-size:24px;font-weight:700;margin:0 0 16px;color:var(--text)}
h2{font-size:18px;font-weight:600;margin:0 0 12px}
.chip{display:inline-flex;align-items:center;padding:3px 10px;border-radius:9999px;font-weight:600;font-size:12px;line-height:1.4;white-space:nowrap}
.ok{background:var(--success-bg);color:var(--success-text)}.warning{background:var(--warning-bg);color:var(--warning-text)}.conectando{background:var(--info-bg);color:var(--info-text)}
.desconectado{background:var(--danger-bg);color:var(--danger-text)}.offline{background:var(--gray);color:#fff}.apagada{background:var(--gray-bg);color:var(--gray)}
.riesgo-alto{background:var(--danger-bg);color:var(--danger-text)}.riesgo-medio{background:var(--warning-bg);color:var(--warning-text)}.riesgo-bajo{background:var(--success-bg);color:var(--success-text)}
.resumen{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:20px;padding:16px;background:var(--surface);border-radius:var(--radius);box-shadow:var(--shadow)}
.resumen .chip{font-size:13px;padding:4px 12px}
.alerta{background:var(--danger-bg);border:1px solid #fecaca;border-radius:var(--radius);padding:12px 16px;margin-bottom:20px;font-size:13px;line-height:1.6}
.alerta strong{color:var(--danger-text)}
.alerta small{color:var(--danger-text)}
table{width:100%;border-collapse:collapse;background:var(--surface);border-radius:var(--radius);overflow:hidden;box-shadow:var(--shadow)}
thead{background:#f8fafc}
th{font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:var(--text-secondary);padding:12px 14px;text-align:left;border-bottom:2px solid var(--border)}
td{padding:12px 14px;border-bottom:1px solid var(--border);vertical-align:top;font-size:13px}
tr:last-child td{border-bottom:none}
tr:hover td{background:#f8fafc}
small{color:var(--text-secondary);font-size:12px}
a.accion{color:var(--primary);text-decoration:none;font-size:12px;font-weight:500;margin-left:8px;transition:color .15s}
a.accion:hover{color:var(--primary-hover);text-decoration:underline}
.dias{display:flex;gap:2px;margin-bottom:6px}
.dia-celda{display:flex;flex-direction:column;align-items:center;gap:2px}
.dia{display:inline-block;width:11px;height:22px;border-radius:3px;background:var(--gray-bg);transition:transform .1s}
.dia:hover{transform:scaleY(1.2)}
.dia-label{font-size:9px;color:var(--text-secondary);line-height:1}
.d-ok{background:var(--success)}.d-aviso{background:var(--warning)}.d-mal{background:var(--danger)}.sd{background:var(--gray-bg)}
.historial{margin:6px 0 0;padding-left:18px;font-size:12px;color:var(--text-secondary)}
.historial li{margin:3px 0}
.card{background:var(--surface);border-radius:var(--radius);box-shadow:var(--shadow);padding:16px;margin-bottom:12px}
.card-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px}
.card-title{font-weight:600;font-size:15px}
.card-body{font-size:13px;line-height:1.6}
.card-footer{display:flex;gap:8px;margin-top:12px;padding-top:12px;border-top:1px solid var(--border)}
.btn{display:inline-flex;align-items:center;gap:6px;padding:6px 12px;border-radius:6px;font-size:13px;font-weight:500;text-decoration:none;transition:all .15s;border:none;cursor:pointer}
.btn-primary{background:var(--primary);color:#fff}.btn-primary:hover{background:var(--primary-hover)}
.btn-secondary{background:var(--gray-bg);color:var(--text)}.btn-secondary:hover{background:var(--border)}
.btn-danger{background:var(--danger-bg);color:var(--danger-text)}.btn-danger:hover{background:#fecaca}
.grid{display:grid;gap:12px}
.grid-2{grid-template-columns:repeat(2,1fr)}
.grid-3{grid-template-columns:repeat(3,1fr)}
.grid-4{grid-template-columns:repeat(4,1fr)}
.stat{background:var(--surface);border-radius:var(--radius);box-shadow:var(--shadow);padding:16px;text-align:center}
.stat-value{font-size:28px;font-weight:700;color:var(--text)}
.stat-label{font-size:12px;color:var(--text-secondary);margin-top:4px}
.badge{display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:9999px;font-size:11px;font-weight:600}
.fade-in{animation:fadeIn .3s ease}
@keyframes fadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
.horario-fila{display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:6px;background:var(--gray-bg)}
.horario-dia{min-width:80px;font-weight:500;font-size:13px}
.horario-check{width:18px;height:18px;cursor:pointer;accent-color:var(--primary)}
.horario-desde,.horario-hasta{width:90px;padding:4px 6px;border:1px solid var(--border);border-radius:4px;font-size:13px;font-family:inherit}
.horario-desde:disabled,.horario-hasta:disabled{opacity:.4;cursor:not-allowed}
@media(max-width:768px){
.container{padding:12px}
header{padding:12px 16px}
header h1{font-size:18px}
nav{gap:16px}
h1{font-size:20px}
.resumen{padding:12px}
table{display:block;overflow-x:auto}
.grid-2,.grid-3,.grid-4{grid-template-columns:1fr}
.stat{padding:12px}
.stat-value{font-size:24px}
}`;

function plantilla(titulo, activa, cuerpo, extra = '') {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(titulo)}</title><style>${ESTILO}</style>
<header class="container">
<h1>📊 Panel de Soporte</h1>
<p>Monitor de clínicas · WhatsApp Reminder</p>
<nav><a href="/clinicas"${activa === 'clinicas' ? ' class="activa"' : ''}>Clínicas</a><a href="/diagnosticos"${activa === 'diagnosticos' ? ' class="activa"' : ''}>Diagnósticos</a></nav>
</header>
<div class="container">${cuerpo}</div>${extra}`;
}

function paginaListado() {
  const todos = fs.readdirSync(DATA_DIR).filter((n) => /^[\w.-]+\.json$/.test(n));
  const kb = Math.round(todos.reduce((t, n) => t + fs.statSync(path.join(DATA_DIR, n)).size, 0) / 1024);
  const filas = todos.sort().reverse().slice(0, 200).map((n) => {
    let d = {};
    try { d = JSON.parse(fs.readFileSync(path.join(DATA_DIR, n), 'utf8')); } catch (_) { /* fichero ilegible */ }
    const fecha = fs.statSync(path.join(DATA_DIR, n)).mtime.toLocaleString('es-ES', { timeZone: ZONA });
    const u = encodeURIComponent(n);
    return `<tr>
      <td><input type="checkbox" class="diag-check" value="${esc(n)}"></td>
      <td>${esc(d.host)}<br><small>${esc(d._ip)}</small></td>
      <td>${esc(fecha)}</td>
      <td>${esc(d.version)}</td>
      <td>${esc(d.estado)}${d.ultimoError ? `<br><small>${esc(String(d.ultimoError).slice(0, 80))}</small>` : ''}</td>
      <td><a href="/f/${u}" class="accion">ver</a> · <a href="/f/${u}?d=1" class="accion">descargar</a> · <a href="#" data-borrar="${esc(n)}" class="accion" style="color:var(--danger-text)">borrar</a></td>
    </tr>`;
  });
  return plantilla('Diagnósticos', 'diagnosticos', `<h1>📋 Diagnósticos recibidos</h1>
<div class="resumen"><span class="chip" style="background:var(--info-bg);color:var(--info-text)">${todos.length} informes</span><span class="chip" style="background:var(--gray-bg);color:var(--gray)">${kb} KB</span>
<button id="btnBorrarSel" class="btn btn-danger" style="margin-left:auto;display:none" disabled>🗑️ Borrar seleccionados (<span id="selCount">0</span>)</button>
<button id="btnSelTodo" class="btn btn-secondary" style="margin-left:8px">Select All</button>
<button id="btnDeselTodo" class="btn btn-secondary" style="margin-left:4px">Deselect All</button></div>
<table><thead><tr>
  <th><input type="checkbox" id="checkAllHeader" title="Seleccionar todo"></th>
  <th>Origen</th><th>Fecha</th><th>Versión</th><th>Estado</th><th>Acciones</th>
</tr></thead><tbody>${filas.join('') || '<tr><td colspan=6 style="text-align:center;padding:24px;color:var(--text-secondary)">Sin informes todavía</td></tr>'}</tbody></table>`, `
<script>
const checks = () => document.querySelectorAll('.diag-check');
const selCount = document.getElementById('selCount');
const btnBorrar = document.getElementById('btnBorrarSel');
const btnSelTodo = document.getElementById('btnSelTodo');
const btnDeselTodo = document.getElementById('btnDeselTodo');
const checkAllHeader = document.getElementById('checkAllHeader');

function actualizarContador() {
  const arr = checks();
  const sel = [...arr].filter(c => c.checked).length;
  selCount.textContent = sel;
  btnBorrar.style.display = sel ? '' : 'none';
  btnBorrar.disabled = sel === 0;
  checkAllHeader.checked = arr.length > 0 && sel === arr.length;
  checkAllHeader.indeterminate = sel > 0 && sel < arr.length;
}

document.addEventListener('change', (e) => {
  if (e.target.classList.contains('diag-check')) actualizarContador();
  if (e.target.id === 'checkAllHeader') {
    const val = e.target.checked;
    checks().forEach(c => c.checked = val);
    actualizarContador();
  }
});

btnSelTodo.addEventListener('click', () => { checks().forEach(c => c.checked = true); actualizarContador(); });
btnDeselTodo.addEventListener('click', () => { checks().forEach(c => c.checked = false); actualizarContador(); });

btnBorrar.addEventListener('click', async () => {
  const nombres = [...checks()].filter(c => c.checked).map(c => c.value);
  if (!nombres.length) return;
  if (!confirm('¿Borrar ' + nombres.length + ' diagnóstico(s)? No se puede deshacer.')) return;
  const r = await fetch('/api/borrar-diagnosticos', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nombres })
  });
  if (r.ok) location.reload(); else alert('No se pudo borrar (' + r.status + ')');
});

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

// ---------- Disponibilidad por dia ----------
// Se va sumando cuanto tiempo pasa cada instalacion en cada estado, por dia, para pintar su
// disponibilidad de los ultimos dias. Entre dos latidos se atribuye el tiempo al estado que dijo el
// primero, pero solo hasta OFFLINE_MS: lo que pase de ahi cuenta como «sin señal» (o «apagada»).
const DIAS_GUARDADOS = 30;
const HORA_MS = 3600e3;
const bucketDe = (estado) => ({ conectado: 'ok', degradado: 'warning', conectando: 'conectando', apagada: 'apagada' }[estado] || 'desconectado');
const diaDe = (t) => new Date(t).toLocaleDateString('sv-SE', { timeZone: ZONA }); // AAAA-MM-DD en la zona de soporte

// Horario por defecto para clinicas sin horario configurado (hora de ZONA)
const HORA_INI = process.env.HORA_INI !== undefined ? Number(process.env.HORA_INI) : 8;
const HORA_FIN = process.env.HORA_FIN !== undefined ? Number(process.env.HORA_FIN) : 21;
const horaDe = (t) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: ZONA, hour: 'numeric', hourCycle: 'h23' }).format(t));

// Horario individual por clínica: array de 7 elementos (domingo=0, sábado=6)
// Cada elemento: { abierto: boolean, desde: "HH:MM", hasta: "HH:MM" }
// Si no tiene horario configurado, usa HORA_INI/HORA_FIN los 7 días
function horarioDeClinica(c) {
  if (Array.isArray(c.horario) && c.horario.length === 7) return c.horario;
  // Horario por defecto: todos los días HORA_INI-HORA_FIN
  return Array(7).fill(null).map(() => ({ abierto: true, desde: String(HORA_INI).padStart(2, '0') + ':00', hasta: String(HORA_FIN).padStart(2, '0') + ':00' }));
}

// Devuelve true si el timestamp cae dentro del horario de la clínica
function dentroHorario(c, t) {
  const horario = horarioDeClinica(c);
  const diaSemana = new Date(t).getDay(); // 0=domingo, 1=lunes, ...
  const h = horario[diaSemana];
  if (!h || !h.abierto) return false;
  const hHora = horaDe(t);
  const [desdeH, desdeM] = h.desde.split(':').map(Number);
  const [hastaH, hastaM] = h.hasta.split(':').map(Number);
  const desdeMin = desdeH * 60 + desdeM;
  const hastaMin = hastaH * 60 + hastaM;
  const minutoActual = hHora * 60;
  return minutoActual >= desdeMin && minutoActual < hastaMin;
}

// Suma [desde, hasta) a dias[dia][bucket], troceando por horas para no pasarse de dia
// Usa el horario de la clínica si se proporciona, sino usa HORA_INI/HORA_FIN globales
function repartir(dias, desde, hasta, bucket, clinica) {
  for (let a = desde; a < hasta;) {
    const fin = Math.min(hasta, (Math.floor(a / HORA_MS) + 1) * HORA_MS);
    let dentro = false;
    if (clinica) {
      dentro = dentroHorario(clinica, a);
    } else {
      const h = horaDe(a);
      dentro = h >= HORA_INI && h < HORA_FIN;
    }
    if (dentro) {
      const d = (dias[diaDe(a)] ||= {});
      d[bucket] = (d[bucket] || 0) + (fin - a);
    }
    a = fin;
  }
}
function acumular(dias, estado, desde, hasta, clinica) {
  if (!(hasta > desde) || hasta - desde > DIAS_GUARDADOS * 24 * HORA_MS) return;
  const cubierto = Math.min(hasta - desde, OFFLINE_MS);
  repartir(dias, desde, desde + cubierto, bucketDe(estado), clinica);
  if (hasta - desde > cubierto) repartir(dias, desde + cubierto, hasta, estado === 'apagada' ? 'apagada' : 'offline', clinica);
}
function podarDias(dias) {
  for (const d of Object.keys(dias).sort().slice(0, -DIAS_GUARDADOS)) delete dias[d];
}

// Estado predominante: el bucket con más tiempo registrado ese día
function estadoPredominante(d) {
  const buckets = ['ok', 'warning', 'desconectado', 'conectando', 'offline'];
  let maxMs = 0, maxK = null;
  for (const k of buckets) {
    const ms = d[k] || 0;
    if (ms > maxMs) { maxMs = ms; maxK = k; }
  }
  return maxK; // null si no hay datos (o solo 'apagada')
}
const horasMin = (ms) => { const m = Math.round(ms / 60000); return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`; };

// Mapeo de bucket a etiqueta legible y clase CSS
const ETIQUETA_ESTADO = { ok: 'conectada', warning: 'con problemas', desconectado: 'desconectada', conectando: 'conectando', offline: 'sin señal', apagada: 'apagada' };

// Los ultimos 14 dias como casillas de color, cada una muestra el estado predominante
function graficaDias(c, ahora) {
  const dias = JSON.parse(JSON.stringify(c.dias || {}));
  if (c.ultimo) acumular(dias, c.estado, c.ultimo, ahora, c); // el tramo abierto hasta este momento
  const casillas = [];
  let diasConectados = 0, diasConDatos = 0;
  for (let i = 13; i >= 0; i--) {
    const dia = diaDe(ahora - i * 24 * HORA_MS);
    const d = dias[dia] || {};
    const pred = estadoPredominante(d);
    if (pred) diasConDatos++;
    if (pred === 'ok') diasConectados++;
    const clase = pred === 'ok' ? 'd-ok' : pred === 'warning' ? 'd-aviso' : pred === 'desconectado' ? 'd-mal' : pred === 'conectando' ? 'd-aviso' : pred === 'offline' ? 'd-mal' : 'sd';
    const detalle = pred === null ? 'sin datos'
      : `${esc(ETIQUETA_ESTADO[pred])} (${horasMin(d[pred])})`
      + Object.entries(d)
        .filter(([k, v]) => k !== 'apagada' && v && k !== pred)
        .map(([k, v]) => ` · ${esc(ETIQUETA_ESTADO[k] || k)} ${horasMin(v)}`)
        .join('');
    const diaSemana = new Date(dia + 'T12:00:00').toLocaleDateString('es-ES', { weekday: 'short' }).replace('.', '');
    const diaCorto = dia.slice(5, 7) + '/' + dia.slice(0, 4);
    casillas.push(`<span class="dia-celda" title="${esc(dia + ': ' + detalle)}"><span class="dia ${clase}"></span><span class="dia-label">${esc(diaSemana)}</span></span>`);
  }
  const resumen = diasConDatos ? `${diasConectados} de ${diasConDatos} días conectada` : '—';
  return `<div class="dias">${casillas.join('')}</div><small>${esc(resumen)} en 14 días</small>`;
}

function validarLatido(d) {
  const ESTADOS = ['conectado', 'degradado', 'conectando', 'desconectado', 'error', 'apagada'];
  const cad = (v, n) => (typeof v === 'string' ? v.slice(0, n) : null);
  if (!d || typeof d !== 'object' || typeof d.id !== 'string' || !/^[a-f0-9-]{16,40}$/.test(d.id) || !ESTADOS.includes(d.estado)) return null;
  return {
    id: d.id, estado: d.estado, host: cad(d.host, 60), version: cad(d.version, 20), canal: cad(d.canal, 20), motor: cad(d.motor, 20),
    causa: cad(d.causa, 200), ultimoError: cad(d.ultimoError, 200),
    ultimoOk: Number.isFinite(d.ultimoOk) ? d.ultimoOk : null, arranqueHaceSeg: Number.isFinite(d.arranqueHaceSeg) ? Math.round(d.arranqueHaceSeg) : null,
    // Datos técnicos para evaluación de riesgos
    cpu: Number.isFinite(d.cpu) ? Math.round(d.cpu) : null,
    memMB: Number.isFinite(d.memMB) ? Math.round(d.memMB) : null,
    citas: Number.isFinite(d.citas) ? Math.round(d.citas) : null,
    enNube: d.enNube === true
  };
}

// ---------- Evaluación de riesgo ----------
// Calcula un nivel de riesgo (alto/medio/bajo) para cada clínica basado en múltiples factores.
// Se actualiza en tiempo real con cada latido.
const RIESGO_ORDEN = { alto: 0, medio: 1, bajo: 2 };

// Devuelve true si la clínica debería estar operativa ahora según su horario
function deberiaEstarAbierto(c, ahora) {
  const horario = horarioDeClinica(c);
  const diaSemana = new Date(ahora).getDay();
  return horario[diaSemana] && horario[diaSemana].abierto;
}

function calcularRiesgo(c, ahora) {
  const sinSenal = ahora - c.ultimo;
  const estaEnHorario = deberiaEstarAbierto(c, ahora);
  // Alto: desconectado >2h, sin señal, en nube, o memoria muy alta
  if (c.enNube) return 'alto';
  // Si la clínica no debería estar abierta ahora, no es riesgo por no dar latidos
  if (sinSenal > OFFLINE_MS && c.estado !== 'apagada' && estaEnHorario) return 'alto';
  if ((c.estado === 'desconectado' || c.estado === 'error') && sinSenal > 2 * 3600e3 && estaEnHorario) return 'alto';
  if (c.memMB != null && c.memMB > 2000) return 'alto'; // >2GB RAM
  // Medio: degradado, conectando >10min, versión desactualizada, canal main
  if (c.estado === 'degradado') return 'medio';
  if (c.estado === 'conectando' && sinSenal > CONECTANDO_MAX_MS) return 'medio';
  if (c.cpu != null && c.cpu > 80) return 'medio'; // CPU alta
  // Bajo: conectado y estable
  return 'bajo';
}

// false si ya hay MAX_CLINICAS instalaciones y esta es nueva
function registrarLatido(l, ip) {
  const ahora = Date.now();
  let c = clinicas[l.id];
  if (!c) {
    if (Object.keys(clinicas).length >= MAX_CLINICAS) return false;
    c = clinicas[l.id] = { id: l.id, alias: null, primero: ahora, cambios: [] };
  }
  const esNueva = !c.ultimo; // primer latido: no hay estado anterior real que comparar
  if (!esNueva) { c.dias ||= {}; acumular(c.dias, c.estado, c.ultimo, ahora, c); podarDias(c.dias); }
  const cambio = c.estado !== l.estado;
  Object.assign(c, l, { ip, ultimo: ahora });
  if (cambio) {
    c.desdeEstado = ahora;
    c.cambios = [...c.cambios, { t: ahora, estado: l.estado }].slice(-20);
  }
  guardarClinicas();
  return true;
}

// «pedir diagnostico» / peticion pendiente / enlace al ultimo recibido
function diagnosticoHtml(c, v, ahora) {
  const pendiente = c.orden && ahora - c.orden.t < ORDEN_MAX_MS;
  const espera = ['offline', 'apagada'].includes(v) ? 'cuando la aplicación vuelva a dar señal' : 'en el próximo latido (como mucho 5 min)';
  const accion = pendiente
    ? `<br><small>⏳ Diagnóstico pedido ${esc(hace(ahora - c.orden.t))}: llegará ${espera}</small>`
    : `<br><a href="#" class="accion" style="margin-left:0" data-pedir="${esc(c.id)}">📋 Pedir diagnóstico</a>`;
  const ultimo = c.ultimoDiag ? `<br><small>Último: <a href="/f/${encodeURIComponent(c.ultimoDiag.archivo)}" class="accion" style="margin-left:0">${esc(hace(ahora - c.ultimoDiag.t))}</a></small>` : '';
  return accion + ultimo;
}

// Historial de transiciones: enlace que abre un modal
function historialHtml(c) {
  if (!c.cambios || !c.cambios.length) return '';
  return `<a href="#" class="accion" data-historial="${esc(c.id)}" title="Ver historial de estados">📜 Historial (${c.cambios.length})</a>`;
}

// Modal de historial (se inyecta en el HTML)
function historialModal() {
  return `<div id="modalHistorial" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:1000;align-items:center;justify-content:center" onclick="this.style.display='none'">
<div class="card" style="max-width:480px;width:90%;max-height:80vh;overflow:auto;position:relative" onclick="event.stopPropagation()">
<button onclick="document.getElementById('modalHistorial').style.display='none'" style="position:absolute;top:12px;right:12px;background:none;border:none;font-size:18px;cursor:pointer;color:var(--text-secondary)">✕</button>
<h2 style="margin:0 0 16px">📜 Historial de estados</h2>
<div id="modalHistorialCuerpo"></div>
</div></div>`;
}

function historialCuerpoHtml(c) {
  if (!c.cambios || !c.cambios.length) return '<p style="color:var(--text-secondary)">Sin registros.</p>';
  const estadoClass = (e) => ({ conectado: 'ok', degradado: 'warning', conectando: 'conectando', desconectado: 'desconectado', error: 'desconectado', apagada: 'apagada' }[e] || 'offline');
  const lineas = c.cambios.slice().reverse().map((x) => {
    const fecha = new Date(x.t).toLocaleString('es-ES', { timeZone: ZONA, dateStyle: 'short', timeStyle: 'medium' });
    return `<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border)">
<span class="chip ${estadoClass(x.estado)}">${esc(x.estado)}</span>
<span style="font-size:13px;color:var(--text-secondary)">${esc(fecha)}</span>
</div>`;
  }).join('');
  return `<div style="padding:0 4px">${lineas}</div>`;
}

// Modal de edición de horario por clínica
function horarioModal() {
  const dias = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
  const filas = dias.map((nombre, i) => {
    return `<div class="horario-fila">
<label class="horario-dia">${esc(nombre)}</label>
<input type="checkbox" class="horario-check" data-dia="${i}">
<input type="time" class="horario-desde" data-dia="${i}" value="09:00">
<span>–</span>
<input type="time" class="horario-hasta" data-dia="${i}" value="14:00">
</div>`;
  }).join('');
  return `<div id="modalHorario" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:1000;align-items:center;justify-content:center" onclick="this.style.display='none'">
<div class="card" style="max-width:420px;width:90%;max-height:80vh;overflow:auto;position:relative" onclick="event.stopPropagation()">
<button onclick="document.getElementById('modalHorario').style.display='none'" style="position:absolute;top:12px;right:12px;background:none;border:none;font-size:18px;cursor:pointer;color:var(--text-secondary)">✕</button>
<h2 style="margin:0 0 4px">🕐 Horario de la clínica</h2>
<p style="margin:0 0 16px;font-size:12px;color:var(--text-secondary)">Los días/horas fuera del horario no cuentan para riesgo ni disponibilidad.</p>
<div id="horarioFilas" style="display:flex;flex-direction:column;gap:8px">${filas}</div>
<div style="margin-top:16px;display:flex;gap:8px;justify-content:flex-end">
<button class="btn btn-secondary" onclick="document.getElementById('modalHorario').style.display='none'">Cancelar</button>
<button id="btnGuardarHorario" class="btn btn-primary">Guardar</button>
</div>
</div></div>`;
}

// Alertas proactivas: problemas que requieren atención inmediata
function alertasProactivas() {
  const ahora = Date.now();
  const alertas = [];
  for (const c of Object.values(clinicas)) {
    if (c.enNube) {
      alertas.push(`🔴 <b>${esc(c.alias || c.host)}</b>: la aplicación está en un directorio sincronizado en la nube (OneDrive/Dropbox/Google Drive). <strong>Riesgo alto de corrupción de datos.</strong>`);
    }
    if (ahora - c.ultimo > 24 * 3600e3 && c.estado !== 'apagada') {
      alertas.push(`🔴 <b>${esc(c.alias || c.host)}</b>: lleva más de 24 horas sin señal. <strong>Posible problema grave.</strong>`);
    }
    if (c.memMB != null && c.memMB > 2000) {
      alertas.push(`🟡 <b>${esc(c.alias || c.host)}</b>: consume más de 2 GB de RAM (${c.memMB} MB). Posible fuga de memoria.`);
    }
  }
  if (alertas.length === 0) return '';
  return `<div class="alerta"><strong>⚠️ ${alertas.length} alerta${alertas.length > 1 ? 's' : ''} activa${alertas.length > 1 ? 's' : ''}</strong><br>${alertas.join('<br>')}</div>`;
}

// Solo lo que cambia (resumen y tabla): la pagina lo pide cada pocos segundos y lo sustituye
function contenidoClinicas() {
  const ahora = Date.now();
  const filas = Object.values(clinicas)
    .map((c) => ({ c, v: estadoVisible(c, ahora), riesgo: calcularRiesgo(c, ahora) }))
    .sort((a, b) => RIESGO_ORDEN[a.riesgo] - RIESGO_ORDEN[b.riesgo] || ORDEN[a.v] - ORDEN[b.v] || String(a.c.alias || a.c.host).localeCompare(String(b.c.alias || b.c.host)));
  const cuenta = {};
  for (const { v } of filas) cuenta[v] = (cuenta[v] || 0) + 1;
  const cuentaRiesgo = {};
  for (const { riesgo } of filas) cuentaRiesgo[riesgo] = (cuentaRiesgo[riesgo] || 0) + 1;
  const resumen = filas.length === 0 ? 'Aún no ha llegado ningún latido.'
    : Object.keys(ORDEN).filter((v) => cuenta[v]).map((v) => `<span class="chip ${v}">${cuenta[v]} ${esc(ETIQUETA[v])}</span>`).join('');
  const resumenRiesgo = filas.length === 0 ? ''
    : Object.keys(RIESGO_ORDEN).filter((r) => cuentaRiesgo[r]).map((r) => `<span class="chip riesgo-${r}">${cuentaRiesgo[r]} riesgo ${esc(r)}</span>`).join('');
  const html = filas.map(({ c, v, riesgo }) => {
    const tecnico = [];
    if (c.cpu != null) tecnico.push(`CPU ${c.cpu}%`);
    if (c.memMB != null) tecnico.push(`RAM ${c.memMB} MB`);
    if (c.citas != null) tecnico.push(`${c.citas} citas`);
    const tecnicoHtml = tecnico.length ? `<br><small>${tecnico.join(' · ')}</small>` : '';
    return `<tr>
<td><span class="chip ${v}">${esc(ETIQUETA[v])}</span></td>
<td><span class="chip riesgo-${riesgo}">riesgo ${esc(riesgo)}</span></td>
<td><b>${esc(c.alias || c.host || 'sin nombre')}</b>${c.alias ? `<br><small>${esc(c.host)}</small>` : ''}<br><small title="${esc(c.id)}">${esc(c.id.slice(0, 8))}</small>
<a href="#" class="accion" data-renombrar="${esc(c.id)}" data-alias="${esc(c.alias || '')}">renombrar</a><a href="#" class="accion" data-olvidar="${esc(c.id)}" style="color:var(--danger-text)">olvidar</a>
<a href="#" class="accion" data-horario="${esc(c.id)}" data-horario-json="${esc(JSON.stringify(c.horario || null))}">🕐 Horario</a>
${diagnosticoHtml(c, v, ahora)}</td>
<td>${esc(detalle(c, v, ahora))}${tecnicoHtml}</td>
<td>${esc(c.version)}<br><small>${esc(c.motor)}${c.canal && c.canal !== 'main' ? ' · canal ' + esc(c.canal) : ''}</small></td>
<td>${esc(hace(ahora - c.ultimo))}</td>
<td>${esc(c.desdeEstado ? hace(ahora - c.desdeEstado) : '')}</td>
<td>${graficaDias(c, ahora)}</td>
<td><small>${esc(c.ip)}</small>${historialHtml(c)}</td></tr>`;
  });
  const alertas = alertasProactivas();
  return `${alertas}<h1>🏥 Clínicas (${filas.length})</h1>
<div class="resumen">${resumen} ${resumenRiesgo ? '<br>' + resumenRiesgo : ''}</div>
<table><thead><tr><th>Estado</th><th>Riesgo</th><th>Clínica</th><th>Detalle</th><th>Versión</th><th>Último latido</th><th>En este estado</th><th>Últimos 14 días</th><th>IP</th></tr></thead><tbody>${html.join('') || '<tr><td colspan=9 style="text-align:center;padding:32px;color:var(--text-secondary)">Sin clínicas todavía: aparecen cuando una aplicación manda su primer latido.</td></tr>'}</tbody></table>
<p style="margin-top:16px"><small>Cada aplicación avisa cada 5 minutos y al cambiar de estado. «Sin señal» = ${Math.round(OFFLINE_MS / 60000)} min sin latidos.</small></p>`;
}

function paginaClinicas() {
  return plantilla('Clínicas', 'clinicas', `<div id="contenido">${contenidoClinicas()}</div>
<div style="margin-top:16px;padding:12px 16px;background:var(--surface);border-radius:var(--radius);box-shadow:var(--shadow);display:flex;justify-content:space-between;align-items:center">
<small id="actualizado">🔄 Se actualiza sola cada ${REFRESCO_S} s.</small>
<small style="color:var(--text-secondary)">Última actualización: <span id="ultimaHora">—</span></small>
</div>
${historialModal()}
${horarioModal()}`, `
<script>
function esc(s) { var d=document.createElement('div'); d.textContent=s; return d.innerHTML; }
function abrirHistorial(id) {
  fetch('/api/historial/' + id)
    .then(r => r.json())
    .then(data => {
      const estadoClass = (e) => ({conectado:'ok',degradado:'warning',conectando:'conectando',desconectado:'desconectado',error:'desconectado',apagada:'apagada'}[e]||'offline');
      const cuerpo = document.getElementById('modalHistorialCuerpo');
      if (!data.cambios || !data.cambios.length) {
        cuerpo.innerHTML = '<p style="color:var(--text-secondary)">Sin registros.</p>';
      } else {
        const lineas = data.cambios.slice().reverse().map((x) => {
          const fecha = new Date(x.t).toLocaleString('es-ES', {dateStyle:'short',timeStyle:'medium'});
          return '<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border)"><span class="chip ' + estadoClass(x.estado) + '">' + esc(x.estado) + '</span><span style="font-size:13px;color:var(--text-secondary)">' + fecha + '</span></div>';
        }).join('');
        cuerpo.innerHTML = '<div style="padding:0 4px">' + lineas + '</div>';
      }
      const modal = document.getElementById('modalHistorial');
      modal.style.display = 'flex';
    });
}
let horarioClinicaId = null;
function abrirHorario(id) {
  horarioClinicaId = id;
  // Cargar el horario actual desde la tabla (se pasa por data attribute)
  const btn = document.querySelector('[data-horario="' + id + '"]');
  const horarioJson = btn ? btn.dataset.horarioJson : null;
  let horario = Array(7).fill(null).map(() => ({abierto:true,desde:'09:00',hasta:'14:00'}));
  if (horarioJson) {
    const parsed = JSON.parse(horarioJson);
    if (Array.isArray(parsed)) horario = parsed;
  }
  // Index 0=Domingo, pero la UI muestra Lunes primero. Reordenamos: [1,2,3,4,5,6,0]
  const orden = [1,2,3,4,5,6,0];
  orden.forEach((idxDia, iFila) => {
    const h = horario[idxDia] || {abierto:true,desde:'09:00',hasta:'14:00'};
    const check = document.querySelector('.horario-check[data-dia="' + iFila + '"]');
    const desde = document.querySelector('.horario-desde[data-dia="' + iFila + '"]');
    const hasta = document.querySelector('.horario-hasta[data-dia="' + iFila + '"]');
    if (check) check.checked = h.abierto;
    if (desde) { desde.value = h.desde; desde.disabled = !h.abierto; }
    if (hasta) { hasta.value = h.hasta; hasta.disabled = !h.abierto; }
  });
  // Toggle de checkbox: habilita/deshabilita los campos de hora
  document.querySelectorAll('.horario-check').forEach(check => {
    check.onchange = () => {
      const dia = check.dataset.dia;
      const desde = document.querySelector('.horario-desde[data-dia="' + dia + '"]');
      const hasta = document.querySelector('.horario-hasta[data-dia="' + dia + '"]');
      desde.disabled = !check.checked;
      hasta.disabled = !check.checked;
    };
  });
  document.getElementById('modalHorario').style.display = 'flex';
}
document.addEventListener('click', async (e) => {
  const d = e.target.dataset || {};
  if (d.historial) { e.preventDefault(); abrirHistorial(d.historial); return; }
  if (d.horario) { e.preventDefault(); abrirHorario(d.horario); return; }
  if (!d.renombrar && !d.olvidar && !d.pedir) return;
  e.preventDefault();
  let r;
  if (d.pedir) {
    r = await fetch('/clinicas/' + d.pedir + '/diagnostico', { method: 'POST' });
  } else if (d.renombrar) {
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
    if (r.status === 401) { document.getElementById('actualizado').textContent = '⚠️ La sesión ha caducado: recarga la página.'; return; }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    document.getElementById('contenido').innerHTML = await r.text();
    fallos = 0;
    const ahora = new Date().toLocaleTimeString('es-ES');
    document.getElementById('actualizado').textContent = '✅ Actualizado a las ' + ahora;
    const elHora = document.getElementById('ultimaHora');
    if (elHora) elHora.textContent = ahora + ' · auto-actualización cada ${REFRESCO_S} s';
  } catch (e) {
    if (++fallos >= 2) document.getElementById('actualizado').textContent = '⚠️ No se puede contactar con el servidor de soporte. Se sigue intentando...';
  }
}
document.getElementById('btnGuardarHorario').addEventListener('click', async () => {
  // La UI muestra filas 0-6 como Lun-Dom. El horario interno es [Dom,Lun,...,Sáb]
  const orden = [1,2,3,4,5,6,0]; // fila 0=Lunes=día 1, fila 6=Dom=día 0
  const horario = Array(7);
  for (let i = 0; i < 7; i++) {
    const idxDia = orden[i];
    const check = document.querySelector('.horario-check[data-dia="' + i + '"]');
    const desde = document.querySelector('.horario-desde[data-dia="' + i + '"]');
    const hasta = document.querySelector('.horario-hasta[data-dia="' + i + '"]');
    horario[idxDia] = {
      abierto: check.checked,
      desde: desde.value || '09:00',
      hasta: hasta.value || '14:00'
    };
  }
  const r = await fetch('/clinicas/' + horarioClinicaId + '/horario', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ horario })
  });
  if (r.ok) {
    document.getElementById('modalHorario').style.display = 'none';
    refrescar();
  } else {
    alert('No se pudo guardar (' + r.status + ')');
  }
});

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
  if (req.method === 'GET' && url.pathname.match(/^\/api\/historial\/[a-f0-9-]{16,40}$/)) {
    if (!autorizar(req, res)) return;
    const id = url.pathname.split('/').pop();
    const c = clinicas[id];
    if (!c) return responder(res, 404, 'no encontrada');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ alias: c.alias || c.host, cambios: c.cambios || [] }));
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
      // La respuesta lleva la peticion de diagnostico pendiente (si la hay): la clinica no acepta conexiones entrantes.
      const c = clinicas[l.id];
      if (c.orden && Date.now() - c.orden.t >= ORDEN_MAX_MS) { delete c.orden; guardarClinicas(); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, diagnostico: c.orden ? c.orden.id : null }));
    });
  }
  const mp = req.method === 'POST' && url.pathname.match(/^\/clinicas\/([a-f0-9-]{16,40})\/diagnostico$/);
  if (mp) {
    if (!origenPropio(req)) return responder(res, 403, 'origen no permitido');
    if (!autorizar(req, res)) return;
    const c = clinicas[mp[1]];
    if (!c) return responder(res, 404, 'no');
    if (!c.orden || Date.now() - c.orden.t >= ORDEN_MAX_MS) c.orden = { id: Date.now(), t: Date.now() }; // una pendiente basta
    guardarClinicas();
    return responder(res, 200, 'ok');
  }
  // Guardar horario de una clínica
  const mh = req.method === 'POST' && url.pathname.match(/^\/clinicas\/([a-f0-9-]{16,40})\/horario$/);
  if (mh) {
    if (!origenPropio(req)) return responder(res, 403, 'origen no permitido');
    if (!autorizar(req, res)) return;
    const c = clinicas[mh[1]];
    if (!c) return responder(res, 404, 'no');
    return leerJson(req, res, 2048, (d) => {
      // Validar: array de 7 elementos, cada uno {abierto, desde, hasta}
      if (!Array.isArray(d.horario) || d.horario.length !== 7) return responder(res, 400, 'formato invalido');
      const horario = d.horario.map((h, i) => {
        if (!h || typeof h.abierto !== 'boolean') return { abierto: false, desde: '09:00', hasta: '14:00' };
        const desde = String(h.desde || '09:00').slice(0, 5);
        const hasta = String(h.hasta || '14:00').slice(0, 5);
        if (!/^\d{2}:\d{2}$/.test(desde) || !/^\d{2}:\d{2}$/.test(hasta)) return { abierto: h.abierto, desde: '09:00', hasta: '14:00' };
        return { abierto: h.abierto, desde, hasta };
      });
      c.horario = horario;
      guardarClinicas();
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
  // Borrado masivo de diagnosticos
  if (req.method === 'POST' && url.pathname === '/api/borrar-diagnosticos') {
    if (!origenPropio(req)) return responder(res, 403, 'origen no permitido');
    if (!autorizar(req, res)) return;
    return leerJson(req, res, 65536, (d) => {
      if (!Array.isArray(d.nombres)) return responder(res, 400, 'formato invalido');
      let borrados = 0;
      for (const n of d.nombres) {
        const ruta = path.join(DATA_DIR, path.basename(String(n)));
        if (fs.existsSync(ruta) && /^[\w.-]+\.json$/.test(path.basename(ruta))) {
          fs.rmSync(ruta);
          borrados++;
          console.log('borrado masivo', path.basename(ruta));
        }
      }
      podar();
      responder(res, 200, `${borrados} borrados`);
    });
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
    // El informe lleva el id de la instalacion: se enlaza a su fila y cumple la peticion pendiente
    const idInst = d.latido && typeof d.latido.id === 'string' ? d.latido.id : null;
    if (idInst && clinicas[idInst]) {
      clinicas[idInst].ultimoDiag = { archivo: nombre, t: Date.now() };
      delete clinicas[idInst].orden;
      guardarClinicas();
    }

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
