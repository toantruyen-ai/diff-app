const electron = require('electron');
const troubleshootingService = require('../services/troubleshootingService');

const SAFE_IDENTIFIER = /^[a-z0-9][a-z0-9._-]*$/i;

function isValidIdentifier(val) {
  if (!val) return true;
  if (typeof val !== 'string') return false;
  return SAFE_IDENTIFIER.test(val);
}

function registerTroubleshootingHandlers(customElectron) {
  const ipcMain = (customElectron && customElectron.ipcMain) || electron.ipcMain;
  if (!ipcMain) return;

  ipcMain.handle('analyze-pod', async (_event, ref, contextName, namespace, podName, opts) => {
    if (!namespace || typeof namespace !== 'string' || !isValidIdentifier(namespace)) {
      return { ok: false, error: 'Invalid namespace identifier' };
    }
    if (!podName || typeof podName !== 'string' || !isValidIdentifier(podName)) {
      return { ok: false, error: 'Invalid podName identifier' };
    }

    try {
      return await troubleshootingService.analyzePod(ref, contextName, namespace, podName, opts);
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('get-analysis-history', async (_event, ref, contextName, namespace, podName) => {
    if (namespace && typeof namespace === 'string' && namespace !== '__all__' && !isValidIdentifier(namespace)) {
      return { ok: false, error: 'Invalid namespace identifier' };
    }
    if (podName && typeof podName === 'string' && !isValidIdentifier(podName)) {
      return { ok: false, error: 'Invalid podName identifier' };
    }

    try {
      return await troubleshootingService.getAnalysisHistory(ref, contextName, namespace, podName);
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('delete-analysis', async (_event, ref, contextName, id) => {
    if (!id || typeof id !== 'string') {
      return { ok: false, error: 'Invalid analysis ID' };
    }

    try {
      return await troubleshootingService.deleteAnalysis(ref, contextName, id);
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('clear-analysis-history', async (_event, ref, contextName, namespace) => {
    if (namespace && typeof namespace === 'string' && namespace !== '__all__' && !isValidIdentifier(namespace)) {
      return { ok: false, error: 'Invalid namespace identifier' };
    }

    try {
      return await troubleshootingService.clearAnalysisHistory(ref, contextName, namespace);
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('test-ai-cli', async (_event, provider) => {
    try {
      return await troubleshootingService.testAiCli(provider || 'claude');
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
}

module.exports = {
  registerTroubleshootingHandlers,
  isValidIdentifier,
};
