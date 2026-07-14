const express = require('express');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const { Client, LocalAuth } = require('whatsapp-web.js');

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const CITAS_PATH = path.join(DATA_DIR, 'citas.json');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const AUTH_PATH = path.join(__dirname, '.wwebjs_auth');
const CACHE_PATH = path.join(__dirname, '.wwebjs_cache');
const MENSAJE_POR_DEFECTO = 'Hola {nombre}, te recordamos tu cita de {especialidad} el día {fecha} a las {hora}. Si no puedes asistir, avísame. ¡Gracias!';

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

let client = null;
let clientReady = false;
const sseClients = new Set(); // conexiones del navegador para eventos en vivo

// ---------- Datos ----------
function seedCitasSiHaceFalta() {
  if (fs.existsSync(CITAS_PATH)) return;
  const semilla = [];
  fs.writeFileSync(CITAS_PATH, JSON.stringify(semilla, null, 2), 'utf8');
}

function leerCitas() {
  seedCitasSiHaceFalta();
  try {
    const datos = JSON.parse(fs.readFileSync(CITAS_PATH, 'utf8'));
    return Array.isArray(datos) ? datos : [];
  } catch (_) {
    return [];
  }
}

function esCitaValida(cita) {
  return cita && typeof cita === 'object' &&
    ['nombre', 'telefono', 'fecha', 'hora', 'especialidad'].every(
      (campo) => cita[campo] === undefined || typeof cita[campo] === 'string'
    );
}

function guardarCitas(citas) {
  // escritura atómica: temporal + rename para no corromper el fichero si se corta a mitad
  const tmp = CITAS_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(citas, null, 2), 'utf8');
  fs.renameSync(tmp, CITAS_PATH);
}

function leerConfig() {
  const configBase = { mensaje: MENSAJE_POR_DEFECTO, autoEnvio: false };
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(configBase, null, 2), 'utf8');
    return configBase;
  }

  try {
    const datos = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return {
      mensaje: typeof datos.mensaje === 'string' && datos.mensaje.trim() ? datos.mensaje : MENSAJE_POR_DEFECTO,
      autoEnvio: datos.autoEnvio === true
    };
  } catch (_) {
    return configBase;
  }
}

function guardarConfig(config) {
  const actual = leerConfig();
  const mensaje = typeof config?.mensaje === 'string' && config.mensaje.trim() ? config.mensaje : actual.mensaje;
  const autoEnvio = typeof config?.autoEnvio === 'boolean' ? config.autoEnvio : actual.autoEnvio;
  const nuevo = { ...actual, mensaje, autoEnvio };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(nuevo, null, 2), 'utf8');
  return nuevo;
}

// ---------- Eventos hacia el navegador (SSE) ----------
function emitir(evento, datos) {
  const linea = `event: ${evento}\ndata: ${JSON.stringify(datos)}\n\n`;
  for (const res of sseClients) {
    try { res.write(linea); } catch (_) { /* ignorar */ }
  }
}

// ---------- Mensajería & Parseo Agnóstico ----------
const DIAS_SEMANA = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

// Elimina espacios raros, dobles y caracteres ocultos de control (ej: \u200e de Windows/Excel)
function limpiarString(str) {
  if (!str) return '';
  return String(str).replace(/[\u200e\u200f\u202a-\u202e]/g, '').replace(/\s+/g, ' ').trim();
}

// Convierte de manera robusta "2026-07-03" o "03/07/2026" en "Viernes 3 Julio"
function formatearFecha(fecha) {
  const limpia = limpiarString(fecha);

  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(limpia);
  if (m) {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    if (d.getMonth() === Number(m[2]) - 1 && d.getDate() === Number(m[3])) {
      return `${DIAS_SEMANA[d.getDay()]} ${d.getDate()} ${MESES[d.getMonth()]}`;
    }
  }

  m = /^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/.exec(limpia);
  if (m) {
    const d = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
    if (d.getMonth() === Number(m[2]) - 1 && d.getDate() === Number(m[1])) {
      return `${DIAS_SEMANA[d.getDay()]} ${d.getDate()} ${MESES[d.getMonth()]}`;
    }
  }

  return limpia;
}

// Convierte formatos mixtos 12H (am/pm, a.m.) o 24H limpios a HH:MM estricto de 24 horas
function normalizarHoraA24(horaStr) {
  let limpia = limpiarString(horaStr).toLowerCase();
  if (!limpia) return null;

  const match12 = /^(\d{1,2}):(\d{2})\s*(am|pm|a\.\s*m\.|p\.\s*m\.)?$/.exec(limpia);
  if (match12) {
    let horas = parseInt(match12[1], 10);
    const minutos = match12[2];
    const sufijo = match12[3];

    if (sufijo) {
      if ((sufijo.includes('p') || sufijo.includes('pm')) && horas < 12) horas += 12;
      if ((sufijo.includes('a') || sufijo.includes('am')) && horas === 12) horas = 0;
    }
    return `${String(horas).padStart(2, '0')}:${minutos}`;
  }
  return limpia;
}

function formatearMensaje(cita, plantilla = leerConfig().mensaje) {
  const valores = {
    nombre: limpiarString(cita.nombre),
    telefono: limpiarString(cita.telefono),
    fecha: cita.fecha ? formatearFecha(cita.fecha) : '',
    hora: normalizarHoraA24(cita.hora) || '',
    especialidad: limpiarString(cita.especialidad) || 'salud'
  };

  return plantilla.replace(/\{(nombre|telefono|fecha|hora|especialidad)\}/gi, (_match, campo) => valores[campo.toLowerCase()] ?? '');
}

// ---------- Cliente WhatsApp ----------
// Borra cache de version web de WhatsApp. En Windows (sobre todo version
// portable) una escritura interrumpida deja este cache corrupto y el cliente
// se queda colgado al iniciar sin emitir 'qr' ni 'ready'. Limpiar antes de
// arrancar evita tener que borrar la carpeta a mano.
function limpiarCacheWeb() {
  try {
    if (fs.existsSync(CACHE_PATH)) {
      fs.rmSync(CACHE_PATH, { recursive: true, force: true });
    }
  } catch (err) {
    emitir('log', { tipo: 'error', texto: 'No se pudo limpiar cache: ' + err.message });
  }
}

function crearClienteSiHaceFalta() {
  if (client) return;

  limpiarCacheWeb();

  client = new Client({
    authStrategy: new LocalAuth({ dataPath: path.resolve(AUTH_PATH) }),
    webVersionCache: { type: 'none' },
    puppeteer: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-extensions',
        '--disable-gpu',
        '--disable-dev-shm-usage'
      ]
    }
  });

  client.on('qr', async (qr) => {
    try {
      const dataUrl = await QRCode.toDataURL(qr, { width: 320, margin: 1 });
      emitir('qr', dataUrl);
    } catch (err) {
      emitir('log', { tipo: 'error', texto: 'No se pudo generar el QR: ' + err.message });
    }
  });

  client.on('authenticated', () => emitir('log', { tipo: 'info', texto: 'Autenticado, conectando...' }));

  client.on('ready', () => {
    clientReady = true;
    emitir('estado', 'conectado');
    emitir('log', { tipo: 'ok', texto: 'WhatsApp conectado y listo.' });
  });

  client.on('auth_failure', (msg) => {
    clientReady = false;
    emitir('estado', 'error');
    emitir('log', { tipo: 'error', texto: 'Error de autenticación: ' + msg });
  });

  client.on('disconnected', (reason) => {
    clientReady = false;
    emitir('estado', 'desconectado');
    emitir('log', { tipo: 'error', texto: 'Sesión desconectada: ' + reason });
    client = null;
  });
}

async function iniciarSesion() {
  crearClienteSiHaceFalta();
  if (clientReady) {
    emitir('estado', 'conectado');
    return;
  }
  emitir('estado', 'conectando');
  client.initialize().catch((err) => {
    emitir('estado', 'error');
    emitir('log', { tipo: 'error', texto: 'Error al iniciar: ' + err.message });
  });
}

async function cerrarSesion() {
  if (!client) return;
  try { await client.logout(); } catch (_) { /* ignorar */ }
  try { await client.destroy(); } catch (_) { /* ignorar */ }
  client = null;
  clientReady = false;
  emitir('estado', 'desconectado');
  emitir('log', { tipo: 'info', texto: 'Sesión cerrada.' });
}

const pausa = (ms) => new Promise((resolver) => setTimeout(resolver, ms));

// envía el recordatorio de una cita; devuelve 'enviado' | 'omitido' | 'fallido'
async function enviarUna(cita, mensaje) {
  let numero = String(cita.telefono).replace(/\D/g, '');
  // número español sin prefijo (9 dígitos empezando por 6/7/8/9): añadir 34
  if (/^[6789]\d{8}$/.test(numero)) numero = '34' + numero;

  // getNumberId devuelve null si el número no tiene WhatsApp, pero con números
  // malformados lanza una excepción interna sin mensaje útil: tratamos ambos igual
  let numeroId = null;
  try { numeroId = await client.getNumberId(numero); } catch (_) { /* número no válido */ }
  if (!numeroId) {
    emitir('log', { tipo: 'aviso', texto: `${cita.nombre || 'Sin nombre'} (${cita.telefono}): el número no es válido o no tiene WhatsApp, no se envió.` });
    return 'omitido';
  }

  try {
    await client.sendMessage(numeroId._serialized, formatearMensaje(cita, mensaje));
    emitir('log', { tipo: 'ok', texto: `Enviado a ${cita.nombre} (${cita.telefono})` });
    return 'enviado';
  } catch (err) {
    emitir('log', { tipo: 'error', texto: `Error con ${cita.nombre} (${cita.telefono}): ${err.message}` });
    return 'fallido';
  }
}

// guarda en citas.json el resultado del envío ('enviado' | 'fallido' | 'omitido')
// para mostrarlo en la tabla y que el envío automático no repita
function marcarEstadoEnvio(citasMarcar, estado) {
  const actuales = leerCitas();
  let cambiado = false;
  for (const c of actuales) {
    const coincide = citasMarcar.some(
      (m) => m.telefono === c.telefono && m.fecha === c.fecha && m.hora === c.hora
    );
    if (coincide && c.estadoEnvio !== estado) {
      c.estadoEnvio = estado;
      cambiado = true;
    }
  }
  if (cambiado) {
    guardarCitas(actuales);
    emitir('citas', actuales); // la tabla del navegador se refresca en vivo
  }
}

async function enviarRecordatorios(citas) {
  if (!clientReady) {
    throw new Error('WhatsApp no está conectado. Pulsa "Conectar WhatsApp" y escanea el QR.');
  }

  const lista = Array.isArray(citas) ? citas : [];
  const { mensaje } = leerConfig();
  let enviados = 0, fallidos = 0, omitidos = 0;
  const porEstado = { enviado: [], fallido: [], omitido: [] };

  for (let i = 0; i < lista.length; i++) {
    const cita = lista[i];

    if (!cita.telefono || !cita.hora || !cita.fecha) {
      omitidos++;
      emitir('log', { tipo: 'aviso', texto: `Cita incompleta omitida: ${cita.nombre || '(sin nombre)'}` });
      emitir('progreso', { hecho: i + 1, total: lista.length });
      continue;
    }

    // pausa aleatoria entre envíos para no parecer envío masivo (riesgo de bloqueo del número)
    if (enviados + fallidos > 0) await pausa(2500 + Math.random() * 2500);

    const resultado = await enviarUna(cita, mensaje);
    porEstado[resultado].push(cita);
    if (resultado === 'enviado') enviados++;
    else if (resultado === 'fallido') fallidos++;
    else omitidos++;
    emitir('progreso', { hecho: i + 1, total: lista.length });
  }

  for (const [estado, marcadas] of Object.entries(porEstado)) {
    if (marcadas.length) marcarEstadoEnvio(marcadas, estado);
  }
  return { enviados, fallidos, omitidos, total: lista.length };
}

// ---------- Envío automático (24 h antes de la cita) ----------
const HORAS_ANTELACION = 24;
const INTERVALO_AUTO_MS = 45 * 1000;

function fechaHoraCita(cita) {
  const fLimpia = limpiarString(cita.fecha);
  const hLimpia = normalizarHoraA24(cita.hora);
  if (!fLimpia || !hLimpia) return null;

  let anio, mes, dia;

  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(fLimpia);
  if (m) {
    anio = Number(m[1]);
    mes = Number(m[2]) - 1;
    dia = Number(m[3]);
  } else {
    m = /^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/.exec(fLimpia);
    if (m) {
      anio = Number(m[3]);
      mes = Number(m[2]) - 1;
      dia = Number(m[1]);
    } else {
      return null;
    }
  }

  const hMatch = /^(\d{2}):(\d{2})$/.exec(hLimpia);
  if (!hMatch) return null;

  const d = new Date(anio, mes, dia, Number(hMatch[1]), Number(hMatch[2]));
  return Number.isNaN(d.getTime()) ? null : d;
}

let autoEnvioEnCurso = false;
async function cicloAutoEnvio() {
  if (autoEnvioEnCurso || !clientReady) return;
  const config = leerConfig();
  if (!config.autoEnvio) return;

  const ahora = Date.now();
  const limite = ahora + HORAS_ANTELACION * 3600 * 1000;
  const pendientes = leerCitas().filter((c) => {
    // estadoEnvio: ya intentado (enviado/fallido/omitido); recordatorioEnviado: compatibilidad con ficheros antiguos
    if (c.estadoEnvio || c.recordatorioEnviado || !c.telefono) return false;
    const dt = fechaHoraCita(c);
    return dt && dt.getTime() > ahora && dt.getTime() <= limite;
  });
  if (pendientes.length === 0) return;

  autoEnvioEnCurso = true;
  try {
    emitir('log', { tipo: 'info', texto: `Envío automático: ${pendientes.length} cita(s) a menos de ${HORAS_ANTELACION} h.` });
    for (let i = 0; i < pendientes.length; i++) {
      if (!clientReady) break;
      if (i > 0) await pausa(2500 + Math.random() * 2500);
      const resultado = await enviarUna(pendientes[i], config.mensaje);
      // se marca también si falló, para no reintentar cada minuto y saturar
      marcarEstadoEnvio([pendientes[i]], resultado);
    }
  } finally {
    autoEnvioEnCurso = false;
  }
}
setInterval(cicloAutoEnvio, INTERVALO_AUTO_MS);

// ---------- Servidor HTTP ----------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'renderer')));

// Librerías para importar PDF/imagen, servidas en local (sin depender de internet)
app.use('/vendor/pdfjs', express.static(path.join(__dirname, 'node_modules', 'pdfjs-dist', 'build')));
app.use('/vendor/tesseract', express.static(path.join(__dirname, 'node_modules', 'tesseract.js', 'dist')));
app.use('/vendor/tesseract-core', express.static(path.join(__dirname, 'node_modules', 'tesseract.js-core')));
app.use('/vendor/tessdata', express.static(path.join(__dirname, 'vendor', 'tessdata')));

// Flujo de eventos en vivo (QR, estado, log, progreso)
app.get('/api/events', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });
  res.flushHeaders();
  res.write('retry: 3000\n\n');
  sseClients.add(res);
  // estado actual al conectar
  res.write(`event: estado\ndata: ${JSON.stringify(clientReady ? 'conectado' : 'desconectado')}\n\n`);
  req.on('close', () => sseClients.delete(res));
});

app.get('/api/citas', (_req, res) => res.json(leerCitas()));

app.post('/api/citas', (req, res) => {
  if (!Array.isArray(req.body) || !req.body.every(esCitaValida)) {
    return res.status(400).json({ error: 'Formato de citas no válido; no se ha guardado nada.' });
  }
  guardarCitas(req.body);
  res.json({ ok: true });
});

app.get('/api/config', (_req, res) => res.json(leerConfig()));

app.post('/api/config', (req, res) => res.json(guardarConfig(req.body || {})));

app.get('/api/estado', (_req, res) => res.json({ estado: clientReady ? 'conectado' : 'desconectado' }));

app.post('/api/conectar', (_req, res) => { iniciarSesion(); res.json({ ok: true }); });

app.post('/api/cerrar', async (_req, res) => { await cerrarSesion(); res.json({ ok: true }); });

app.post('/api/enviar', async (req, res) => {
  try {
    const resultado = await enviarRecordatorios(req.body);
    res.json(resultado);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------- Actualizaciones ----------
const updater = require('./update.js');

app.get('/api/actualizacion', async (_req, res) => {
  try {
    res.json(await updater.buscarActualizacion());
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Aplica la actualizacion. server.js ya esta cargado en memoria, asi que los
// cambios de codigo del servidor tienen efecto al reiniciar; los de renderer
// se ven al recargar el navegador.
app.post('/api/actualizar', async (_req, res) => {
  try {
    const { hayActualizacion, remota } = await updater.buscarActualizacion();
    if (!hayActualizacion) return res.json({ actualizado: false, version: remota });
    const archivos = await updater.aplicarActualizacion();
    emitir('log', { tipo: 'ok', texto: `Actualizado a la version ${remota}. Reinicia la aplicacion para aplicar los cambios.` });
    res.json({ actualizado: true, version: remota, archivos });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

const server = app.listen(PORT, () => {
  console.log('==================================================');
  console.log('  Recordatorios WhatsApp Multiplataforma');
  console.log(`  Abre en tu navegador: http://localhost:${PORT}`);
  console.log('==================================================');
});

// ---------- Cierre limpio al cerrar el terminal ----------
let cerrando = false;
async function apagar(motivo) {
  if (cerrando) return;
  cerrando = true;
  console.log(`\nCerrando de forma segura (${motivo})...`);

  // cerrar conexiones SSE abiertas
  for (const res of sseClients) {
    try { res.end(); } catch (_) { /* ignorar */ }
  }

  await new Promise((resolve) => server.close(() => resolve()));

  // destruir el cliente WhatsApp mata el Chromium de Puppeteer
  if (client) {
    try {
      await client.destroy();
      console.log('Procesos de Chromium cerrados correctamente.');
    } catch (_) { /* ignorar */ }
  }

  process.exit(0);
}

// SIGINT (Ctrl+C), SIGTERM (kill), SIGHUP (cerrar terminal en Linux/Mac)
['SIGINT', 'SIGTERM', 'SIGHUP'].forEach((sig) => {
  process.on(sig, () => apagar(sig));
});

// Windows: al cerrar la ventana de consola
if (process.platform === 'win32') {
  process.on('SIGBREAK', () => apagar('SIGBREAK'));
  try {
    const readline = require('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.on('SIGINT', () => apagar('SIGINT'));
  } catch (_) { /* ignorar */ }
}
