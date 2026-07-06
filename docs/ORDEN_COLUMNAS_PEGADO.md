# Cambiar el orden de columnas del pegado desde Excel

Guía técnica: qué tocar si cambia el orden de las columnas que el usuario pega desde Excel/CSV en el modal «Importar citas».

> Nota: desde la versión con importación de PDF/imagen, el parseo vive en `renderer/parser.js` (no en `renderer.js`). La importación desde PDF/imagen no depende del orden de columnas (detecta teléfono/fecha/hora por su formato en `extraerCitaDeLinea`); este documento solo aplica al pegado clásico con columnas (`parsearPegado`).

## Orden actual

```
nombre · fecha · teléfono · hora · especialidad
```

## Dónde está el código

Todo el parseo del pegado ocurre **en el cliente** (`renderer/renderer.js`). El servidor recibe las citas ya estructuradas como JSON, así que **no hay que tocar `server.js`** para un cambio de orden.

### 1. Mapeo de columnas — `renderer/renderer.js` (función `parsearPegado`, ~línea 72)

Es el único punto donde el orden está codificado. El índice `c[N]` es la posición de la columna en la línea pegada:

```js
resultado.push({
  nombre: c[0] || '',
  fecha: normalizarFecha(c[1]),
  telefono: (c[2] || '').replace(/\s+/g, ''),
  hora: normalizarHora(c[3]),
  especialidad: c[4] || ''
});
```

Para cambiar el orden, reasigna los índices. Ojo: cada campo tiene su normalizador asociado (`normalizarFecha`, `normalizarHora`, limpieza de espacios en teléfono) — al mover índices, mueve el índice, no el normalizador.

### 2. Detección de cabecera — `renderer/renderer.js` (~línea 37)

```js
const CABECERAS = ['nombre', 'name', 'telefono', 'teléfono', 'tel', 'movil', 'móvil'];
```

Detecta si la primera línea pegada es una fila de cabeceras (para saltarla). No depende del orden, pero si se añaden/renombran columnas conviene ampliar esta lista con los nombres nuevos.

### 3. Texto de ayuda del modal — `renderer/index.html` (~líneas 108–115)

Dos cosas que actualizar para que la UI no mienta:

- El orden mostrado al usuario:
  ```html
  <code class="modal-orden">nombre · fecha · teléfono · hora · especialidad</code>
  ```
- El `placeholder` del textarea `#areaPegar`, que contiene filas de ejemplo separadas por tabuladores en ese mismo orden:
  ```
  Ana García	03/07/2026	34612345678	10:30	revisión
  ```

### 4. Manual de usuario — `MANUAL_USUARIO.md` (sección de importación, ~línea 164)

Documenta el orden esperado:

```
nombre · fecha · teléfono · hora · especialidad
```

Actualizar también `MANUAL_USUARIO.pdf` (se regenera a partir del `.md`).

## Qué NO depende del orden de pegado

- **`CAMPOS`** (`renderer/renderer.js:3`): define el orden de columnas de la **tabla en pantalla**, no del pegado. Son independientes; cambiar uno no obliga a cambiar el otro.
- **`server.js` y `data/citas.json`**: trabajan con objetos con claves (`nombre`, `telefono`…), nunca con posiciones.
- **Plantilla de mensaje** (`{nombre}`, `{fecha}`…): usa claves, no posiciones.

## Distribución portable

`dist/whatsapp-reminder-portable/` contiene una **copia** de `renderer/` y `server.js`. Tras cualquier cambio hay que regenerar el paquete portable (y su zip), o los usuarios de la versión portable no verán el cambio.

## Checklist de cambio

1. [ ] `renderer/renderer.js` → índices en `parsearPegado`
2. [ ] `renderer/renderer.js` → `CABECERAS` si hay columnas nuevas/renombradas
3. [ ] `renderer/index.html` → `<code class="modal-orden">` y `placeholder` de `#areaPegar`
4. [ ] `MANUAL_USUARIO.md` → sección de importación (+ regenerar PDF)
5. [ ] Regenerar `dist/` portable
6. [ ] Probar: pegar con cabecera, sin cabecera, con separador tab/`;`/`,`, y filas incompletas
