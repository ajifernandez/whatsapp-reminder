// Receptor de diagnosticos de las clinicas. Sin dependencias (Node 18+).
// POST /diagnostico  (JSON)  -> guarda DATA_DIR/<fecha>_<host>.json y avisa a NTFY_URL si existe.
// GET  /             -> listado web (ver / descargar). Requiere ADMIN_PASS (Basic auth); sin ella queda desactivado.
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

fs.mkdirSync(DATA_DIR, { recursive: true });
const visitas = new Map(); // ip -> timestamps; ponytail: en memoria, se pierde al reiniciar
const fallos = new Map(); // ip -> timestamps de logins fallidos

function limitado(ip) {
  const ahora = Date.now();
  const ts = (visitas.get(ip) || []).filter((t) => ahora - t < 3600e3);
  ts.push(ahora);
  visitas.set(ip, ts);
  return ts.length > MAX_POR_HORA;
}

const iguales = (a, b) => {
  const x = crypto.createHash('sha256').update(a).digest();
  const y = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(x, y);
};
const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const ipDe = (req) => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress).split(',')[0].trim();

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

function paginaListado() {
  const filas = fs.readdirSync(DATA_DIR).filter((n) => /^[\w.-]+\.json$/.test(n)).sort().reverse().slice(0, 200).map((n) => {
    let d = {};
    try { d = JSON.parse(fs.readFileSync(path.join(DATA_DIR, n), 'utf8')); } catch (_) { /* fichero ilegible */ }
    const fecha = fs.statSync(path.join(DATA_DIR, n)).mtime.toLocaleString('es-ES', { timeZone: ZONA });
    const u = encodeURIComponent(n);
    return `<tr><td>${esc(d.host)}<br><small>${esc(d._ip)}</small></td><td>${esc(fecha)}</td><td>${esc(d.version)}</td>`
      + `<td>${esc(d.estado)}${d.ultimoError ? `<br><small>${esc(String(d.ultimoError).slice(0, 80))}</small>` : ''}</td>`
      + `<td><a href="/f/${u}">ver</a> · <a href="/f/${u}?d=1">descargar</a></td></tr>`;
  });
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Diagnósticos</title>
<style>body{font:14px system-ui;margin:16px;max-width:900px}table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:6px 10px;border-bottom:1px solid #ddd;vertical-align:top}small{color:#666}</style>
<h1>Diagnósticos recibidos (${filas.length})</h1>
<table><tr><th>Origen</th><th>Fecha</th><th>Versión</th><th>Estado</th><th></th></tr>${filas.join('') || '<tr><td colspan=5>Sin informes todavía</td></tr>'}</table>`;
}

function podar() {
  const f = fs.readdirSync(DATA_DIR).filter((n) => n.endsWith('.json')).sort();
  f.slice(0, Math.max(0, f.length - MAX_FICHEROS)).forEach((n) => fs.rmSync(path.join(DATA_DIR, n), { force: true }));
}

const responder = (res, code, texto) => { res.writeHead(code, { 'Content-Type': 'text/plain' }); res.end(texto); };

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'GET' && url.pathname === '/health') return responder(res, 200, 'ok');
  if (req.method === 'GET' && url.pathname === '/') {
    if (!autorizar(req, res)) return;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(paginaListado());
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
