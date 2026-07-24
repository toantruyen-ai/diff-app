const { ipcMain } = require('electron');
const { sessionManager } = require('../services/sessionManagerService');
const podExecService = require('../services/podExecService');
const portForwardService = require('../services/portForwardService');
const ephemeralDebugService = require('../services/ephemeralDebugService');

const SAFE_IDENTIFIER = /^[a-z0-9][a-z0-9._-]*$/i;

function isValidIdentifier(val) {
  if (!val) return true;
  if (typeof val !== 'string') return false;
  return SAFE_IDENTIFIER.test(val);
}

function registerDebugHandlers(getMainWindow) {
  ipcMain.handle('session:list', () => {
    return { ok: true, sessions: sessionManager.listSessions() };
  });

  ipcMain.handle('pf:list', () => {
    return { ok: true, sessions: sessionManager.listSessions().filter((s) => s.kind === 'port-forward') };
  });

  ipcMain.handle('session:stop', (_e, sid) => {
    if (!sid || typeof sid !== 'string') return { ok: false, error: 'invalid-input' };
    sessionManager.removeSession(sid, getMainWindow);
    return { ok: true };
  });

  ipcMain.handle('exec:start', (_e, ref, contextName, namespace, pod, container, sid, shellCmd) => {
    if (!isValidIdentifier(namespace) || !isValidIdentifier(pod) || !isValidIdentifier(container)) {
      return { ok: false, error: 'invalid-input' };
    }
    return podExecService.execStart(ref, contextName, namespace, pod, container, sid, getMainWindow, shellCmd);
  });

  ipcMain.on('exec:write', (_e, sid, data) => {
    if (sid && typeof data === 'string') {
      podExecService.execWrite(sid, data);
    }
  });

  ipcMain.on('exec:resize', (_e, sid, cols, rows) => {
    if (sid && typeof cols === 'number' && typeof rows === 'number') {
      podExecService.execResize(sid, cols, rows);
    }
  });

  ipcMain.handle('exec:stop', (_e, sid) => {
    if (!sid || typeof sid !== 'string') return { ok: false, error: 'invalid-input' };
    return podExecService.execStop(sid, getMainWindow);
  });

  ipcMain.handle('pf:start', (_e, ref, contextName, namespace, targetArg, targetPortArg, localPortArg, sid, opts) => {
    if (!isValidIdentifier(namespace)) return { ok: false, error: 'invalid-input' };
    return portForwardService.pfStart(ref, contextName, namespace, targetArg, targetPortArg, localPortArg, sid, getMainWindow, opts);
  });
  ipcMain.handle('pf-start', (_e, ref, contextName, namespace, targetArg, targetPortArg, localPortArg, sid, opts) => {
    if (!isValidIdentifier(namespace)) return { ok: false, error: 'invalid-input' };
    return portForwardService.pfStart(ref, contextName, namespace, targetArg, targetPortArg, localPortArg, sid, getMainWindow, opts);
  });

  ipcMain.handle('pf:stop', (_e, sid) => {
    if (!sid || typeof sid !== 'string') return { ok: false, error: 'invalid-input' };
    return portForwardService.pfStop(sid, getMainWindow);
  });
  ipcMain.handle('pf-stop', (_e, sid) => {
    if (!sid || typeof sid !== 'string') return { ok: false, error: 'invalid-input' };
    return portForwardService.pfStop(sid, getMainWindow);
  });

  ipcMain.handle('pf:open-browser', (_e, localPort) => {
    return portForwardService.openLocalBrowser(localPort);
  });

  ipcMain.handle('debug:inject-ephemeral', (_e, ref, contextName, namespace, pod, targetContainer, image) => {
    if (!isValidIdentifier(namespace) || !isValidIdentifier(pod) || !isValidIdentifier(targetContainer)) {
      return { ok: false, error: 'invalid-input' };
    }
    return ephemeralDebugService.injectEphemeralContainer(ref, contextName, namespace, pod, targetContainer, image);
  });

  ipcMain.handle('debug:copy-to', (_e, ref, contextName, namespace, podName, containerToOverride, image, command) => {
    if (!isValidIdentifier(namespace) || !isValidIdentifier(podName) || !isValidIdentifier(containerToOverride)) {
      return { ok: false, error: 'invalid-input' };
    }
    return ephemeralDebugService.copyPodToDebug(ref, contextName, namespace, podName, containerToOverride, image, command);
  });
}

module.exports = {
  registerDebugHandlers,
  isValidIdentifier,
};
