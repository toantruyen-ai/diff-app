/**
 * Main entry point for Electron main process.
 * Modularized under src/main/ for scalable architecture and token-efficient AI editing.
 */
const { initApp } = require('./src/main/index');

initApp();
