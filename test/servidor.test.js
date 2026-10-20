// Pruebas del servidor con el motor falso (sin WhatsApp ni navegador): arranque con
// sesion guardada, envio por lotes, numeros sin WhatsApp, citas incompletas y los
// eventos de sesion. Cada escenario arranca un servidor en una carpeta temporal.
// Uso: npm test
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

const RAIZ = path.join(__dirname, '..');
const pausa = (ms) => new Promise((r) => setTimeout(r, ms));

async function arrancar({ sesionWwebjs = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-servidor-'));
  // todos los ficheros de la aplicación: si faltara alguno, el arranque iría a GitHub a por él
  for (const f of JSON.parse(fs.readFileSync(path.join(RAIZ, 'package.json'), 'utf8')).archivosActualizables) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.copyFileSync(path.join(RAIZ, f), path.join(dir, f));
  }
  if (sesionWwebjs) fs.mkdirSync(path.join(dir, '.wwebjs_auth', 'session'), { recursive: true });
  fs.symlinkSync(path.join(RAIZ, 'node_modules'), path.join(dir, 'node_modules'), 'junction');
  const puerto = 3900 + Math.floor(Math.random() * 90);
  const proc = spawn(process.execPath, ['-r', path.join(__dirname, 'motor-falso.js'), 'server.js'], {
    cwd: dir, env: { ...process.env, PORT: String(puerto), FALSO_DIR: dir, FALSO_SESION: '1', DIAG_URL: '' }, stdio: 'ignore'
  });
  const base = `http://localhost:${puerto}`;
  const api = async (ruta, cuerpo) => (await fetch(base + ruta, cuerpo === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo)
  })).json();
  const esperarEstado = async (estado) => {
    for (let i = 0; i < 60; i++) {
      try { if ((await api('/api/estado')).estado === estado) return; } catch (_) { /* aun arrancando */ }
      await pausa(100);
    }
    throw new Error('no se llego al estado ' + estado);
  };
  const cerrar = async () => {
    proc.kill();
    await pausa(300); // en Windows el proceso tarda en soltar los ficheros
    // primero el enlace (junction en Windows), para no borrar nunca el node_modules real
    const enlace = path.join(dir, 'node_modules');
    try { fs.unlinkSync(enlace); } catch (_) { try { fs.rmdirSync(enlace); } catch (_) { /* ya no está */ } }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* temporal: no es grave */ }
  };
  const salida = new Promise((r, rechazar) => { proc.on('exit', r); setTimeout(() => rechazar(new Error('el proceso no se cerró')), 15000).unref(); });
  salida.catch(() => {});
  return { dir, base, api, esperarEstado, cerrar, salida, orden: (o) => fs.writeFileSync(path.join(dir, 'orden.txt'), o) };
}

const ok = (n) => console.log('OK  ' + n);
const cita = (nombre, telefono, extra = {}) => ({ nombre, telefono, fecha: '2026-11-05', hora: '10:30', especialidad: 'Dermatología', ...extra });

(async () => {
  let s = await arrancar();
  try {
    await s.esperarEstado('conectado');
    ok('con sesion guardada reconecta solo al arrancar');
    assert.equal(JSON.parse(fs.readFileSync(path.join(s.dir, 'data', 'config.json'), 'utf8')).motor, 'baileys');
    ok('instalación nueva: motor por defecto Baileys');

    const r = await s.api('/api/enviar', [cita('Ana', '612345678'), cita('Sin WhatsApp', '611111000'), cita('Incompleta', '')]);
    assert.deepEqual(r, { enviados: 1, fallidos: 0, omitidos: 2, total: 3 });
    const enviados = fs.readFileSync(path.join(s.dir, 'enviados.log'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(enviados.length, 1);
    assert.equal(enviados[0].id, '34612345678@s.whatsapp.net');
    assert.match(enviados[0].texto, /Ana/); assert.match(enviados[0].texto, /Dermatología/);
    ok('envio: 1 enviado (con prefijo 34), sin WhatsApp y cita incompleta omitidos');

    const diag = await s.api('/api/diagnostico');
    assert.equal(diag.motor, 'falso');
    assert.ok(diag.log.some((l) => l.includes('Enviado a [nombre] ([tel])')), 'el log del informe va anonimizado');
    assert.ok(!JSON.stringify(diag).includes('612345678'), 'el telefono no sale en el informe');
    ok('diagnostico: motor y log anonimizado');

    s.orden('desconectar');
    await s.esperarEstado('desconectado');
    ok('evento desconectado -> estado desconectado');

    const mal = await fetch(s.base + '/api/motor', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"motor":"nada"}' });
    assert.equal(mal.status, 400);
    const cambio = await s.api('/api/motor', { motor: 'wwebjs' });
    assert.equal(cambio.motor, 'wwebjs');
    assert.equal(JSON.parse(fs.readFileSync(path.join(s.dir, 'data', 'config.json'), 'utf8')).motor, 'wwebjs');
    await s.esperarEstado('conectado'); // con sesión guardada reconecta sin esperar el cooldown
    assert.ok(Array.isArray((await s.api('/api/estado')).motores));
    ok('cambio de motor: valida, se guarda en config.json y reconecta');
  } finally { await s.cerrar(); }

  s = await arrancar({ sesionWwebjs: true });
  try {
    await s.esperarEstado('conectado');
    assert.equal(JSON.parse(fs.readFileSync(path.join(s.dir, 'data', 'config.json'), 'utf8')).motor, 'wwebjs');
    ok('instalación que ya usaba whatsapp-web.js: sigue con wwebjs (sin revincular)');

    s.orden('fallo_auth');
    await pausa(300);
    const e = await s.api('/api/estado');
    assert.match(String(e.ultimoError), /Error de autenticación: PRUEBA/);
    ok('evento fallo_auth -> se registra el error');

    await s.api('/api/cerrar', {});
    await s.esperarEstado('desconectado');
    assert.ok(fs.readFileSync(path.join(s.dir, 'enviados.log'), 'utf8').includes('cerrarSesion'));
    ok('cerrar sesion llama al motor y deja el estado desconectado');
  } finally { await s.cerrar(); }

  s = await arrancar();
  try {
    await s.esperarEstado('conectado');
    const ajeno = await fetch(s.base + '/api/apagar', { method: 'POST', headers: { Origin: 'https://otra-web.example' } });
    assert.equal(ajeno.status, 403);
    assert.equal((await s.api('/api/estado')).estado, 'conectado', 'sigue en marcha');
    const propio = await fetch(s.base + '/api/apagar', { method: 'POST', headers: { Origin: s.base } });
    assert.equal(propio.status, 200);
    await s.salida;
    assert.match(fs.readFileSync(path.join(s.dir, 'data', 'app.log'), 'utf8'), /Aplicación cerrada \(botón Apagar/);
    ok('apagar: rechaza otro origen; desde la página cierra el proceso y lo registra');
  } finally { await s.cerrar(); }

  console.log('\nTODAS LAS PRUEBAS DEL SERVIDOR PASAN');
})().catch((e) => { console.error('FALLO:', e); process.exit(1); });
