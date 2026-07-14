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
// Uso directo:  node update.js            -> comprueba y aplica
// Como modulo:  require('./update.js')    -> buscarActualizacion / aplicarActualizacion

const fs = require('fs');
const path = require('path');
const https = require('https');

const REPO = 'ajifernandez/whatsapp-reminder';
const RAMA = 'main';
const RAW_BASE = `https://raw.githubusercontent.com/${REPO}/${RAMA}`;

// Ficheros que se actualizan. NO incluir node_modules/, chrome/, bin/, data/
// ni .wwebjs_* (binarios pesados, datos locales o sesion).
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

async function buscarActualizacion() {
  const local = versionLocal();
  const remotaPkg = JSON.parse(await descargar(RAW_BASE + '/package.json'));
  const remota = remotaPkg.version || '0.0.0';
  return { local, remota, hayActualizacion: esMayor(remota, local) };
}

// Baja todos los ficheros a memoria y, si van todos, los escribe. Devuelve
// la lista de ficheros actualizados.
async function aplicarActualizacion() {
  const contenidos = {};
  for (const rel of ARCHIVOS) {
    contenidos[rel] = await descargar(RAW_BASE + '/' + rel);
  }
  const escritos = [];
  for (const rel of ARCHIVOS) {
    const destino = path.join(__dirname, rel);
    fs.mkdirSync(path.dirname(destino), { recursive: true });
    fs.writeFileSync(destino, contenidos[rel]);
    escritos.push(rel);
  }
  return escritos;
}

module.exports = { buscarActualizacion, aplicarActualizacion, versionLocal, ARCHIVOS };

// Ejecucion directa (desde Iniciar.bat). Nunca corta el arranque: si falla la
// red, avisa y sale con 0 para que el servidor arranque con la version actual.
if (require.main === module) {
  (async () => {
    try {
      const { local, remota, hayActualizacion } = await buscarActualizacion();
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
