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

// ---------- Importar desde texto pegado (Excel/CSV/txt) ----------
const CABECERAS = ['nombre', 'name', 'telefono', 'teléfono', 'tel', 'movil', 'móvil'];

function detectarSeparador(texto) {
  const linea = texto.split(/\r?\n/).find((l) => l.trim() !== '') || '';
  if (linea.includes('\t')) return '\t';
  if (linea.includes(';')) return ';';
  return ',';
}

function normalizarFecha(v) {
  const s = (v || '').trim();
  if (!s) return '';
  // aaaa-mm-dd (ya válido)
  let m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  // dd/mm/aaaa o dd-mm-aaaa (o año de 2 dígitos)
  m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})$/);
  if (m) {
    let anio = m[3];
    if (anio.length === 2) anio = '20' + anio;
    return `${anio}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  return s; // se deja tal cual; el usuario puede corregir
}

function normalizarHora(v) {
  const s = (v || '').trim();
  if (!s) return '';
  const m = s.match(/^(\d{1,2})[:.h](\d{2})/);
  if (m) return `${m[1].padStart(2, '0')}:${m[2]}`;
  const soloHora = s.match(/^(\d{1,2})$/);
  if (soloHora) return `${soloHora[1].padStart(2, '0')}:00`;
  return s;
}

function parsearPegado(texto) {
  const sep = detectarSeparador(texto);
  const lineas = texto.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lineas.length === 0) return [];

  const partir = (linea) => linea.split(sep).map((c) => c.trim().replace(/^"(.*)"$/, '$1'));

  // ¿La primera línea es cabecera?
  const primera = partir(lineas[0]).map((c) => c.toLowerCase());
  const esCabecera = primera.some((c) => CABECERAS.includes(c));
  const inicio = esCabecera ? 1 : 0;

  const resultado = [];
  for (let i = inicio; i < lineas.length; i++) {
    const c = partir(lineas[i]);
    resultado.push({
      nombre: c[0] || '',
      fecha: normalizarFecha(c[1]),
      telefono: (c[2] || '').replace(/\s+/g, ''),
      hora: normalizarHora(c[3]),
      especialidad: c[4] || ''
    });
  }
  return resultado;
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
}

function guardarMensaje() {
  clearTimeout(guardarConfigTimer);
  guardarConfigTimer = setTimeout(() => {
    guardarMensajeAhora().catch((err) => log(err.message, 'error'));
  }, 300);
}

function actualizarBotonEnviar() {
  $('btnEnviar').disabled = !conectado || citas.length === 0;
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

// ---------- Modal: pegar desde Excel/CSV ----------
function abrirModal() {
  $('areaPegar').value = '';
  $('pegarPreview').textContent = '';
  $('pegarPreview').className = 'pegar-preview';
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
  log(`Importadas ${filas.length} cita(s) desde texto pegado.`, 'ok');
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
