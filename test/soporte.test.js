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

    // --- actualización en vivo: la página pide solo el contenido, sin recargarse entera
    assert.equal((await fetch(r.base + '/clinicas?parcial=1')).status, 401, 'la versión parcial también pide contraseña');
    const parcial = await r.html('/clinicas?parcial=1');
    assert.ok(!parcial.includes('<nav') && !parcial.includes('<!doctype') && !parcial.includes('<script'), 'solo el contenido, sin la página');
    assert.match(parcial, /CLINICA-OK/);
    const entera = await r.html('/clinicas');
    assert.match(entera, /id="contenido"/);
    assert.match(entera, /\/clinicas\?parcial=1/, 'la página sabe a dónde pedir el contenido');
    assert.match(entera, /setInterval\(refrescar, 5000\)/, 'cada 5 s por defecto');
    assert.ok(!entera.includes('location.reload'), 'ni al renombrar ni periódicamente: actualiza solo la tabla');
    await r.latido(base(ID5, { host: 'CLINICA-NUEVA', estado: 'conectado' }));
    assert.match(await r.html('/clinicas?parcial=1'), /CLINICA-NUEVA/, 'un latido nuevo aparece en la siguiente petición');
    ok('actualización en vivo: la versión parcial (con contraseña) trae solo el contenido y refleja los latidos nuevos');

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

    // --- pedir diagnóstico desde la web: la petición viaja en la respuesta del latido
    const pedir = (id, cab = {}) => r.pedir('/clinicas/' + id + '/diagnostico', { method: 'POST', headers: cab });
    assert.match(await r.html('/clinicas?parcial=1'), /data-pedir="a1b2c3d4-0000-4000-8000-000000000001"/, 'botón «pedir diagnóstico»');
    assert.equal((await pedir(ID1, { Origin: 'https://otra-web.example' })).status, 403, 'otra web no puede pedir diagnósticos');
    assert.equal((await fetch(r.base + '/clinicas/' + ID1 + '/diagnostico', { method: 'POST' })).status, 401, 'sin contraseña no');
    assert.equal((await pedir('a1b2c3d4-ffff-4000-8000-00000000ffff')).status, 404, 'instalación desconocida');
    let resp = await (await r.latido(base(ID1, { host: 'CLINICA-OK' }))).json();
    assert.deepEqual(resp, { ok: true, diagnostico: null }, 'sin petición: el latido responde sin orden');
    assert.equal((await pedir(ID1, { Origin: r.base })).status, 200);
    const orden = (await (await r.latido(base(ID1, { host: 'CLINICA-OK' }))).json()).diagnostico;
    assert.ok(Number.isFinite(orden), 'el siguiente latido trae la orden');
    assert.equal((await (await r.latido(base(ID1, { host: 'CLINICA-OK' }))).json()).diagnostico, orden, 'sigue pendiente (misma orden) hasta que llegue el informe');
    assert.equal((await (await r.latido(base(ID2, { host: 'CLINICA-AVISO' }))).json()).diagnostico, null, 'las demás no reciben la orden');
    await pedir(ID1);
    assert.equal((await (await r.latido(base(ID1, { host: 'CLINICA-OK' }))).json()).diagnostico, orden, 'pedir otra vez no duplica: sigue la misma orden');
    let fila = (await r.html('/clinicas?parcial=1')).split('<tr>').find((f) => f.includes('CLINICA-OK'));
    assert.match(fila, /diagnóstico pedido/); assert.ok(!fila.includes('data-pedir'), 'pendiente: sin botón');
    assert.match(fila, /en el próximo latido/);
    // llega el informe (con el id de la instalación): cumple la petición y se enlaza a la fila
    const informe = { version: '2.5.0', estado: 'conectado', log: [], latido: { id: ID1 } };
    assert.equal((await fetch(r.base + '/diagnostico', { method: 'POST', body: JSON.stringify({ ...informe, host: 'CLINICA-OK' }) })).status, 200);
    assert.equal((await (await r.latido(base(ID1, { host: 'CLINICA-OK' }))).json()).diagnostico, null, 'cumplida: ya no se pide');
    fila = (await r.html('/clinicas?parcial=1')).split('<tr>').find((f) => f.includes('CLINICA-OK'));
    const enlace = /último diagnóstico: <a href="\/f\/([^"]+)">/.exec(fila);
    assert.ok(enlace, 'enlace al último diagnóstico'); assert.match(fila, /data-pedir/, 'vuelve el botón');
    assert.equal((await r.pedir('/f/' + enlace[1])).status, 200, 'el enlace abre el informe');
    // un informe de una instalación desconocida o sin id no rompe nada
    assert.equal((await fetch(r.base + '/diagnostico', { method: 'POST', body: JSON.stringify({ version: '2.5.0', log: [], latido: { id: 'a1b2c3d4-ffff-4000-8000-00000000ffff' } }) })).status, 200);
    assert.equal((await fetch(r.base + '/diagnostico', { method: 'POST', body: JSON.stringify({ version: '2.5.0', log: [] }) })).status, 200);
    ok('pedir diagnóstico: botón, solo con contraseña y origen propio, orden única en el latido, se cumple al llegar el informe y se enlaza');

    // --- historial de transiciones por instalacion
    await r.latido(base(ID2, { host: 'CLINICA-AVISO', estado: 'conectado' }));
    await r.latido(base(ID2, { host: 'CLINICA-AVISO', estado: 'degradado', causa: 'x' }));
    await r.latido(base(ID2, { host: 'CLINICA-AVISO', estado: 'conectado' }));
    pagina = await r.html('/clinicas?parcial=1');
    const filaAviso = pagina.split('<tr>').find((f) => f.includes('CLINICA-AVISO'));
    assert.match(filaAviso, /historial \(\d+\)/, 'hay desplegable de historial');
    const items = [...filaAviso.matchAll(/<li>[^<]*· (\w+)<\/li>/g)].map((m) => m[1]);
    // la más reciente primero: conectado (la última), degradado, conectado (la primera)
    assert.deepEqual(items.slice(0, 3), ['conectado', 'degradado', 'conectado'], 'orden: más reciente primero');
    const filaOk = pagina.split('<tr>').find((f) => f.includes('CLINICA-OK'));
    const idCerrada = 'a1b2c3d4-0000-4000-8000-00000000000b';
    await r.latido(base(idCerrada, { host: 'CLINICA-SIN-CAMBIOS', estado: 'conectado' }));
    const filaSinCambios = (await r.html('/clinicas?parcial=1')).split('<tr>').find((f) => f.includes('CLINICA-SIN-CAMBIOS'));
    assert.ok(filaSinCambios.includes('historial (1)'), 'el primer estado cuenta como una transición');
    assert.ok(filaOk && typeof filaOk === 'string', 'la fila OK existe');
    ok('historial: cada instalación muestra sus últimas transiciones en un desplegable');

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

  // --- disponibilidad por día: datos conocidos precargados (porcentajes, colores y detalle exactos)
  const dirDisp = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-disp-'));
  dirsTemporales.push(dirDisp);
  fs.mkdirSync(path.join(dirDisp, 'estado'), { recursive: true });
  const diaHace = (n) => new Date(Date.now() - n * 24 * 3600e3).toLocaleDateString('sv-SE', { timeZone: process.env.TZ || 'Europe/Madrid' });
  const H = 3600e3;
  fs.writeFileSync(path.join(dirDisp, 'estado', 'clinicas.json'), JSON.stringify({
    [ID1]: { id: ID1, alias: null, host: 'CLINICA-DISP', estado: 'apagada', ultimo: Date.now(), cambios: [],
      dias: {
        [diaHace(3)]: { ok: 24 * H },                                                    // 100 %  -> verde
        [diaHace(2)]: { ok: 22 * H, warning: 2 * H },                                    // 91,7 % -> ámbar
        [diaHace(1)]: { ok: 12 * H, offline: 12 * H },                                   // 50 %   -> rojo
        [diaHace(5)]: { apagada: 24 * H }                                                // solo apagada -> sin datos
      } }
  }));
  r = await arrancar({ dir: dirDisp, env: { OFFLINE_MIN: '60' } });
  try {
    const pag = await r.html('/clinicas?parcial=1');
    const cas = (n) => new RegExp(`<span class="dia ([\\w-]+)" title="${diaHace(n)}: ([^"]*)"`).exec(pag);
    assert.equal(cas(3)[1], 'd-ok'); assert.match(cas(3)[2], /100,0 % disponible/);
    assert.equal(cas(2)[1], 'd-aviso'); assert.match(cas(2)[2], /91,7 % disponible.*con problemas 2 h 0 min/);
    assert.equal(cas(1)[1], 'd-mal'); assert.match(cas(1)[2], /50,0 % disponible.*sin señal 12 h 0 min/);
    assert.equal(cas(5)[1], 'sd', 'un día solo apagada no cuenta como indisponible'); assert.match(cas(5)[2], /sin datos/);
    assert.equal(cas(7)[1], 'sd'); // un día sin ningún dato
    assert.match(pag, /Últimos 14 días/);
    assert.match(pag, /\d+,\d % en 14 días/, 'resumen de 14 días');
    ok('disponibilidad: porcentaje, color (verde ≥99 %, ámbar ≥90 %, rojo) y detalle por día; apagada no cuenta como caída');
  } finally { await r.parar(); }

  // --- disponibilidad por día: acumulación real con latidos y un hueco sin señal
  r = await arrancar({ env: { OFFLINE_MIN: '0.02', HORA_INI: '0', HORA_FIN: '24' } }); // 1,2 s; todo el día, para que no dependa de la hora de la prueba
  dirsTemporales.push(r.dir);
  try {
    const leer = () => JSON.parse(fs.readFileSync(path.join(r.dir, 'estado', 'clinicas.json'), 'utf8'))[ID1].dias;
    const hoy = new Date().toLocaleDateString('sv-SE', { timeZone: process.env.TZ || 'Europe/Madrid' });
    await r.latido(base(ID1, { estado: 'conectado' }));
    await pausa(600);
    await r.latido(base(ID1, { estado: 'degradado', causa: 'x' })); // los 600 ms anteriores eran «ok»
    await pausa(600);
    await r.latido(base(ID1, { estado: 'conectado' }));              // los 600 ms anteriores eran «con problemas»
    await pausa(2500);                                              // hueco > 1,2 s
    await r.latido(base(ID1, { estado: 'conectado' }));
    const d = leer()[hoy];
    // ok = 600 ms del primer tramo + 1200 ms del hueco que aún cubre el último latido «conectado»
    assert.ok(d.ok >= 1500 && d.ok < 2800, 'ok ≈ 600 + 1200 ms: ' + d.ok);
    assert.ok(d.warning >= 500 && d.warning < 1500, 'con problemas ≈ 600 ms: ' + d.warning);
    assert.ok(d.offline >= 1000 && d.offline < 2500, 'el hueco más allá de 1,2 s cuenta como sin señal: ' + d.offline);
    ok('disponibilidad: el tiempo entre latidos se atribuye al estado anterior y el hueco largo cuenta como sin señal');
  } finally { await r.parar(); }

  // --- una petición de diagnóstico sin atender caduca al día
  const dirOrden = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-orden-'));
  dirsTemporales.push(dirOrden);
  fs.mkdirSync(path.join(dirOrden, 'estado'), { recursive: true });
  fs.writeFileSync(path.join(dirOrden, 'estado', 'clinicas.json'), JSON.stringify({
    [ID1]: { id: ID1, alias: null, host: 'VIEJA', estado: 'conectado', ultimo: Date.now(), cambios: [], orden: { id: 1, t: Date.now() - 25 * 3600e3 } },
    [ID2]: { id: ID2, alias: null, host: 'RECIENTE', estado: 'conectado', ultimo: Date.now(), cambios: [], orden: { id: 2, t: Date.now() - 3600e3 } }
  }));
  r = await arrancar({ dir: dirOrden });
  try {
    assert.equal((await (await r.latido(base(ID1, { host: 'VIEJA' }))).json()).diagnostico, null, 'una petición de hace 25 h ha caducado');
    assert.equal((await (await r.latido(base(ID2, { host: 'RECIENTE' }))).json()).diagnostico, 2, 'una de hace 1 h sigue vigente');
    ok('las peticiones de diagnóstico sin atender caducan a las 24 h');
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
