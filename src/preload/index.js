const electron = require('electron');

function exposePreloadApi(customElectron) {
  const e = customElectron || electron;
  const contextBridge = e.contextBridge;
  const ipcRenderer = e.ipcRenderer;
  if (!contextBridge || !ipcRenderer) return;

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
    getAppVersion: () => ipcRenderer.invoke('get-app-version'),
    onUpdateAvailable: (cb) => ipcRenderer.on('update-available', (_e, v) => cb(v)),

    listResource: (ref, ctx, ns, kind) => ipcRenderer.invoke('list-resource', ref, ctx, ns, kind),
    getMetrics: (ref, ctx, ns, scope) => ipcRenderer.invoke('get-metrics', ref, ctx, ns, scope),
    getResourceYaml: (ref, ctx, ns, kind, name, opts) => ipcRenderer.invoke('get-resource-yaml', ref, ctx, ns, kind, name, opts),
    applyResourceYaml: (ref, ctx, ns, kind, name, yamlText, resourceVersion) =>
      ipcRenderer.invoke('apply-resource-yaml', ref, ctx, ns, kind, name, yamlText, resourceVersion),
    dryRunYaml: (ref, ctx, yamlText) => ipcRenderer.invoke('dry-run-yaml', ref, ctx, yamlText),
    applySsaYaml: (ref, ctx, yamlText, force) => ipcRenderer.invoke('apply-ssa-yaml', ref, ctx, yamlText, force),
    dryRunBatchYaml: (ref, ctx, yamlText) => ipcRenderer.invoke('dry-run-batch-yaml', ref, ctx, yamlText),
    applyBatchYaml: (ref, ctx, yamlText, force) => ipcRenderer.invoke('apply-batch-yaml', ref, ctx, yamlText, force),
    lintYaml: (yamlText) => ipcRenderer.invoke('lint-yaml', yamlText),
    mapYamlPos: (yamlText, path) => ipcRenderer.invoke('map-yaml-pos', yamlText, path),
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

    startPortForward: (ref, ctx, ns, pod, targetPort, localPort, sid, opts) =>
      ipcRenderer.invoke('pf:start', ref, ctx, ns, pod, targetPort, localPort, sid, opts),
    stopPortForward: (sid) => ipcRenderer.invoke('pf:stop', sid),
    openPortForwardBrowser: (localPort) => ipcRenderer.invoke('pf:open-browser', localPort),
    
    toggleEventCapture: (params) => ipcRenderer.invoke('toggle-event-capture', params),

    auditDbDiscover: () => ipcRenderer.invoke('audit-db-discover'),
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

    startMultiPodLogs: (ref, ctx, ns, workload, opts, sid) =>
      ipcRenderer.invoke('multi-pod-log-start', ref, ctx, ns, workload, opts, sid),
    stopMultiPodLogs: (sid) => ipcRenderer.invoke('multi-pod-log-stop', sid),
    updateMultiPodLogTail: (sid, tailLines) => ipcRenderer.invoke('multi-pod-log-update-tail', sid, tailLines),
    setMultiPodLogStreamEnabled: (sid, streamKey, enabled) =>
      ipcRenderer.invoke('multi-pod-log-set-stream-enabled', sid, streamKey, enabled),
    setMultiPodLogBackpressure: (sid, mode) =>
      ipcRenderer.invoke('multi-pod-log-set-backpressure', sid, mode),

    onMultiPodLogBatch: (sid, cb) => {
      const handler = (_e, batch) => cb(batch);
      ipcRenderer.on(`multi-pod-log-batch:${sid}`, handler);
      return () => ipcRenderer.removeListener(`multi-pod-log-batch:${sid}`, handler);
    },
    onMultiPodLogTopology: (sid, cb) => {
      const handler = (_e, topology) => cb(topology);
      ipcRenderer.on(`multi-pod-log-topology:${sid}`, handler);
      return () => ipcRenderer.removeListener(`multi-pod-log-topology:${sid}`, handler);
    },
    onMultiPodLogStatus: (sid, cb) => {
      const handler = (_e, status) => cb(status);
      ipcRenderer.on(`multi-pod-log-status:${sid}`, handler);
      return () => ipcRenderer.removeListener(`multi-pod-log-status:${sid}`, handler);
    },

    listSessions: () => ipcRenderer.invoke('session:list'),
    stopSession: (sid) => ipcRenderer.invoke('session:stop', sid),
    injectEphemeralContainer: (ref, ctx, ns, pod, targetContainer, image) =>
      ipcRenderer.invoke('debug:inject-ephemeral', ref, ctx, ns, pod, targetContainer, image),
    copyPodToDebug: (ref, ctx, ns, podName, containerToOverride, image, command) =>
      ipcRenderer.invoke('debug:copy-to', ref, ctx, ns, podName, containerToOverride, image, command),
    analyzePod: (ref, ctx, ns, podName, opts) =>
      ipcRenderer.invoke('analyze-pod', ref, ctx, ns, podName, opts),
    getAnalysisHistory: (ref, ctx, ns, podName) =>
      ipcRenderer.invoke('get-analysis-history', ref, ctx, ns, podName),
    deleteAnalysis: (ref, ctx, id) =>
      ipcRenderer.invoke('delete-analysis', ref, ctx, id),
    clearAnalysisHistory: (ref, ctx, ns) =>
      ipcRenderer.invoke('clear-analysis-history', ref, ctx, ns),
    testAiCli: (provider) =>
      ipcRenderer.invoke('test-ai-cli', provider),
    getAiConfig: (ref, ctx) =>
      ipcRenderer.invoke('get-ai-config', ref, ctx),
    saveAiConfig: (ref, ctx, config) =>
      ipcRenderer.invoke('save-ai-config', ref, ctx, config),
    onSessionEvent: (cb) => {
      const handler = (_e, ev) => cb(ev);
      ipcRenderer.on('session:event', handler);
      return () => ipcRenderer.removeListener('session:event', handler);
    },
  });
}

module.exports = {
  exposePreloadApi,
};
