# Propuestas de Mejora — WhatsApp Reminder

> Fecha: 2026-11-19
> Versión actual: v2.5.12
> Objetivo: Mejorar la venta a otras clínicas, hacer cada instalación configurable por clínica, y aumentar la resiliencia del sistema.

---

## 1. Multi-tenencia y configuración por clínica (Prioridad: Alta)

**Problema**: Cada clínica es una instalación independiente sin personalización centralizada.

### 1.1 Branding personalizable

Permitir que cada clínica tenga su propio logo, nombre y colores en la interfaz.

```json
{
  "clinica": {
    "nombre": "Clínica San José",
    "logo": "data/logo.png",
    "colorPrimario": "#2b6cb0"
  }
}
```

La interfaz leería estos valores de `data/config.json` y personalizaría el header, el título de la ventana y los mensajes.

### 1.2 Mensajes por especialidad

Plantillas diferentes por especialidad en lugar de una plantilla global:

```json
{
  "mensajes": {
    "default": "Hola {nombre}, te recordamos tu cita...",
    "Dermatología": "Hola {nombre}, recordatorio: cita de dermatología...",
    "Odontología": "Estimado {nombre}, le recordamos su cita dental..."
  }
}
```

### 1.3 Horarios de envío configurables

Cada clínica define sus propias ventanas de envío (ej. 09:00-13:00 y 16:00-20:00) para no molestar fuera de horario.

### 1.4 Antelación configurable

Actualmente es 24h fijo. Permitir configurar 12h, 24h, 48h o múltiples recordatorios (ej. 48h + 24h antes).

---

## 2. Resiliencia y disponibilidad (Prioridad: Alta)

**Problema**: La app depende de un PC en la clínica. Si se apaga, se reinicia o pierde internet, no envía recordatorios.

### 2.1 Modo servidor Docker

Empaquetar la app completa (no solo soporte-server) en Docker para VPS:

```yaml
services:
  whatsapp-reminder:
    build: .
    restart: unless-stopped
    volumes:
      - data:/app/data
      - session:/.wwebjs_auth
```

Elimina el requisito de "PC encendido en recepción".

### 2.2 Reconexión agresiva

Añadir modo "reintento agresivo" con backoff exponencial para entornos inestables.

### 2.3 Cola de envíos persistente

Si la app está caída cuando toca enviar un recordatorio automático, al recuperarse reintentar los perdidos (dentro de un margen razonable).

### 2.4 Health check externo

Endpoint `/health` accesible desde fuera para UptimeRobot, Healthchecks.io, etc. El soporte-server ya lo tiene; la app cliente no expone nada (es localhost).

---

## 3. Cumplimiento legal y RGPD (Prioridad: Media-Alta)

**Problema**: WhatsApp Web no oficial + datos en JSON sin cifrado.

### 3.1 Cifrado de datos en reposo

Cifrar `citas.json` con una clave derivada de la instalación. Protege contra robo de disco o ZIP portable.

### 3.2 Registro de auditoría

Log de quién hizo qué (añadir/editar/borrar citas, enviar recordatorios) con timestamp. Requisito RGPD.

### 3.3 Exportación y eliminación de datos

- Botón para exportar todas las citas en CSV.
- Botón para eliminar datos de un paciente específico (derecho al olvido).

### 3.4 Aviso legal en la interfaz

Banner/modal en el primer uso informando sobre el tratamiento de datos y obteniendo consentimiento del responsable.

### 3.5 WhatsApp Business API (opcional)

Para clínicas con requisitos legales estrictos, ofrecer versión con API oficial de Meta (con costo por mensaje pero cumplimiento total).

---

## 4. Funcionalidades adicionales vendibles (Prioridad: Media)

### 4.1 Respuestas de confirmación ⭐

El feature más diferenciador. Si el paciente responde "Sí" o "No":
- Detectar respuestas automáticas.
- Marcar la cita como "confirmada" o "cancelada".
- Notificar a la recepcionista.

### 4.2 Recordatorios recurrentes

Para pacientes con citas periódicas (semanales, mensuales), definir patrones recurrentes en lugar de añadir manualmente.

### 4.3 Múltiples números de WhatsApp

Soportar múltiples sesiones de WhatsApp simultáneas para clínicas grandes (recepción, recordatorios, urgencias).

### 4.4 Integración con calendarios

- Exportar citas a Google Calendar.
- Importar desde calendario compartido.
- Soporte iCal (.ics).

### 4.5 Estadísticas de envío

Panel con métricas: recordatorios enviados, confirmados, tasa de no-shows, etc. Mide el ROI.

### 4.6 Mensajes de seguimiento post-cita

"¿Cómo estuvo su visita?" enviado automáticamente X horas después de la cita.

---

## 5. Modelo de negocio y distribución (Prioridad: Media)

### 5.1 Licenciamiento

Sistema de licencias simple con verificación al arrancar. Token firmado offline. Sin licencia → modo demo con límite de envíos.

### 5.2 Portal de soporte integrado

Ampliar el soporte-server existente con:
- Chat de soporte integrado.
- Base de conocimientos / FAQ.
- Tickets de soporte.

### 5.3 Onboarding automático

Wizard guiado al instalar:
1. Pide el nombre de la clínica.
2. Configura el mensaje personalizado.
3. Guía la conexión de WhatsApp.
4. Importa las primeras citas.
5. Envía un recordatorio de prueba.

### 5.4 Documentación por roles

Versiones del manual específicas para:
- **Recepcionista**: uso diario.
- **Administrador**: configuración.
- **Técnico**: solución de problemas.

---

## 6. Mejoras técnicas para escalabilidad (Prioridad: Baja-Media)

### 6.1 Base de datos real

Reemplazar `citas.json` por SQLite (empotrada, sin servidor):
- Consultas más rápidas con muchas citas.
- Integridad de datos (sin corrupción por escrituras interrumpidas).
- Posibilidad de migrar a PostgreSQL si crece.

### 6.2 API REST documentada

Documentar endpoints con OpenAPI/Swagger para integraciones con software de gestión clínica.

### 6.3 Webhooks

Notificar URLs externas cuando se envía un recordatorio, se confirma una cita, etc.

### 6.4 Internacionalización (i18n)

Adaptaciones locales para otros países hispanohablantes (formatos de fecha, saludos, etc.).

---

## Priorización recomendada

Para vender a más clínicas rápidamente:

| #  | Feature                      | Impacto en venta | Esfuerzo |
|----|-----------------------------|-------------------|----------|
| 1  | Branding personalizable      | Alto              | Bajo     |
| 2  | Modo servidor Docker         | Alto              | Medio    |
| 3  | Cifrado de datos             | Alto (RGPD)       | Medio    |
| 4  | Respuestas de confirmación   | Muy alto          | Medio    |
| 5  | Licenciamiento               | Alto              | Medio    |
| 6  | Onboarding wizard            | Medio             | Bajo     |
| 7  | Mensajes por especialidad    | Medio             | Bajo     |
| 8  | Horarios de envío            | Medio             | Bajo     |

---

## Notas técnicas

El código base es excelente:
- Estructura limpia y modular.
- Tests con motor falso, sin dependencia de red ni WhatsApp real.
- Resiliente: atómico en escrituras, timeouts en todo, logs persistentes.
- Auto-actualización desde GitHub con freno de versión, canales beta y downgrade.
- Soporte remoto profesional con servidor dedicado.

Las propuestas son **adiciones modulares** que no requieren reescribir lo existente.
