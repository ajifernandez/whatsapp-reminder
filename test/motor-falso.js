// Motor de WhatsApp falso para las pruebas del servidor. Se precarga con
// `node -r ./test/motor-falso.js server.js` y sustituye a cualquier motor real.
// Se controla con ficheros en FALSO_DIR:
//   ping_falla  <- si existe, motor.ping() falla (WhatsApp sin responder)
//   orden.txt   <- escribir 'desconectar' o 'fallo_auth' para que el motor lo emita
//   enviados.log -> una linea JSON por mensaje enviado
// Numeros terminados en 000: "sin WhatsApp" (idDe -> null); en 888: WhatsApp no responde (idDe lanza).
const Module = require('module');
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');

const DIR = process.env.FALSO_DIR;
const ORDEN = path.join(DIR, 'orden.txt');
const ENVIADOS = path.join(DIR, 'enviados.log');

const falso = {
  nombre: 'falso',
  sesionGuardada: () => process.env.FALSO_SESION === '1',
  prepararArranque: async () => 0,
  diagnostico: async () => ({ sesionVinculada: falso.sesionGuardada(), chromiumRuta: null }),
  crear() {
    const m = new EventEmitter();
    let vigilancia = null;
    m.iniciar = async () => {
      setTimeout(() => { m.emit('autenticado'); m.emit('listo'); }, 50);
      vigilancia = setInterval(() => {
        let orden = '';
        try { orden = fs.readFileSync(ORDEN, 'utf8').trim(); } catch (_) { return; }
        fs.rmSync(ORDEN, { force: true });
        if (orden === 'desconectar') m.emit('desconectado', 'PRUEBA');
        if (orden === 'fallo_auth') m.emit('fallo_auth', 'PRUEBA');
      }, 50);
    };
    m.idDe = async (n) => {
      if (n.endsWith('888')) throw Object.assign(new Error('WhatsApp no responde'), { sinRespuesta: true });
      return n.endsWith('000') ? null : n + '@s.whatsapp.net';
    };
    m.ping = async () => {
      if (fs.existsSync(path.join(DIR, 'ping_falla'))) throw Object.assign(new Error('WhatsApp no responde'), { sinRespuesta: true });
    };
    m.enviar = async (id, texto) => fs.appendFileSync(ENVIADOS, JSON.stringify({ id, texto }) + '\n');
    m.cerrarSesion = async () => fs.appendFileSync(ENVIADOS, JSON.stringify({ cerrarSesion: true }) + '\n');
    m.descartar = () => { clearInterval(vigilancia); m.removeAllListeners(); };
    // FALSO_APAGAR_MS: tarda en cerrarse, como Chromium con whatsapp-web.js
    m.apagar = async () => { await new Promise((r) => setTimeout(r, Number(process.env.FALSO_APAGAR_MS) || 0)); m.descartar(); };
    return m;
  }
};

const cargar = Module._load;
Module._load = function (peticion, padre, ...resto) {
  if (/[\\/]motores[\\/]/.test(peticion) || peticion.startsWith('./motores/')) return falso;
  return cargar.call(this, peticion, padre, ...resto);
};
