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
  azLogout: () => ipcRenderer.invoke('az-logout'),
  kubeloginRefresh: () => ipcRenderer.invoke('kubelogin-refresh'),
  triggerUpdate: () => ipcRenderer.invoke('trigger-update'),
  onUpdateAvailable: (cb) => ipcRenderer.on('update-available', (_e, v) => cb(v)),

  listResource: (ref, ctx, ns, kind) => ipcRenderer.invoke('list-resource', ref, ctx, ns, kind),
  getMetrics: (ref, ctx, ns, scope) => ipcRenderer.invoke('get-metrics', ref, ctx, ns, scope),
  getResourceYaml: (ref, ctx, ns, kind, name, opts) => ipcRenderer.invoke('get-resource-yaml', ref, ctx, ns, kind, name, opts),
  applyResourceYaml: (ref, ctx, ns, kind, name, yamlText, resourceVersion) =>
    ipcRenderer.invoke('apply-resource-yaml', ref, ctx, ns, kind, name, yamlText, resourceVersion),
  getResourceEvents: (ref, ctx, ns, kind, name) => ipcRenderer.invoke('get-resource-events', ref, ctx, ns, kind, name),
  resourceAction: (ref, ctx, ns, kind, name, action, payload) =>
    ipcRenderer.invoke('resource-action', ref, ctx, ns, kind, name, action, payload),
  checkAccess: (ref, ctx, ns, kind, name) => ipcRenderer.invoke('check-access', ref, ctx, ns, kind, name),
  checkCustomResourceAccess: (ref, ctx, ns, group, resource, namespaced, name) =>
    ipcRenderer.invoke('check-custom-resource-access', ref, ctx, ns, group, resource, namespaced, name),
  searchResources: (ref, ctx, ns, query, crds) => ipcRenderer.invoke('search-resources', ref, ctx, ns, query, crds),
  getManageOverview: (ref, ctx) => ipcRenderer.invoke('get-manage-overview', ref, ctx),

  listCrds: (ref, ctx) => ipcRenderer.invoke('list-crds', ref, ctx),
  listCustomResource: (ref, ctx, ns, group, version, plural, namespaced) =>
    ipcRenderer.invoke('list-custom-resource', ref, ctx, ns, group, version, plural, namespaced),
  getCustomResourceYaml: (ref, ctx, ns, group, version, plural, name, namespaced, opts) =>
    ipcRenderer.invoke('get-custom-resource-yaml', ref, ctx, ns, group, version, plural, name, namespaced, opts),
  applyCustomResourceYaml: (ref, ctx, ns, group, version, plural, name, namespaced, yamlText, resourceVersion) =>
    ipcRenderer.invoke('apply-custom-resource-yaml', ref, ctx, ns, group, version, plural, name, namespaced, yamlText, resourceVersion),
  getCustomResourceEvents: (ref, ctx, ns, kindLabel, name, namespaced) =>
    ipcRenderer.invoke('get-custom-resource-events', ref, ctx, ns, kindLabel, name, namespaced),
  customResourceAction: (ref, ctx, ns, group, version, plural, name, namespaced, action) =>
    ipcRenderer.invoke('custom-resource-action', ref, ctx, ns, group, version, plural, name, namespaced, action),

  startPortForward: (ref, ctx, ns, pod, targetPort, localPort, sid) =>
    ipcRenderer.invoke('pf-start', ref, ctx, ns, pod, targetPort, localPort, sid),
  stopPortForward: (sid) => ipcRenderer.invoke('pf-stop', sid),
  
  // Event Auto-Capture
  toggleEventCapture: (params) => ipcRenderer.invoke('toggle-event-capture', params),

  // Audit Database
  discoverAuditDb: () => ipcRenderer.invoke('audit-db-discover'),
  connectAuditDb: (user, pw) => ipcRenderer.invoke('audit-db-connect', user, pw),
  disconnectAuditDb: () => ipcRenderer.invoke('audit-db-disconnect'),
  getAuditDbStatus: () => ipcRenderer.invoke('audit-db-status'),
  getResourceVersions: (ref, ctx, ns, kind, name) => ipcRenderer.invoke('get-resource-versions', ref, ctx, ns, kind, name),
  getVersionYaml: (id) => ipcRenderer.invoke('get-version-yaml', id),
  restoreResourceVersion: (ref, ctx, ns, kind, name, id, crdMeta) => ipcRenderer.invoke('restore-resource-version', ref, ctx, ns, kind, name, id, crdMeta),
  getDeletedResources: (ref, ctx, ns) => ipcRenderer.invoke('get-deleted-resources', ref, ctx, ns),
  restoreDeletedResource: (ref, ctx, ns, kind, name, id, crdMeta) => ipcRenderer.invoke('restore-deleted-resource', ref, ctx, ns, kind, name, id, crdMeta),
  setEventRetention: (params) => ipcRenderer.invoke('set-event-retention', params),
  clearEventDb: () => ipcRenderer.invoke('clear-event-db'),
  getLocalEvents: (params) => ipcRenderer.invoke('get-local-events', params),

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

  startWatch: (ref, ctx, ns, kind, sid) => ipcRenderer.invoke('watch-start', ref, ctx, ns, kind, sid),
  stopWatch: (sid) => ipcRenderer.invoke('watch-stop', sid),
  onWatchSync: (sid, cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on(`watch-sync:${sid}`, handler);
    return () => ipcRenderer.removeListener(`watch-sync:${sid}`, handler);
  },
  onWatchEvent: (sid, cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on(`watch-event:${sid}`, handler);
    return () => ipcRenderer.removeListener(`watch-event:${sid}`, handler);
  },
  onWatchError: (sid, cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on(`watch-error:${sid}`, handler);
    return () => ipcRenderer.removeListener(`watch-error:${sid}`, handler);
  },
});
