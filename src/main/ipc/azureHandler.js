const { ipcMain } = require('electron');
const azureService = require('../services/azureService');

function registerAzureHandlers() {
  ipcMain.handle('check-azure-auth', () => azureService.checkAzureAuth());
  ipcMain.handle('check-kubelogin-auth', () => azureService.checkKubeloginAuth());
  ipcMain.handle('get-token-expiry', () => azureService.getTokenExpiry());
  ipcMain.handle('az-logout', () => azureService.azLogout());
  ipcMain.handle('az-login', () => azureService.azLogin());
  ipcMain.handle('kubelogin-refresh', () => azureService.kubeloginRefresh());
  ipcMain.handle('list-aks-clusters', () => azureService.listAksClusters());
  ipcMain.handle('get-aks-credentials', (_e, name, resourceGroup) => azureService.getAksCredentials(name, resourceGroup));
  ipcMain.handle('list-storage-accounts', () => azureService.listStorageAccounts());
  ipcMain.handle('list-storage-containers', (_e, accounts) => azureService.listStorageContainers(accounts));
  ipcMain.handle('list-servicebus-namespaces', () => azureService.listServicebusNamespaces());
  ipcMain.handle('list-servicebus-queues', (_e, namespaces) => azureService.listServicebusQueues(namespaces));
}

module.exports = {
  registerAzureHandlers,
};
