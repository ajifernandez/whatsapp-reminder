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

Al pulsar **Iniciar**, la app se conecta a GitHub y descarga sola la última versión del código antes de arrancar (si no hay internet, sigue con la versión actual). También hay un botón **⟳ Comprobar versión** en la cabecera para buscar cambios (y bajarlos) sin reiniciar.

- Se actualizan el código y los documentos (`server.js`, `update.js`, `renderer/`, `package.json`, `README.md`, `MANUAL_USUARIO.md`); nunca los datos, la sesión ni los binarios empaquetados.
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

## Volver a una versión anterior (downgrade)

Desde la carpeta de la app: `node update.js 2.1.11` instala esa versión (tags `vX.Y.Z` de GitHub) y crea `data/version-fija.txt`, que desactiva el auto-update. Para volver a seguir la última: `node update.js latest`. También desde la cabecera de la app: selector «Versión…» (pide confirmación; muestra 🔒 si hay versión fijada). Solo se queda fijada si la versión destino es 2.1.11 o posterior (las anteriores no conocen la fijación y se actualizarían solas). Al publicar una versión nueva: `git tag vX.Y.Z && git push --tags`.

## Diagnóstico de problemas de conexión

Con la app abierta, visitar `http://localhost:PUERTO/api/diagnostico` (mismo puerto que la app). Devuelve versión, estado, último error, SO/Node, RAM libre, si hay sesión vinculada, locks de Chromium y las últimas 80 líneas del log. El botón «✉ Enviar diagnóstico» de la cabecera lo envía desde el servidor al receptor de soporte (`soporte-server/`, ver su `compose.yaml` para Dockge; la interfaz web `/` lista los informes con usuario `ADMIN_USER` y contraseña `ADMIN_PASS`; la URL va en `DIAG_URL` de `server.js`). Si no hay receptor configurado o falla (sin internet), descarga el informe `.json` y abre el correo para adjuntarlo a mano. El log se anonimiza antes: nombres y teléfonos de pacientes salen como `[nombre]` y `[tel]` (función `anonimizar` en `server.js`; si se añaden logs con datos personales, revisarla).

Qué mirar:

- `lockYaExistiaAlArrancar` no vacío: el equipo se apagó sin cerrar la app (apagón, kill, cierre forzado). La app ya lo limpia sola; solo indica que hubo cierre sucio.
- Log con `Cargando WhatsApp Web: N%` que se queda parado: Chromium arranca pero WhatsApp Web no termina de cargar (red, proxy, antivirus). Si ni aparece, Chromium no arranca (ruta, permisos, RAM).
- `ramLibreMB` bajo (<500): Chromium se arrastra o muere.
- `Error de autenticación` / `Sesión desconectada`: el teléfono desvinculó la sesión; hay que volver a escanear el QR.
- `La conexión tardó más de 90s`: ver las líneas anteriores del log para saber en qué fase se quedó.

El log completo está en `data/app.log` (se recorta solo a 512 KB). Borrar `.wwebjs_auth` es el último recurso: pierde la sesión y obliga a volver a vincular.
