const { ipcMain } = require('electron');
const multiPodLogService = require('../services/multiPodLogService');

const IDENTIFIER_REGEX = /^[a-z0-9][a-z0-9._-]*$/i;

function validateId(val) {
  return typeof val === 'string' && IDENTIFIER_REGEX.test(val);
}

function registerMultiPodLogHandlers(getMainWindow, customIpcMain) {
  const targetIpc = customIpcMain || ipcMain;
  targetIpc.handle('multi-pod-log-start', (_e, ref, contextName, namespace, workload, opts, sid) => {
    if (!validateId(namespace) || !validateId(sid)) {
      return { ok: false, error: 'Invalid input identifiers' };
    }
    return multiPodLogService.startMultiPodLogs(
      ref,
      contextName,
      namespace,
      workload,
      opts,
      sid,
      getMainWindow
    );
  });

  targetIpc.handle('multi-pod-log-stop', (_e, sid) => {
    if (!validateId(sid)) return { ok: false, error: 'Invalid session ID' };
    return multiPodLogService.stopMultiPodLogs(sid);
  });

  targetIpc.handle('multi-pod-log-update-tail', (_e, sid, tailLines) => {
    if (!validateId(sid)) return { ok: false, error: 'Invalid session ID' };
    return multiPodLogService.updateTail(sid, tailLines);
  });

  targetIpc.handle('multi-pod-log-set-stream-enabled', (_e, sid, streamKey, enabled) => {
    if (!validateId(sid)) return { ok: false, error: 'Invalid session ID' };
    return multiPodLogService.setStreamEnabled(sid, streamKey, enabled);
  });

  targetIpc.handle('multi-pod-log-set-backpressure', (_e, sid, mode) => {
    if (!validateId(sid)) return { ok: false, error: 'Invalid session ID' };
    return multiPodLogService.setBackpressure(sid, mode);
  });
}

module.exports = {
  registerMultiPodLogHandlers,
};
