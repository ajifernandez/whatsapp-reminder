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

Para cerrar la aplicación, mejor el botón **⏻ Apagar** de la cabecera que cerrar la ventana negra: cierra WhatsApp de forma ordenada y evita procesos colgados en el siguiente arranque.

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

- `data/citas.json` — las citas; `data/config.json` — mensaje, envío automático y motor.
- `.baileys_auth/` (motor Baileys) o `.wwebjs_auth/` (motor whatsapp-web.js) — la sesión de WhatsApp (para no volver a vincular cada vez).

Ambas carpetas están ignoradas por git (contienen datos y sesión).

---

## Estructura del proyecto

- `server.js` — servidor web local (Express): estados de conexión, envío por lotes con pausas, envío automático, diagnóstico.
- `motores/` — cómo se habla con WhatsApp (misma interfaz en los dos, ver cabecera de `motores/wwebjs.js`):
  - `baileys.js` — por WebSocket, sin navegador. Vincula con QR o con código. Usa `vendor/baileys.bundle.mjs`.
  - `wwebjs.js` — whatsapp-web.js: Chromium oculto con web.whatsapp.com (el de la 2.x).
  - Se elige en la página («Motor», bajo «Conectar WhatsApp») o con `"motor"` en `data/config.json`. Por defecto: Baileys en instalaciones nuevas; las que ya usaban whatsapp-web.js siguen con él (sin volver a vincular) hasta que se cambie. Cada motor tiene su propia vinculación; si el elegido no está vinculado, la página avisa.
- `vendor/baileys.bundle.mjs` — Baileys 6.7.24 empaquetado en un fichero (la portable no tiene npm). Se regenera con `npm run build:baileys`. La 7.0 (release candidate) la rechaza WhatsApp a fecha de 2026-10.
- `update.js` — auto-actualizador desde GitHub (se ejecuta antes de `server.js`).
- `test/` — `npm test`: updater, motor Baileys y servidor con un motor falso; sin red ni WhatsApp.
- `renderer/` — interfaz del navegador (`index.html`, `styles.css`, `renderer.js`, `parser.js`).
- `Iniciar.bat` / `Iniciar.sh` — lanzadores de doble clic (Windows / Linux).
- `Makefile` — `make prepare_portable_dist` regenera el ZIP portable de Windows.
- `package.json` — dependencias.

## Limitaciones

- No es la API oficial de Meta: pensado para recordatorios personales o de consultas pequeñas, no para envíos masivos ni spam.
- Requiere que el móvil vinculado tenga conexión a internet.

## Versiones mayores, canal beta y ficheros nuevos

- **Freno de versión mayor**: en el canal estable el auto-update solo actúa dentro de la misma versión mayor (2.x → 2.x). Una 3.0 en `main` solo se avisa («versión mayor nueva»); se instala de forma explícita con `node update.js latest`.
- **Canal beta por clínica**: `node update.js canal v3` hace que esa clínica siga la rama `v3` (sin freno: elegir el canal ya es aceptar la beta). `node update.js canal main` la devuelve a estable. Se guarda en `data/canal.txt` y sale en el diagnóstico (`canal`).
- **Lista de ficheros remota**: el updater baja los ficheros que indica `archivosActualizables` en el `package.json` **remoto**, así una versión nueva puede añadir ficheros (p. ej. un motor empaquetado en `vendor/`). Rutas relativas sin `..`; si la lista falta o es inválida, usa la lista mínima de `update.js`.
- **Autorreparación**: al arrancar, `server.js` comprueba que existen todos los ficheros de su `archivosActualizables` y descarga los que falten del tag de su versión. Cubre la primera actualización hecha por un updater ≤ 2.1.16, que solo bajaba su lista fija.
- **Sin npm en la clínica**: la versión portable solo trae `bin\node.exe`, así que las dependencias nuevas deben ir empaquetadas como ficheros en `archivosActualizables`, no en `node_modules`.
- Regla: no fusionar una versión mayor en `main` hasta que todas las clínicas informen (diagnóstico) una versión con freno (≥ 2.1.17); un updater más antiguo no frena.
- Pruebas del updater (sin red): `npm test`.

## Volver a una versión anterior (downgrade)

Desde la carpeta de la app: `node update.js 2.1.11` instala esa versión (tags `vX.Y.Z` de GitHub) y crea `data/version-fija.txt`, que desactiva el auto-update. Para volver a seguir la última: `node update.js latest`. El selector «Versión…» de la cabecera está oculto desde la 2.2.1 (no funcionaba bien); la cabecera sigue mostrando 🔒 si hay versión fijada. Solo se queda fijada si la versión destino es 2.1.11 o posterior (las anteriores no conocen la fijación y se actualizarían solas). Al publicar una versión nueva: `git tag vX.Y.Z && git push --tags`.

## Estado de la conexión (comprobación automática)

«Conectado» solo dice que la conexión se estableció una vez. Cada minuto el servidor hace una consulta real a WhatsApp (`ping()` del motor: el ping de protocolo en Baileys; `getState()` evaluado dentro de la página en whatsapp-web.js, que detecta la página colgada). Si falla 2 veces seguidas (~2 min), el estado pasa a **«Conectado, con problemas»** (punto ámbar, aviso con la hora, la causa y qué hacer, toast y línea en el registro); al recuperarse vuelve a «Conectado».

La causa se averigua con dos comprobaciones de red desde Node: `web.whatsapp.com` y `www.cloudflare.com/cdn-cgi/trace` (solo para saber si hay internet):

- ninguna responde → sin internet (o cortafuegos/proxy);
- solo falla WhatsApp → WhatsApp inaccesible (caída o bloqueo del antivirus/cortafuegos);
- responden las dos → la red va bien pero el motor no responde (probable página colgada: «⏻ Apagar» y abrir de nuevo, o cambiar de motor).

No bloquea nada: se puede seguir enviando (los envíos que no reciban respuesta quedan sin marcar). Para pruebas: `INTERVALO_SALUD_MS` y `SALUD_RED=ok|wa|nada`.

**Qué queda registrado** (para el diagnóstico, aunque el problema ya se haya ido):

- Registro y `data/app.log`: el paso a «con problemas» (con la causa) y la recuperación. Además, en `app.log` (no en pantalla), el **primer fallo suelto** y cada 5 seguidos: `Comprobación de conexión fallida (N seguidas): motivo`.
- Diagnóstico, campo `salud`: estado actual, contadores desde el arranque (`comprobaciones`, `fallos`) y los **últimos 10 incidentes** (`desde`, `hasta`, `minutos`, `causa`, `motivo`, `motor` y `fin`: `recuperada`, `desconexión`, `sesión cerrada`, `reconexión`, `cambio de motor`, `aplicación cerrada` o `reinicio de la aplicación`). Se guardan en `data/salud.json`, así que sobreviven a reiniciar la aplicación, que es lo que suele hacerse antes de mandar el informe.

## Estado de las clínicas en remoto (latidos)

Para saber si una clínica funciona **sin que envíe el diagnóstico**, cada aplicación manda un *latido* a `soporte…/latido` al arrancar, cada 5 minutos y al cambiar de estado; y al cerrarla con «⏻ Apagar», un último aviso «apagada». La web de soporte (`/clinicas`, con la contraseña de administración) lista las instalaciones por gravedad:

| Estado | Significa |
|---|---|
| **Sin señal** | no llegan latidos desde hace 12 min (equipo apagado, sin internet o aplicación cerrada a la fuerza) |
| **Desconectado** | la app está en marcha pero sin sesión de WhatsApp (con el último error) |
| **Con problemas** | conectada pero `ping` fallando (con la causa), o más de 10 min «conectando» |
| **Conectando** | arrancando o reconectando |
| **OK** | conectada y respondiendo |
| **Apagada** | la cerraron a propósito con «Apagar» (no es una caída) |

- **Qué lleva el latido** (nunca datos de pacientes): id de instalación aleatorio (`data/instalacion.json`), nombre del equipo, versión, canal, motor, estado, causa, último error (anonimizado) y último OK. Se ve el IP del equipo en el servidor.
- **Transparencia y desactivación**: la página tiene la casilla «Avisar a soporte del estado de la conexión (sin datos de pacientes)» (por defecto activada; `latido` en `data/config.json`). Desactivada, la clínica aparecerá como «Sin señal». El informe de diagnóstico incluye `latido` (activo, id).
- **Nombres**: los equipos suelen llamarse «PC-123»; en la web, «renombrar» pone el de la clínica y «olvidar» borra una instalación (reaparece si sigue avisando). Se guarda en `DATA_DIR/estado/clinicas.json` del receptor.
- **Receptor**: `POST /latido` valida el formato, limita a 40 latidos/hora por instalación y 120 por IP, y admite como mucho 500 instalaciones. `OFFLINE_MIN` cambia el umbral de «Sin señal». Hay que reiniciar el stack `soporte` en Dockge para que use la versión nueva.
- La aplicación solo aparece en la lista desde la versión que incluye esta función.
- Si el receptor no está disponible, la app lo anota **una vez** en `app.log` y sigue sin molestar. Para pruebas, `LATIDO_URL=` (vacío) desactiva los latidos.

## Diagnóstico de problemas de conexión

Con la app abierta, visitar `http://localhost:PUERTO/api/diagnostico` (mismo puerto que la app). Devuelve versión, estado, último error, SO/Node, RAM libre, si hay sesión vinculada, locks de Chromium y las últimas 80 líneas del log. El botón «✉ Enviar diagnóstico» de la cabecera lo envía desde el servidor al receptor de soporte (`soporte-server/`, ver su `compose.yaml` para Dockge; la interfaz web `/` lista los informes con usuario `ADMIN_USER` y contraseña `ADMIN_PASS`; la URL va en `DIAG_URL` de `server.js`). Si no hay receptor configurado o falla (sin internet), descarga el informe `.json` y abre el correo para adjuntarlo a mano. El log se anonimiza antes: nombres y teléfonos de pacientes salen como `[nombre]` y `[tel]` (función `anonimizar` en `server.js`; si se añaden logs con datos personales, revisarla).

Qué mirar:

- `lockYaExistiaAlArrancar` no vacío: el equipo se apagó sin cerrar la app (apagón, kill, cierre forzado). La app ya lo limpia sola; solo indica que hubo cierre sucio.
- Log con `Cargando WhatsApp Web: N%` que se queda parado: Chromium arranca pero WhatsApp Web no termina de cargar (red, proxy, antivirus). Si ni aparece, Chromium no arranca (ruta, permisos, RAM).
- `ramLibreMB` bajo (<500): Chromium se arrastra o muere.
- `Error de autenticación` / `Sesión desconectada`: el teléfono desvinculó la sesión; hay que volver a escanear el QR.
- `La conexión tardó más de 90s`: ver las líneas anteriores del log para saber en qué fase se quedó.

Campos útiles del informe para un cuelgue de conexión:

- `redWhatsApp`: si Node llega a `web.whatsapp.com`. Si Node llega y Chromium no, lo bloquea el navegador (antivirus, cortafuegos del `chrome.exe`, proxy del sistema); si Node tampoco, es la red.
- `proxy`: variables de entorno y, en Windows, el proxy de Internet Settings (el que usa Chromium). Sin credenciales.
- `procesosChromiumPerfil`: procesos de navegador vivos con el perfil de la app (más de ~10 con la app parada indica restos de un intento anterior).
- En el log, líneas `[conexión +Ns]`: «Chromium lanzado», «Página creada», peticiones fallidas (`net::ERR_…`) y, a los 45 s sin conectar, los hosts con peticiones pendientes. Dicen en qué fase se atasca. Solo guardan hosts y estados, nunca contenido de la página.
- Las rutas salen sin el nombre de usuario de Windows (`C:\Users\<usuario>\…`).

El log completo está en `data/app.log` (se recorta solo a 512 KB). Borrar `.wwebjs_auth` es el último recurso: pierde la sesión y obliga a volver a vincular.
