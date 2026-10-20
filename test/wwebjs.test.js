// Prueba de la «foto» de la pagina (motores/wwebjs.js: sondaPagina) con Chromium de verdad y paginas
// simuladas. En la CI no se descarga Chromium (PUPPETEER_SKIP_DOWNLOAD): ahi se omite.
// Uso: npm test
const fs = require('fs');
const assert = require('assert');
const { sondaPagina, pulsarUsarAqui, cerrarPestanasDuplicadas } = require('../motores/wwebjs');

const ok = (n) => console.log('OK  ' + n);

(async () => {
  let puppeteer, ruta;
  try { puppeteer = require('puppeteer'); ruta = puppeteer.executablePath(); } catch (_) { /* sin puppeteer */ }
  if (!ruta || !fs.existsSync(ruta)) {
    console.log('OMITIDO: pruebas de la foto de la página (no hay Chromium descargado)');
    return;
  }
  const navegador = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const pagina = await navegador.newPage();

    // pantalla «abierto en otra ventana», con la app de WhatsApp presente y un nombre de paciente en pantalla
    await pagina.setContent(`<html><head><title>(3) WhatsApp</title></head><body>
      <p>WhatsApp está abierto en otra ventana. Haz clic en «Usar aquí» para usarlo en esta ventana.</p>
      <canvas></canvas><div>Paciente Ana López Martínez 612345678</div></body></html>`);
    await pagina.evaluate(() => { window.Debug = { VERSION: '2.3000.1023456789' }; });
    const foto = await sondaPagina(pagina);
    assert.equal(foto.readyState, 'complete');
    assert.equal(foto.appWhatsApp, true);
    assert.equal(foto.versionWeb, '2.3000', 'versión recortada (el número largo parecería un teléfono)');
    assert.equal(foto.titulo, 'WhatsApp', 'sin el contador de no leídos');
    assert.equal(foto.qr, true);
    assert.equal(foto.pantallas.usarAqui, true);
    assert.equal(foto.pantallas.actualizar, false);
    assert.ok(foto.temporizador500ms >= 450 && foto.temporizador500ms < 2000, 'temporizador ≈ 500 ms: ' + foto.temporizador500ms);
    const json = JSON.stringify(foto);
    assert.ok(!json.includes('Ana') && !json.includes('612345678'), 'el texto de la página nunca sale en la foto');
    ok('foto: detecta «Usar aquí», la app y su versión, el QR y el título sin no leídos; mide el temporizador; no saca el texto');

    // sin la app de WhatsApp (p. ej. pantalla de navegador no compatible); pagina nueva (setContent conserva window)
    await pagina.goto('about:blank');
    await pagina.setContent('<html><head><title>WhatsApp</title></head><body>Este navegador no es compatible. Actualiza Google Chrome.</body></html>');
    const sinApp = await sondaPagina(pagina);
    assert.equal(sinApp.appWhatsApp, false);
    assert.equal(sinApp.versionWeb, null);
    assert.equal(sinApp.pantallas.actualizar, true);
    assert.equal(sinApp.qr, false);
    ok('foto: sin la app de WhatsApp y con la pantalla de «actualiza el navegador»');

    // pagina bloqueada (hilo principal ocupado): no se espera para siempre, y eso mismo es el dato
    pagina.evaluate(() => { const fin = Date.now() + 9000; while (Date.now() < fin) { /* bloqueo */ } }).catch(() => {});
    const t0 = Date.now();
    const bloqueada = await sondaPagina(pagina);
    assert.deepEqual(bloqueada, { sinRespuesta6s: true });
    assert.ok(Date.now() - t0 < 7500, 'responde en ~6 s aunque la página siga bloqueada');
    ok('foto: con la página bloqueada devuelve «sin respuesta en 6 s» en vez de colgarse');

    // «Usar aquí»: la app lo pulsa sola (en español y en inglés); sin el botón no toca nada
    for (const texto of ['Usar aquí', 'Use here']) {
      await pagina.goto('about:blank');
      await pagina.setContent(`<p>WhatsApp está abierto en otra ventana.</p><button onclick="window.pulsado = true"><div>  ${texto}  </div></button><button onclick="window.otro = true">Cerrar</button>`);
      assert.equal(await pulsarUsarAqui(pagina), true, texto);
      assert.equal(await pagina.evaluate(() => window.pulsado === true && !window.otro), true, 'pulsa ese botón y no otro');
    }
    await pagina.goto('about:blank');
    await pagina.setContent('<button onclick="window.pulsado = true">Usar aquí otra vez</button><div role="button">Conectar</div>');
    assert.equal(await pulsarUsarAqui(pagina), false, 'solo el texto exacto');
    assert.equal(await pagina.evaluate(() => window.pulsado === true), false);
    assert.equal(await pulsarUsarAqui(null), false);
    ok('«Usar aquí»: lo pulsa sola (español e inglés), solo ese botón y solo con el texto exacto');

    // dos pestañas de WhatsApp Web en el mismo navegador (la nuestra y una «restaurada») y una ajena;
    // web.whatsapp.com se simula interceptando la petición, sin red
    const abrirWhatsApp = async () => {
      const p = await navegador.newPage();
      await p.setRequestInterception(true);
      p.on('request', (r) => r.respond({ status: 200, contentType: 'text/html', body: '<title>WhatsApp</title><p>WhatsApp</p>' }));
      await p.goto('https://web.whatsapp.com/');
      return p;
    };
    const propia = await abrirWhatsApp();
    const restaurada = await abrirWhatsApp();
    const ajena = await navegador.newPage();
    let conPestanas = await sondaPagina(propia, navegador);
    assert.equal(conPestanas.pestanas.whatsapp, 2, 'cuenta las dos de WhatsApp Web');
    assert.ok(conPestanas.pestanas.total >= 3);
    assert.equal(await cerrarPestanasDuplicadas(navegador, propia), 1, 'cierra solo la otra de WhatsApp');
    assert.equal(propia.isClosed(), false, 'la nuestra sigue abierta');
    assert.equal(restaurada.isClosed(), true);
    assert.equal(ajena.isClosed(), false, 'las que no son de WhatsApp no se tocan');
    conPestanas = await sondaPagina(propia, navegador);
    assert.equal(conPestanas.pestanas.whatsapp, 1);
    assert.equal(await cerrarPestanasDuplicadas(navegador, propia), 0, 'sin duplicadas no hace nada');
    assert.equal(await cerrarPestanasDuplicadas(null, propia), 0);
    ok('pestañas: la foto las cuenta; se cierra la otra de WhatsApp Web, nunca la nuestra ni las ajenas');

    assert.deepEqual(await sondaPagina(null), { pagina: false });
    console.log('\nTODAS LAS PRUEBAS DE LA FOTO DE LA PÁGINA PASAN');
  } finally {
    await navegador.close().catch(() => {});
  }
})().catch((e) => { console.error('FALLO:', e); process.exit(1); });
