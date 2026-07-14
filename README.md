# Recordatorios WhatsApp

App web local para enviar recordatorios de citas por WhatsApp. Funciona en **Windows** y **Linux**: se arranca con un doble clic y se usa desde el navegador. Interfaz visual pensada para recepción, sin tocar la terminal.

Usa [`whatsapp-web.js`](https://github.com/pedroslopez/whatsapp-web.js) por debajo.

## Qué hace

- Tabla visual para añadir, editar y borrar citas (se guarda sola).
- Botón **Conectar WhatsApp** que muestra un QR en pantalla (solo la primera vez).
- Botón **Enviar recordatorios** que manda un mensaje a cada cita, con barra de progreso y registro de resultados en vivo.
- Importar citas desde **Excel, PDF o imagen** (OCR) además de a mano.
- **Auto-actualización** desde GitHub: al iniciar se trae la última versión sola.

El mensaje que se envía:

> Hola *nombre*, te recordamos tu cita de *especialidad* el día *fecha* a las *hora*. Si no puedes asistir, avísame. ¡Gracias!

---

## Para la recepcionista (uso diario)

1. Doble clic en **Iniciar** (`Iniciar.bat` en Windows, `Iniciar.sh` en Linux).
   Se abre una ventana negra (el servidor, déjala abierta) y el navegador con la app.
2. Pulsa **Conectar WhatsApp**. La primera vez aparece un QR:
   móvil → **WhatsApp → Ajustes → Dispositivos vinculados → Vincular dispositivo** → escanea.
   (Las siguientes veces se conecta solo, sin QR.)
3. Añade o edita las citas en la tabla. El teléfono va en formato internacional **sin `+`** (ej. España: `34612345678`).
4. Pulsa **Enviar recordatorios**. Verás el progreso y qué se envió correctamente.

> El teléfono con WhatsApp debe estar encendido y con internet.
> Para cerrar, cierra la pestaña del navegador y la ventana negra del servidor.

---

## Actualizaciones automáticas

Al pulsar **Iniciar**, la app se conecta a GitHub y descarga sola la última versión del código antes de arrancar (si no hay internet, sigue con la versión actual). También hay un botón **⟳ Actualizar** en la cabecera para buscar cambios sin reiniciar.

- Solo se actualiza el código (`server.js`, `update.js`, `renderer/`, `package.json`); nunca los datos, la sesión ni los binarios empaquetados.
- Requiere que el repo sea **público**: <https://github.com/ajifernandez/whatsapp-reminder>

**Para publicar una nueva versión** (desarrollador): sube el número de `version` en `package.json` y haz `git push`. Los equipos se actualizan al reiniciar. El updater solo aplica versiones **mayores** que la instalada.

---

## Requisito único: Node.js

El ordenador necesita **Node.js 18 o superior** instalado una sola vez: <https://nodejs.org> (botón LTS).
Los lanzadores instalan solos las dependencias la primera vez.

Arranque manual (equivalente al doble clic):

```bash
cd whatsapp-reminder
npm install     # solo la primera vez
npm start       # y abre http://localhost:3000 en el navegador
```

El puerto se puede cambiar con la variable `PORT` (ej. `PORT=4000 npm start`).

---

## Dónde se guardan los datos

Todo queda en la propia carpeta del programa:

- `data/citas.json` — las citas.
- `.wwebjs_auth/` — la sesión de WhatsApp (para no re-escanear el QR cada vez).

Ambas carpetas están ignoradas por git (contienen datos y sesión).

---

## Estructura del proyecto

- `server.js` — servidor web local (Express) + lógica de WhatsApp.
- `update.js` — auto-actualizador desde GitHub (se ejecuta antes de `server.js`).
- `renderer/` — interfaz del navegador (`index.html`, `styles.css`, `renderer.js`, `parser.js`).
- `Iniciar.bat` / `Iniciar.sh` — lanzadores de doble clic (Windows / Linux).
- `Makefile` — `make prepare_portable_dist` regenera el ZIP portable de Windows.
- `package.json` — dependencias.

## Limitaciones

- No es la API oficial de Meta: pensado para recordatorios personales o de consultas pequeñas, no para envíos masivos ni spam.
- Requiere que el móvil vinculado tenga conexión a internet.
