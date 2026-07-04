@echo off
REM Lanzador para Windows: arranca el servidor y abre el navegador.
title Recordatorios WhatsApp
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo ERROR: Node.js no esta instalado. Instalalo desde https://nodejs.org
  pause
  exit /b 1
)

if not exist node_modules (
  echo Instalando dependencias ^(solo la primera vez^)...
  call npm install
  if errorlevel 1 (
    echo Fallo la instalacion.
    pause
    exit /b 1
  )
)

echo Abriendo http://localhost:3000 en el navegador...
start "" http://localhost:3000
node server.js

pause
