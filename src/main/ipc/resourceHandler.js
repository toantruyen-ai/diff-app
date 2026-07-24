const { ipcMain } = require('electron');
const k8sService = require('../services/k8sService');
const resourceActionService = require('../services/resourceActionService');
const metricsService = require('../services/metricsService');
const { auditDb, readManageObject, resolveClusterId, recordAudit } = require('../services/auditService');

function registerResourceHandlers() {
  ipcMain.handle('list-resource', (_e, ref, contextName, namespace, kind) =>
    k8sService.listResource(ref, contextName, namespace, kind)
  );

  ipcMain.handle('search-resources', (_e, ref, contextName, namespace, query, crds) =>
    k8sService.searchResources(ref, contextName, namespace, query, crds)
  );

  ipcMain.handle('get-resource-yaml', (_e, ref, contextName, namespace, kind, name, opts) =>
    k8sService.getResourceYaml(ref, contextName, namespace, kind, name, opts)
  );

  ipcMain.handle('get-resource-events', (_e, ref, contextName, namespace, kind, name) =>
    k8sService.getResourceEvents(ref, contextName, namespace, kind, name)
  );

  ipcMain.handle('check-access', (_e, ref, contextName, namespace, kind, name) =>
    k8sService.checkAccess(ref, contextName, namespace, kind, name)
  );

  ipcMain.handle('check-custom-resource-access', (_e, ref, contextName, namespace, group, resource, namespaced, name) =>
    k8sService.checkCustomResourceAccess(ref, contextName, namespace, group, resource, namespaced, name)
  );

  ipcMain.handle('resource-action', (_e, ref, contextName, namespace, kind, name, action, payload) =>
    resourceActionService.resourceAction(ref, contextName, namespace, kind, name, action, payload, auditDb, readManageObject, recordAudit)
  );

  ipcMain.handle('apply-resource-yaml', (_e, ref, contextName, namespace, kind, name, yamlText, resourceVersion) =>
    resourceActionService.applyResourceYaml(ref, contextName, namespace, kind, name, yamlText, resourceVersion, auditDb, readManageObject, resolveClusterId, recordAudit)
  );

  ipcMain.handle('list-crds', (_e, ref, contextName) =>
    k8sService.listCrds(ref, contextName)
  );

  ipcMain.handle('list-custom-resource', (_e, ref, contextName, namespace, group, version, plural, namespaced) =>
    k8sService.listCustomResource(ref, contextName, namespace, group, version, plural, namespaced)
  );

  ipcMain.handle('get-custom-resource-yaml', (_e, ref, contextName, namespace, group, version, plural, name, namespaced, opts) =>
    k8sService.getCustomResourceYaml(ref, contextName, namespace, group, version, plural, name, namespaced, opts)
  );

  ipcMain.handle('get-custom-resource-events', (_e, ref, contextName, namespace, involvedObjectKind, name, namespaced) =>
    k8sService.getCustomResourceEvents(ref, contextName, namespace, involvedObjectKind, name, namespaced)
  );

  ipcMain.handle('custom-resource-action', (_e, ref, contextName, namespace, group, version, plural, name, namespaced, action) =>
    resourceActionService.customResourceAction(ref, contextName, namespace, group, version, plural, name, namespaced, action)
  );

  ipcMain.handle('apply-custom-resource-yaml', (_e, ref, contextName, namespace, group, version, plural, name, namespaced, yamlText, resourceVersion) =>
    resourceActionService.applyCustomResourceYaml(ref, contextName, namespace, group, version, plural, name, namespaced, yamlText, resourceVersion)
  );

  ipcMain.handle('get-manage-overview', (_e, ref, contextName) =>
    metricsService.getManageOverview(ref, contextName)
  );

  ipcMain.handle('get-metrics', (_e, ref, contextName, namespace, scope) =>
    metricsService.getMetrics(ref, contextName, namespace, scope)
  );
}

module.exports = {
  registerResourceHandlers,
};
