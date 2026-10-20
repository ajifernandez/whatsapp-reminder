// Pruebas de motores/baileys.js con una librería falsa (sin WhatsApp): eventos de
// conexión, reconexiones, sesión cerrada/reemplazada, cierre y comprobación de números.
// El motor se copia a una carpeta temporal para no tocar ninguna sesión real.
// Uso: npm test
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-baileys-'));
fs.mkdirSync(path.join(DIR, 'motores'));
fs.copyFileSync(path.join(__dirname, '..', 'motores', 'baileys.js'), path.join(DIR, 'motores', 'baileys.js'));
const Baileys = require(path.join(DIR, 'motores', 'baileys.js'));
const AUTH = path.join(DIR, '.baileys_auth');

const pausa = (ms) => new Promise((r) => setTimeout(r, ms));
const espera = () => pausa(20);
const cierre = (statusCode) => ({ connection: 'close', lastDisconnect: { error: { message: 'prueba', output: { statusCode } } } });

// Librería falsa: guarda los sockets creados para emitir eventos sobre el último.
function libreriaFalsa() {
  const sockets = [];
  return {
    sockets,
    DisconnectReason: { loggedOut: 401, connectionReplaced: 440, restartRequired: 515 },
    Browsers: { windows: () => ['Windows', 'Chrome', '10'] },
    fetchLatestBaileysVersion: async () => ({ version: [2, 3000, 1] }),
    useMultiFileAuthState: async () => ({ state: {}, saveCreds() {} }),
    makeWASocket() {
      const s = { ev: new EventEmitter(), terminado: false, logoutLlamado: false, enviados: [] };
      s.end = () => { s.terminado = true; };
      s.logout = async () => { s.logoutLlamado = true; s.ev.emit('connection.update', cierre(401)); };
      s.onWhatsApp = async (jid) => {
        if (jid.startsWith('999')) throw new Error('fallo');
        return [{ exists: !jid.startsWith('000'), jid }];
      };
      s.sendMessage = async (id, m) => s.enviados.push([id, m.text]);
      sockets.push(s);
      return s;
    }
  };
}

function nuevo() {
  const lib = libreriaFalsa();
  const logs = [];
  const m = Baileys.crear({ log: (t, x) => logs.push(x), libreria: lib });
  const ev = [];
  for (const e of ['qr', 'autenticado', 'listo', 'desconectado', 'fallo_auth']) m.on(e, (x) => ev.push(x === undefined ? e : `${e}:${x}`));
  const ultimo = () => lib.sockets[lib.sockets.length - 1];
  const emitir = (u) => ultimo().ev.emit('connection.update', u);
  return { m, lib, ev, logs, ultimo, emitir };
}

const ok = (n) => console.log('OK  ' + n);

(async () => {
  // 1. QR, apertura y 515 (reinicio normal tras escanear)
  let t = nuevo();
  await t.m.iniciar();
  t.emitir({ qr: 'QR-1' });
  assert.deepEqual(t.ev, ['qr:QR-1']);
  t.emitir(cierre(515)); await espera();
  assert.equal(t.lib.sockets.length, 2, 'tras 515 se crea un socket nuevo');
  assert.ok(!t.ev.some((e) => e.startsWith('desconectado')), '515 no es una desconexión');
  t.emitir({ connection: 'open' });
  assert.deepEqual(t.ev, ['qr:QR-1', 'autenticado', 'listo']);
  ok('QR, reinicio 515 sin avisar y apertura -> autenticado + listo');

  // 2. idDe y enviar
  assert.equal(await t.m.idDe('34612345678'), '34612345678@s.whatsapp.net');
  assert.equal(await t.m.idDe('000111'), null);
  assert.equal(await t.m.idDe('999111'), null);
  await t.m.enviar('34612345678@s.whatsapp.net', 'hola');
  assert.deepEqual(t.ultimo().enviados, [['34612345678@s.whatsapp.net', 'hola']]);
  ok('idDe: existe -> jid; sin WhatsApp o error -> null; enviar manda el texto');

  // 3. cortes de red: reintenta con espera y se rinde tras 5 (setTimeout acelerado)
  const reloj = global.setTimeout;
  global.setTimeout = (fn) => reloj(fn, 0);
  try {
    for (let i = 0; i < 5; i++) { t.emitir(cierre(428)); await espera(); }
    assert.equal(t.lib.sockets.length, 7, '5 reintentos');
    assert.ok(!t.ev.some((e) => e.startsWith('desconectado')));
    assert.equal(t.logs.filter((l) => l.includes('reintento')).length, 5);
    t.emitir(cierre(428)); await espera();
    assert.match(t.ev[t.ev.length - 1], /^desconectado:Sin conexión con WhatsApp tras 5 reintentos/);
  } finally { global.setTimeout = reloj; }
  ok('cortes de red: 5 reintentos registrados y después desconectado');

  // 4. sesión cerrada desde el móvil: borra credenciales y avisa
  t = nuevo();
  fs.mkdirSync(AUTH, { recursive: true });
  fs.writeFileSync(path.join(AUTH, 'creds.json'), JSON.stringify({ me: { id: '34600000000@s.whatsapp.net' } }));
  assert.equal(Baileys.sesionGuardada(), true);
  await t.m.iniciar();
  t.emitir({ connection: 'open' });
  t.emitir(cierre(401));
  assert.equal(t.ev[t.ev.length - 1], 'desconectado:Sesión cerrada desde el teléfono');
  assert.equal(fs.existsSync(AUTH), false, 'credenciales borradas');
  assert.equal(Baileys.sesionGuardada(), false);
  ok('401 (desvinculado en el móvil): borra la sesión y avisa');

  // 5. sesión reemplazada (440): avisa sin reintentar
  t = nuevo();
  await t.m.iniciar();
  t.emitir(cierre(440)); await espera();
  assert.match(t.ev[0], /^desconectado:Sesión abierta en otro sitio/);
  assert.equal(t.lib.sockets.length, 1);
  ok('440 (abierta en otro sitio): avisa y no reintenta');

  // 6. cerrar sesión: logout sin un "desconectado" falso
  t = nuevo();
  await t.m.iniciar();
  t.emitir({ connection: 'open' });
  const s = t.ultimo();
  await t.m.cerrarSesion();
  assert.ok(s.logoutLlamado && s.terminado);
  assert.deepEqual(t.ev, ['autenticado', 'listo']);
  ok('cerrar sesión: logout y cierre sin evento de desconexión');

  // 7. descartar: los eventos tardíos se ignoran y no reconecta
  t = nuevo();
  await t.m.iniciar();
  const s2 = t.ultimo();
  t.m.descartar();
  s2.ev.emit('connection.update', { connection: 'open' });
  s2.ev.emit('connection.update', cierre(428)); await espera();
  assert.deepEqual(t.ev, []);
  assert.equal(t.lib.sockets.length, 1);
  assert.ok(s2.terminado);
  ok('descartar: sin eventos tardíos ni reconexiones');

  // 8. el diagnóstico refleja reconexiones y último cierre
  const d = await Baileys.diagnostico();
  assert.ok(d.reconexiones >= 5); assert.match(d.ultimoCierre, /428|440|401/);
  ok('diagnóstico: reconexiones y último cierre');

  // 9. ruido de libsignal por consola: se silencia y se cuenta; lo demás pasa
  const salida = [];
  const original = console.error, originalInfo = console.info;
  console.error = (...a) => salida.push(a.join(' '));
  console.info = (...a) => salida.push(a.join(' '));
  try {
    Baileys.silenciarRuidoSignal();
    const antes = (await Baileys.diagnostico()).entrantesNoDescifrados;
    console.error('Failed to decrypt message with any known session...');
    console.error('Session error:Error: Bad MAC', 'stack');
    console.info('Opening session:', { claves: 'secreto' });
    console.error('Otro error que sí debe verse');
    assert.deepEqual(salida, ['Otro error que sí debe verse']);
    assert.equal((await Baileys.diagnostico()).entrantesNoDescifrados, antes + 1);
  } finally { console.error = original; console.info = originalInfo; }
  ok('ruido de libsignal (Bad MAC, sesiones con claves) silenciado y contado; el resto se ve');

  fs.rmSync(DIR, { recursive: true, force: true });
  console.log('\nTODAS LAS PRUEBAS DEL MOTOR BAILEYS PASAN');
})().catch((e) => { console.error('FALLO:', e); process.exit(1); });
