const { ipcMain } = require('electron');
const watchService = require('../services/watchService');

function registerWatchHandlers(getMainWindow) {
  ipcMain.handle('watch-start', (_e, ref, contextName, namespace, kind, sid) =>
    watchService.watchStart(ref, contextName, namespace, kind, sid, getMainWindow)
  );

  ipcMain.handle('watch-stop', (_e, sid) =>
    watchService.watchStop(sid)
  );
}

module.exports = {
  registerWatchHandlers,
};
