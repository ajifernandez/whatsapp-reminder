#!/usr/bin/env bash
# Lanzador para Linux / Mac: arranca el servidor y abre el navegador.
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: Node.js no está instalado. Instálalo desde https://nodejs.org"
  read -r -p "Pulsa Enter para salir..."
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "Instalando dependencias (solo la primera vez)..."
  npm install || { echo "Falló la instalación."; read -r -p "Enter para salir..."; exit 1; }
fi

URL="http://localhost:3000"

# Abrir el navegador cuando el servidor esté listo
( sleep 3
  if command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL"
  elif command -v open >/dev/null 2>&1; then open "$URL"
  fi
) &

echo "Abriendo $URL en el navegador..."
node server.js
