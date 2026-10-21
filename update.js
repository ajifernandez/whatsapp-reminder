// Auto-actualizador desde GitHub (repo publico).
//
// Descarga la ultima version de los ficheros de codigo y los reemplaza.
// Se ejecuta ANTES de server.js (desde Iniciar.bat) para que el propio
// server.js pueda actualizarse: un proceso no puede reescribir de forma fiable
// el fichero que esta ejecutando, por eso el updater es un script aparte y
// corto que termina antes de arrancar el servidor.
//
// Seguridad ante cortes de red: primero baja TODO a memoria y solo si baja
// entero se escribe a disco. Asi un corte a mitad no deja ficheros corruptos.
//
// Uso directo:  node update.js            -> comprueba y aplica (solo dentro de la misma version mayor)
//               node update.js 2.1.9      -> downgrade: instala esa version y desactiva el auto-update
//               node update.js latest     -> quita la fijacion y actualiza, aunque sea a otra version mayor
//               node update.js canal v3   -> esta clinica sigue la rama v3 (beta); 'canal main' vuelve a estable
// Como modulo:  require('./update.js')    -> buscarActualizacion / aplicarActualizacion

const fs = require('fs');
const path = require('path');
const https = require('https');

const REPO = 'ajifernandez/whatsapp-reminder';
const RAMA = 'main';
const rawBase = (ref) => `https://raw.githubusercontent.com/${REPO}/${ref}`;
// Si existe, el auto-update queda desactivado y la app se queda en esa version
// (downgrade). 'node update.js latest' lo borra.
const FIJA = path.join(__dirname, 'data', 'version-fija.txt');
// Rama que sigue esta clinica (beta). Sin fichero: main (estable).
const CANAL = path.join(__dirname, 'data', 'canal.txt');
const RAMA_VALIDA = /^[\w.-]+$/;

function canal() {
  try {
    const r = fs.readFileSync(CANAL, 'utf8').trim();
    return RAMA_VALIDA.test(r) ? r : RAMA;
  } catch {
    return RAMA;
  }
}

function fijarCanal(rama) {
  if (!RAMA_VALIDA.test(rama)) throw new Error('Rama invalida: ' + rama);
  if (rama === RAMA) return fs.rmSync(CANAL, { force: true });
  fs.mkdirSync(path.dirname(CANAL), { recursive: true });
  fs.writeFileSync(CANAL, rama);
}

// Lista minima de ficheros, para versiones (tags antiguos) cuyo package.json no
// trae 'archivosActualizables'. La lista real viene del remoto: si la tomaramos
// de aqui, una version nueva que anade ficheros bajaria un server.js que los
// necesita sin bajarlos. NO incluir node_modules/, chrome/, bin/, data/ ni
// .wwebjs_* (binarios pesados, datos locales o sesion).
const ARCHIVOS = [
  'server.js',
  'update.js',
  'package.json',
  'README.md',
  'MANUAL_USUARIO.md',
  'renderer/index.html',
  'renderer/renderer.js',
  'renderer/parser.js',
  'renderer/styles.css'
];

// Descarga una URL a string (sigue redirecciones del CDN de GitHub).
function descargar(url, saltos = 0) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'whatsapp-reminder-updater' } }, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        if (saltos >= 3) return reject(new Error('Demasiadas redirecciones'));
        return resolve(descargar(res.headers.location, saltos + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('HTTP ' + res.statusCode + ' en ' + url));
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve(data));
    });
    req.setTimeout(15000, () => req.destroy(new Error('Timeout de descarga')));
    req.on('error', reject);
  });
}

function versionLocal() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

// Version del codigo que esta corriendo (se lee al cargar este modulo). Tras descargar una version
// nueva el disco ya dice otra cosa hasta que se reinicia: por eso se muestra esta, no versionLocal().
const VERSION_EN_EJECUCION = versionLocal();
function versionEnEjecucion() { return VERSION_EN_EJECUCION; }

// Al arrancar: si hay una version nueva permitida, la descarga. Devuelve true si la ha instalado
// (el arranque se relanza entonces con el codigo nuevo).
async function instalarSiHayNueva() {
  const b = await buscarActualizacion();
  if (!b.hayActualizacion || b.fijada || b.nuevaMayor) return false;
  await aplicarActualizacion();
  return true;
}

const mayorDe = (v) => parseInt(String(v).split('.')[0], 10) || 0;

// Compara semver simple (a > b). Evita "actualizar" a una version igual o menor.
function esMayor(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return false;
}

// En el canal estable, el salto de version mayor (2.x -> 3.0) nunca es automatico:
// se informa en 'nuevaMayor' y hay que pedirlo ('latest' o el selector de version).
// En un canal beta, elegir el canal ya es el consentimiento.
async function buscarActualizacion({ ignorarFreno = false } = {}) {
  const local = versionLocal();
  if (fs.existsSync(FIJA)) return { local, remota: local, hayActualizacion: false, fijada: true };
  const rama = canal();
  const remotaPkg = JSON.parse(await descargar(rawBase(rama) + '/package.json'));
  const remota = remotaPkg.version || '0.0.0';
  const hay = esMayor(remota, local);
  if (hay && !ignorarFreno && rama === RAMA && mayorDe(remota) > mayorDe(local)) {
    return { local, remota, hayActualizacion: false, nuevaMayor: remota, canal: rama };
  }
  return { local, remota, hayActualizacion: hay, canal: rama };
}

// Ruta relativa segura dentro de la carpeta de la app.
const RUTA_VALIDA = (rel) => typeof rel === 'string' && /^[\w][\w./-]*$/.test(rel) && !rel.split('/').includes('..');

async function archivosDe(ref) {
  try {
    const lista = JSON.parse(await descargar(rawBase(ref) + '/package.json')).archivosActualizables;
    if (Array.isArray(lista) && lista.length && lista.every(RUTA_VALIDA)) return lista;
  } catch { /* sin lista remota: la minima */ }
  return ARCHIVOS;
}

// Baja todos los ficheros a memoria y, si van todos, los escribe. Devuelve
// la lista de ficheros actualizados.
async function aplicarActualizacion(ref = canal()) {
  const archivos = await archivosDe(ref);
  const contenidos = {};
  for (const rel of archivos) {
    contenidos[rel] = await descargar(rawBase(ref) + '/' + rel);
  }
  const escritos = [];
  for (const rel of archivos) {
    const destino = path.join(__dirname, rel);
    fs.mkdirSync(path.dirname(destino), { recursive: true });
    fs.writeFileSync(destino, contenidos[rel]);
    escritos.push(rel);
  }
  return escritos;
}

// Ficheros de la lista LOCAL que faltan: pasa cuando una version nueva la instala un
// updater antiguo (<= 2.1.16), que solo bajaba su propia lista fija. Se descargan del tag
// de la version instalada. Devuelve los reparados (vacio si no faltaba nada).
async function repararFaltantes() {
  let lista = ARCHIVOS;
  try {
    const l = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).archivosActualizables;
    if (Array.isArray(l) && l.length && l.every(RUTA_VALIDA)) lista = l;
  } catch { /* sin package.json legible: la lista minima */ }
  const faltan = lista.filter((rel) => !fs.existsSync(path.join(__dirname, rel)));
  if (!faltan.length) return [];
  const ref = 'v' + versionLocal();
  const contenidos = {};
  for (const rel of faltan) contenidos[rel] = await descargar(rawBase(ref) + '/' + rel);
  for (const rel of faltan) {
    const destino = path.join(__dirname, rel);
    fs.mkdirSync(path.dirname(destino), { recursive: true });
    fs.writeFileSync(destino, contenidos[rel]);
  }
  return faltan;
}

const SEMVER = /^\d+\.\d+\.\d+$/;

// Downgrade/pin: instala el tag vX.Y.Z y desactiva el auto-update.
async function fijarVersion(version) {
  if (!SEMVER.test(version)) throw new Error('Version invalida: ' + version);
  const escritos = await aplicarActualizacion('v' + version);
  fs.mkdirSync(path.dirname(FIJA), { recursive: true });
  fs.writeFileSync(FIJA, version);
  return escritos;
}

const quitarFijacion = () => fs.rmSync(FIJA, { force: true });
const versionFijada = () => (fs.existsSync(FIJA) ? fs.readFileSync(FIJA, 'utf8').trim() : null);

// Versiones instalables (tags vX.Y.Z de GitHub), de mas nueva a mas antigua.
async function listarVersiones() {
  const tags = JSON.parse(await descargar(`https://api.github.com/repos/${REPO}/tags?per_page=100`));
  return tags.map((t) => t.name.replace(/^v/, '')).filter((v) => SEMVER.test(v))
    .sort((a, b) => (esMayor(a, b) ? -1 : 1));
}

module.exports = { buscarActualizacion, aplicarActualizacion, instalarSiHayNueva, repararFaltantes, versionLocal, versionEnEjecucion, fijarVersion, quitarFijacion, versionFijada, listarVersiones, canal, fijarCanal, ARCHIVOS };

// Ejecucion directa (desde Iniciar.bat). Nunca corta el arranque: si falla la
// red, avisa y sale con 0 para que el servidor arranque con la version actual.
if (require.main === module) {
  (async () => {
    try {
      const arg = process.argv[2];
      if (arg === 'canal') {
        fijarCanal(process.argv[3] || RAMA);
        console.log(`[update] Canal: ${canal()}${canal() === RAMA ? ' (estable)' : ' (beta)'}`);
        return;
      }
      if (arg && arg !== 'latest') {
        if (!SEMVER.test(arg)) return console.log('[update] Version invalida. Uso: node update.js 2.1.9 | latest');
        const escritos = await fijarVersion(arg);
        return console.log(`[update] Version fijada a ${arg} (auto-update desactivado). Ficheros: ${escritos.join(', ')}. Para volver: node update.js latest`);
      }
      if (arg === 'latest') quitarFijacion();
      const { local, remota, hayActualizacion, fijada, nuevaMayor } = await buscarActualizacion({ ignorarFreno: arg === 'latest' });
      if (fijada) return console.log(`[update] Version fijada en ${local}: no se actualiza. Para volver: node update.js latest`);
      if (nuevaMayor) return console.log(`[update] Hay una version mayor nueva (${nuevaMayor}); no se instala sola. Para instalarla: node update.js latest`);
      if (!hayActualizacion) {
        console.log(`[update] Ya estas en la ultima version (${local}).`);
        return;
      }
      console.log(`[update] Nueva version ${remota} (tienes ${local}). Descargando...`);
      const escritos = await aplicarActualizacion();
      console.log(`[update] Actualizado a ${remota}. Ficheros: ${escritos.join(', ')}`);
    } catch (err) {
      console.log('[update] No se pudo actualizar (se sigue con la version actual): ' + err.message);
    }
  })();
}
