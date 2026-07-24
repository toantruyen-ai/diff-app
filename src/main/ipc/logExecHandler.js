const { ipcMain } = require('electron');
const podLogService = require('../services/podLogService');
const podExecService = require('../services/podExecService');
const portForwardService = require('../services/portForwardService');

function registerLogExecHandlers(getMainWindow) {
  ipcMain.handle('start-pod-logs', (_e, ref, contextName, namespace, pod, container, opts, sid) =>
    podLogService.startPodLogs(ref, contextName, namespace, pod, container, opts, sid, getMainWindow)
  );

  ipcMain.handle('stop-pod-logs', (_e, sid) =>
    podLogService.stopPodLogs(sid)
  );

  ipcMain.handle('exec-start', (_e, ref, contextName, namespace, pod, container, sid) =>
    podExecService.execStart(ref, contextName, namespace, pod, container, sid, getMainWindow)
  );

  ipcMain.on('exec-write', (_e, sid, data) =>
    podExecService.execWrite(sid, data)
  );

  ipcMain.on('exec-resize', (_e, sid, cols, rows) =>
    podExecService.execResize(sid, cols, rows)
  );

  ipcMain.handle('exec-stop', (_e, sid) =>
    podExecService.execStop(sid)
  );

  ipcMain.handle('pf-start', (_e, ref, contextName, namespace, pod, targetPort, localPort, sid) =>
    portForwardService.pfStart(ref, contextName, namespace, pod, targetPort, localPort, sid, getMainWindow)
  );

  ipcMain.handle('pf-stop', (_e, sid) =>
    portForwardService.pfStop(sid)
  );
}

module.exports = {
  registerLogExecHandlers,
};
