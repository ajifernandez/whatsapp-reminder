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
  enviar: (c) => fetch('/api/enviar', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(c)
  }).then(async (r) => {
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Error al enviar');
    return data;
  }),
  estado: () => fetch('/api/estado').then((r) => r.json()).then((d) => d.estado)
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
function log(texto, tipo = 'info') {
  const li = document.createElement('li');
  li.className = tipo;
  const hora = new Date().toLocaleTimeString('es-ES');
  li.textContent = `[${hora}] ${texto}`;
  $('log').prepend(li);
}

// ---------- Estado de conexión ----------
function setEstado(estado) {
  $('estadoPunto').className = 'punto ' + estado;
  const mapa = { conectado: 'Conectado', desconectado: 'Desconectado', conectando: 'Conectando...', error: 'Error' };
  $('estadoTexto').textContent = mapa[estado] || estado;

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
  setEstado(estadoInicial);
  conectarEventos();
})();
