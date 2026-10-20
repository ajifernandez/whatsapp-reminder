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

async function arrancar({ sesionWwebjs = false, env = {}, saludPrevia = null, config = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-servidor-'));
  // todos los ficheros de la aplicación: si faltara alguno, el arranque iría a GitHub a por él
  for (const f of JSON.parse(fs.readFileSync(path.join(RAIZ, 'package.json'), 'utf8')).archivosActualizables) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.copyFileSync(path.join(RAIZ, f), path.join(dir, f));
  }
  if (sesionWwebjs) fs.mkdirSync(path.join(dir, '.wwebjs_auth', 'session'), { recursive: true });
  if (config) { fs.mkdirSync(path.join(dir, 'data'), { recursive: true }); fs.writeFileSync(path.join(dir, 'data', 'config.json'), JSON.stringify(config)); }
  if (saludPrevia) { fs.mkdirSync(path.join(dir, 'data'), { recursive: true }); fs.writeFileSync(path.join(dir, 'data', 'salud.json'), JSON.stringify(saludPrevia)); }
  fs.symlinkSync(path.join(RAIZ, 'node_modules'), path.join(dir, 'node_modules'), 'junction');
  const puerto = 3900 + Math.floor(Math.random() * 90);
  const proc = spawn(process.execPath, ['-r', path.join(__dirname, 'motor-falso.js'), 'server.js'], {
    cwd: dir, env: { ...process.env, PORT: String(puerto), FALSO_DIR: dir, FALSO_SESION: '1', DIAG_URL: '', LATIDO_URL: '', ...env }, stdio: 'ignore'
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
const enviadosDe = (dir) => {
  try { return fs.readFileSync(path.join(dir, 'enviados.log'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter((e) => e.id); } catch (_) { return []; }
};
const cita = (nombre, telefono, extra = {}) => ({ nombre, telefono, fecha: '2026-11-05', hora: '10:30', especialidad: 'Dermatología', ...extra });

(async () => {
  let s = await arrancar();
  try {
    await s.esperarEstado('conectado');
    ok('con sesion guardada reconecta solo al arrancar');
    assert.equal(JSON.parse(fs.readFileSync(path.join(s.dir, 'data', 'config.json'), 'utf8')).motor, 'wwebjs');
    ok('instalación nueva: motor por defecto whatsapp-web.js (Baileys es experimental)');

    const r = await s.api('/api/enviar', [cita('Ana', '612345678'), cita('Sin WhatsApp', '611111000'), cita('Incompleta', '')]);
    assert.deepEqual(r, { enviados: 1, fallidos: 0, omitidos: 2, sinRespuesta: 0, total: 3 });
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

    // texto libre: solo scripts del mismo equipo (sin Origin) y solo JSON
    const libre = (cuerpo, cab = {}) => fetch(s.base + '/api/mensaje', { method: 'POST', headers: { 'Content-Type': 'application/json', ...cab }, body: JSON.stringify(cuerpo) });
    assert.equal((await libre({ telefono: '612345678', texto: 'Aviso de prueba\ncon dos líneas' })).status, 200);
    const ultimo = fs.readFileSync(path.join(s.dir, 'enviados.log'), 'utf8').trim().split('\n').map(JSON.parse).pop();
    assert.deepEqual(ultimo, { id: '34612345678@s.whatsapp.net', texto: 'Aviso de prueba\ncon dos líneas' }, 'texto tal cual, con saltos de línea, sin plantilla');
    assert.equal((await libre({ telefono: '612345678', texto: 'x' }, { Origin: s.base })).status, 403, 'desde una web (aunque sea la propia) no');
    assert.equal((await fetch(s.base + '/api/mensaje', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{"telefono":"612345678","texto":"x"}' })).status, 403, 'solo JSON');
    assert.equal((await libre({ telefono: '612345678' })).status, 400);
    assert.equal((await libre({ telefono: '611111000', texto: 'x' })).status, 404, 'sin WhatsApp');
    assert.ok(!(await s.api('/api/diagnostico')).log.some((l) => l.includes('612345678')), 'el teléfono no sale en el informe');
    ok('texto libre: solo desde scripts del mismo equipo (sin Origin, JSON), tal cual y sin plantilla');

    s.orden('desconectar');
    await s.esperarEstado('desconectado');
    ok('evento desconectado -> estado desconectado');

    const mal = await fetch(s.base + '/api/motor', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"motor":"nada"}' });
    assert.equal(mal.status, 400);
    const cambio = await s.api('/api/motor', { motor: 'wwebjs' });
    assert.equal(cambio.motor, 'wwebjs');
    assert.equal(JSON.parse(fs.readFileSync(path.join(s.dir, 'data', 'config.json'), 'utf8')).motor, 'wwebjs');
    assert.equal(JSON.parse(fs.readFileSync(path.join(s.dir, 'data', 'config.json'), 'utf8')).motorElegido, true, 'elegido a mano');
    await s.esperarEstado('conectado'); // con sesión guardada reconecta sin esperar el cooldown
    assert.ok(Array.isArray((await s.api('/api/estado')).motores));
    ok('cambio de motor: valida, se guarda en config.json y reconecta');
  } finally { await s.cerrar(); }

  // WhatsApp (el navegador) no responde: las citas no se marcan como "omitidas"
  s = await arrancar();
  try {
    await s.esperarEstado('conectado');
    const lista = [cita('Ana', '612345001'), cita('Bea', '612345888'), cita('Eva', '612346888'), cita('Zoe', '612345002')];
    await s.api('/api/citas', lista);
    const r = await s.api('/api/enviar', lista);
    assert.deepEqual(r, { enviados: 1, fallidos: 0, omitidos: 0, sinRespuesta: 3, total: 4 });
    assert.equal(enviadosDe(s.dir).length, 1, 'el lote se detiene: Zoe no se envía');
    const guardadas = await s.api('/api/citas');
    assert.equal(guardadas.find((c) => c.nombre === 'Ana').estadoEnvio, 'enviado');
    for (const n of ['Bea', 'Eva', 'Zoe']) assert.equal(guardadas.find((c) => c.nombre === n).estadoEnvio, undefined, n + ' no debe quedar marcada');
    const diag = await s.api('/api/diagnostico');
    assert.ok(diag.log.some((l) => l.includes('WhatsApp no responde: envío detenido')));
    assert.ok(!diag.log.some((l) => l.includes('no es válido')), 'no se da por "número no válido"');
    ok('WhatsApp sin respuesta: lote detenido al 2.º fallo, citas sin marcar y sin falso "número no válido"');

    // un fallo aislado no corta el lote
    const r2 = await s.api('/api/enviar', [cita('Uno', '612345003'), cita('Mal', '612345888'), cita('Dos', '612345004')]);
    assert.deepEqual(r2, { enviados: 2, fallidos: 0, omitidos: 0, sinRespuesta: 1, total: 3 });
    ok('un único fallo sin respuesta no detiene el resto del lote');
  } finally { await s.cerrar(); }

  // Baileys guardado sin elegirlo (motor por defecto de 2.2.0-2.4.0) -> pasa a whatsapp-web.js, con aviso
  s = await arrancar({ config: { mensaje: 'Hola {nombre}', autoEnvio: false, motor: 'baileys', latido: true } });
  try {
    await s.esperarEstado('conectado');
    const cfg = JSON.parse(fs.readFileSync(path.join(s.dir, 'data', 'config.json'), 'utf8'));
    assert.equal(cfg.motor, 'wwebjs');
    assert.equal(cfg.mensaje, 'Hola {nombre}', 'el resto de la configuración se conserva');
    assert.ok((await s.api('/api/diagnostico')).log.some((l) => l.includes('Se usa whatsapp-web.js en lugar de Baileys')), 'queda anotado');
    const nombres = (await s.api('/api/estado')).motores.map((m) => m.nombre);
    assert.deepEqual(nombres, ['whatsapp-web.js (recomendado)', 'Baileys (experimental)']);
    ok('Baileys heredado (no elegido) pasa a whatsapp-web.js una vez, con aviso; el selector lo marca experimental');
  } finally { await s.cerrar(); }

  // Baileys elegido a mano en el selector se respeta
  s = await arrancar({ config: { mensaje: 'Hola {nombre}', autoEnvio: false, motor: 'baileys', motorElegido: true, latido: true } });
  try {
    await s.esperarEstado('conectado');
    assert.equal(JSON.parse(fs.readFileSync(path.join(s.dir, 'data', 'config.json'), 'utf8')).motor, 'baileys');
    assert.ok(!(await s.api('/api/diagnostico')).log.some((l) => l.includes('Se usa whatsapp-web.js en lugar de Baileys')));
    ok('Baileys elegido a mano se respeta');
  } finally { await s.cerrar(); }

  // salud de la conexion: 'conectado' pasa a 'degradado' con la causa, y se recupera
  const estadoSalud = async (s) => (await s.api('/api/estado'));
  const esperarCon = async (s, cond, ms = 8000) => {
    for (let t = 0; t < ms; t += 100) { const e = await estadoSalud(s); if (cond(e)) return e; await pausa(100); }
    throw new Error('no se cumplio la condicion de salud');
  };
  for (const [red, texto] of [['ok', /La red funciona pero WhatsApp no responde/], ['nada', /Sin internet/], ['wa', /WhatsApp no es accesible/]]) {
    s = await arrancar({ env: { INTERVALO_SALUD_MS: '150', SALUD_RED: red } });
    try {
      await s.esperarEstado('conectado');
      await pausa(500);
      assert.equal((await estadoSalud(s)).salud.degradada, false, 'sin fallos no se avisa');
      fs.writeFileSync(path.join(s.dir, 'ping_falla'), '');
      const e = await esperarCon(s, (x) => x.estado === 'degradado');
      assert.match(e.salud.causa, texto);
      assert.ok(e.salud.consejo && e.salud.desde, 'con consejo y hora de inicio');
      let diag = await s.api('/api/diagnostico');
      assert.ok(diag.log.some((l) => l.includes('Conexión con WhatsApp con problemas')));
      assert.ok(diag.log.some((l) => l.includes('Comprobación de conexión fallida (1 seguida)')), 'el primer fallo suelto también queda en el log del informe');
      assert.ok(diag.log.some((l) => l.includes('Foto de la página: {"falso":true')), 'en el primer fallo, foto de la página');
      assert.equal(diag.salud.degradada, true);
      assert.ok(diag.salud.comprobaciones >= 3 && diag.salud.fallos >= 2, 'contadores desde el arranque');
      assert.equal(diag.salud.incidentes.length, 1);
      assert.match(diag.salud.incidentes[0].causa, texto);
      assert.equal(diag.salud.incidentes[0].hasta, null, 'incidente abierto');
      assert.match(diag.salud.incidentes[0].desde, /^\d{4}-\d\d-\d\dT/);
      if (red === 'ok') {
        fs.rmSync(path.join(s.dir, 'ping_falla'));
        const r = await esperarCon(s, (x) => x.estado === 'conectado');
        assert.equal(r.salud.degradada, false);
        diag = await s.api('/api/diagnostico');
        assert.ok(diag.log.some((l) => l.includes('Conexión con WhatsApp recuperada')));
        assert.equal(diag.salud.incidentes[0].fin, 'recuperada');
        assert.ok(diag.salud.incidentes[0].hasta, 'incidente cerrado con su hora de fin');
      }
      ok(`salud (${red}): degradado con la causa correcta${red === 'ok' ? ' y recuperación a conectado' : ''}`);
    } finally { await s.cerrar(); }
  }

  // el incidente tambien termina si la conexion se corta estando con problemas, y el aviso desaparece
  s = await arrancar({ env: { INTERVALO_SALUD_MS: '150', SALUD_RED: 'ok' } });
  try {
    await s.esperarEstado('conectado');
    fs.writeFileSync(path.join(s.dir, 'ping_falla'), '');
    await esperarCon(s, (x) => x.estado === 'degradado');
    s.orden('desconectar');
    const e = await esperarCon(s, (x) => x.estado === 'desconectado');
    assert.equal(e.salud.degradada, false, 'sin aviso de salud si no hay conexion');
    const inc = (await s.api('/api/diagnostico')).salud.incidentes;
    assert.equal(inc.length, 1);
    assert.equal(inc[0].fin, 'desconexión');
    assert.ok(inc[0].hasta);
    ok('un corte estando con problemas cierra el incidente (fin: desconexión) y limpia el aviso');
  } finally { await s.cerrar(); }

  // un incidente que quedo abierto al cerrarse la aplicacion se muestra como cerrado por el reinicio
  s = await arrancar({ saludPrevia: [{ desde: Date.parse('2026-10-01T10:00:00Z'), hasta: null, fin: null, causa: 'Sin internet', motivo: 'no contesta', motor: 'baileys' }] });
  try {
    await s.esperarEstado('conectado');
    const inc = (await s.api('/api/diagnostico')).salud.incidentes;
    assert.equal(inc.length, 1);
    assert.equal(inc[0].fin, 'reinicio de la aplicación');
    assert.equal(inc[0].causa, 'Sin internet');
    ok('el historial de incidentes sobrevive a los reinicios (uno abierto se marca «reinicio de la aplicación»)');
  } finally { await s.cerrar(); }

  // latido hacia soporte: la app avisa de su estado a un receptor real
  const dirReceptor = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-receptor-'));
  const puertoRec = 3700 + Math.floor(Math.random() * 90);
  const receptor = spawn(process.execPath, [path.join(RAIZ, 'soporte-server', 'server.js')], { env: { ...process.env, PORT: String(puertoRec), DATA_DIR: dirReceptor, ADMIN_PASS: 'x' }, stdio: 'ignore' });
  const clinicasEnRecepcion = () => { try { return Object.values(JSON.parse(fs.readFileSync(path.join(dirReceptor, 'estado', 'clinicas.json'), 'utf8'))); } catch (_) { return []; } };
  const esperarClinica = async (cond, ms = 9000) => {
    for (let t = 0; t < ms; t += 100) { const c = clinicasEnRecepcion()[0]; if (c && cond(c)) return c; await pausa(100); }
    throw new Error('el receptor no recibió el latido esperado: ' + JSON.stringify(clinicasEnRecepcion()[0]));
  };
  await pausa(600);
  s = await arrancar({ env: { LATIDO_URL: `http://localhost:${puertoRec}/latido`, DIAG_URL: `http://localhost:${puertoRec}/diagnostico`, INTERVALO_LATIDO_MS: '300', INTERVALO_SALUD_MS: '150', SALUD_RED: 'ok' } });
  try {
    await s.esperarEstado('conectado');
    const c = await esperarClinica((x) => x.estado === 'conectado');
    assert.equal(c.motor, 'falso');
    assert.equal(c.host, os.hostname());
    assert.match(c.id, /^[a-f0-9-]{36}$/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(s.dir, 'data', 'instalacion.json'), 'utf8')).id, c.id, 'el id se guarda para los siguientes arranques');
    assert.equal((await s.api('/api/diagnostico')).latido.id, c.id, 'el informe lleva el mismo id');
    ok('latido: llega al receptor con id estable, equipo, motor y estado');

    fs.writeFileSync(path.join(s.dir, 'ping_falla'), '');
    const d = await esperarClinica((x) => x.estado === 'degradado');
    assert.match(d.causa, /La red funciona pero WhatsApp no responde/);
    fs.rmSync(path.join(s.dir, 'ping_falla'));
    await esperarClinica((x) => x.estado === 'conectado');
    ok('latido: al cambiar de estado (con problemas y recuperación) llega enseguida');

    // la clinica puede desactivarlo
    await s.api('/api/config', { latido: false });
    await pausa(500);
    const antes = clinicasEnRecepcion()[0].ultimo;
    await pausa(1200);
    assert.equal(clinicasEnRecepcion()[0].ultimo, antes, 'desactivado: no llegan más latidos');
    assert.equal((await s.api('/api/diagnostico')).latido.activo, false);
    await s.api('/api/config', { latido: true });
    await esperarClinica((x) => x.ultimo > antes);
    ok('latido: se puede desactivar desde la configuración (y reactivar)');

    // soporte pide un diagnostico desde su web: la app lo manda sola en el siguiente latido
    const adminRec = 'Basic ' + Buffer.from('admin:x').toString('base64');
    const idApp = clinicasEnRecepcion()[0].id;
    const informesEnRecepcion = () => fs.readdirSync(dirReceptor).filter((n) => n.endsWith('.json'));
    const esperarInformes = async (n, ms = 9000) => { for (let t = 0; t < ms && informesEnRecepcion().length < n; t += 100) await pausa(100); return informesEnRecepcion().length; };
    const pedirDesdeSoporte = () => fetch(`http://localhost:${puertoRec}/clinicas/${idApp}/diagnostico`, { method: 'POST', headers: { Authorization: adminRec } });
    assert.equal(informesEnRecepcion().length, 0, 'no se ha mandado ningún informe por su cuenta');
    assert.equal((await pedirDesdeSoporte()).status, 200);
    assert.equal(await esperarInformes(1), 1, 'la app manda el informe tras la petición');
    await pausa(1200); // varios latidos más: no se repite
    assert.equal(informesEnRecepcion().length, 1, 'se atiende una sola vez');
    const informe = JSON.parse(fs.readFileSync(path.join(dirReceptor, informesEnRecepcion()[0]), 'utf8'));
    assert.equal(informe.latido.id, idApp, 'el informe lleva el id de la instalación');
    assert.ok(informe.log.some((l) => l.includes('Soporte ha pedido un diagnóstico')), 'queda anotado en el log de la clínica');
    const rec = clinicasEnRecepcion()[0];
    assert.ok(rec.ultimoDiag && !rec.orden, 'el receptor lo da por cumplido');
    assert.ok((await s.api('/api/diagnostico')).log.some((l) => l.includes('Diagnóstico enviado a soporte, a petición suya')));
    ok('diagnóstico a petición de soporte: la app lo envía sola en el siguiente latido, una vez, y queda anotado');

    // con el aviso de estado desactivado la clinica no participa: no se atiende ninguna peticion
    await s.api('/api/config', { latido: false });
    await pausa(500);
    assert.equal((await pedirDesdeSoporte()).status, 200);
    await pausa(1500);
    assert.equal(informesEnRecepcion().length, 1, 'con «avisar a soporte» desactivado no se manda nada');
    await s.api('/api/config', { latido: true });
    assert.equal(await esperarInformes(2), 2, 'al reactivarlo, se atiende la petición pendiente');
    ok('con el aviso de estado desactivado no se atiende ninguna petición de diagnóstico (y se atiende al reactivarlo)');

    // al apagar con el boton, un ultimo aviso: "apagada" (a proposito), no una caida
    const apagar = await fetch(s.base + '/api/apagar', { method: 'POST', headers: { Origin: s.base } });
    assert.equal(apagar.status, 200);
    await s.salida;
    assert.equal(clinicasEnRecepcion()[0].estado, 'apagada');
    ok('latido: al apagar con «Apagar» llega un último aviso «apagada»');
  } finally { await s.cerrar(); }

  // carrera al apagar: tras mandar «apagada» la app sigue cerrando (con whatsapp-web.js, Chromium tarda
  // hasta 5 s; aqui el motor falso tarda 800 ms) y el latido periodico seguia saliendo con «conectado»,
  // que llegaba el ultimo (paso en la CI de Windows). El ultimo en llegar tiene que ser «apagada».
  for (let vuelta = 1; vuelta <= 3; vuelta++) {
    s = await arrancar({ env: { LATIDO_URL: `http://localhost:${puertoRec}/latido`, INTERVALO_LATIDO_MS: '20', FALSO_APAGAR_MS: '800' } });
    try {
      await s.esperarEstado('conectado');
      // esta instalacion (cada vuelta es una nueva, con su propio id)
      const rutaId = path.join(s.dir, 'data', 'instalacion.json');
      for (let t = 0; t < 9000 && !fs.existsSync(rutaId); t += 50) await pausa(50);
      const idEsta = JSON.parse(fs.readFileSync(rutaId, 'utf8')).id;
      const enRecepcion = () => { try { return JSON.parse(fs.readFileSync(path.join(dirReceptor, 'estado', 'clinicas.json'), 'utf8'))[idEsta]; } catch (_) { return null; } };
      for (let t = 0; t < 9000 && !(enRecepcion() && enRecepcion().estado === 'conectado'); t += 50) await pausa(50);
      assert.equal(enRecepcion().estado, 'conectado');
      await pausa(300);
      assert.equal((await fetch(s.base + '/api/apagar', { method: 'POST', headers: { Origin: s.base } })).status, 200);
      await s.salida;
      await pausa(300); // por si quedara algo en camino
      const final = JSON.parse(fs.readFileSync(path.join(dirReceptor, 'estado', 'clinicas.json'), 'utf8'))[idEsta];
      assert.equal(final.estado, 'apagada', `vuelta ${vuelta}: el último latido debe ser «apagada»`);
    } finally { await s.cerrar(); }
  }
  ok('latido: al apagar con latidos en camino, el último en llegar siempre es «apagada» (3 vueltas)');
  receptor.kill(); await pausa(200); fs.rmSync(dirReceptor, { recursive: true, force: true });

  // envio automatico: cita en las proximas horas con WhatsApp sin responder -> sin marcar y en pausa
  s = await arrancar({ env: { INTERVALO_AUTO_MS: '200' } });
  try {
    await s.esperarEstado('conectado');
    const dentro = new Date(Date.now() + 3 * 3600e3);
    const dos = (n) => String(n).padStart(2, '0');
    const fecha = `${dentro.getFullYear()}-${dos(dentro.getMonth() + 1)}-${dos(dentro.getDate())}`;
    const hora = `${dos(dentro.getHours())}:${dos(dentro.getMinutes())}`;
    await s.api('/api/citas', [cita('Auto', '612345888', { fecha, hora })]);
    await s.api('/api/config', { autoEnvio: true });
    await pausa(1500);
    const g = (await s.api('/api/citas'))[0];
    assert.equal(g.estadoEnvio, undefined, 'sin marcar');
    const log = (await s.api('/api/diagnostico')).log;
    assert.equal(log.filter((l) => l.includes('Envío automático en pausa')).length, 1, 'entra en pausa una sola vez, no cada 200 ms');
    assert.equal(log.filter((l) => l.includes('WhatsApp no responde, no se pudo comprobar')).length, 1, 'no reintenta durante la pausa');
    ok('envío automático: sin respuesta -> cita sin marcar y pausa (no reintenta en bucle)');
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
