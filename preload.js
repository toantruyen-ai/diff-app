const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('k8sApi', {
  selectKubeconfig: () => ipcRenderer.invoke('select-kubeconfig'),
  loadContexts: (kubeconfigPath) => ipcRenderer.invoke('load-contexts', kubeconfigPath),
  loadNamespaces: (kubeconfigPath, ctx) => ipcRenderer.invoke('load-namespaces', kubeconfigPath, ctx),
  loadDeployments: (kubeconfigPath, ctx, ns) => ipcRenderer.invoke('load-deployments', kubeconfigPath, ctx, ns),
  loadEnvs: (kubeconfigPath, ctx, ns, dep) => ipcRenderer.invoke('load-envs', kubeconfigPath, ctx, ns, dep),
  getTokenExpiry: () => ipcRenderer.invoke('get-token-expiry'),
  listAksClusters: () => ipcRenderer.invoke('list-aks-clusters'),
  getAksCredentials: (name, rg) => ipcRenderer.invoke('get-aks-credentials', name, rg),
  listStorageAccounts: () => ipcRenderer.invoke('list-storage-accounts'),
  listStorageContainers: (accounts) => ipcRenderer.invoke('list-storage-containers', accounts),
  listServiceBusNamespaces: () => ipcRenderer.invoke('list-servicebus-namespaces'),
  listServiceBusQueues: (namespaces) => ipcRenderer.invoke('list-servicebus-queues', namespaces),
  checkAzureAuth: () => ipcRenderer.invoke('check-azure-auth'),
  checkKubeloginAuth: () => ipcRenderer.invoke('check-kubelogin-auth'),
  azLogin: () => ipcRenderer.invoke('az-login'),
  kubeloginRefresh: () => ipcRenderer.invoke('kubelogin-refresh'),
});
