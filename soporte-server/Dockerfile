# Receptor de soporte: un solo fichero, sin dependencias. Se construye directamente desde git
# (ver compose.yaml), asi que no depende de la cache de raw.githubusercontent.com.
FROM node:22-alpine
WORKDIR /app
COPY server.js .
# Se ejecuta como root a proposito: el volumen soporte-data ya existente tiene ficheros de root
CMD ["node", "server.js"]
