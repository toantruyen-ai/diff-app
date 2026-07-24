const { app, BrowserWindow } = require('electron');
const path = require('path');
const { execFileSync } = require('child_process');
const os = require('os');
const { registerAllIpcHandlers } = require('./ipc');
const { stopAllWatchSessions } = require('./services/watchService');
const { stopAllLogSessions } = require('./services/podLogService');
const { stopAllExecSessions } = require('./services/podExecService');
const { stopAllPortForwardSessions } = require('./services/portForwardService');
const { stopEventWatch } = require('./services/eventsService');

app.setName('Diff-App');

// ── Auto-updater (packaged app only) ──────────────────────────────────────────
let autoUpdater = null;
if (app.isPackaged) {
  try {
    autoUpdater = require('electron-updater').autoUpdater;
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.logger = null;

    autoUpdater.on('update-available', (info) => {
      if (mainWindow) mainWindow.webContents.send('update-available', info.version);
    });
  } catch {
    autoUpdater = null;
  }
}

// Ensure PATH contains user shell binaries when packaged
if ((process.platform === 'darwin' || process.platform === 'linux') && app.isPackaged) {
  try {
    const shell = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
    const shellPath = execFileSync(shell, ['-l', '-c', 'echo $PATH'], {
      encoding: 'utf8',
      timeout: 3000,
    }).trim();
    if (shellPath) process.env.PATH = shellPath;
  } catch {
    const home = os.homedir();
    const extra = process.platform === 'darwin'
      ? ['/opt/homebrew/bin']
      : ['/usr/bin', '/snap/bin'];
    process.env.PATH = [
      `${home}/.krew/bin`,
      '/usr/local/bin',
      ...extra,
      process.env.PATH,
    ].join(':');
  }
}

let mainWindow = null;
const ICON_PATH = path.join(__dirname, '..', '..', 'build', 'icon.png');

function getMainWindow() {
  return mainWindow;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    webPreferences: {
      preload: path.join(__dirname, '..', '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0f1117',
    icon: ICON_PATH,
    show: false,
  });

  mainWindow.loadFile(path.join(__dirname, '..', '..', 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (autoUpdater) setTimeout(() => autoUpdater.checkForUpdates().catch(() => { }), 5000);
  });

  mainWindow.on('closed', () => {
    stopAllLogSessions();
    stopAllExecSessions();
    stopAllPortForwardSessions();
    stopAllWatchSessions();
    mainWindow = null;
  });
}

function initApp() {
  registerAllIpcHandlers(getMainWindow);

  app.whenReady().then(() => {
    if (process.platform === 'darwin' && app.dock) {
      try { app.dock.setIcon(ICON_PATH); } catch { /* icon missing */ }
    }
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('will-quit', () => {
    stopEventWatch();
  });
}

module.exports = {
  initApp,
  createWindow,
  getMainWindow,
};
