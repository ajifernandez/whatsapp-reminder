const $ = (id) => document.getElementById(id);

const CAMPOS = ['nombre', 'telefono', 'fecha', 'hora', 'especialidad'];
let citas = [];
let conectado = false;
let config = { mensaje: '', autoEnvio: false };

// ---------- Capa de acceso al servidor ----------
const api = {
  listarCitas: () => fetch('/api/citas').then((r) => r.json()),
  guardarCitas: (c) => fetch('/api/citas', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(c)
  }),
  config: () => fetch('/api/config').then((r) => r.json()),
  guardarConfig: (c) => fetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(c)
  }).then((r) => r.json()),
  conectar: () => fetch('/api/conectar', { method: 'POST' }),
  cerrarSesion: () => fetch('/api/cerrar', { method: 'POST' }),
  cambiarMotor: (motor) => fetch('/api/motor', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ motor })
  }).then(async (r) => {
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'No se pudo cambiar el motor');
    return data;
  }),
  pedirCodigo: (telefono) => fetch('/api/vincular-codigo', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ telefono })
  }).then(async (r) => {
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'No se pudo obtener el código');
    return data.codigo;
  }),
  enviar: (c) => fetch('/api/enviar', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(c)
  }).then(async (r) => {
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Error al enviar');
    return data;
  }),
  estado: () => fetch('/api/estado').then((r) => r.json()),
  buscarActualizacion: () => fetch('/api/actualizacion').then(async (r) => {
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'No se pudo comprobar');
    return data;
  }),
  versiones: () => fetch('/api/versiones').then(async (r) => {
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'No se pudo obtener la lista');
    return data;
  }),
  cambiarVersion: (version) => fetch('/api/version', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version })
  }).then(async (r) => {
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'No se pudo cambiar de versión');
    return data;
  }),
  actualizar: () => fetch('/api/actualizar', { method: 'POST' }).then(async (r) => {
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'No se pudo actualizar');
    return data;
  })
};

// El parseo (pegado Excel/CSV y texto libre de PDF/OCR) vive en parser.js,
// que se carga antes que este archivo y es testeable en Node.

function normalizarCitaOCR(cita) {
  if (!cita || typeof cita !== 'object') return cita;

  const limpia = { ...cita };
  const especialidad = String(limpia.especialidad || '').trim();

  if (!limpia.hora && especialidad) {
    const horaDesdeEspecialidad = normalizarHora(especialidad);
    if (/^\d{2}:\d{2}$/.test(horaDesdeEspecialidad)) {
      limpia.hora = horaDesdeEspecialidad;
      limpia.especialidad = '';
    }
  }

  if (limpia.hora) {
    const horaNormalizada = normalizarHora(limpia.hora);
    if (/^\d{2}:\d{2}$/.test(horaNormalizada)) limpia.hora = horaNormalizada;
  }

  if (especialidad) {
    const horaResidual = normalizarHora(especialidad);
    if (/^\d{2}:\d{2}$/.test(horaResidual) || /^[-–—_:.,/\\]+$/.test(especialidad)) {
      limpia.especialidad = '';
      if (!limpia.hora) limpia.hora = horaResidual;
    }
  }

  return limpia;
}

// ---------- Render de la tabla ----------
// pinta la celda de estado de una fila: ✔ enviado, ✖ fallido/omitido, vacío si pendiente
function pintarEstado(tr, cita) {
  const td = tr.children[CAMPOS.length];
  if (!td) return;
  const estado = cita.estadoEnvio || (cita.recordatorioEnviado ? 'enviado' : '');
  td.className = 'estado-envio';
  if (estado === 'enviado') { td.textContent = '✔'; td.classList.add('ok'); td.title = 'Recordatorio enviado'; }
  else if (estado === 'fallido') { td.textContent = '✖'; td.classList.add('error'); td.title = 'El envío falló'; }
  else if (estado === 'omitido') { td.textContent = '✖'; td.classList.add('error'); td.title = 'Número no válido o sin WhatsApp'; }
  else { td.textContent = ''; td.title = ''; }
}

const DIAS_PREVIEW = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
const MESES_PREVIEW = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

function limpiarPreviewString(str) {
  if (!str) return '';
  return String(str).replace(/[\u200e\u200f\u202a-\u202e]/g, '').replace(/\s+/g, ' ').trim();
}

function formatearFechaPreview(fecha) {
  const limpia = limpiarPreviewString(fecha);

  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(limpia);
  if (m) {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    if (d.getMonth() === Number(m[2]) - 1 && d.getDate() === Number(m[3])) {
      return `${DIAS_PREVIEW[d.getDay()]} ${d.getDate()} ${MESES_PREVIEW[d.getMonth()]}`;
    }
  }

  m = /^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/.exec(limpia);
  if (m) {
    const d = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
    if (d.getMonth() === Number(m[2]) - 1 && d.getDate() === Number(m[1])) {
      return `${DIAS_PREVIEW[d.getDay()]} ${d.getDate()} ${MESES_PREVIEW[d.getMonth()]}`;
    }
  }

  return limpia;
}

function normalizarHoraPreview(horaStr) {
  let limpia = limpiarPreviewString(horaStr).toLowerCase();
  if (!limpia) return null;

  const match12 = /^(\d{1,2}):(\d{2})\s*(am|pm|a\.\s*m\.|p\.\s*m\.)?$/.exec(limpia);
  if (match12) {
    let horas = parseInt(match12[1], 10);
    const minutos = match12[2];
    const sufijo = match12[3];

    if (sufijo) {
      if ((sufijo.includes('p') || sufijo.includes('pm')) && horas < 12) horas += 12;
      if ((sufijo.includes('a') || sufijo.includes('am')) && horas === 12) horas = 0;
    }
    return `${String(horas).padStart(2, '0')}:${minutos}`;
  }
  return limpia;
}

function formatearMensajePreview(cita, plantilla) {
  const valores = {
    nombre: limpiarPreviewString(cita.nombre),
    telefono: limpiarPreviewString(cita.telefono),
    fecha: cita.fecha ? formatearFechaPreview(cita.fecha) : '',
    hora: normalizarHoraPreview(cita.hora) || '',
    especialidad: limpiarPreviewString(cita.especialidad) || 'salud'
  };

  return plantilla.replace(/\{(nombre|telefono|fecha|hora|especialidad)\}/gi, (_match, campo) => valores[campo.toLowerCase()] ?? '');
}

function actualizarPreviewMensaje() {
  const preview = $('mensajePreview');
  if (!preview) return;

  if (citas.length === 0) {
    preview.textContent = 'Añade o importa una cita para ver la vista previa.';
    preview.classList.add('vacio-preview');
    return;
  }

  const plantilla = $('mensajePlantilla').value || config.mensaje || '';
  const texto = formatearMensajePreview(citas[0], plantilla);
  preview.textContent = texto || 'La plantilla está vacía.';
  preview.classList.toggle('vacio-preview', !texto);
}

function pintarTabla() {
  const tbody = $('tbody');
  tbody.innerHTML = '';

  citas.forEach((cita, idx) => {
    const tr = document.createElement('tr');

    CAMPOS.forEach((campo) => {
      const td = document.createElement('td');
      const input = document.createElement('input');
      input.type = campo === 'fecha' ? 'date' : campo === 'hora' ? 'time' : 'text';
      input.value = cita[campo] || '';
      input.placeholder = campo === 'telefono' ? '34612345678' : '';
      input.addEventListener('input', () => {
        citas[idx][campo] = input.value;
        // al corregir teléfono/fecha/hora se borra el resultado anterior para poder reenviar
        if (campo !== 'nombre' && campo !== 'especialidad') {
          delete citas[idx].estadoEnvio;
          delete citas[idx].recordatorioEnviado;
          pintarEstado(tr, citas[idx]);
        }
        guardar();
        actualizarPreviewMensaje();
      });
      td.appendChild(input);
      tr.appendChild(td);
    });

    const tdEstado = document.createElement('td');
    tr.appendChild(tdEstado);
    pintarEstado(tr, cita);

    const tdBorrar = document.createElement('td');
    const btn = document.createElement('button');
    btn.className = 'btn-borrar';
    btn.textContent = '🗑';
    btn.title = 'Borrar cita';
    btn.addEventListener('click', () => {
      citas.splice(idx, 1);
      guardar();
      pintarTabla();
    });
    tdBorrar.appendChild(btn);
    tr.appendChild(tdBorrar);

    tbody.appendChild(tr);
  });

  $('vacio').classList.toggle('oculto', citas.length > 0);
  actualizarBotonEnviar();
  actualizarPreviewMensaje();
}

let guardarTimer = null;
function guardar() {
  // pequeño debounce para no golpear el servidor en cada tecla
  clearTimeout(guardarTimer);
  guardarTimer = setTimeout(() => api.guardarCitas(citas), 300);
}

let guardarConfigTimer = null;
async function guardarMensajeAhora() {
  clearTimeout(guardarConfigTimer);
  config.mensaje = $('mensajePlantilla').value;
  config = await api.guardarConfig(config);
  $('mensajePlantilla').value = config.mensaje;
  actualizarPreviewMensaje();
}

function guardarMensaje() {
  actualizarPreviewMensaje();
  clearTimeout(guardarConfigTimer);
  guardarConfigTimer = setTimeout(() => {
    guardarMensajeAhora().catch((err) => log(err.message, 'error'));
  }, 300);
}

function actualizarBotonEnviar() {
  $('btnEnviar').disabled = !conectado || citas.length === 0;
  $('btnVaciar').disabled = citas.length === 0;
}

// ---------- Registro ----------
// Aviso efímero en pantalla (el log solo queda abajo, fuera de la vista).
function toast(texto, tipo = 'info') {
  const t = document.createElement('div');
  t.className = `toast ${tipo}`;
  t.textContent = texto;
  $('toasts').appendChild(t);
  setTimeout(() => t.remove(), 5000);
}

function log(texto, tipo = 'info') {
  const li = document.createElement('li');
  li.className = tipo;
  const hora = new Date().toLocaleTimeString('es-ES');
  li.textContent = `[${hora}] ${texto}`;
  if (tipo === 'error') {
    li.classList.add('log-clicable');
    li.title = 'Clic para ver cómo arreglarlo';
    li.addEventListener('click', () => mostrarBannerError(texto));
  }
  $('log').prepend(li);
  if (tipo === 'error') mostrarBannerError(texto);
}

// ---------- Diccionario de errores conocidos ----------
// Cada entrada: patrón que reconoce el texto del error (tal cual llega del
// backend) y pasos en lenguaje simple para resolverlo, sin jerga técnica.
const GUIA_ERRORES = [
  {
    patron: /no se pudo generar el qr/i,
    titulo: 'No se pudo generar el código QR',
    pasos: [
      'Pulsa <b>Cerrar sesión</b> y luego <b>Conectar WhatsApp</b> otra vez.',
      'Comprueba que tienes conexión a internet.',
      'Si sigue fallando, cierra la aplicación por completo y vuelve a abrirla.',
    ],
  },
  {
    patron: /error de autenticación/i,
    titulo: 'Fallo al autenticar con WhatsApp',
    pasos: [
      'El vínculo con tu WhatsApp ha caducado o se ha roto.',
      'Pulsa <b>Cerrar sesión</b>, luego <b>Conectar WhatsApp</b> y escanea el QR de nuevo.',
    ],
  },
  {
    patron: /sesión desconectada/i,
    titulo: 'WhatsApp se ha desconectado',
    pasos: [
      'Puede deberse a que desvinculaste el dispositivo desde el móvil (WhatsApp → Dispositivos vinculados).',
      'Pulsa <b>Conectar WhatsApp</b> y vincula de nuevo escaneando el QR.',
    ],
  },
  {
    patron: /no se pudo limpiar cache/i,
    titulo: 'No se pudo limpiar la caché interna',
    pasos: [
      'Cierra la aplicación por completo.',
      'Vuelve a abrirla e inténtalo de nuevo.',
      'Si persiste, puede que otro proceso tenga el archivo abierto: reinicia el ordenador.',
    ],
  },
  {
    patron: /no es válido o no tiene whatsapp/i,
    titulo: 'Número no válido o sin WhatsApp',
    pasos: [
      'Revisa que el teléfono tenga el prefijo de país (ej. <code>34</code> para España).',
      'Confirma que ese número tiene WhatsApp instalado.',
      'Corrígelo en la tabla de citas y vuelve a enviar solo esa fila.',
    ],
  },
  {
    patron: /enoent|no such file|executablepath|chrome|chromium/i,
    titulo: 'No se encuentra el navegador interno (Chrome/Chromium)',
    pasos: [
      'La app necesita un Chrome/Chromium instalado para conectar con WhatsApp.',
      'Cierra la aplicación y reinstala las dependencias con <code>npm install</code> (o pide ayuda técnica si no sabes usar la consola).',
      'Si acabas de mover la carpeta de la aplicación a otro sitio, vuelve a instalarla desde cero.',
    ],
  },
  {
    patron: /net::err|enotfound|econnrefused|timeout|timed out/i,
    titulo: 'Problema de conexión a internet',
    pasos: [
      'Comprueba que el ordenador tiene internet.',
      'Espera un minuto y pulsa <b>Conectar WhatsApp</b> de nuevo.',
      'Si usas una red de empresa, puede que un firewall bloquee la conexión: consulta con tu soporte técnico.',
    ],
  },
  {
    patron: /protocol error|execution context was destroyed|session closed|target closed/i,
    titulo: 'La conexión interna con WhatsApp se cortó',
    pasos: [
      'Esto suele pasar si el ordenador se quedó sin memoria o se cerró de golpe.',
      'Cierra la aplicación por completo y vuelve a abrirla.',
      'Pulsa <b>Conectar WhatsApp</b> otra vez.',
    ],
  },
];

function buscarGuiaError(texto) {
  return GUIA_ERRORES.find((g) => g.patron.test(texto)) || null;
}

function mostrarBannerError(texto) {
  const guia = buscarGuiaError(texto);
  $('bannerError').classList.remove('oculto');
  $('bannerErrorTexto').textContent = texto;
  const detalle = $('bannerErrorDetalle');
  const pasosHtml = (guia ? guia.pasos : [
    'Vuelve a intentar la acción que falló.',
    'Si se repite, cierra la aplicación por completo y ábrela de nuevo.',
    'Si sigue sin funcionar, revisa el archivo <code>data/app.log</code> (tiene el detalle técnico) o pide ayuda mostrando ese archivo.',
  ]).map((p) => `<li>${p}</li>`).join('');
  detalle.innerHTML = `
    <h3>${guia ? guia.titulo : 'No hemos reconocido este error automáticamente'}</h3>
    <ol>${pasosHtml}</ol>
    <button id="btnCopiarError" class="btn btn-gris pequeno banner-error-copiar">📋 Copiar detalle técnico</button>
  `;
  const btnCopiar = document.getElementById('btnCopiarError');
  if (btnCopiar) {
    btnCopiar.addEventListener('click', () => {
      navigator.clipboard?.writeText(texto).then(() => {
        btnCopiar.textContent = '✅ Copiado';
        setTimeout(() => { btnCopiar.textContent = '📋 Copiar detalle técnico'; }, 1500);
      }).catch(() => {});
    });
  }
}

$('btnBannerFix').addEventListener('click', () => {
  $('bannerErrorDetalle').classList.toggle('oculto');
});
$('btnBannerCerrar').addEventListener('click', () => {
  $('bannerError').classList.add('oculto');
  $('bannerErrorDetalle').classList.add('oculto');
});

// ---------- Estado de conexión ----------
let temporizadorConectando = null;

function detenerTemporizadorConectando() {
  if (temporizadorConectando) {
    clearInterval(temporizadorConectando);
    temporizadorConectando = null;
  }
}

// Mientras se conecta, avisa cuánto lleva esperando: arrancar el navegador
// interno y restaurar la sesión puede tardar 30-40s la primera vez, y sin
// esta cuenta atrás parece que la app se ha colgado.
function iniciarTemporizadorConectando() {
  detenerTemporizadorConectando();
  const inicio = Date.now();
  const actualizar = () => {
    const s = Math.round((Date.now() - inicio) / 1000);
    let texto = `Conectando... (${s}s)`;
    if (s >= 8) texto += ' — puede tardar hasta 90s la primera vez';
    if (s >= 85) texto += ', si se pasa de ese tiempo se cancelará sola';
    $('estadoTexto').textContent = texto;
  };
  actualizar();
  temporizadorConectando = setInterval(actualizar, 1000);
}

function setEstado(estado) {
  $('estadoPunto').className = 'punto ' + estado;
  const mapa = {
    conectado: 'Conectado',
    desconectado: 'Desconectado — pulsa «Conectar WhatsApp»',
    conectando: 'Conectando...',
    error: 'Error — revisa el aviso de abajo',
  };

  if (estado === 'conectando') {
    iniciarTemporizadorConectando();
  } else {
    detenerTemporizadorConectando();
    $('estadoTexto').textContent = mapa[estado] || estado;
  }

  conectado = estado === 'conectado';
  $('btnCerrar').disabled = !conectado;
  $('btnConectar').disabled = estado === 'conectando' || conectado;
  if (conectado) $('qrCaja').classList.add('oculto');
  actualizarBotonEnviar();
}

// ---------- Eventos de botones ----------
$('btnAnadir').addEventListener('click', () => {
  citas.push({ nombre: '', telefono: '', fecha: '', hora: '', especialidad: '' });
  guardar();
  pintarTabla();
  const inputs = $('tbody').querySelectorAll('tr:last-child input');
  if (inputs.length) inputs[0].focus();
});

$('btnVaciar').addEventListener('click', () => {
  if (citas.length === 0) return;
  if (!confirm(`¿Borrar las ${citas.length} cita(s) de la lista?`)) return;
  citas = [];
  guardar();
  pintarTabla();
  log('Lista de citas vaciada.', 'info');
});

$('btnConectar').addEventListener('click', () => {
  setEstado('conectando');
  log('Iniciando conexión con WhatsApp...', 'info');
  api.conectar();
});

$('btnCerrar').addEventListener('click', () => api.cerrarSesion());

// Selector de motor: cada uno tiene su propia vinculación con el móvil.
let motorActual = null;
function pintarMotores(actual, motores) {
  motorActual = actual;
  $('selMotor').innerHTML = motores.map((m) => `<option value="${m.id}"${m.id === actual ? ' selected' : ''}>${m.nombre}${m.vinculado ? ' · vinculado' : ''}</option>`).join('');
  // vincular con código: solo el motor Baileys lo admite
  $('vincularCodigo').classList.toggle('oculto', actual !== 'baileys');
}

$('selMotor').addEventListener('change', async () => {
  const sel = $('selMotor');
  const nuevo = sel.value;
  const aviso = conectado ? ' Se cortará la conexión actual.' : '';
  if (!confirm(`¿Cambiar el motor de WhatsApp?${aviso} Si el nuevo motor no está vinculado, habrá que vincular el móvil.`)) {
    sel.value = motorActual;
    return;
  }
  try {
    const r = await api.cambiarMotor(nuevo);
    pintarMotores(r.motor, r.motores);
    $('qrCaja').classList.add('oculto');
    toast('Motor cambiado.', 'ok');
  } catch (err) {
    sel.value = motorActual;
    toast(err.message, 'error');
  }
});

// Cierre controlado: mejor que cerrar la ventana negra, que puede dejar procesos colgados.
$('btnApagar').addEventListener('click', async () => {
  if (!confirm('¿Apagar la aplicación? Mientras esté apagada no se enviarán recordatorios (tampoco los automáticos).')) return;
  try {
    const r = await fetch('/api/apagar', { method: 'POST' });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'No se pudo apagar');
    document.querySelector('main').innerHTML = '<section class="tarjeta"><h2>Aplicación apagada</h2>'
      + '<p>Se ha cerrado correctamente. Ya puedes cerrar esta pestaña.</p>'
      + '<p>Para volver a usarla, abre <b>Iniciar</b> de nuevo.</p></section>';
    $('estadoTexto').textContent = 'Apagada';
    $('estadoPunto').className = 'punto desconectado';
    for (const b of document.querySelectorAll('header button, header select')) b.disabled = true;
  } catch (err) {
    toast('No se pudo apagar: ' + err.message, 'error');
  }
});

$('btnCodigo').addEventListener('click', async () => {
  const btn = $('btnCodigo');
  btn.disabled = true;
  try {
    const codigo = await api.pedirCodigo($('telVincular').value);
    // formato del móvil: XXXX-XXXX
    $('codigoVincular').textContent = codigo.length === 8 ? codigo.slice(0, 4) + '-' + codigo.slice(4) : codigo;
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
});

$('btnEnviar').addEventListener('click', async () => {
  if (!conectado) return;
  const validas = citas.filter((c) => c.telefono && c.fecha && c.hora);
  if (validas.length === 0) {
    log('No hay citas completas para enviar (faltan teléfono/fecha/hora).', 'aviso');
    return;
  }
  if (!confirm(`¿Enviar ${validas.length} recordatorio(s) por WhatsApp?`)) return;

  $('btnEnviar').disabled = true;
  $('progresoCaja').classList.remove('oculto');
  $('barraRelleno').style.width = '0%';
  $('progresoTexto').textContent = `0 / ${citas.length}`;

  // estimación simple: ~3.7s de pausa media entre mensajes + 30s cada 20 (pausa larga)
  const n = validas.length;
  const segundosEstimados = Math.round(n * 3.7 + Math.floor(n / 20) * 30);
  if (segundosEstimados >= 20) {
    const minutos = Math.ceil(segundosEstimados / 60);
    log(`Enviando ${n} recordatorio(s), con pausas de seguridad: puede tardar unos ${minutos} minuto(s).`, 'info');
  }

  try {
    await guardarMensajeAhora();
    const r = await api.enviar(citas);
    log(`Terminado: ${r.enviados} enviados, ${r.fallidos} fallidos, ${r.omitidos} omitidos.`,
      r.fallidos > 0 ? 'aviso' : 'ok');
  } catch (err) {
    log(err.message, 'error');
  } finally {
    $('btnEnviar').disabled = false;
    setTimeout(() => $('progresoCaja').classList.add('oculto'), 1500);
  }
});

$('btnLimpiarLog').addEventListener('click', () => { $('log').innerHTML = ''; });

// El servidor deja el resultado en el log (pagina y app.log); aqui solo se avisa con un toast.
$('btnActualizar').addEventListener('click', async () => {
  const btn = $('btnActualizar');
  btn.disabled = true;
  try {
    toast('Comprobando actualizaciones...');
    const r = await api.actualizar();
    if (r.actualizado) toast(`Actualizado a la versión ${r.version}. Cierra y vuelve a abrir la aplicación.`, 'ok');
    else if (r.fijada) toast(`Versión fijada en ${r.version}: no se actualiza sola.`, 'aviso');
    else if (r.nuevaMayor) toast(`Hay una versión mayor nueva (${r.nuevaMayor}). No se instala sola: elígela en «Versión…».`, 'aviso');
    else toast(`Ya tienes la última versión (${r.version}).`, 'ok');
  } catch (err) {
    toast('No se pudo actualizar: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
  }
});

// Selector de versión (downgrade de emergencia). Se rellena al cargar; sin conexión queda desactivado.
async function cargarVersiones() {
  const sel = $('selVersion');
  try {
    const { actual, fijada, versiones } = await api.versiones();
    sel.innerHTML = '<option value="">Versión…</option>'
      + `<option value="latest">${fijada ? 'Última (automática)' : 'Última versión'}</option>`
      + versiones.filter((v) => v !== actual).map((v) => `<option value="${v}">${v}</option>`).join('');
    sel.disabled = false;
    if (fijada) {
      $('versionTexto').textContent = `v${actual} 🔒`;
      $('versionTexto').title = 'Versión fijada: no se actualiza sola. Elige «Última (automática)» para volver.';
    }
  } catch (_) { /* sin conexion: ignorar */ }
}

// Soporte remoto: el servidor envia el informe a soporte. Si no hay envio directo
// o falla (p. ej. sin internet), se descarga el informe y se abre el correo para adjuntarlo.
const EMAIL_SOPORTE = 'agustinjf87@gmail.com';
$('btnDiagnostico').addEventListener('click', async () => {
  const btn = $('btnDiagnostico');
  btn.disabled = true;
  try {
    const r = await fetch('/api/enviar-diagnostico', { method: 'POST' });
    if (r.ok) return toast('Diagnóstico enviado a soporte. Gracias.', 'ok');
    const motivo = (await r.json().catch(() => ({}))).error;
    if (r.status !== 501) log('No se pudo enviar directamente (' + motivo + '). Se usa el correo.', 'aviso');

    const d = await fetch('/api/diagnostico').then((x) => x.json());
    const nombre = `diagnostico-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.json`;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' }));
    a.download = nombre;
    a.click();
    URL.revokeObjectURL(a.href);
    const asunto = `Diagnóstico Recordatorios WhatsApp v${d.version}`;
    const cuerpo = `Hola,\n\nAdjunto el fichero ${nombre} (está en la carpeta de Descargas).\n\nEstado: ${d.estado}\n`;
    log(`Informe descargado (${nombre}). Se abre el correo: adjunta ese fichero y envíalo.`, 'info');
    location.href = `mailto:${EMAIL_SOPORTE}?subject=${encodeURIComponent(asunto)}&body=${encodeURIComponent(cuerpo)}`;
  } catch (err) {
    log('No se pudo generar el diagnóstico: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
  }
});

$('selVersion').addEventListener('change', async () => {
  const sel = $('selVersion');
  const v = sel.value;
  if (!v) return;
  const txt = v === 'latest' ? 'la última versión y activar las actualizaciones automáticas' : `la versión ${v} (se desactivan las actualizaciones automáticas)`;
  if (!confirm(`¿Instalar ${txt}?`)) { sel.value = ''; return; }
  sel.disabled = true;
  try {
    toast(`Instalando ${v === 'latest' ? 'la última versión' : 'la versión ' + v}... puede tardar un minuto.`);
    await api.cambiarVersion(v);
    toast('Hecho. Cierra y vuelve a abrir la aplicación para aplicar los cambios.', 'ok');
  } catch (err) {
    log('No se pudo cambiar de versión: ' + err.message, 'error');
  } finally {
    cargarVersiones();
  }
});

$('mensajePlantilla').addEventListener('input', guardarMensaje);

$('chkAutoEnvio').addEventListener('change', async () => {
  config.autoEnvio = $('chkAutoEnvio').checked;
  try {
    config = await api.guardarConfig(config);
    $('chkAutoEnvio').checked = !!config.autoEnvio;
    log(config.autoEnvio
      ? 'Envío automático activado: se avisará 24 h antes de cada cita.'
      : 'Envío automático desactivado.', 'info');
  } catch (err) {
    log('No se pudo guardar la configuración: ' + err.message, 'error');
  }
});

// ---------- Importar desde archivo (PDF o imagen) ----------
// Las librerías (pdf.js, tesseract.js) se sirven en local desde el propio
// servidor y se cargan solo la primera vez que se usa un archivo.
function cargarScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('No se pudo cargar ' + src));
    document.head.appendChild(s);
  });
}

async function extraerLineasPdf(archivo) {
  await cargarScript('/vendor/pdfjs/pdf.min.js');
  pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.js';
  const pdf = await pdfjsLib.getDocument({ data: await archivo.arrayBuffer() }).promise;
  const lineas = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const pagina = await pdf.getPage(p);
    const contenido = await pagina.getTextContent();
    lineas.push(...agruparItemsPdf(contenido.items));
  }
  return lineas;
}

let ocrWorker = null;
let ocrProgreso = () => {};
async function extraerLineasImagen(archivo, onProgreso, psm = '4') {
  await cargarScript('/vendor/tesseract/tesseract.min.js');
  ocrProgreso = onProgreso;
  if (!ocrWorker) {
    ocrWorker = await Tesseract.createWorker('spa', 1, {
      workerPath: '/vendor/tesseract/worker.min.js',
      corePath: '/vendor/tesseract-core',
      langPath: '/vendor/tessdata',
      logger: (m) => {
        if (m.status === 'recognizing text') ocrProgreso(Math.round(m.progress * 100));
      }
    });
  }
  // PSM 4 (columna única) lee bien los listados en tabla; el 3 (automático)
  // se pierde con las rejillas de las tablas.
  await ocrWorker.setParameters({ tessedit_pageseg_mode: psm });
  const { data } = await ocrWorker.recognize(archivo);
  return data.text.split(/\r?\n/);
}

let procesandoArchivo = false;
async function procesarArchivo(archivo) {
  if (!archivo || procesandoArchivo) return;
  procesandoArchivo = true;
  const estado = $('archivoEstado');
  estado.className = 'pegar-preview';
  $('dropImagen').classList.add('cargando');
  try {
    let lineas;
    if (archivo.type === 'application/pdf' || /\.pdf$/i.test(archivo.name)) {
      estado.textContent = 'Leyendo PDF...';
      lineas = await extraerLineasPdf(archivo);
    } else if (/^image\//.test(archivo.type)) {
      estado.textContent = 'Leyendo imagen (OCR)... puede tardar un poco la primera vez.';
      const progreso = (pct) => { estado.textContent = `Leyendo imagen (OCR)... ${pct}%`; };
      lineas = await extraerLineasImagen(archivo, progreso);
      if (!lineas.some((l) => extraerCitaDeLinea(l))) {
        // Segundo intento con segmentación automática (imágenes sin tabla)
        estado.textContent = 'Reintentando lectura...';
        lineas = await extraerLineasImagen(archivo, progreso, '3');
      }
    } else {
      throw new Error('Solo se admiten PDF o imágenes.');
    }
    const detectadas = lineas.map(extraerCitaDeLinea).filter(Boolean).map(normalizarCitaOCR);
    if (detectadas.length === 0) {
      estado.textContent = 'No se detectó ninguna cita en el archivo (hacen falta teléfonos, fechas u horas legibles).';
      estado.className = 'pegar-preview error';
      return;
    }
    $('areaPegar').value = detectadas
      .map((c) => [c.nombre, c.fecha, c.telefono, c.hora, c.especialidad].join('\t'))
      .join('\n');
    $('areaPegar').dispatchEvent(new Event('input'));
    estado.textContent = `Archivo leído: ${detectadas.length} cita(s). Revisa el texto de abajo, corrige lo necesario y pulsa Importar.`;
    estado.className = 'pegar-preview ok';
  } catch (err) {
    estado.textContent = 'Error al leer el archivo: ' + err.message;
    estado.className = 'pegar-preview error';
  } finally {
    procesandoArchivo = false;
    $('dropImagen').classList.remove('cargando');
  }
}

$('btnImagen').addEventListener('click', () => $('inputImagen').click());

$('inputImagen').addEventListener('change', () => {
  const archivo = $('inputImagen').files[0];
  $('inputImagen').value = '';
  procesarArchivo(archivo);
});

// Arrastrar y soltar sobre la zona punteada
['dragover', 'dragenter'].forEach((ev) =>
  $('dropImagen').addEventListener(ev, (e) => {
    e.preventDefault();
    $('dropImagen').classList.add('activo');
  })
);
['dragleave', 'drop'].forEach((ev) =>
  $('dropImagen').addEventListener(ev, () => $('dropImagen').classList.remove('activo'))
);
$('dropImagen').addEventListener('drop', (e) => {
  e.preventDefault();
  procesarArchivo(e.dataTransfer.files && e.dataTransfer.files[0]);
});

// Ctrl+V con una captura en el portapapeles, con el modal abierto
document.addEventListener('paste', (e) => {
  if ($('modalPegar').classList.contains('oculto')) return;
  const item = Array.from(e.clipboardData.items || [])
    .find((i) => i.kind === 'file' && (/^image\//.test(i.type) || i.type === 'application/pdf'));
  if (!item) return; // texto pegado: lo gestiona el textarea
  e.preventDefault();
  procesarArchivo(item.getAsFile());
});

// ---------- Modal: importar citas ----------
function abrirModal() {
  $('areaPegar').value = '';
  $('pegarPreview').textContent = '';
  $('pegarPreview').className = 'pegar-preview';
  $('archivoEstado').textContent = '';
  $('archivoEstado').className = 'pegar-preview';
  $('modalPegar').classList.remove('oculto');
  $('areaPegar').focus();
}
function cerrarModal() { $('modalPegar').classList.add('oculto'); }

$('btnPegar').addEventListener('click', abrirModal);
$('btnCancelarPegar').addEventListener('click', cerrarModal);
$('modalPegar').addEventListener('click', (e) => { if (e.target.id === 'modalPegar') cerrarModal(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('modalPegar').classList.contains('oculto')) cerrarModal();
});

$('areaPegar').addEventListener('input', () => {
  const filas = parsearPegado($('areaPegar').value);
  const prev = $('pegarPreview');
  if (filas.length === 0) {
    prev.textContent = '';
    prev.className = 'pegar-preview';
    return;
  }
  const incompletas = filas.filter((c) => !c.telefono || !c.fecha || !c.hora).length;
  prev.textContent = `Se detectaron ${filas.length} cita(s)` +
    (incompletas ? `, ${incompletas} con datos incompletos (revísalas tras importar).` : '.');
  prev.className = 'pegar-preview ' + (incompletas ? 'error' : 'ok');
});

$('btnImportar').addEventListener('click', () => {
  const filas = parsearPegado($('areaPegar').value);
  if (filas.length === 0) {
    $('pegarPreview').textContent = 'No se detectó ninguna cita. Pega al menos una línea.';
    $('pegarPreview').className = 'pegar-preview error';
    return;
  }
  if ($('chkReemplazar').checked) citas = filas;
  else citas = citas.concat(filas);

  guardar();
  pintarTabla();
  cerrarModal();
  log(`Importadas ${filas.length} cita(s) desde texto o imagen.`, 'ok');
});

// ---------- Eventos en vivo del servidor (SSE) ----------
function conectarEventos() {
  const es = new EventSource('/api/events');
  es.addEventListener('qr', (e) => {
    $('qrImg').src = JSON.parse(e.data);
    $('qrCaja').classList.remove('oculto');
    log('Código QR listo. Escanéalo con tu teléfono.', 'info');
  });
  es.addEventListener('estado', (e) => setEstado(JSON.parse(e.data)));
  es.addEventListener('citas', (e) => {
    // el servidor ha marcado resultados de envío: refrescar tabla
    citas = JSON.parse(e.data);
    pintarTabla();
  });
  es.addEventListener('log', (e) => {
    const { tipo, texto } = JSON.parse(e.data);
    log(texto, tipo || 'info');
  });
  es.addEventListener('progreso', (e) => {
    const { hecho, total } = JSON.parse(e.data);
    const pct = total ? Math.round((hecho / total) * 100) : 0;
    $('barraRelleno').style.width = pct + '%';
    $('progresoTexto').textContent = `${hecho} / ${total}`;
  });
}

// ---------- Arranque ----------
(async function init() {
  const [citasIniciales, configInicial, estadoInicial] = await Promise.all([
    api.listarCitas(),
    api.config(),
    api.estado()
  ]);
  citas = citasIniciales;
  config = configInicial;
  $('mensajePlantilla').value = config.mensaje;
  $('chkAutoEnvio').checked = !!config.autoEnvio;
  pintarTabla();
  pintarMotores(estadoInicial.motor, estadoInicial.motores || []);
  // motor sin sesión pero con otro motor vinculado: avisar al abrir la página
  const motores = estadoInicial.motores || [];
  const actual = motores.find((m) => m.id === estadoInicial.motor);
  const otro = motores.find((m) => m.vinculado && m.id !== estadoInicial.motor);
  if (actual && !actual.vinculado && otro && estadoInicial.estado !== 'conectado') {
    log(`Esta versión usa ${actual.nombre}: hay que vincular el móvil una vez más (pulsa «Conectar WhatsApp»; QR o código). Para seguir con el motor anterior, elige «${otro.nombre}» en «Motor».`, 'aviso');
  }
  if (estadoInicial.version) {
    $('versionTexto').textContent = 'v' + estadoInicial.version;
  }
  setEstado(estadoInicial.estado);
  if (estadoInicial.ultimoError && estadoInicial.estado !== 'conectado') {
    log('Último error registrado: ' + estadoInicial.ultimoError, 'error');
  }
  conectarEventos();
  cargarVersiones();

  // Aviso no intrusivo si hay version nueva (el arranque ya intenta bajarla).
  api.buscarActualizacion()
    .then((info) => {
      if (info.nuevaMayor) {
        const v = $('versionTexto');
        v.textContent = `v${info.local} · ${info.nuevaMayor} disponible`;
        v.classList.add('hay-nueva');
        v.title = 'Versión mayor nueva: no se instala sola. Elige «Última versión» en «Versión…» para instalarla.';
      } else if (info.hayActualizacion) {
        const v = $('versionTexto');
        v.textContent = `v${info.local} → ${info.remota} disponible`;
        v.classList.add('hay-nueva');
        v.title = 'Hay una versión más nueva: pulsa «⟳ Comprobar versión» o reinicia la aplicación';
        log(`Hay una versión nueva (${info.remota}). Pulsa «⟳ Comprobar versión» o reinicia la aplicación.`, 'aviso');
      }
    })
    .catch(() => { /* sin conexion: ignorar */ });
})();
