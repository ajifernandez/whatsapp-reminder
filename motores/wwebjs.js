// Motor whatsapp-web.js: maneja un Chromium oculto con web.whatsapp.com.
//
// Interfaz comun de los motores (ver tambien motores/baileys.js):
//   modulo:   nombre, sesionGuardada(), prepararArranque(log) -> n huerfanos cerrados,
//             diagnostico() -> campos propios del motor para el informe
//   instancia (crear(opts)) es un EventEmitter:
//     eventos: 'qr' (texto), 'autenticado', 'listo', 'fallo_auth' (msg), 'desconectado' (motivo)
//     metodos: iniciar() -> rechaza si falla; idDe(numero) -> id | null; enviar(id, texto);
//              cerrarSesion(); descartar() (sin listeners y con el navegador muerto); apagar()
//   opts: { log(tipo, texto, ui), timeoutMs }
const EventEmitter = require('events');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

const DIR_APP = path.join(__dirname, '..');
const AUTH_PATH = path.join(DIR_APP, '.wwebjs_auth');
const CACHE_PATH = path.join(DIR_APP, '.wwebjs_cache');
const PERFIL_DIR = path.join(path.resolve(AUTH_PATH), 'session');

const pausa = (ms) => new Promise((resolver) => setTimeout(resolver, ms));
const ejecutar = (cmd, args) => new Promise((resolve) => {
  execFile(cmd, args, { timeout: 15000, windowsHide: true }, (_err, stdout) => resolve(String(stdout || '')));
});

const sesionGuardada = () => fs.existsSync(PERFIL_DIR);

// Borra cache de version web de WhatsApp. En Windows (sobre todo version
// portable) una escritura interrumpida deja este cache corrupto y el cliente
// se queda colgado al iniciar sin emitir 'qr' ni 'ready'. Limpiar antes de
// arrancar evita tener que borrar la carpeta a mano.
function limpiarCacheWeb(log) {
  try {
    if (fs.existsSync(CACHE_PATH)) fs.rmSync(CACHE_PATH, { recursive: true, force: true });
  } catch (err) {
    log('error', 'No se pudo limpiar cache: ' + err.message, true);
  }
}

// Tras apagar el PC / kill -9, Chromium deja SingletonLock/Cookie/Socket en el
// perfil y el siguiente arranque se cuelga creyendo que otra instancia lo usa.
// Aquí solo corre un Chromium (el nuestro, aún sin crear), así que son seguros de borrar.
const locksAlArrancar = [];
function limpiarLocksChromium(log) {
  for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'DevToolsActivePort']) {
    try {
      const ruta = path.join(PERFIL_DIR, f);
      if (fs.existsSync(ruta) || fs.lstatSync(ruta, { throwIfNoEntry: false })) {
        log('aviso', `Lock huérfano de Chromium eliminado: ${f}`);
        locksAlArrancar.push(f);
      }
      fs.rmSync(ruta, { force: true });
    } catch (_) { /* ignorar */ }
  }
}

// Chromium de NUESTRO perfil que sigue vivo (p. ej. tras un timeout cuyo destroy() no
// lo mato): mantiene el perfil bloqueado y el siguiente intento se cuelga. Solo se
// tocan procesos de navegador cuya linea de comandos lleva nuestra ruta de perfil,
// nunca el Chrome del usuario. Devuelve cuantos hay (y los termina si matar=true).
async function chromiumDelPerfil(matar) {
  try {
    if (process.platform === 'win32') {
      const ruta = PERFIL_DIR.replace(/'/g, "''");
      const ps = "$p=@(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.Name -match '^(chrome|chromium|msedge|chrome-headless-shell)\\.exe$' -and $_.CommandLine -and $_.CommandLine.Contains('" + ruta + "') });"
        + (matar ? '$p | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue };' : '') + '$p.Count';
      return parseInt((await ejecutar('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps])).trim(), 10) || 0;
    }
    const patron = '--user-data-dir=' + PERFIL_DIR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const n = (await ejecutar('pgrep', ['-f', '--', patron])).split('\n').filter(Boolean).length;
    if (matar && n) await ejecutar('pkill', ['-9', '-f', '--', patron]);
    return n;
  } catch (_) { return 0; }
}

// Antes de crear un cliente: Chromium huerfano, cache y locks.
async function prepararArranque(log) {
  const huerfanos = await chromiumDelPerfil(true);
  limpiarCacheWeb(log);
  limpiarLocksChromium(log);
  return huerfanos;
}

async function diagnostico() {
  const version = (modulo) => { try { return JSON.parse(fs.readFileSync(path.join(DIR_APP, 'node_modules', modulo, 'package.json'), 'utf8')).version; } catch (_) { return null; } };
  let chromiumRuta = null; try { chromiumRuta = require('puppeteer').executablePath(); } catch (_) { /* sin puppeteer */ }
  return {
    sesionVinculada: sesionGuardada(),
    locksChromium: ['SingletonLock', 'SingletonCookie', 'SingletonSocket'].filter((f) => fs.lstatSync(path.join(PERFIL_DIR, f), { throwIfNoEntry: false })),
    lockYaExistiaAlArrancar: locksAlArrancar,
    procesosChromiumPerfil: await chromiumDelPerfil(false),
    whatsappWebJs: version('whatsapp-web.js'), puppeteer: version('puppeteer'), chromiumRuta
  };
}

function crear({ log, timeoutMs }) {
  // require diferido: con el motor Baileys no hace falta cargar puppeteer
  const { Client, LocalAuth } = require('whatsapp-web.js');
  const motor = new EventEmitter();
  let listo = false;
  let descartado = false;
  const c = new Client({
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

  c.on('qr', (qr) => motor.emit('qr', qr));
  c.on('loading_screen', (pct, msg) => log('info', `Cargando WhatsApp Web: ${pct}% ${msg || ''}`));
  c.on('authenticated', () => motor.emit('autenticado'));
  c.on('ready', () => { listo = true; motor.emit('listo'); });
  c.on('auth_failure', (msg) => motor.emit('fallo_auth', msg));
  c.on('disconnected', (reason) => motor.emit('desconectado', reason));

  // Registra en que fase se atasca una conexion lenta: Chromium lanzado, pagina creada,
  // peticiones fallidas y, a los 45 s, las que siguen pendientes (el cuelgue de la clinica
  // esta en la carga de web.whatsapp.com, que espera a TODOS sus recursos). Solo hosts y
  // estados, nunca contenido de la pagina: podria haber chats.
  async function vigilarConexion() {
    const t0 = Date.now();
    const seg = () => Math.round((Date.now() - t0) / 1000);
    const nota = (texto) => log('info', `[conexión +${seg()}s] ${texto}`);
    const host = (u) => { try { const x = new URL(u); return x.host || x.protocol; } catch (_) { return '?'; } };
    const pendientes = new Map();
    let navegador = false, pagina = null, informado = false, notas = 0;
    const limitada = (texto) => { if (notas++ < 25) nota(texto); };
    while (!descartado && !listo && seg() < timeoutMs / 1000) {
      if (!navegador && c.pupBrowser) { navegador = true; nota('Chromium lanzado'); }
      if (!pagina && c.pupPage) {
        pagina = c.pupPage;
        nota('Página creada');
        pagina.on('request', (r) => pendientes.set(r, `${host(r.url())} (${r.resourceType()})`));
        pagina.on('requestfinished', (r) => pendientes.delete(r));
        pagina.on('requestfailed', (r) => { pendientes.delete(r); limitada(`Petición fallida: ${(r.failure() && r.failure().errorText) || '?'} ${host(r.url())}`); });
        pagina.on('pageerror', (e) => limitada('Error en la página: ' + String(e.message).slice(0, 120)));
      }
      if (!informado && seg() >= 45) {
        informado = true;
        const hosts = [...new Set(pendientes.values())].slice(0, 8).join(', ');
        nota(`Sin conectar: ${pendientes.size} peticiones pendientes${hosts ? ': ' + hosts : ''}; navegador=${navegador}, página=${!!pagina}${pagina ? ', url=' + host(pagina.url()) : ''}`);
        if (pagina) {
          try {
            const estado = await Promise.race([pagina.evaluate(() => document.readyState), pausa(3000)]);
            nota('Estado de la página: ' + (estado || 'sin respuesta en 3 s'));
          } catch (e) { nota('Estado de la página: error ' + String(e.message).slice(0, 80)); }
        }
      }
      await pausa(100);
    }
  }

  // initialize() resuelve ANTES de 'ready' y a veces no resuelve nunca (por eso el
  // servidor pone su propio timeout): el exito se avisa con el evento 'listo'.
  motor.iniciar = () => {
    vigilarConexion().catch(() => {});
    return c.initialize();
  };

  // getNumberId devuelve null si el número no tiene WhatsApp, pero con números
  // malformados lanza una excepción interna sin mensaje útil: tratamos ambos igual
  motor.idDe = async (numero) => {
    try {
      const id = await c.getNumberId(numero);
      return id ? id._serialized : null;
    } catch (_) { return null; }
  };
  motor.enviar = (id, texto) => c.sendMessage(id, texto);

  motor.cerrarSesion = async () => {
    try { await c.logout(); } catch (_) { /* ignorar */ }
    try { await c.destroy(); } catch (_) { /* ignorar */ }
  };

  // Termina el cliente sin dejar su Chromium vivo ni sus listeners activos
  // (un 'ready' tardio de un cliente viejo marcaria como conectado a uno que ya no usamos).
  motor.descartar = () => {
    descartado = true;
    motor.removeAllListeners();
    c.removeAllListeners();
    try {
      const proc = c.pupBrowser && c.pupBrowser.process();
      if (proc && proc.pid) {
        if (process.platform === 'win32') execFile('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true }, () => {});
        else process.kill(proc.pid, 'SIGKILL');
      }
    } catch (_) { /* ya estaba muerto */ }
    c.destroy().catch(() => {});
  };

  // Cierre de la app: destroy() puede colgarse, y si lo hace se mata el navegador igualmente
  motor.apagar = async () => {
    await Promise.race([c.destroy().catch(() => {}), pausa(5000)]);
    motor.descartar();
  };

  return motor;
}

module.exports = { nombre: 'wwebjs', sesionGuardada, prepararArranque, diagnostico, crear };
