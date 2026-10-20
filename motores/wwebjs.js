// Motor whatsapp-web.js: maneja un Chromium oculto con web.whatsapp.com.
//
// Interfaz comun de los motores (ver tambien motores/baileys.js):
//   modulo:   nombre, sesionGuardada(), prepararArranque(log) -> n huerfanos cerrados,
//             diagnostico() -> campos propios del motor para el informe
//   instancia (crear(opts)) es un EventEmitter:
//     eventos: 'qr' (texto), 'autenticado', 'listo', 'fallo_auth' (msg), 'desconectado' (motivo)
//     metodos: iniciar() -> rechaza si falla; idDe(numero) -> id | null; enviar(id, texto);
//              cerrarSesion(); descartar() (sin listeners y con el navegador muerto); apagar()
//     idDe lanza sinRespuesta() (ver comun.js) si WhatsApp no contesta; null solo si el numero no tiene WhatsApp
//     ping() resuelve si la conexion responde; si no, lanza (sinRespuesta() o un Error con .motivo)
//   opts: { log(tipo, texto, ui), timeoutMs, esperaIdMs, esperaPingMs }
const EventEmitter = require('events');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { sinRespuesta, conLimite } = require('./comun');

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

// «Foto» de la pagina de WhatsApp Web para saber POR QUE no arranca o deja de responder. Solo datos
// tecnicos: el texto de la pagina se usa para comprobar pantallas conocidas y nunca sale de aqui (podria
// haber chats). Si la pagina no responde en 6 s, eso mismo es el dato (hilo bloqueado o estrangulado).
const esWhatsAppWeb = (p) => { try { return new URL(p.url()).host === 'web.whatsapp.com'; } catch (_) { return false; } };

async function sondaPagina(pagina, navegador = null) {
  if (!pagina) return { pagina: false };
  // pestanas del navegador interno: con dos de WhatsApp Web sale «abierto en otra ventana»
  let pestanas = null;
  if (navegador) {
    const ps = await Promise.race([navegador.pages(), pausa(3000).then(() => null)]).catch(() => null);
    if (ps) pestanas = { total: ps.length, whatsapp: ps.filter(esWhatsAppWeb).length };
  }
  const foto = await Promise.race([
    pagina.evaluate(async () => {
      const t0 = performance.now();
      await new Promise((r) => setTimeout(r, 500));
      const texto = ((document.body && document.body.innerText) || '').toLowerCase();
      const v = window.Debug && window.Debug.VERSION;
      return {
        readyState: document.readyState,
        visibilidad: document.visibilityState,
        titulo: document.title.replace(/\(\d+\)\s*/g, '').slice(0, 40), // sin el contador de no leidos
        appWhatsApp: typeof window.Debug !== 'undefined',
        versionWeb: v ? String(v).split('.').slice(0, 2).join('.') : null,
        qr: !!document.querySelector('canvas'),
        pantallas: {
          usarAqui: /usar aquí|use here/.test(texto),
          actualizar: /actualiza|update (google )?chrome|navegador no (es )?compatible|browser (is )?not supported/.test(texto),
          cargando: /cargando|loading/.test(texto),
          conectando: /conectando|connecting/.test(texto),
          error: /algo salió mal|something went wrong|vuelve a cargar|reload/.test(texto)
        },
        online: navigator.onLine,
        // un temporizador de 500 ms que tarda mucho mas = la pagina esta estrangulada o bloqueada
        temporizador500ms: Math.round(performance.now() - t0)
      };
    }),
    pausa(6000).then(() => ({ sinRespuesta6s: true }))
  ]).catch((e) => ({ error: String(e.message).slice(0, 80) }));
  return pestanas ? { ...foto, pestanas } : foto;
}

// «WhatsApp está abierto en otra ventana · Usar aquí»: la MISMA sesion esta abierta en otro sitio (casi
// siempre otra copia de la aplicacion). whatsapp-web.js solo toma el control (takeoverOnConflict) cuando ya
// esta conectado; esta pantalla sale ANTES, y la conexion se queda esperando a que alguien pulse el boton.
// Devuelve true si lo ha pulsado.
async function pulsarUsarAqui(pagina) {
  if (!pagina) return false;
  return Promise.race([
    pagina.evaluate(() => {
      const boton = [...document.querySelectorAll('button, [role="button"]')]
        .find((e) => /^(usar aquí|use here)$/i.test((e.innerText || e.textContent || '').trim()));
      if (!boton) return false;
      boton.click();
      return true;
    }),
    pausa(3000).then(() => false)
  ]).catch(() => false);
}

// Otras pestañas de WhatsApp Web en el navegador interno que no son la nuestra (p. ej. restauradas por
// Chromium tras un cierre brusco): con dos, una muestra «abierto en otra ventana» y la conexion se queda
// esperando. Se cierran. Devuelve cuantas.
async function cerrarPestanasDuplicadas(navegador, propia) {
  if (!navegador) return 0;
  const ps = await Promise.race([navegador.pages(), pausa(3000).then(() => [])]).catch(() => []);
  let cerradas = 0;
  for (const p of ps) {
    if (p === propia || !esWhatsAppWeb(p)) continue;
    await p.close().catch(() => {});
    cerradas++;
  }
  return cerradas;
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

// Errores del navegador (pagina colgada, cerrada...): no son "numero sin WhatsApp"
const ERROR_NAVEGADOR = /timed out|Target closed|Session closed|Protocol error|context was destroyed|detached|disconnected/i;

function crear({ log, timeoutMs, esperaIdMs = 30000, esperaPingMs = 15000 }) {
  // require diferido: con el motor Baileys no hace falta cargar puppeteer
  const { Client, LocalAuth } = require('whatsapp-web.js');
  const motor = new EventEmitter();
  let listo = false;
  let descartado = false;
  const c = new Client({
    authStrategy: new LocalAuth({ dataPath: path.resolve(AUTH_PATH) }),
    // «WhatsApp está abierto en otra ventana · Usar aquí»: tomar el control en vez de quedarse esperando
    takeoverOnConflict: true,
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
    const alPedir = (r) => pendientes.set(r, `${host(r.url())} (${r.resourceType()})`);
    const alTerminar = (r) => pendientes.delete(r);
    // ERR_ABORTED = la propia pagina cancela una peticion (miniaturas, etc.): normal, no es un fallo
    const alFallar = (r) => { pendientes.delete(r); const e = (r.failure() && r.failure().errorText) || '?'; if (e !== 'net::ERR_ABORTED') limitada(`Petición fallida: ${e} ${host(r.url())}`); };
    const alErrorPagina = (e) => limitada('Error en la página: ' + String(e.message).slice(0, 120));
    let tomas = 0, siguienteToma = 0;
    try {
    while (!descartado && !listo && seg() < timeoutMs / 1000) {
      if (!navegador && c.pupBrowser) { navegador = true; nota('Chromium lanzado'); }
      if (!pagina && c.pupPage) {
        pagina = c.pupPage;
        nota('Página creada');
        pagina.on('request', alPedir);
        pagina.on('requestfinished', alTerminar);
        pagina.on('requestfailed', alFallar);
        pagina.on('pageerror', alErrorPagina);
      }
      if (pagina && tomas < 3 && Date.now() >= siguienteToma) {
        siguienteToma = Date.now() + 3000;
        const duplicadas = await cerrarPestanasDuplicadas(c.pupBrowser, pagina);
        if (duplicadas) log('aviso', `Había ${duplicadas} pestaña(s) más de WhatsApp Web abiertas en el navegador interno (seguramente restauradas tras un cierre brusco): se han cerrado.`, true);
        if (await pulsarUsarAqui(pagina)) {
          tomas++;
          log('aviso', 'WhatsApp estaba abierto en otra ventana con esta misma sesión: la aplicación ha tomado el control («Usar aquí»). Si hay otra copia de la aplicación abierta (en otro ordenador o en otra carpeta), ciérrala: si no, se quitarán la sesión una a otra.', true);
        }
      }
      if (!informado && seg() >= 45) {
        informado = true;
        const hosts = [...new Set(pendientes.values())].slice(0, 8).join(', ');
        nota(`Sin conectar: ${pendientes.size} peticiones pendientes${hosts ? ': ' + hosts : ''}; navegador=${navegador}, página=${!!pagina}${pagina ? ', url=' + host(pagina.url()) : ''}`);
        if (pagina) nota('Foto de la página: ' + JSON.stringify(await sondaPagina(pagina, c.pupBrowser)));
      }
      await pausa(100);
    }
    } finally {
      // conectado (o descartado): dejar de observar; si no, se seguirian anotando peticiones
      // de la sesion normal durante horas
      if (pagina) {
        pagina.off('request', alPedir); pagina.off('requestfinished', alTerminar);
        pagina.off('requestfailed', alFallar); pagina.off('pageerror', alErrorPagina);
      }
    }
  }

  // initialize() resuelve ANTES de 'ready' y a veces no resuelve nunca (por eso el
  // servidor pone su propio timeout): el exito se avisa con el evento 'listo'.
  motor.iniciar = () => {
    vigilarConexion().catch(() => {});
    return c.initialize();
  };

  // getNumberId devuelve null si el número no tiene WhatsApp, pero con números
  // malformados lanza una excepción interna sin mensaje útil: tratamos ambos igual (null).
  // Si la pagina esta colgada (protocolTimeout de Puppeteer = 180 s por consulta) NO es un
  // numero invalido: se corta a los esperaIdMs y se avisa como sinRespuesta.
  motor.idDe = async (numero) => {
    let id;
    try {
      id = await conLimite(c.getNumberId(numero), esperaIdMs);
    } catch (e) {
      if (e.sinRespuesta || ERROR_NAVEGADOR.test(String(e && e.message))) throw sinRespuesta();
      return null;
    }
    return id ? id._serialized : null;
  };
  motor.enviar = (id, texto) => c.sendMessage(id, texto);

  // Salud: getState() se evalua DENTRO de la pagina, asi que si esta colgada (el fallo de la
  // clinica: 'conectado' con la pagina muerta) no contesta y vence.
  motor.sonda = () => sondaPagina(c.pupPage, c.pupBrowser);

  motor.ping = async () => {
    const estado = await conLimite(c.getState(), esperaPingMs);
    if (estado !== 'CONNECTED') {
      throw Object.assign(new Error('estado ' + estado), { motivo: estado ? `WhatsApp Web en estado ${estado}` : 'WhatsApp Web no ha cargado' });
    }
  };

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

module.exports = { nombre: 'wwebjs', sesionGuardada, prepararArranque, diagnostico, crear, sondaPagina, pulsarUsarAqui, cerrarPestanasDuplicadas };
