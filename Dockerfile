# WhatsApp Reminder v3 - Modo servidor Docker
# Permite ejecutar la app en un VPS sin necesidad de PC en la clínica

FROM node:18-bookworm-slim

# Chromium y dependencias para whatsapp-web.js
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    && rm -rf /var/lib/apt/lists/*

# Variables para puppeteer
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

# Copiar dependencias primero (mejor caché de Docker)
COPY package.json package-lock.json* ./
RUN npm install --production

# Copiar el resto del código
COPY . .

# Puerto de la aplicación
EXPOSE 3000

# Salud de la conexión
HEALTHCHECK --interval=60s --timeout=10s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/api/estado').then(r => r.json()).then(d => { process.exit(d.estado === 'conectado' || d.estado === 'conectando' ? 0 : 1); }).catch(() => process.exit(1))"

# Desactivar auto-actualización desde GitHub en Docker (la imagen ya es la versión)
ENV WR_SIN_ACTUALIZAR=1

CMD ["node", "server.js"]
