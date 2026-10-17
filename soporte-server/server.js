// Receptor de diagnosticos de las clinicas. Sin dependencias (Node 18+).
// POST /diagnostico  (JSON)  -> guarda DATA_DIR/<fecha>_<host>.json y avisa a NTFY_URL si existe.
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || '/data';
const NTFY_URL = process.env.NTFY_URL || ''; // opcional: https://ntfy.tudominio/tema
const MAX_BYTES = 256 * 1024;
const MAX_POR_HORA = 10; // por IP
const MAX_FICHEROS = 1000;

fs.mkdirSync(DATA_DIR, { recursive: true });
const visitas = new Map(); // ip -> timestamps; ponytail: en memoria, se pierde al reiniciar

function limitado(ip) {
  const ahora = Date.now();
  const ts = (visitas.get(ip) || []).filter((t) => ahora - t < 3600e3);
  ts.push(ahora);
  visitas.set(ip, ts);
  return ts.length > MAX_POR_HORA;
}

function podar() {
  const f = fs.readdirSync(DATA_DIR).filter((n) => n.endsWith('.json')).sort();
  f.slice(0, Math.max(0, f.length - MAX_FICHEROS)).forEach((n) => fs.rmSync(path.join(DATA_DIR, n), { force: true }));
}

const responder = (res, code, texto) => { res.writeHead(code, { 'Content-Type': 'text/plain' }); res.end(texto); };

http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') return responder(res, 200, 'ok');
  if (req.method !== 'POST' || req.url !== '/diagnostico') return responder(res, 404, 'no');

  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress).split(',')[0].trim();
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
