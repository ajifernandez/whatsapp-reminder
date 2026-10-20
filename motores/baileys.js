// Motor Baileys: habla con WhatsApp por WebSocket como un dispositivo vinculado,
// sin navegador. Misma interfaz que motores/wwebjs.js (ver su cabecera); además:
//   instancia.pedirCodigo(numero) -> código de 8 caracteres para vincular sin QR.
// Baileys llega empaquetado en vendor/baileys.bundle.mjs (npm run build:baileys).
const EventEmitter = require('events');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { sinRespuesta, conLimite } = require('./comun');

const DIR_APP = path.join(__dirname, '..');
const AUTH_DIR = path.join(DIR_APP, '.baileys_auth');
const BUNDLE = path.join(DIR_APP, 'vendor', 'baileys.bundle.mjs');
const REINTENTOS_MAX = 5;

const pausa = (ms) => new Promise((resolver) => setTimeout(resolver, ms));

const estadoDiag = { reconexiones: 0, ultimoCierre: null, entrantesNoDescifrados: 0 };

// libsignal (dentro de Baileys) escribe directamente en consola: mensajes ENTRANTES que no
// puede descifrar ("Bad MAC", habitual tras vincular; la app solo envía, no le afecta) y los
// objetos de sesión al abrirlas/cerrarlas, que incluyen material de cifrado. Se silencia solo
// eso; los fallos de descifrado se cuentan para el diagnóstico.
const RUIDO_SIGNAL = /^(Failed to decrypt message|Session error:|Decrypted message with closed session|Closing (open |stale open )?session|Opening session:|Removing old closed session|Session already (closed|open)|Migrating session to|V1 session storage migration|Unhandled bucket type|WARNING: Expected pubkey)/;
let silenciado = false;
function silenciarRuidoSignal() {
  if (silenciado) return;
  silenciado = true;
  for (const k of ['log', 'info', 'warn', 'error']) {
    const original = console[k];
    console[k] = (...args) => {
      if (typeof args[0] === 'string' && RUIDO_SIGNAL.test(args[0])) {
        if (args[0].startsWith('Failed to decrypt')) estadoDiag.entrantesNoDescifrados++;
        return;
      }
      original.apply(console, args);
    };
  }
}

let libreria = null;
const cargar = async () => {
  silenciarRuidoSignal();
  return (libreria ||= await import(pathToFileURL(BUNDLE).href));
};

// Vinculada = hay credenciales con la cuenta ('me'); solo un QR a medias no cuenta.
function sesionGuardada() {
  try { return !!JSON.parse(fs.readFileSync(path.join(AUTH_DIR, 'creds.json'), 'utf8')).me; } catch (_) { return false; }
}
const borrarSesion = () => fs.rmSync(AUTH_DIR, { recursive: true, force: true });

const prepararArranque = async () => 0; // sin navegador: nada que limpiar

async function diagnostico() {
  let bundle = null;
  try { bundle = fs.readFileSync(BUNDLE, 'utf8').slice(0, 120).match(/Baileys [\d.]+/)[0]; } catch (_) { /* sin bundle */ }
  return { sesionVinculada: sesionGuardada(), baileys: bundle, ...estadoDiag };
}

// Logger que pide Baileys (interfaz de pino), en silencio: los motivos que importan
// llegan por connection.update y se registran aquí.
const silencio = { level: 'silent', trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child() { return silencio; } };

// libreria: solo para las pruebas (sustituye al bundle)
function crear({ log, libreria = null, esperaIdMs = 20000 }) {
  const motor = new EventEmitter();
  let sock = null;
  let descartado = false;
  let listo = false;
  let intentos = 0;
  let temporizador = null;

  async function conectar() {
    const { makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, Browsers, DisconnectReason } = libreria || await cargar();
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    // version actual de WhatsApp Web; si no se puede consultar, la que trae Baileys
    let version;
    try { version = (await Promise.race([fetchLatestBaileysVersion(), pausa(5000)]))?.version; } catch (_) { /* por defecto */ }
    if (descartado) return;

    sock = makeWASocket({
      auth: state,
      logger: silencio,
      browser: Browsers.windows('Chrome'),
      ...(version ? { version } : {}),
      markOnlineOnConnect: false, // que el móvil siga recibiendo notificaciones
      syncFullHistory: false,
      shouldSyncHistoryMessage: () => false, // no bajar el historial de chats: no lo necesitamos
      getMessage: async () => undefined
    });
    const s = sock;
    s.ev.on('creds.update', saveCreds);
    s.ev.on('connection.update', (u) => {
      if (descartado || s !== sock) return;
      if (u.qr) motor.emit('qr', u.qr);
      if (u.connection === 'open') {
        intentos = 0;
        if (!listo) { listo = true; motor.emit('autenticado'); motor.emit('listo'); }
        return;
      }
      if (u.connection !== 'close') return;

      const codigo = u.lastDisconnect?.error?.output?.statusCode;
      const texto = u.lastDisconnect?.error?.message || 'sin detalle';
      estadoDiag.ultimoCierre = `${codigo ?? '?'} ${texto}`.slice(0, 120);
      if (codigo === DisconnectReason.loggedOut) {
        // desvinculado desde el móvil: las credenciales ya no sirven, el próximo intento pide QR
        borrarSesion();
        listo = false;
        return motor.emit('desconectado', 'Sesión cerrada desde el teléfono');
      }
      if (codigo === DisconnectReason.connectionReplaced) {
        listo = false;
        return motor.emit('desconectado', 'Sesión abierta en otro sitio (¿la aplicación está abierta dos veces?)');
      }
      // 515 tras escanear el QR es normal (hay que reconectar); el resto, cortes de red: se reintenta
      if (codigo !== DisconnectReason.restartRequired) {
        if (++intentos > REINTENTOS_MAX) {
          listo = false;
          return motor.emit('desconectado', `Sin conexión con WhatsApp tras ${REINTENTOS_MAX} reintentos (${estadoDiag.ultimoCierre})`);
        }
        estadoDiag.reconexiones++;
        log('aviso', `Conexión con WhatsApp cortada (${estadoDiag.ultimoCierre}); reintento ${intentos}/${REINTENTOS_MAX}...`);
      }
      const espera = codigo === DisconnectReason.restartRequired ? 0 : Math.min(2000 * 2 ** (intentos - 1), 30000);
      temporizador = setTimeout(() => conectar().catch((e) => log('error', 'No se pudo reconectar: ' + e.message, true)), espera);
    });
  }

  motor.iniciar = () => conectar();

  // Un numero sin WhatsApp NO lanza (exists:false); si lanza o tarda, WhatsApp no responde.
  motor.idDe = async (numero) => {
    let r;
    try {
      [r] = await conLimite(sock.onWhatsApp(numero + '@s.whatsapp.net'), esperaIdMs);
    } catch (_) {
      throw sinRespuesta();
    }
    return r && r.exists ? r.jid : null;
  };
  motor.enviar = (id, texto) => sock.sendMessage(id, { text: texto });

  // Vincular sin cámara: el número del móvil, con prefijo de país, solo dígitos.
  motor.pedirCodigo = async (numero) => {
    if (!sock) throw new Error('Pulsa antes «Conectar WhatsApp»');
    if (sesionGuardada()) throw new Error('Ya hay una sesión vinculada');
    return sock.requestPairingCode(String(numero).replace(/\D/g, ''));
  };

  // sin listeners ni reconexiones: los cierres que vengan después ya no son nuestros
  function soltar() {
    descartado = true;
    clearTimeout(temporizador);
    motor.removeAllListeners();
    try { sock?.ev.removeAllListeners(); } catch (_) { /* ya cerrado */ }
  }

  motor.descartar = () => {
    soltar();
    try { sock?.end(undefined); } catch (_) { /* ya cerrado */ }
  };

  // se suelta ANTES del logout: el cierre que provoca no es una desconexión inesperada
  motor.cerrarSesion = async () => {
    soltar();
    try { await sock?.logout(); } catch (_) { /* sin sesión vinculada */ }
    try { sock?.end(undefined); } catch (_) { /* ya cerrado */ }
    borrarSesion();
  };

  motor.apagar = async () => motor.descartar();

  return motor;
}

module.exports = { nombre: 'baileys', sesionGuardada, prepararArranque, diagnostico, crear, silenciarRuidoSignal };
