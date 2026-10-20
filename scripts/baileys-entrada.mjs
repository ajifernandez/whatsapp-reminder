// Entrada del bundle de Baileys (npm run build:baileys -> vendor/baileys.bundle.mjs).
// Las clínicas usan la versión portable, sin npm: Baileys les llega como un único
// fichero que el updater descarga como cualquier otro.
export { default as makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } from 'baileys';
