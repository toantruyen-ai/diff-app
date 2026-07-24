const k8s = require('@kubernetes/client-node');
const { auditDb, resolveClusterId, recordAudit, readManageObject, createManageObject } = require('../services/auditService');
const eventsService = require('../services/eventsService');
const { buildKubeConfig } = require('../utils/k8sHelper');
const { stripForRecreate } = require('../utils/resourceFormatter');
const { RESTORABLE_KINDS } = require('../constants/k8sConstants');

const IDENTIFIER_REGEX = /^[a-z0-9][a-z0-9._-]*$/i;

function isValidIdentifier(val, allowEmpty = false) {
  if (val === undefined || val === null || val === '') {
    return allowEmpty;
  }
  return typeof val === 'string' && IDENTIFIER_REGEX.test(val);
}

function registerAuditHandlers(customElectron) {
  const { ipcMain } = customElectron || require('electron');
  ipcMain.handle('audit-db-discover', async () => auditDb.discover());

  ipcMain.handle('audit-db-connect', async (_e, user, password) => {
    let disc = auditDb.status();
    if (!disc.server) {
      const discResult = await auditDb.discover();
      if (!discResult.ok) return { ok: false, error: 'No Azure SQL server found with tag aks-database-backup=k8s-env-diff' };
      disc = { server: discResult.server, database: discResult.database };
    }
    const result = await auditDb.connect({ server: disc.server, database: disc.database, user, password });
    if (result.ok) {
      return { ok: true, server: disc.server, database: disc.database };
    }
    return result;
  });

  ipcMain.handle('audit-db-disconnect', async () => {
    await auditDb.close();
    return { ok: true };
  });

  ipcMain.handle('audit-db-status', async () => auditDb.status());

  ipcMain.handle('get-resource-versions', async (_e, ref, contextName, namespace, kind, name) => {
    if (!isValidIdentifier(kind, false) || !isValidIdentifier(name, false) || !isValidIdentifier(namespace, true)) {
      return { ok: false, reason: 'invalid-input' };
    }
    try {
      const clusterId = resolveClusterId(ref, contextName);
      const rows = await auditDb.getVersions({ clusterId, namespace, kind, name });
      return { ok: true, rows };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('get-version-yaml', async (_e, id) => {
    try {
      const row = await auditDb.getVersionYaml(id);
      if (!row) return { ok: false, error: 'Version not found' };
      return { ok: true, row };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('get-deleted-resources', async (_e, ref, contextName, namespace) => {
    if (!isValidIdentifier(namespace, true)) {
      return { ok: false, reason: 'invalid-input' };
    }
    try {
      const clusterId = resolveClusterId(ref, contextName);
      const rows = await auditDb.getDeletedResources({ clusterId, namespace });
      return { ok: true, rows };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('restore-deleted-resource', async (_e, ref, contextName, namespace, kind, name, id, crdMeta) => {
    if (!isValidIdentifier(kind, false) || !isValidIdentifier(name, false) || !isValidIdentifier(namespace, true)) {
      return { ok: false, reason: 'invalid-input' };
    }
    if (id !== undefined && id !== null && typeof id !== 'string') {
      return { ok: false, reason: 'invalid-input' };
    }
    if (!auditDb.status().connected) return { ok: false, error: 'Audit DB not connected', kind: 'forbidden' };
    if (!crdMeta && kind === 'secrets') {
      return { ok: false, error: 'Secrets cannot be restored — their values were redacted at delete time and were never saved.', kind: 'validation' };
    }
    if (!crdMeta && !RESTORABLE_KINDS.has(kind)) {
      return { ok: false, error: `Restore not supported for kind: ${kind}`, kind: 'validation' };
    }
    try {
      const versionRow = await auditDb.getVersionYaml(id);
      if (!versionRow) return { ok: false, error: 'Version not found' };
      const targetYaml = versionRow.old_yaml;
      if (!targetYaml) return { ok: false, error: 'No YAML data in this version' };

      let parsed = k8s.loadYaml(targetYaml);
      if (!parsed || typeof parsed !== 'object') return { ok: false, error: 'Invalid YAML in version', kind: 'parse' };
      parsed = stripForRecreate(parsed);

      let newObj;
      if (crdMeta) {
        const kc = buildKubeConfig(ref, contextName);
        const customApi = kc.makeApiClient(k8s.CustomObjectsApi);
        const res = crdMeta.namespaced
          ? await customApi.createNamespacedCustomObject(crdMeta.group, crdMeta.version, namespace, crdMeta.plural, parsed)
          : await customApi.createClusterCustomObject(crdMeta.group, crdMeta.version, crdMeta.plural, parsed);
        newObj = res.body;
      } else {
        newObj = await createManageObject(ref, contextName, namespace, kind, parsed);
        if (!newObj) return { ok: false, error: `Restore not supported for kind: ${kind}`, kind: 'validation' };
      }

      const clusterId = resolveClusterId(ref, contextName);
      const editVersion = await auditDb.nextEditVersion({ clusterId, namespace, kind, name });
      const auditWarning = await recordAudit({
        ref, contextName, namespace, kind, name, action: 'restore',
        oldObj: null, newObj, editVersion,
      });

      return { ok: true, auditWarning };
    } catch (e) {
      if (e.statusCode === 409) {
        return { ok: false, error: 'A resource with this name already exists — delete it first, or it was already restored.', kind: 'conflict' };
      }
      if (e.statusCode === 403) return { ok: false, error: e.body?.message || e.message, kind: 'forbidden' };
      if (e.statusCode === 400 || e.statusCode === 422) return { ok: false, error: e.body?.message || e.message, kind: 'invalid' };
      return { ok: false, error: e.message, kind: 'error' };
    }
  });

  ipcMain.handle('restore-resource-version', async (_e, ref, contextName, namespace, kind, name, id, crdMeta) => {
    if (!isValidIdentifier(kind, false) || !isValidIdentifier(name, false) || !isValidIdentifier(namespace, true)) {
      return { ok: false, reason: 'invalid-input' };
    }
    if (id !== undefined && id !== null && typeof id !== 'string') {
      return { ok: false, reason: 'invalid-input' };
    }
    if (!auditDb.status().connected) return { ok: false, error: 'Audit DB not connected', kind: 'forbidden' };
    try {
      const versionRow = await auditDb.getVersionYaml(id);
      if (!versionRow) return { ok: false, error: 'Version not found' };
      const targetYaml = versionRow.new_yaml || versionRow.old_yaml;
      if (!targetYaml) return { ok: false, error: 'No YAML data in this version' };

      const parsed = k8s.loadYaml(targetYaml);
      if (!parsed || typeof parsed !== 'object') return { ok: false, error: 'Invalid YAML in version', kind: 'parse' };

      let liveObj;
      if (crdMeta) {
        const kc = buildKubeConfig(ref, contextName);
        const customApi = kc.makeApiClient(k8s.CustomObjectsApi);
        const res = crdMeta.namespaced
          ? await customApi.getNamespacedCustomObject(crdMeta.group, crdMeta.version, namespace, crdMeta.plural, name)
          : await customApi.getClusterCustomObject(crdMeta.group, crdMeta.version, crdMeta.plural, name);
        liveObj = res.body;
      } else {
        liveObj = await readManageObject(ref, contextName, namespace, kind, name);
      }
      if (!liveObj) return { ok: false, error: 'Cannot read current resource' };

      if (!parsed.metadata) parsed.metadata = {};
      parsed.metadata.resourceVersion = liveObj.metadata.resourceVersion;

      const clusterId = resolveClusterId(ref, contextName);
      const dbNext = await auditDb.nextEditVersion({ clusterId, namespace, kind, name });
      const currentAnno = parseInt(liveObj.metadata?.annotations?.['k8senvdiff-edit-resource-version'] || '0', 10);
      const next = Math.max(dbNext, currentAnno + 1);
      if (!parsed.metadata.annotations) parsed.metadata.annotations = {};
      parsed.metadata.annotations['k8senvdiff-edit-resource-version'] = String(next);

      let newObj;
      if (crdMeta) {
        const kc = buildKubeConfig(ref, contextName);
        const customApi = kc.makeApiClient(k8s.CustomObjectsApi);
        const res = crdMeta.namespaced
          ? await customApi.replaceNamespacedCustomObject(crdMeta.group, crdMeta.version, namespace, crdMeta.plural, name, parsed)
          : await customApi.replaceClusterCustomObject(crdMeta.group, crdMeta.version, crdMeta.plural, name, parsed);
        newObj = res.body;
      } else {
        const kc = buildKubeConfig(ref, contextName);
        const coreApi = kc.makeApiClient(k8s.CoreV1Api);
        const appsApi = kc.makeApiClient(k8s.AppsV1Api);
        const batchApi = kc.makeApiClient(k8s.BatchV1Api);
        const networkingApi = kc.makeApiClient(k8s.NetworkingV1Api);
        const autoscalingApi = kc.makeApiClient(k8s.AutoscalingV2Api);
        const rbacApi = kc.makeApiClient(k8s.RbacAuthorizationV1Api);
        const storageApi = kc.makeApiClient(k8s.StorageV1Api);
        let res;
        switch (kind) {
          case 'pods': res = await coreApi.replaceNamespacedPod(name, namespace, parsed); break;
          case 'deployments': res = await appsApi.replaceNamespacedDeployment(name, namespace, parsed); break;
          case 'statefulsets': res = await appsApi.replaceNamespacedStatefulSet(name, namespace, parsed); break;
          case 'daemonsets': res = await appsApi.replaceNamespacedDaemonSet(name, namespace, parsed); break;
          case 'replicasets': res = await appsApi.replaceNamespacedReplicaSet(name, namespace, parsed); break;
          case 'services': res = await coreApi.replaceNamespacedService(name, namespace, parsed); break;
          case 'ingresses': res = await networkingApi.replaceNamespacedIngress(name, namespace, parsed); break;
          case 'configmaps': res = await coreApi.replaceNamespacedConfigMap(name, namespace, parsed); break;
          case 'secrets': res = await coreApi.replaceNamespacedSecret(name, namespace, parsed); break;
          case 'jobs': res = await batchApi.replaceNamespacedJob(name, namespace, parsed); break;
          case 'cronjobs': res = await batchApi.replaceNamespacedCronJob(name, namespace, parsed); break;
          case 'pvcs': res = await coreApi.replaceNamespacedPersistentVolumeClaim(name, namespace, parsed); break;
          case 'hpas': res = await autoscalingApi.replaceNamespacedHorizontalPodAutoscaler(name, namespace, parsed); break;
          case 'nodes': res = await coreApi.replaceNode(name, parsed); break;
          case 'pvs': res = await coreApi.replacePersistentVolume(name, parsed); break;
          case 'namespaces': res = await coreApi.replaceNamespace(name, parsed); break;
          case 'events': res = await coreApi.replaceNamespacedEvent(name, namespace, parsed); break;
          case 'serviceaccounts': res = await coreApi.replaceNamespacedServiceAccount(name, namespace, parsed); break;
          case 'roles': res = await rbacApi.replaceNamespacedRole(name, namespace, parsed); break;
          case 'rolebindings': res = await rbacApi.replaceNamespacedRoleBinding(name, namespace, parsed); break;
          case 'clusterroles': res = await rbacApi.replaceClusterRole(name, parsed); break;
          case 'clusterrolebindings': res = await rbacApi.replaceClusterRoleBinding(name, parsed); break;
          case 'networkpolicies': res = await networkingApi.replaceNamespacedNetworkPolicy(name, namespace, parsed); break;
          case 'storageclasses': res = await storageApi.replaceStorageClass(name, parsed); break;
          case 'resourcequotas': res = await coreApi.replaceNamespacedResourceQuota(name, namespace, parsed); break;
          case 'limitranges': res = await coreApi.replaceNamespacedLimitRange(name, namespace, parsed); break;
          default: return { ok: false, error: `Restore not supported for kind: ${kind}` };
        }
        newObj = res.body;
      }

      const auditWarning = await recordAudit({
        ref, contextName, namespace, kind, name, action: 'restore',
        oldObj: liveObj, newObj, editVersion: next,
      });

      return { ok: true, auditWarning };
    } catch (e) {
      if (e.statusCode === 409) return { ok: false, error: 'Resource changed since load — reload and retry.', kind: 'conflict' };
      if (e.statusCode === 403) return { ok: false, error: e.body?.message || e.message, kind: 'forbidden' };
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('toggle-event-capture', async (_e, { enabled, ref, contextName, namespace, retentionDays }) => {
    try {
      if (enabled) {
        await eventsService.startEventWatch(ref, contextName, namespace, retentionDays);
      } else {
        eventsService.stopEventWatch();
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('set-event-retention', async (_e, { retentionDays }) => {
    try {
      await eventsService.setEventRetention(retentionDays);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('clear-event-db', async () => {
    try {
      const changes = await eventsService.eventsDb.clearEvents();
      return { ok: true, changes };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('get-local-events', async (_e, params = {}) => {
    if (!params || typeof params !== 'object') {
      return { ok: false, reason: 'invalid-input' };
    }
    const { namespace, kind, name } = params;
    if (!isValidIdentifier(namespace, true) || !isValidIdentifier(kind, true) || !isValidIdentifier(name, true)) {
      return { ok: false, reason: 'invalid-input' };
    }
    try {
      const rows = await eventsService.eventsDb.getLocalEvents(namespace, kind, name);
      return { ok: true, rows };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
}

module.exports = {
  registerAuditHandlers,
};
