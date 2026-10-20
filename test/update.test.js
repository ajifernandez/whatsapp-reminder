// Pruebas del auto-actualizador (sin red): https.get sirve un repositorio falso en
// memoria y update.js se ejecuta en una carpeta temporal. Uso: npm test
const https = require('https'), EE = require('events'), fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert');
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-update-'));
fs.copyFileSync(path.join(__dirname, '..', 'update.js'), path.join(DIR, 'update.js'));
let repo = {};
const lista = (extra = []) => ['server.js', 'update.js', 'package.json', 'README.md', 'MANUAL_USUARIO.md', 'renderer/index.html', 'renderer/renderer.js', 'renderer/parser.js', 'renderer/styles.css', ...extra];
function rama(version, { archivos, extra = {} } = {}) {
  const pkg = { version }; if (archivos !== undefined) pkg.archivosActualizables = archivos;
  const r = { 'package.json': JSON.stringify(pkg) };
  for (const f of lista()) if (f !== 'package.json') r[f] = `// ${f} ${version}`;
  return Object.assign(r, extra);
}
https.get = (url, _o, cb) => {
  const req = new EE(); req.setTimeout = () => {};
  const m = url.match(/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/([^/]+)\/(.+)$/);
  const res = new EE(); res.headers = {}; res.setEncoding = () => {}; res.resume = () => {};
  const cuerpo = m && repo[m[1]] && repo[m[1]][m[2]];
  res.statusCode = cuerpo === undefined ? 404 : 200;
  setImmediate(() => { cb(res); if (cuerpo !== undefined) res.emit('data', cuerpo); res.emit('end'); });
  return req;
};
const u = require(path.join(DIR, 'update.js'));
const local = (v) => fs.writeFileSync(path.join(DIR, 'package.json'), JSON.stringify({ version: v }));
const lee = (f) => { try { return fs.readFileSync(path.join(DIR, f), 'utf8'); } catch { return null; } };
const limpiar = () => { for (const f of ['data/canal.txt', 'data/version-fija.txt', 'motores/baileys.js', 'server.js', 'evil.js']) fs.rmSync(path.join(DIR, f), { force: true }); };
const ok = (n) => console.log('OK  ' + n);

(async () => {
  // 1. misma mayor: actualiza y baja la lista REMOTA (con fichero nuevo)
  limpiar(); local('2.1.17');
  repo = { main: rama('2.1.18', { archivos: lista(['motores/baileys.js']), extra: { 'motores/baileys.js': '// motor' } }) };
  let r = await u.buscarActualizacion();
  assert.equal(r.hayActualizacion, true); assert.equal(r.nuevaMayor, undefined);
  let esc = await u.aplicarActualizacion();
  assert.ok(esc.includes('motores/baileys.js')); assert.equal(lee('motores/baileys.js'), '// motor');
  ok('2.1.17 -> 2.1.18 en main: se actualiza y baja el fichero nuevo de la lista remota');

  // 2. freno de mayor en main
  limpiar(); local('2.1.17'); repo = { main: rama('3.0.0', { archivos: lista() }) };
  r = await u.buscarActualizacion();
  assert.equal(r.hayActualizacion, false); assert.equal(r.nuevaMayor, '3.0.0');
  ok('2.1.17 con 3.0.0 en main: NO se actualiza, avisa nuevaMayor=3.0.0');

  // 3. latest (explicito) salta el freno
  r = await u.buscarActualizacion({ ignorarFreno: true });
  assert.equal(r.hayActualizacion, true);
  ok('ignorarFreno (latest / selector): sí permite 3.0.0');

  // 4. canal beta: sigue la rama v3, sin freno, y baja de v3
  limpiar(); local('2.1.17'); repo = { main: rama('2.1.17', { archivos: lista() }), v3: rama('3.0.0', { archivos: lista(), extra: {} }) };
  repo.v3['server.js'] = '// server v3';
  u.fijarCanal('v3'); assert.equal(u.canal(), 'v3');
  r = await u.buscarActualizacion();
  assert.equal(r.hayActualizacion, true); assert.equal(r.canal, 'v3');
  await u.aplicarActualizacion(); assert.equal(lee('server.js'), '// server v3');
  ok('canal v3: ve la 3.0.0 sin freno y baja de la rama v3');

  // 5. volver a estable borra el fichero de canal; canal invalido -> main
  u.fijarCanal('main'); assert.equal(fs.existsSync(path.join(DIR, 'data/canal.txt')), false); assert.equal(u.canal(), 'main');
  fs.writeFileSync(path.join(DIR, 'data/canal.txt'), '../../etc'); assert.equal(u.canal(), 'main');
  assert.throws(() => u.fijarCanal('../x'));
  ok('canal main borra canal.txt; canal inválido cae a main; fijarCanal rechaza rutas');

  // 6. lista remota con ruta peligrosa -> se ignora y se usa la mínima
  limpiar(); local('2.1.17'); repo = { main: rama('2.1.18', { archivos: lista(['../evil.js']), extra: { '../evil.js': 'mal' } }) };
  esc = await u.aplicarActualizacion();
  assert.ok(!esc.some((f) => f.includes('evil'))); assert.equal(lee('../evil.js'), null); assert.equal(esc.length, 9);
  ok('lista remota con "../evil.js": se descarta entera y se usa la lista mínima');

  // 7. tag antiguo sin lista (downgrade) -> lista mínima
  limpiar(); local('2.1.17'); repo = { 'v2.1.12': rama('2.1.12') };
  esc = await u.fijarVersion('2.1.12'); assert.equal(esc.length, 9); assert.equal(u.versionFijada(), '2.1.12');
  ok('downgrade a tag sin lista remota: usa la lista mínima y fija la versión');

  // 8. fijada manda sobre canal y freno
  repo.main = rama('2.1.99', { archivos: lista() });
  r = await u.buscarActualizacion(); assert.equal(r.fijada, true); assert.equal(r.hayActualizacion, false);
  ok('con versión fijada no se actualiza');

  // 9. todo o nada: si falta un fichero, no se escribe ninguno
  limpiar(); local('2.1.17'); repo = { main: rama('2.1.18', { archivos: lista(['motores/falta.js']) }) };
  repo.main['server.js'] = '// nuevo';
  await assert.rejects(u.aplicarActualizacion());
  assert.equal(lee('server.js'), null);
  ok('si un fichero de la lista no existe: falla y no escribe nada');
  // 10. la lista real del repo: todo existe y no falta ningún motor (si falta, la clínica
  // bajaría un server.js que requiere un fichero que no se descarga y no arrancaría)
  const RAIZ = path.join(__dirname, '..');
  const real = JSON.parse(fs.readFileSync(path.join(RAIZ, 'package.json'), 'utf8')).archivosActualizables;
  for (const f of real) assert.ok(fs.existsSync(path.join(RAIZ, f)), 'no existe ' + f);
  for (const f of fs.readdirSync(path.join(RAIZ, 'motores'))) assert.ok(real.includes('motores/' + f), 'falta en archivosActualizables: motores/' + f);
  ok('archivosActualizables del repo: todo existe y están todos los motores');

  console.log('\nTODAS LAS PRUEBAS DEL UPDATER PASAN');
  fs.rmSync(DIR, { recursive: true, force: true });
})().catch((e) => { console.error('FALLO:', e); process.exit(1); });
