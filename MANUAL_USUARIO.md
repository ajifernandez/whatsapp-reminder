# Manual de usuario - Recordatorios WhatsApp

## 1. Introducción

Recordatorios WhatsApp es una aplicación web local para enviar recordatorios de citas por WhatsApp desde un ordenador. Está pensada para uso diario en recepción: se abre desde un lanzador, se usa en el navegador y no requiere escribir comandos durante el uso normal.

La aplicación permite:

- Añadir, editar y borrar citas en una tabla.
- Importar citas pegando datos desde Excel, LibreOffice Calc, CSV o texto.
- Conectar WhatsApp escaneando un código QR.
- Personalizar el mensaje que se enviará.
- Enviar recordatorios y ver el progreso en pantalla.
- Guardar las citas y la configuración automáticamente.

## 2. Requisitos

### 2.1. Ordenador

La aplicación funciona en Windows, Linux y macOS.

### 2.2. Node.js

El único requisito previo es tener instalado Node.js 18 o superior.

Para instalarlo:

1. Abre https://nodejs.org.
2. Descarga la versión LTS.
3. Instálala siguiendo el asistente.
4. Cierra y vuelve a abrir cualquier terminal o ventana desde la que vayas a iniciar la aplicación.

### 2.3. WhatsApp

Necesitas un teléfono con WhatsApp instalado, encendido y con conexión a internet. La aplicación usa una sesión vinculada de WhatsApp Web.

## 3. Instalación

### 3.1. Instalar en Windows

1. Copia la carpeta `whatsapp-reminder` al ordenador.
2. Entra en la carpeta.
3. Haz doble clic en `Iniciar.bat`.
4. La primera vez, el lanzador instalará automáticamente las dependencias.
5. Cuando termine, se abrirá el navegador en `http://localhost:3000`.

Si aparece un mensaje indicando que Node.js no está instalado, instala Node.js desde https://nodejs.org y vuelve a abrir `Iniciar.bat`.

### 3.2. Instalar en Linux o macOS

1. Copia la carpeta `whatsapp-reminder` al ordenador.
2. Entra en la carpeta.
3. Ejecuta `Iniciar.sh`.
4. La primera vez, el lanzador instalará automáticamente las dependencias.
5. Cuando termine, se abrirá el navegador en `http://localhost:3000`.

Si el sistema no permite ejecutar el archivo, abre una terminal en la carpeta y ejecuta:

```bash
chmod +x Iniciar.sh
./Iniciar.sh
```

### 3.3. Instalación manual

Si prefieres iniciar la aplicación manualmente:

```bash
npm install
npm start
```

Después abre en el navegador:

```text
http://localhost:3000
```

## 4. Cómo iniciar la aplicación

### 4.1. Inicio normal

- En Windows: doble clic en `Iniciar.bat`.
- En Linux/macOS: doble clic o ejecución de `Iniciar.sh`.

Se abrirá una ventana de terminal. Déjala abierta mientras uses la aplicación. Si cierras esa ventana, la aplicación se detendrá.

### 4.2. Abrir desde el navegador

Si la aplicación está iniciada pero no se abre automáticamente, entra manualmente en:

```text
http://localhost:3000
```

### 4.3. Cambiar el puerto

Por defecto se usa el puerto `3000`. Si necesitas otro puerto, puedes iniciar la aplicación con la variable `PORT`:

```bash
PORT=4000 npm start
```

Entonces abre:

```text
http://localhost:4000
```

## 5. Primera conexión con WhatsApp

1. Abre la aplicación.
2. Pulsa `Conectar WhatsApp`.
3. Espera a que aparezca el código QR.
4. En el móvil, abre WhatsApp.
5. Ve a `Ajustes` o `Configuración`.
6. Entra en `Dispositivos vinculados`.
7. Pulsa `Vincular dispositivo`.
8. Escanea el QR de la pantalla.
9. Cuando la conexión esté lista, el estado cambiará a `Conectado`.

Normalmente solo hace falta escanear el QR la primera vez. La sesión queda guardada para futuros inicios.

## 6. Uso diario

### 6.1. Añadir una cita manualmente

1. Pulsa `+ Añadir fila`.
2. Rellena los campos:
   - `Nombre`
   - `Teléfono`
   - `Fecha`
   - `Hora`
   - `Especialidad`
3. Los datos se guardan automáticamente.

### 6.2. Formato del teléfono

El teléfono debe escribirse en formato internacional, sin espacios y sin el símbolo `+`.

Ejemplos:

- España: `34612345678`
- México: `5215512345678`
- Argentina: `5491123456789`

### 6.3. Editar una cita

Haz clic en cualquier campo de la tabla y modifica el contenido. Los cambios se guardan automáticamente.

### 6.4. Borrar una cita

Pulsa el botón de papelera de la fila que quieres eliminar.

## 7. Importar citas desde Excel, CSV o texto

1. Copia las filas desde Excel, LibreOffice Calc, CSV o un documento de texto.
2. Pulsa `Pegar desde Excel/CSV`.
3. Pega los datos en el cuadro de texto.
4. Revisa la vista previa.
5. Elige si quieres reemplazar las citas actuales o añadirlas a las existentes.
6. Pulsa `Importar`.

El orden de columnas esperado es:

```text
nombre · fecha · teléfono · hora · especialidad
```

Ejemplo:

```text
Ana García	03/07/2026	34612345678	10:30	revisión
Carlos López	03/07/2026	34687654321	17:00	nutrición
```

La aplicación detecta automáticamente estos separadores:

- Tabulador, habitual al copiar desde Excel.
- Punto y coma `;`.
- Coma `,`.

Formatos de fecha aceptados:

- `dd/mm/aaaa`
- `dd-mm-aaaa`
- `aaaa-mm-dd`

## 8. Configurar el mensaje a enviar

En la sección `Mensaje a enviar` puedes modificar la plantilla del recordatorio.

Variables disponibles:

- `{nombre}`: nombre de la persona.
- `{telefono}`: teléfono de la persona.
- `{fecha}`: fecha de la cita.
- `{hora}`: hora de la cita.
- `{especialidad}`: especialidad o tipo de cita.

Mensaje de ejemplo:

```text
Hola {nombre}, te recordamos tu cita de {especialidad} el día {fecha} a las {hora}. Si no puedes asistir, avísame. ¡Gracias!
```

Cuando se envía un recordatorio, la aplicación sustituye esas variables por los datos de cada cita.

Ejemplo final:

```text
Hola Ana García, te recordamos tu cita de revisión el día Viernes 3 Julio a las 10:30. Si no puedes asistir, avísame. ¡Gracias!
```

La plantilla se guarda automáticamente en la configuración.

## 9. Enviar recordatorios

1. Comprueba que el estado sea `Conectado`.
2. Revisa que las citas tengan teléfono, fecha y hora.
3. Revisa la plantilla del mensaje.
4. Pulsa `Enviar recordatorios`.
5. Confirma el envío cuando aparezca el aviso.
6. Observa la barra de progreso y el registro de envíos.

La aplicación omitirá las citas incompletas. También puede omitir números no válidos o números que no tengan WhatsApp.

## 10. Registro de envíos

El registro muestra información en vivo:

- Mensajes enviados correctamente.
- Citas omitidas por datos incompletos.
- Números no válidos o sin WhatsApp.
- Errores de conexión o envío.

Puedes pulsar `Limpiar` para vaciar el registro visual. Esto no borra las citas ni la configuración.

## 11. Cerrar la aplicación

Para cerrar:

1. Cierra la pestaña del navegador.
2. Cierra la ventana de terminal donde se está ejecutando el servidor.

También puedes cerrar sesión de WhatsApp desde el botón `Cerrar sesión`. Si lo haces, probablemente tendrás que escanear el QR de nuevo la próxima vez.

## 12. Dónde se guardan los datos

Los datos se guardan dentro de la carpeta del programa:

- `data/citas.json`: citas guardadas.
- `data/config.json`: plantilla del mensaje y configuración.
- `.wwebjs_auth/`: sesión de WhatsApp vinculada.

Si quieres mover la aplicación a otro ordenador conservando datos y sesión, copia también esas carpetas. Si quieres empezar desde cero, puedes borrar `data` y `.wwebjs_auth` con la aplicación cerrada.

## 13. Solución de problemas

### 13.1. No se abre la aplicación

Comprueba que la ventana de terminal siga abierta y entra manualmente en:

```text
http://localhost:3000
```

### 13.2. Dice que Node.js no está instalado

Instala Node.js LTS desde https://nodejs.org y vuelve a iniciar la aplicación.

### 13.3. No aparece el QR

Prueba lo siguiente:

1. Espera unos segundos.
2. Recarga la página.
3. Pulsa de nuevo `Conectar WhatsApp`.
4. Cierra y vuelve a iniciar la aplicación.

### 13.4. WhatsApp se desconecta

Comprueba que el móvil esté encendido y con internet. Después vuelve a pulsar `Conectar WhatsApp`.

### 13.5. Un número no recibe mensaje

Revisa que:

- El teléfono tenga prefijo internacional.
- No tenga `+`, espacios ni guiones.
- El número tenga WhatsApp.
- La cita tenga fecha y hora.

### 13.6. Puerto ocupado

Si `http://localhost:3000` no funciona porque el puerto está ocupado, inicia con otro puerto:

```bash
PORT=4000 npm start
```

## 14. Recomendaciones de uso

- No cierres la ventana de terminal mientras estés usando la aplicación.
- Revisa siempre la plantilla antes de enviar recordatorios.
- Haz una prueba con tu propio número antes de usar una plantilla nueva.
- No uses la aplicación para spam ni envíos masivos.
- Mantén el teléfono vinculado con batería y conexión a internet.

## 15. Limitaciones

Esta aplicación no usa la API oficial de Meta. Está pensada para recordatorios de citas y uso local. WhatsApp puede limitar o bloquear comportamientos que parezcan automatización abusiva o spam.

## 16. Resumen rápido

1. Instala Node.js 18 o superior.
2. Abre `Iniciar.bat` en Windows o `Iniciar.sh` en Linux/macOS.
3. Entra en `http://localhost:3000` si no se abre solo.
4. Pulsa `Conectar WhatsApp` y escanea el QR.
5. Añade o importa citas.
6. Ajusta el mensaje.
7. Pulsa `Enviar recordatorios`.
8. Revisa el registro de envíos.
