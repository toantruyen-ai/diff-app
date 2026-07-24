const { dryRunApply, applySsa, dryRunBatch, applyBatch } = require('../services/yamlDryRunService');
const { lintYamlText } = require('../utils/yamlLintHelper');
const { mapPathToPosition } = require('../utils/yamlPosHelper');

function registerYamlHandler(customElectron) {
  const { ipcMain } = customElectron || require('electron');

  ipcMain.handle('dry-run-yaml', async (_event, ref, contextName, manifestYaml) => {
    if (!ref || typeof ref !== 'string' || !manifestYaml || typeof manifestYaml !== 'string') {
      return { ok: false, reason: 'invalid-input', error: 'Invalid or missing arguments' };
    }
    return dryRunApply(ref, contextName, manifestYaml);
  });

  ipcMain.handle('apply-ssa-yaml', async (_event, ref, contextName, manifestYaml, force) => {
    if (!ref || typeof ref !== 'string' || !manifestYaml || typeof manifestYaml !== 'string') {
      return { ok: false, reason: 'invalid-input', error: 'Invalid or missing arguments' };
    }
    return applySsa(ref, contextName, manifestYaml, Boolean(force));
  });

  ipcMain.handle('dry-run-batch-yaml', async (_event, ref, contextName, manifestYaml) => {
    if (!ref || typeof ref !== 'string' || !manifestYaml || typeof manifestYaml !== 'string') {
      return { ok: false, reason: 'invalid-input', error: 'Invalid or missing arguments' };
    }
    return dryRunBatch(ref, contextName, manifestYaml);
  });

  ipcMain.handle('apply-batch-yaml', async (_event, ref, contextName, manifestYaml, force) => {
    if (!ref || typeof ref !== 'string' || !manifestYaml || typeof manifestYaml !== 'string') {
      return { ok: false, reason: 'invalid-input', error: 'Invalid or missing arguments' };
    }
    return applyBatch(ref, contextName, manifestYaml, Boolean(force));
  });

  ipcMain.handle('lint-yaml', async (_event, yamlText) => {
    if (!yamlText || typeof yamlText !== 'string') {
      return { ok: false, reason: 'invalid-input', error: 'Invalid YAML text argument' };
    }
    return lintYamlText(yamlText);
  });

  ipcMain.handle('map-yaml-pos', async (_event, yamlText, path) => {
    if (!yamlText || typeof yamlText !== 'string' || !Array.isArray(path)) {
      return { ok: false, reason: 'invalid-input', error: 'Invalid arguments for map-yaml-pos' };
    }
    const pos = mapPathToPosition(yamlText, path);
    return { ok: true, pos };
  });
}

module.exports = {
  registerYamlHandler,
};
