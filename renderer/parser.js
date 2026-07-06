// Parseo de citas desde texto pegado (Excel/CSV) o texto libre (PDF/OCR).
// Se carga en el navegador antes de renderer.js y también se puede usar en Node (tests).

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
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
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
  const m = s.match(/^(\d{1,2})[:.h](\d{2})(?:[:.h]\d{2})?(?:\D.*)?$/i);
  if (m) return `${m[1].padStart(2, '0')}:${m[2]}`;
  const soloHora = s.match(/^(\d{1,2})$/);
  if (soloHora) return `${soloHora[1].padStart(2, '0')}:00`;
  return s;
}

// ---------- Texto libre (PDF, OCR, texto sin columnas) ----------
// En texto sin separadores fiables no hay orden de columnas: se localizan
// teléfono/fecha/hora por su forma y el texto restante se reparte entre
// nombre y especialidad.
const RE_FECHA_LIBRE = /(?<![\d.\-/])(\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4}|\d{4}-\d{1,2}-\d{1,2})(?![\d.\-/])/;
const RE_HORA_LIBRE = /(^|[^\d:.])(\d{1,2})[:.hH](\d{2})(?:[:.hH]\d{2})?(?=$|[^\d])/;
// Entre dígitos se permite como mucho UN espacio/punto/guion, para que el
// teléfono no "salte" por encima de otras columnas separadas por huecos anchos.
const RE_TELEFONO_LIBRE = /\+?\d(?:[ .\-()]?\d){7,}/g;

const PALABRAS_CABECERA = ['nombre', 'fecha', 'telefono', 'teléfono', 'hora', 'especialidad', 'paciente'];

function extraerCitaDeLinea(linea) {
  let resto = (linea || '').trim();
  if (!resto) return null;

  // Línea de cabecera de tabla (contiene 2+ nombres de columna) → no es una cita
  const minusculas = resto.toLowerCase();
  if (PALABRAS_CABECERA.filter((p) => minusculas.includes(p)).length >= 2) return null;

  const fechaM = resto.match(RE_FECHA_LIBRE);
  const fecha = fechaM ? normalizarFecha(fechaM[1]) : '';
  if (fechaM) resto = resto.replace(fechaM[0], '  ');

  const horaM = resto.match(RE_HORA_LIBRE);
  let hora = horaM ? normalizarHora(`${horaM[2]}:${horaM[3]}`) : '';
  if (horaM) resto = resto.replace(horaM[0], horaM[1] + '  ');
  if (!hora) {
    // Forma "17 h" / "17h" (sin minutos)
    const horaHM = resto.match(/(^|[^\d:.])(\d{1,2})\s*[hH](?![\wáéíóú])/);
    if (horaHM) {
      hora = normalizarHora(horaHM[2]);
      resto = resto.replace(horaHM[0], horaHM[1] + '  ');
    }
  }

  // Teléfono: la secuencia con más dígitos (mínimo 9).
  let telefono = '';
  let telefonoTexto = '';
  for (const m of resto.match(RE_TELEFONO_LIBRE) || []) {
    const digitos = m.replace(/\D/g, '');
    if (digitos.length >= 9 && digitos.length > telefono.replace(/\D/g, '').length) {
      telefono = digitos;
      telefonoTexto = m;
    }
  }
  if (telefonoTexto) resto = resto.replace(telefonoTexto, '  ');

  // Solo cuenta como cita si hay teléfono, o al menos fecha Y hora (una fecha
  // suelta suele ser el título del listado).
  if (!telefono && !(fecha && hora)) return null;

  let trozos = resto
    .split(/\s{2,}|\t/)
    .map((t) => t
      .replace(/[|;,·]+/g, ' ')
      .replace(/\s+/g, ' ')
      // El OCR mete a veces corchetes/comillas/guiones pegados al texto
      .replace(/^[[\]{}()<>«»"'*_\-–—.:]+|[[\]{}()<>«»"'*_\-–—:]+$/g, '')
      .trim())
    .filter(Boolean);
  // Números de fila al principio ("1", "1.", "23)") no son parte del nombre.
  while (trozos.length && /^\d{1,3}[).:\-]?$/.test(trozos[0])) trozos.shift();

  return {
    nombre: trozos[0] || '',
    telefono,
    fecha,
    hora,
    especialidad: trozos.slice(1).join(' ')
  };
}

// Agrupa los items de texto de pdf.js (cada uno con posición x/y) en líneas:
// misma y (con tolerancia) = misma fila; dentro de la fila se ordena por x.
function agruparItemsPdf(items) {
  const filas = [];
  for (const it of items) {
    const texto = (it.str || '').trim();
    if (!texto) continue;
    const x = it.transform[4];
    const y = it.transform[5];
    let fila = filas.find((f) => Math.abs(f.y - y) < 4);
    if (!fila) {
      fila = { y, celdas: [] };
      filas.push(fila);
    }
    fila.celdas.push({ x, texto });
  }
  filas.sort((a, b) => b.y - a.y); // en PDF la y crece hacia arriba
  return filas.map((f) => f.celdas.sort((a, b) => a.x - b.x).map((c) => c.texto).join('  '));
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
    if (c.length >= 3) {
      // Columnas claras: orden fijo nombre · fecha · teléfono · hora · especialidad
      resultado.push({
        nombre: c[0] || '',
        fecha: normalizarFecha(c[1]),
        telefono: (c[2] || '').replace(/\s+/g, ''),
        hora: normalizarHora(c[3]),
        especialidad: c[4] || ''
      });
    } else {
      // Sin columnas (texto copiado de un PDF, OCR...): detección por forma
      const cita = extraerCitaDeLinea(lineas[i]);
      if (cita) resultado.push(cita);
    }
  }
  return resultado;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    CABECERAS,
    detectarSeparador,
    normalizarFecha,
    normalizarHora,
    extraerCitaDeLinea,
    agruparItemsPdf,
    parsearPegado
  };
}
