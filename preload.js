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
  triggerUpdate: () => ipcRenderer.invoke('trigger-update'),
  onUpdateAvailable: (cb) => ipcRenderer.on('update-available', (_e, v) => cb(v)),

  listResource: (ref, ctx, ns, kind) => ipcRenderer.invoke('list-resource', ref, ctx, ns, kind),
  getMetrics: (ref, ctx, ns, scope) => ipcRenderer.invoke('get-metrics', ref, ctx, ns, scope),
  getResourceYaml: (ref, ctx, ns, kind, name, opts) => ipcRenderer.invoke('get-resource-yaml', ref, ctx, ns, kind, name, opts),
  getResourceEvents: (ref, ctx, ns, kind, name) => ipcRenderer.invoke('get-resource-events', ref, ctx, ns, kind, name),
  resourceAction: (ref, ctx, ns, kind, name, action, payload) =>
    ipcRenderer.invoke('resource-action', ref, ctx, ns, kind, name, action, payload),
  checkAccess: (ref, ctx, ns, kind, name) => ipcRenderer.invoke('check-access', ref, ctx, ns, kind, name),
  searchResources: (ref, ctx, ns, query) => ipcRenderer.invoke('search-resources', ref, ctx, ns, query),
  getManageOverview: (ref, ctx) => ipcRenderer.invoke('get-manage-overview', ref, ctx),

  listCrds: (ref, ctx) => ipcRenderer.invoke('list-crds', ref, ctx),
  listCustomResource: (ref, ctx, ns, group, version, plural, namespaced) =>
    ipcRenderer.invoke('list-custom-resource', ref, ctx, ns, group, version, plural, namespaced),
  getCustomResourceYaml: (ref, ctx, ns, group, version, plural, name, namespaced) =>
    ipcRenderer.invoke('get-custom-resource-yaml', ref, ctx, ns, group, version, plural, name, namespaced),
  getCustomResourceEvents: (ref, ctx, ns, kindLabel, name, namespaced) =>
    ipcRenderer.invoke('get-custom-resource-events', ref, ctx, ns, kindLabel, name, namespaced),
  customResourceAction: (ref, ctx, ns, group, version, plural, name, namespaced, action) =>
    ipcRenderer.invoke('custom-resource-action', ref, ctx, ns, group, version, plural, name, namespaced, action),

  startPortForward: (ref, ctx, ns, pod, targetPort, localPort, sid) =>
    ipcRenderer.invoke('pf-start', ref, ctx, ns, pod, targetPort, localPort, sid),
  stopPortForward: (sid) => ipcRenderer.invoke('pf-stop', sid),
  onPortForwardError: (sid, cb) => {
    const handler = (_e, msg) => cb(msg);
    ipcRenderer.on(`pf-error:${sid}`, handler);
    return () => ipcRenderer.removeListener(`pf-error:${sid}`, handler);
  },

  startPodLogs: (ref, ctx, ns, pod, container, opts, sid) =>
    ipcRenderer.invoke('start-pod-logs', ref, ctx, ns, pod, container, opts, sid),
  stopPodLogs: (sid) => ipcRenderer.invoke('stop-pod-logs', sid),
  onPodLogData: (sid, cb) => {
    const handler = (_e, chunk) => cb(chunk);
    ipcRenderer.on(`pod-log-data:${sid}`, handler);
    return () => ipcRenderer.removeListener(`pod-log-data:${sid}`, handler);
  },
  onPodLogEnd: (sid, cb) => {
    const handler = () => cb();
    ipcRenderer.on(`pod-log-end:${sid}`, handler);
    return () => ipcRenderer.removeListener(`pod-log-end:${sid}`, handler);
  },
  onPodLogError: (sid, cb) => {
    const handler = (_e, msg) => cb(msg);
    ipcRenderer.on(`pod-log-error:${sid}`, handler);
    return () => ipcRenderer.removeListener(`pod-log-error:${sid}`, handler);
  },

  startExec: (ref, ctx, ns, pod, container, sid) =>
    ipcRenderer.invoke('exec-start', ref, ctx, ns, pod, container, sid),
  execWrite: (sid, data) => ipcRenderer.send('exec-write', sid, data),
  execResize: (sid, cols, rows) => ipcRenderer.send('exec-resize', sid, cols, rows),
  stopExec: (sid) => ipcRenderer.invoke('exec-stop', sid),
  onExecData: (sid, cb) => {
    const handler = (_e, chunk) => cb(chunk);
    ipcRenderer.on(`exec-data:${sid}`, handler);
    return () => ipcRenderer.removeListener(`exec-data:${sid}`, handler);
  },
  onExecExit: (sid, cb) => {
    const handler = (_e, status) => cb(status);
    ipcRenderer.on(`exec-exit:${sid}`, handler);
    return () => ipcRenderer.removeListener(`exec-exit:${sid}`, handler);
  },
});
