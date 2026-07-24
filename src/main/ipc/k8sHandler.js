const { ipcMain, dialog } = require('electron');
const { loadContexts, loadNamespaces, loadDeployments } = require('../services/k8sService');
const { loadEnvs } = require('../services/envResolverService');

function registerK8sHandlers() {
  ipcMain.handle('select-kubeconfig', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Kubeconfig', extensions: ['yaml', 'yml', ''] }],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipcMain.handle('load-contexts', async (_e, ref) => loadContexts(ref));

  ipcMain.handle('load-namespaces', async (_e, kubeconfigPath, contextName) => loadNamespaces(kubeconfigPath, contextName));

  ipcMain.handle('load-deployments', async (_e, kubeconfigPath, contextName, namespace) => loadDeployments(kubeconfigPath, contextName, namespace));

  ipcMain.handle('load-envs', async (_e, kubeconfigPath, contextName, namespace, deploymentName) => loadEnvs(kubeconfigPath, contextName, namespace, deploymentName));
}

module.exports = {
  registerK8sHandlers,
};
