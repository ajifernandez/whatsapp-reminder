const express = require('express');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const updater = require('./update.js');
const { execFile } = require('child_process');

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const CITAS_PATH = path.join(DATA_DIR, 'citas.json');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const LOG_PATH = path.join(DATA_DIR, 'app.log');
const LOG_MAX_BYTES = 512 * 1024; // se recorta a la mitad al superarlo
// Motor de WhatsApp (motores/*.js). Se elige con "motor" en data/config.json o desde la
// pagina (/api/motor). Cada motor tiene su propia sesion: al cambiar hay que vincular.
const MOTORES = { baileys: './motores/baileys', wwebjs: './motores/wwebjs' };
const NOMBRES_MOTOR = { baileys: 'Baileys (recomendado)', wwebjs: 'whatsapp-web.js (anterior)' };
// Instalaciones que ya usaban whatsapp-web.js siguen con él (sin volver a vincular el
// móvil); las nuevas, Baileys. Sin cargar los motores: puede que aún falten ficheros.
function motorPorDefecto() {
  const conWwebjs = fs.existsSync(path.join(__dirname, '.wwebjs_auth', 'session'));
  const conBaileys = fs.existsSync(path.join(__dirname, '.baileys_auth', 'creds.json'));
  return conWwebjs && !conBaileys ? 'wwebjs' : 'baileys';
}
const MENSAJE_POR_DEFECTO = 'Hola {nombre}, te recordamos tu cita de {especialidad} el día {fecha} a las {hora}. Si no puedes asistir, avísame. ¡Gracias!';

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

let client = null;
let clientReady = false;
const sseClients = new Set(); // conexiones del navegador para eventos en vivo

// ---------- Registro persistente ----------
// Los mensajes del panel "Registro" se escriben también en data/app.log y en
// la consola, para poder consultar el motivo de un fallo después de cerrar.
function leerUltimoErrorDelLog() {
  try {
    if (!fs.existsSync(LOG_PATH)) return null;
    const lineas = fs.readFileSync(LOG_PATH, 'utf8').trimEnd().split('\n');
    for (let i = lineas.length - 1; i >= 0; i--) {
      if (lineas[i].includes('[error]')) {
        return lineas[i].replace(/^\[[^\]]*\]\s*\[error\]\s*/, '');
      }
    }
  } catch (_) { /* ignorar */ }
  return null;
}

let ultimoError = leerUltimoErrorDelLog(); // sobrevive recargas del navegador y reinicios

function registrarLog(tipo, texto) {
  if (tipo === 'error') ultimoError = texto;
  const linea = `[${new Date().toISOString()}] [${tipo}] ${texto}`;
  try {
    if (fs.existsSync(LOG_PATH) && fs.statSync(LOG_PATH).size > LOG_MAX_BYTES) {
      const viejo = fs.readFileSync(LOG_PATH, 'utf8');
      fs.writeFileSync(LOG_PATH, viejo.slice(-Math.floor(LOG_MAX_BYTES / 2)), 'utf8');
    }
    fs.appendFileSync(LOG_PATH, linea + '\n', 'utf8');
  } catch (_) { /* si no se puede escribir, al menos llega por SSE */ }
  console.log(linea);
}

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
  const configBase = { mensaje: MENSAJE_POR_DEFECTO, autoEnvio: false, motor: motorPorDefecto() };
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(configBase, null, 2), 'utf8');
    return configBase;
  }

  try {
    const datos = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return {
      mensaje: typeof datos.mensaje === 'string' && datos.mensaje.trim() ? datos.mensaje : MENSAJE_POR_DEFECTO,
      autoEnvio: datos.autoEnvio === true,
      motor: Object.hasOwn(MOTORES, datos.motor) ? datos.motor : motorPorDefecto()
    };
  } catch (_) {
    return configBase;
  }
}

function guardarConfig(config) {
  const actual = leerConfig();
  const mensaje = typeof config?.mensaje === 'string' && config.mensaje.trim() ? config.mensaje : actual.mensaje;
  const autoEnvio = typeof config?.autoEnvio === 'boolean' ? config.autoEnvio : actual.autoEnvio;
  const motor = Object.hasOwn(MOTORES, config?.motor) ? config.motor : actual.motor;
  const nuevo = { ...actual, mensaje, autoEnvio, motor };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(nuevo, null, 2), 'utf8');
  return nuevo;
}

// ---------- Eventos hacia el navegador (SSE) ----------
function emitir(evento, datos) {
  if (evento === 'log' && datos && typeof datos === 'object') {
    registrarLog(datos.tipo || 'info', String(datos.texto ?? ''));
  }
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

// ---------- Cliente WhatsApp (lo propio de cada libreria vive en motores/) ----------
let Motor = null; // se carga al arrancar, tras comprobar que no faltan ficheros (ver arrancar())
// motores con su sesion: para el selector de la pagina y el aviso de revincular
const listaMotores = () => Object.keys(MOTORES).map((id) => ({ id, nombre: NOMBRES_MOTOR[id], vinculado: require(MOTORES[id]).sesionGuardada() }));
// log del motor: ui=true tambien lo muestra en la pagina
const logMotor = (tipo, texto, ui = false) => (ui ? emitir('log', { tipo, texto }) : registrarLog(tipo, texto));

function crearCliente() {
  const c = Motor.crear({ log: logMotor, timeoutMs: TIMEOUT_CONEXION_MS });

  c.on('qr', async (qr) => {
    try {
      const dataUrl = await QRCode.toDataURL(qr, { width: 320, margin: 1 });
      emitir('qr', dataUrl);
    } catch (err) {
      emitir('log', { tipo: 'error', texto: 'No se pudo generar el QR: ' + err.message });
    }
  });

  c.on('autenticado', () => emitir('log', { tipo: 'info', texto: 'Autenticado, conectando...' }));

  c.on('listo', () => {
    pararTemporizadorConexion();
    conectando = false;
    clientReady = true;
    ultimoError = null; // la conexión funcionó: el error anterior ya no aplica
    emitir('estado', 'conectado');
    emitir('log', { tipo: 'ok', texto: 'WhatsApp conectado y listo.' });
  });

  c.on('fallo_auth', (msg) => {
    pararTemporizadorConexion();
    conectando = false;
    clientReady = false;
    emitir('estado', 'error');
    emitir('log', { tipo: 'error', texto: 'Error de autenticación: ' + msg });
  });

  c.on('desconectado', (reason) => {
    pararTemporizadorConexion();
    conectando = false;
    clientReady = false;
    emitir('estado', 'desconectado');
    emitir('log', { tipo: 'error', texto: 'Sesión desconectada: ' + reason });
    client = null;
  });
  return c;
}

const COOLDOWN_RECONEXION_MS = 30 * 1000; // evita reintentos en bucle (posible causa de bloqueo)
const TIMEOUT_CONEXION_MS = 90 * 1000; // si no conecta en este tiempo, se cancela en vez de colgarse para siempre
let ultimoIntentoConexion = 0;
let conectando = false;
let temporizadorConexion = null;

function pararTemporizadorConexion() {
  if (temporizadorConexion) {
    clearTimeout(temporizadorConexion);
    temporizadorConexion = null;
  }
}

// Estado para informar al navegador: incluye 'conectando' mientras hay un
// intento en marcha, aunque clientReady siga en false (evita que la página
// recién cargada muestre "Desconectado" y habilite el botón durante el intento)
function estadoActual() {
  if (clientReady) return 'conectado';
  if (conectando) return 'conectando';
  return 'desconectado';
}

async function iniciarSesion() {
  if (clientReady) {
    emitir('estado', 'conectado');
    return;
  }
  if (conectando) {
    emitir('estado', 'conectando'); // confirma al navegador que sigue en curso, no se queda colgado
    return;
  }

  const ahora = Date.now();
  const restante = COOLDOWN_RECONEXION_MS - (ahora - ultimoIntentoConexion);
  if (restante > 0) {
    emitir('log', { tipo: 'aviso', texto: `Espera ${Math.ceil(restante / 1000)} s antes de reintentar conectar (evita bloqueos por reintentos seguidos).` });
    emitir('estado', 'desconectado'); // deshace el "conectando" que puso el botón al pulsarlo
    return;
  }

  ultimoIntentoConexion = ahora;
  conectando = true;
  emitir('estado', 'conectando');
  if (!client) {
    const huerfanos = await Motor.prepararArranque(logMotor);
    if (huerfanos) emitir('log', { tipo: 'aviso', texto: `Se cerraron ${huerfanos} procesos de Chromium que habían quedado abiertos de un intento anterior.` });
    client = crearCliente();
  }
  const c = client;

  // Si el motor se cuelga conectando (whatsapp-web.js cargando la página, pasa a veces),
  // iniciar() no rechaza ni resuelve nunca: sin este límite se
  // quedaría en "Conectando..." para siempre, sin avisar ni dejar reintentar.
  temporizadorConexion = setTimeout(() => {
    if (clientReady) return;
    emitir('estado', 'error');
    emitir('log', { tipo: 'error', texto: `La conexión tardó más de ${TIMEOUT_CONEXION_MS / 1000}s y se canceló. Pulsa "Conectar WhatsApp" para reintentar.` });
    if (client === c) client = null;
    conectando = false;
    // sin listeners (un 'desconectado' machacaria el estado 'error') y terminado de verdad
    c.descartar();
  }, TIMEOUT_CONEXION_MS);

  // NOTA: conectando se libera solo en estados finales (listo, fallo_auth,
  // desconectado, error de iniciar o timeout). iniciar() puede resolver ANTES
  // de 'listo': si se liberara aquí, un clic en "Conectar" durante ese hueco
  // caería en el cooldown y pondría estado 'desconectado' aunque la conexión
  // siguiera en marcha.
  c.iniciar().catch((err) => {
    if (client !== c) return; // ya descartado (timeout): el aviso ya se dio
    // si el cliente fallido se quedara en 'client', el siguiente intento lo reutilizaria roto
    pararTemporizadorConexion();
    client = null;
    conectando = false;
    c.descartar();
    emitir('estado', 'error');
    emitir('log', { tipo: 'error', texto: 'Error al iniciar: ' + ((err && err.message) || err) });
  });
}

async function cerrarSesion() {
  if (!client) return;
  pararTemporizadorConexion(); // si se cierra a mitad de conectar, que el timeout no salte después
  conectando = false;
  await client.cerrarSesion();
  client = null;
  clientReady = false;
  emitir('estado', 'desconectado');
  emitir('log', { tipo: 'info', texto: 'Sesión cerrada.' });
}

const pausa = (ms) => new Promise((resolver) => setTimeout(resolver, ms));

const PAUSA_LARGA_CADA = 20; // envíos entre cada pausa larga
const PAUSA_LARGA_MS = 30 * 1000; // duración de la pausa larga

// solo dígitos; número español sin prefijo (9 dígitos empezando por 6/7/8/9): añadir 34
function normalizarTelefono(telefono) {
  const numero = String(telefono).replace(/\D/g, '');
  return /^[6789]\d{8}$/.test(numero) ? '34' + numero : numero;
}

// envía el recordatorio de una cita; devuelve 'enviado' | 'omitido' | 'fallido'
async function enviarUna(cita, mensaje) {
  const numero = normalizarTelefono(cita.telefono);

  const id = await client.idDe(numero); // null: número no válido o sin WhatsApp
  if (!id) {
    emitir('log', { tipo: 'aviso', texto: `${cita.nombre || 'Sin nombre'} (${cita.telefono}): el número no es válido o no tiene WhatsApp, no se envió.` });
    return 'omitido';
  }

  try {
    await client.enviar(id, formatearMensaje(cita, mensaje));
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

    // pausa aleatoria entre envíos para no parecer envío masivo (riesgo de bloqueo del número).
    // Cada PAUSA_LARGA_CADA envíos se hace una pausa mucho más larga, simulando uso humano
    // (WhatsApp puede bloquear números que mandan mensajes seguidos sin descanso).
    const hechos = enviados + fallidos;
    if (hechos > 0) {
      if (hechos % PAUSA_LARGA_CADA === 0) {
        emitir('log', { tipo: 'info', texto: `Pausa de seguridad (${Math.round(PAUSA_LARGA_MS / 1000)} s) tras ${hechos} envíos para evitar bloqueos.` });
        await pausa(PAUSA_LARGA_MS);
      } else {
        await pausa(2500 + Math.random() * 2500);
      }
    }

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
  res.write(`event: estado\ndata: ${JSON.stringify(estadoActual())}\n\n`);
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

app.get('/api/estado', (_req, res) => res.json({ estado: estadoActual(), ultimoError, version: updater.versionLocal(), fijada: updater.versionFijada(), motor: Motor.nombre, motores: listaMotores() }));

// Cambio de motor desde la pagina: corta la conexion actual (cada motor tiene su sesion)
// y, si el nuevo ya esta vinculado, conecta con el.
app.post('/api/motor', (req, res) => {
  const id = String((req.body || {}).motor || '');
  if (!Object.hasOwn(MOTORES, id)) return res.status(400).json({ error: 'Motor desconocido' });
  if (client) {
    pararTemporizadorConexion();
    client.descartar();
    client = null;
  }
  conectando = false;
  clientReady = false;
  Motor = require(MOTORES[id]);
  guardarConfig({ motor: id });
  emitir('estado', 'desconectado');
  emitir('log', { tipo: 'info', texto: `Motor cambiado a ${NOMBRES_MOTOR[id]}.` + (Motor.sesionGuardada() ? ' Conectando con su sesión guardada...' : ' Pulsa «Conectar WhatsApp» y vincula el móvil.') });
  if (Motor.sesionGuardada()) {
    ultimoIntentoConexion = 0; // cambio explicito: sin esperar el cooldown
    iniciarSesion();
  }
  res.json({ motor: id, motores: listaMotores() });
});

// El log lleva nombres y telefonos de pacientes: se quitan antes de sacarlo del equipo.
function anonimizar(linea) {
  const [, prefijo = '', texto] = String(linea).match(/^(\[[^\]]*\] \[[^\]]*\] )?([\s\S]*)$/);
  return prefijo + texto
    .replace(/(Enviado a|Error con|omitida:) [^(\n]+?(?= \(|$)/g, '$1 [nombre]')
    .replace(/^[^(\n]+(?= \([^)]*\): el número no es válido)/, '[nombre]')
    .replace(/\+?\d[\d\s-]{6,}\d/g, '[tel]')
    .replace(sinUsuarioRe, '$1<usuario>');
}

// Las rutas llevan el nombre de usuario del PC: se oculta en el informe.
const sinUsuarioRe = /([A-Za-z]:[\\/]Users[\\/]|\/home\/|\/Users\/)[^\\/\n]+/gi;
const sinUsuario = (ruta) => (ruta == null ? ruta : String(ruta).replace(sinUsuarioRe, '$1<usuario>'));

// Receptor de diagnosticos (ver soporte-server/). Si falla o esta vacio, la UI cae a descarga + correo.
const DIAG_URL = process.env.DIAG_URL || 'https://soporte.familia-jimenez.es/diagnostico';

// Si Node llega a WhatsApp Web pero Chromium no, el bloqueo es del navegador (antivirus,
// cortafuegos del chrome.exe, proxy del sistema); si Node tampoco, es la red.
async function pruebaRed() {
  const t = Date.now();
  try {
    const r = await fetch('https://web.whatsapp.com/', { method: 'HEAD', signal: AbortSignal.timeout(8000) });
    return `HTTP ${r.status} en ${Date.now() - t} ms`;
  } catch (e) {
    return `fallo tras ${Date.now() - t} ms: ${(e.cause && e.cause.code) || e.name}`;
  }
}

const ejecutar = (cmd, args) => new Promise((resolve) => {
  execFile(cmd, args, { timeout: 15000, windowsHide: true }, (_err, stdout) => resolve(String(stdout || '')));
});

// Chromium usa el proxy de Windows (Internet Settings), no el de Node. Sin credenciales.
async function proxyDelSistema() {
  const r = { variablesEntorno: ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY'].filter((k) => process.env[k] || process.env[k.toLowerCase()]) };
  if (process.platform === 'win32') {
    for (const v of ['ProxyEnable', 'ProxyServer', 'AutoConfigURL']) {
      const out = await ejecutar('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings', '/v', v]);
      const m = out.match(/REG_\w+\s+(.+)/);
      r[v] = m ? m[1].trim().replace(/\/\/[^@/\s]+@/g, '//') : null;
    }
  }
  return r;
}

async function informeDiagnostico() {
  const os = require('os');
  let discoLibreMB = null; try { const f = fs.statfsSync(__dirname); discoLibreMB = Math.round((f.bavail * f.bsize) / 1048576); } catch (_) { /* sin statfs */ }
  const [red, proxy, delMotor] = await Promise.all([pruebaRed(), proxyDelSistema(), Motor.diagnostico()]);
  let log = [];
  try { log = fs.readFileSync(LOG_PATH, 'utf8').trimEnd().split('\n').slice(-80); } catch (_) { /* sin log */ }
  return {
    version: updater.versionLocal(), canal: updater.canal(), fijada: updater.versionFijada(), estado: estadoActual(), ultimoError: ultimoError && anonimizar(ultimoError),
    node: process.version, so: `${os.type()} ${os.release()} ${os.arch()}`, host: os.hostname(),
    arranqueHaceSeg: Math.round(process.uptime()), ramLibreMB: Math.round(os.freemem() / 1048576),
    citas: leerCitas().length, motor: Motor.nombre,
    ...delMotor, chromiumRuta: sinUsuario(delMotor.chromiumRuta),
    redWhatsApp: red, proxy, rutaApp: sinUsuario(__dirname), enNube: /onedrive|dropbox|google ?drive|icloud/i.test(__dirname), discoLibreMB,
    log: log.map(anonimizar)
  };
}

// Resumen para soporte remoto: abrir http://localhost:PUERTO/api/diagnostico
app.get('/api/diagnostico', async (_req, res) => res.json(await informeDiagnostico()));

app.post('/api/enviar-diagnostico', async (_req, res) => {
  if (!DIAG_URL) return res.status(501).json({ error: 'Envio directo no configurado' });
  try {
    const r = await fetch(DIAG_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(await informeDiagnostico()), signal: AbortSignal.timeout(15000)
    });
    if (!r.ok) throw new Error('El servidor respondio ' + r.status);
    emitir('log', { tipo: 'ok', texto: 'Diagnostico enviado a soporte' });
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.post('/api/conectar', (_req, res) => { iniciarSesion(); res.json({ ok: true }); });

// Vincular sin cámara (solo motores que lo admiten, p. ej. Baileys): con «Conectar»
// ya pulsado, devuelve el código que se introduce en el móvil.
app.post('/api/vincular-codigo', async (req, res) => {
  if (!client || typeof client.pedirCodigo !== 'function') return res.status(400).json({ error: 'Pulsa antes «Conectar WhatsApp» (o este motor no admite código).' });
  const numero = normalizarTelefono((req.body || {}).telefono || '');
  if (numero.length < 10) return res.status(400).json({ error: 'Escribe el número del móvil que vas a vincular' });
  try {
    const codigo = await client.pedirCodigo(numero);
    emitir('log', { tipo: 'info', texto: 'Código de vinculación generado. Introdúcelo en el móvil: WhatsApp → Dispositivos vinculados → Vincular con el número de teléfono.' });
    res.json({ codigo });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Cierre controlado desde la página (el mismo que Ctrl+C). Solo desde la propia
// página: cualquier web abierta en el PC podría mandar este POST a localhost.
app.post('/api/apagar', (req, res) => {
  const origen = req.headers.origin;
  let propio = true;
  try { propio = !origen || new URL(origen).host === req.headers.host; } catch (_) { propio = false; }
  if (!propio) return res.status(403).json({ error: 'Origen no permitido' });
  res.json({ ok: true });
  setTimeout(() => apagar('botón Apagar de la página'), 100); // que la respuesta llegue antes
});

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

app.get('/api/actualizacion', async (_req, res) => {
  try {
    res.json(await updater.buscarActualizacion());
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/versiones', async (_req, res) => {
  try {
    res.json({ actual: updater.versionLocal(), fijada: updater.versionFijada(), versiones: await updater.listarVersiones() });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Downgrade ({version:'2.1.9'}) o volver a seguir la ultima ({version:'latest'}).
// Como /api/actualizar, el codigo del servidor aplica tras reiniciar.
app.post('/api/version', async (req, res) => {
  try {
    const v = String((req.body || {}).version || '');
    if (v === 'latest') {
      updater.quitarFijacion();
      await updater.aplicarActualizacion();
    } else {
      await updater.fijarVersion(v);
    }
    emitir('log', { tipo: 'aviso', texto: `Cambio de version: ${v}. Reinicia la aplicacion para aplicar los cambios.` });
    res.json({ version: v });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Aplica la actualizacion. server.js ya esta cargado en memoria, asi que los
// cambios de codigo del servidor tienen efecto al reiniciar; los de renderer
// se ven al recargar el navegador.
app.post('/api/actualizar', async (_req, res) => {
  try {
    const { local, remota, hayActualizacion, fijada, nuevaMayor } = await updater.buscarActualizacion();
    if (nuevaMayor) {
      emitir('log', { tipo: 'aviso', texto: `Hay una versión mayor nueva (${nuevaMayor}). No se instala sola: avisa a soporte para instalarla.` });
      return res.json({ actualizado: false, version: local, nuevaMayor });
    }
    if (fijada) {
      emitir('log', { tipo: 'aviso', texto: `Versión fijada en ${local}: no se actualiza sola. Para volver a la última, avisa a soporte.` });
      return res.json({ actualizado: false, version: local, fijada: true });
    }
    if (!hayActualizacion) {
      emitir('log', { tipo: 'ok', texto: `Ya tienes la última versión (${local}).` });
      return res.json({ actualizado: false, version: local });
    }
    emitir('log', { tipo: 'info', texto: `Nueva versión ${remota} disponible (tienes ${local}). Descargando...` });
    const archivos = await updater.aplicarActualizacion();
    emitir('log', { tipo: 'ok', texto: `Actualizado a la version ${remota}. Reinicia la aplicacion para aplicar los cambios.` });
    res.json({ actualizado: true, version: remota, archivos });
  } catch (err) {
    emitir('log', { tipo: 'error', texto: 'No se pudo actualizar: ' + err.message });
    res.status(502).json({ error: err.message });
  }
});

// Errores internos de puppeteer/whatsapp-web.js que no pasan por emitir():
// se guardan en el log para no perder el motivo real de un fallo de conexión.
process.on('unhandledRejection', (err) => {
  registrarLog('error', 'Error interno no capturado: ' + (err && err.message ? err.message : String(err)));
});
process.on('uncaughtException', (err) => {
  registrarLog('error', 'Excepción no capturada: ' + err.message);
});

let server = null;
async function arrancar() {
  // Una version nueva instalada por un updater antiguo puede venir sin sus ficheros nuevos
  // (motores/, vendor/...): se descargan antes de cargar el motor.
  try {
    const reparados = await updater.repararFaltantes();
    if (reparados.length) registrarLog('aviso', `Faltaban ficheros de la versión ${updater.versionLocal()}; descargados: ${reparados.join(', ')}`);
  } catch (err) {
    registrarLog('error', `Faltan ficheros de la aplicación y no se pudieron descargar (${err.message}). Conecta a internet y vuelve a abrirla.`);
  }
  Motor = require(MOTORES[leerConfig().motor]);

  server = app.listen(PORT, () => {
    console.log('==================================================');
    console.log('  Recordatorios WhatsApp Multiplataforma');
    console.log(`  Abre en tu navegador: http://localhost:${PORT}`);
    console.log('==================================================');

    // Si ya había una sesión de WhatsApp vinculada antes, intenta reconectar
    // sola al arrancar en vez de obligar a pulsar "Conectar" cada vez.
    if (Motor.sesionGuardada()) {
      registrarLog('info', 'Sesión de WhatsApp encontrada, reconectando automáticamente...');
      iniciarSesion();
    } else {
      // motor sin sesión pero con otro vinculado: la sesión de un motor no sirve para el otro
      const otro = listaMotores().find((m) => m.vinculado);
      if (otro) emitir('log', { tipo: 'aviso', texto: `Esta versión usa ${NOMBRES_MOTOR[Motor.nombre]}: hay que vincular el móvil una vez más (pulsa «Conectar WhatsApp»; QR o código). Para seguir con el motor anterior, elige «${otro.nombre}» en «Motor».` });
    }
  });

  // Segunda instancia con el puerto ocupado: sin esto el uncaughtException global se lo traga
  // y el proceso queda vivo y mudo.
  server.on('error', (err) => {
    if (err.code !== 'EADDRINUSE') throw err;
    registrarLog('error', `La aplicación ya está abierta (el puerto ${PORT} está ocupado). Usa http://localhost:${PORT} y no abras otra copia.`);
    process.exit(1);
  });
}
arrancar();

// ---------- Cierre limpio al cerrar el terminal ----------
let cerrando = false;
async function apagar(motivo) {
  if (cerrando) return;
  cerrando = true;
  console.log(`\nCerrando de forma segura (${motivo})...`);
  registrarLog('info', `Aplicación cerrada (${motivo}).`);
  setTimeout(() => process.exit(0), 10000).unref(); // si algo se cuelga al cerrar, se sale igual

  // cerrar conexiones SSE abiertas
  for (const res of sseClients) {
    try { res.end(); } catch (_) { /* ignorar */ }
  }

  if (server) await new Promise((resolve) => server.close(() => resolve()));

  // cerrar el motor (con whatsapp-web.js, mata el Chromium de Puppeteer)
  if (client) {
    try {
      await client.apagar();
      console.log('Cliente de WhatsApp cerrado correctamente.');
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
