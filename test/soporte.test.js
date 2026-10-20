// Pruebas del receptor de soporte (soporte-server/server.js): latidos, estado de cada clínica,
// páginas protegidas, alias, persistencia y escapado de HTML. Cada escenario arranca un
// receptor real en una carpeta temporal.
// Uso: npm test
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

const RECEPTOR = path.join(__dirname, '..', 'soporte-server', 'server.js');
const pausa = (ms) => new Promise((r) => setTimeout(r, ms));
const AUTH = 'Basic ' + Buffer.from('admin:secreto').toString('base64');

async function arrancar({ dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-soporte-')), env = {} } = {}) {
  const puerto = 3800 + Math.floor(Math.random() * 90);
  const proc = spawn(process.execPath, [RECEPTOR], { env: { ...process.env, PORT: String(puerto), DATA_DIR: dir, ADMIN_PASS: 'secreto', ...env }, stdio: 'ignore' });
  const base = `http://localhost:${puerto}`;
  for (let i = 0; i < 50; i++) { try { if ((await fetch(base + '/health')).ok) break; } catch (_) { /* arrancando */ } await pausa(100); }
  const pedir = (ruta, opts = {}) => fetch(base + ruta, { redirect: 'manual', ...opts, headers: { Authorization: AUTH, ...(opts.headers || {}) } });
  const latido = (d) => fetch(base + '/latido', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(d) });
  const html = async (ruta) => (await pedir(ruta)).text();
  const parar = async () => { proc.kill(); await pausa(200); };
  return { dir, base, pedir, latido, html, parar };
}

const ID1 = 'a1b2c3d4-0000-4000-8000-000000000001';
const ID2 = 'a1b2c3d4-0000-4000-8000-000000000002';
const ID3 = 'a1b2c3d4-0000-4000-8000-000000000003';
const ID4 = 'a1b2c3d4-0000-4000-8000-000000000004';
const ID5 = 'a1b2c3d4-0000-4000-8000-000000000005';
const base = (id, extra = {}) => ({ id, host: 'PC-' + id.slice(-1), version: '2.4.0', canal: 'main', motor: 'baileys', estado: 'conectado', ...extra });
const ok = (n) => console.log('OK  ' + n);
const dirsTemporales = [];

(async () => {
  let r = await arrancar({ env: { OFFLINE_MIN: '0.03' } }); // 1,8 s hasta "sin señal"
  dirsTemporales.push(r.dir);
  try {
    // --- validación y límites
    assert.equal((await r.latido({ id: 'corto', estado: 'conectado' })).status, 400, 'id inválido');
    assert.equal((await r.latido({ id: ID1, estado: 'inventado' })).status, 400, 'estado inválido');
    assert.equal((await r.latido({ id: ID1 })).status, 400, 'sin estado');
    assert.equal((await fetch(r.base + '/latido', { method: 'POST', body: 'no es json' })).status, 400);
    assert.equal((await fetch(r.base + '/latido', { method: 'POST', body: JSON.stringify(base(ID1, { causa: 'x'.repeat(10000) })) })).status, 413, 'demasiado grande');
    ok('latido: rechaza id/estado inválidos, JSON roto y cuerpos enormes');

    // --- páginas protegidas
    assert.equal((await fetch(r.base + '/clinicas')).status, 401);
    assert.equal((await fetch(r.base + '/clinicas', { headers: { Authorization: 'Basic ' + Buffer.from('admin:mal').toString('base64') } })).status, 401);
    const raiz = await r.pedir('/');
    assert.equal(raiz.status, 302); assert.equal(raiz.headers.get('location'), '/clinicas');
    assert.match(await r.html('/clinicas'), /Aún no ha llegado ningún latido/);
    ok('/clinicas requiere contraseña; / redirige a /clinicas; vacío al principio');

    // --- cada estado se ve como toca
    assert.equal((await r.latido(base(ID1, { host: 'CLINICA-OK' }))).status, 200);
    await r.latido(base(ID2, { host: 'CLINICA-AVISO', estado: 'degradado', causa: 'La red funciona pero WhatsApp no responde (no contesta)' }));
    await r.latido(base(ID3, { host: 'CLINICA-CAIDA', estado: 'desconectado', ultimoError: 'Sesión desconectada: LOGOUT' }));
    await r.latido(base(ID4, { host: 'CLINICA-CERRADA', estado: 'apagada' }));
    await r.latido(base(ID5, { host: 'CLINICA-CONECTANDO', estado: 'conectando' }));
    let pagina = await r.html('/clinicas');
    for (const [host, clase, etiqueta] of [['CLINICA-OK', 'ok', 'OK'], ['CLINICA-AVISO', 'warning', 'Con problemas'], ['CLINICA-CAIDA', 'desconectado', 'Desconectado'], ['CLINICA-CERRADA', 'apagada', 'Apagada'], ['CLINICA-CONECTANDO', 'conectando', 'Conectando']]) {
      const fila = pagina.split('<tr>').find((f) => f.includes(host));
      assert.ok(fila && fila.includes(`class="chip ${clase}">${etiqueta}<`), `${host} -> ${etiqueta}`);
    }
    assert.match(pagina, /La red funciona pero WhatsApp no responde/);
    assert.match(pagina, /Sesión desconectada: LOGOUT/);
    // orden por gravedad: desconectado, con problemas, conectando, ok, apagada
    const pos = (h) => pagina.indexOf(h);
    assert.ok(pos('CLINICA-CAIDA') < pos('CLINICA-AVISO') && pos('CLINICA-AVISO') < pos('CLINICA-CONECTANDO') && pos('CLINICA-CONECTANDO') < pos('CLINICA-OK') && pos('CLINICA-OK') < pos('CLINICA-CERRADA'));
    ok('estados OK / con problemas / desconectado / conectando / apagada, con detalle y ordenados por gravedad');

    // --- sin señal: dejan de llegar latidos (las apagadas siguen "apagadas", no son una caída)
    await pausa(2300);
    await r.latido(base(ID1, { host: 'CLINICA-OK' })); // esta sigue viva
    pagina = await r.html('/clinicas');
    const claseDe = (host) => /class="chip (\w+)"/.exec(pagina.split('<tr>').find((f) => f.includes(host)))[1];
    assert.equal(claseDe('CLINICA-OK'), 'ok');
    assert.equal(claseDe('CLINICA-AVISO'), 'offline');
    assert.equal(claseDe('CLINICA-CAIDA'), 'offline');
    assert.equal(claseDe('CLINICA-CERRADA'), 'apagada');
    assert.match(pagina, /Sin latidos/); // con el umbral de prueba (1,8 s) «hace» sale como «ahora»
    assert.ok(pagina.indexOf('CLINICA-AVISO') < pagina.indexOf('CLINICA-OK'), 'sin señal va antes que OK');
    ok('sin latidos -> «Sin señal» (menos las apagadas a propósito), por delante de las que están bien');

    // --- alias, y solo desde la propia página con contraseña
    const cambiar = (alias, cab = {}) => r.pedir('/clinicas/' + ID1, { method: 'POST', headers: { 'Content-Type': 'application/json', ...cab }, body: JSON.stringify({ alias }) });
    assert.equal((await cambiar('Clínica Centro', { Origin: 'https://otra-web.example' })).status, 403);
    assert.equal((await fetch(r.base + '/clinicas/' + ID1, { method: 'POST', body: '{"alias":"x"}' })).status, 401);
    assert.equal((await cambiar('Clínica Centro', { Origin: r.base })).status, 200);
    pagina = await r.html('/clinicas');
    assert.match(pagina, /<b>Clínica Centro<\/b>/);
    assert.match(pagina, /CLINICA-OK/, 'el nombre del equipo sigue debajo');
    await r.latido(base(ID1, { host: 'CLINICA-OK' }));
    assert.match(await r.html('/clinicas'), /<b>Clínica Centro<\/b>/, 'un latido nuevo no pisa el alias');
    assert.equal((await r.pedir('/clinicas/' + ID1, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ alias: '   ' }) })).status, 200);
    assert.match(await r.html('/clinicas'), /<b>CLINICA-OK<\/b>/, 'alias vacío = vuelve el nombre del equipo');
    assert.equal((await r.pedir('/clinicas/a1b2c3d4-ffff-4000-8000-00000000ffff', { method: 'DELETE' })).status, 404);
    ok('alias: solo con contraseña y desde la propia página; sobrevive a nuevos latidos; vacío vuelve al nombre del equipo');

    // --- HTML escapado
    await r.latido(base(ID5, { host: '<script>alert(1)</script>', estado: 'degradado', causa: '<img src=x onerror=alert(1)>' }));
    pagina = await r.html('/clinicas');
    assert.ok(!pagina.includes('<script>alert(1)') && !pagina.includes('<img src=x'), 'sin HTML sin escapar');
    assert.match(pagina, /&#60;script&#62;alert\(1\)/);
    ok('host y causa con HTML salen escapados');

    // --- no se mezclan con los diagnósticos
    assert.match(await r.html('/diagnosticos'), /Diagnósticos recibidos \(0,/);
    assert.ok(!(await r.html('/diagnosticos')).includes('clinicas.json'));
    ok('el estado de las clínicas no aparece en la lista de diagnósticos');

    // --- olvidar una instalación
    assert.equal((await r.pedir('/clinicas/' + ID4, { method: 'DELETE', headers: { Origin: 'https://otra-web.example' } })).status, 403);
    assert.equal((await r.pedir('/clinicas/' + ID4, { method: 'DELETE', headers: { Origin: r.base } })).status, 200);
    assert.ok(!(await r.html('/clinicas')).includes('CLINICA-CERRADA'));
    ok('olvidar una instalación (con comprobación de origen)');
  } finally { await r.parar(); }

  // --- persistencia: otro arranque con la misma carpeta
  r = await arrancar({ dir: dirsTemporales[0], env: { OFFLINE_MIN: '60' } });
  try {
    const pagina = await r.html('/clinicas');
    assert.match(pagina, /<b>CLINICA-OK<\/b>/);
    assert.match(pagina, /CLINICA-CAIDA/);
    ok('el estado de las clínicas sobrevive a reiniciar el receptor');
  } finally { await r.parar(); }

  // --- límite por instalación (40 latidos/hora)
  r = await arrancar();
  dirsTemporales.push(r.dir);
  try {
    let ultimo = 200;
    for (let i = 0; i < 45; i++) ultimo = (await r.latido(base(ID1))).status;
    assert.equal(ultimo, 429);
    assert.equal((await r.latido(base(ID2))).status, 200, 'otra instalación no se ve afectada');
    ok('límite de 40 latidos/hora por instalación; las demás no se ven afectadas');
  } finally { await r.parar(); }

  for (const d of dirsTemporales) fs.rmSync(d, { recursive: true, force: true });
  console.log('\nTODAS LAS PRUEBAS DEL RECEPTOR DE SOPORTE PASAN');
})().catch((e) => { console.error('FALLO:', e); process.exit(1); });
