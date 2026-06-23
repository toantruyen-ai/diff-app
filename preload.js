const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('k8sApi', {
  selectKubeconfig: () => ipcRenderer.invoke('select-kubeconfig'),
  loadContexts: (kubeconfigPath) => ipcRenderer.invoke('load-contexts', kubeconfigPath),
  loadNamespaces: (kubeconfigPath, ctx) => ipcRenderer.invoke('load-namespaces', kubeconfigPath, ctx),
  loadDeployments: (kubeconfigPath, ctx, ns) => ipcRenderer.invoke('load-deployments', kubeconfigPath, ctx, ns),
  loadEnvs: (kubeconfigPath, ctx, ns, dep) => ipcRenderer.invoke('load-envs', kubeconfigPath, ctx, ns, dep),
});
