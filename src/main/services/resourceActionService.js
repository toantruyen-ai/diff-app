const k8s = require('@kubernetes/client-node');
const { buildKubeConfig } = require('../utils/k8sHelper');
const { withTimeout } = require('../utils/timeout');
const { redactSecretData } = require('../utils/resourceFormatter');
const {
  MANAGE_KINDS,
  MANAGE_CLUSTER_SCOPED_KINDS,
  MANAGE_KIND_LABEL,
} = require('../constants/k8sConstants');

const MANAGE_ACTIONS = ['restart', 'scale', 'delete', 'cordon', 'uncordon'];
const STRATEGIC_MERGE_PATCH_OPTS = { headers: { 'Content-Type': 'application/strategic-merge-patch+json' } };

async function resourceAction(ref, contextName, namespace, kind, name, action, payload, auditDb, readManageObject, recordAudit) {
  if (!MANAGE_ACTIONS.includes(action)) return { ok: false, error: `Unknown action: ${action}` };
  try {
    const kc = buildKubeConfig(ref, contextName);
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);
    const appsApi = kc.makeApiClient(k8s.AppsV1Api);
    const batchApi = kc.makeApiClient(k8s.BatchV1Api);
    const networkingApi = kc.makeApiClient(k8s.NetworkingV1Api);
    const autoscalingApi = kc.makeApiClient(k8s.AutoscalingV2Api);
    const rbacApi = kc.makeApiClient(k8s.RbacAuthorizationV1Api);
    const storageApi = kc.makeApiClient(k8s.StorageV1Api);

    switch (action) {
      case 'delete': {
        let oldObj = null;
        let auditEditVersion = 0;
        if (auditDb && auditDb.status && auditDb.status().connected) {
          try { oldObj = await readManageObject(ref, contextName, namespace, kind, name); } catch { /* best-effort */ }
          auditEditVersion = parseInt(oldObj?.metadata?.annotations?.['k8senvdiff-edit-resource-version'] || '0', 10);
        }

        switch (kind) {
          case 'pods': await coreApi.deleteNamespacedPod(name, namespace); break;
          case 'deployments': await appsApi.deleteNamespacedDeployment(name, namespace); break;
          case 'statefulsets': await appsApi.deleteNamespacedStatefulSet(name, namespace); break;
          case 'daemonsets': await appsApi.deleteNamespacedDaemonSet(name, namespace); break;
          case 'replicasets': await appsApi.deleteNamespacedReplicaSet(name, namespace); break;
          case 'services': await coreApi.deleteNamespacedService(name, namespace); break;
          case 'ingresses': await networkingApi.deleteNamespacedIngress(name, namespace); break;
          case 'configmaps': await coreApi.deleteNamespacedConfigMap(name, namespace); break;
          case 'secrets': await coreApi.deleteNamespacedSecret(name, namespace); break;
          case 'jobs': await batchApi.deleteNamespacedJob(name, namespace); break;
          case 'cronjobs': await batchApi.deleteNamespacedCronJob(name, namespace); break;
          case 'pvcs': await coreApi.deleteNamespacedPersistentVolumeClaim(name, namespace); break;
          case 'hpas': await autoscalingApi.deleteNamespacedHorizontalPodAutoscaler(name, namespace); break;
          case 'nodes': await coreApi.deleteNode(name); break;
          case 'pvs': await coreApi.deletePersistentVolume(name); break;
          case 'namespaces': await coreApi.deleteNamespace(name); break;
          case 'events': await coreApi.deleteNamespacedEvent(name, namespace); break;
          case 'serviceaccounts': await coreApi.deleteNamespacedServiceAccount(name, namespace); break;
          case 'roles': await rbacApi.deleteNamespacedRole(name, namespace); break;
          case 'rolebindings': await rbacApi.deleteNamespacedRoleBinding(name, namespace); break;
          case 'clusterroles': await rbacApi.deleteClusterRole(name); break;
          case 'clusterrolebindings': await rbacApi.deleteClusterRoleBinding(name); break;
          case 'networkpolicies': await networkingApi.deleteNamespacedNetworkPolicy(name, namespace); break;
          case 'storageclasses': await storageApi.deleteStorageClass(name); break;
          case 'resourcequotas': await coreApi.deleteNamespacedResourceQuota(name, namespace); break;
          case 'limitranges': await coreApi.deleteNamespacedLimitRange(name, namespace); break;
          default: return { ok: false, error: `Delete not supported for kind: ${kind}` };
        }

        if (auditDb && auditDb.status && auditDb.status().connected && oldObj && recordAudit) {
          await recordAudit({
            ref, contextName, namespace, kind, name, action: 'delete',
            oldObj, newObj: null, editVersion: auditEditVersion,
          });
        }
        break;
      }
      case 'restart': {
        if (!['deployments', 'statefulsets', 'daemonsets'].includes(kind)) {
          return { ok: false, error: `Rollout restart not supported for kind: ${kind}` };
        }
        const patch = {
          spec: { template: { metadata: { annotations: { 'kubectl.kubernetes.io/restartedAt': new Date().toISOString() } } } },
        };
        if (kind === 'deployments') await appsApi.patchNamespacedDeployment(name, namespace, patch, undefined, undefined, undefined, undefined, undefined, STRATEGIC_MERGE_PATCH_OPTS);
        if (kind === 'statefulsets') await appsApi.patchNamespacedStatefulSet(name, namespace, patch, undefined, undefined, undefined, undefined, undefined, STRATEGIC_MERGE_PATCH_OPTS);
        if (kind === 'daemonsets') await appsApi.patchNamespacedDaemonSet(name, namespace, patch, undefined, undefined, undefined, undefined, undefined, STRATEGIC_MERGE_PATCH_OPTS);
        break;
      }
      case 'scale': {
        if (!['deployments', 'statefulsets'].includes(kind)) {
          return { ok: false, error: `Scale not supported for kind: ${kind}` };
        }
        const replicas = Number(payload && payload.replicas);
        if (!Number.isInteger(replicas) || replicas < 0) return { ok: false, error: 'Invalid replica count' };
        const patch = { spec: { replicas } };
        if (kind === 'deployments') await appsApi.patchNamespacedDeploymentScale(name, namespace, patch, undefined, undefined, undefined, undefined, undefined, STRATEGIC_MERGE_PATCH_OPTS);
        if (kind === 'statefulsets') await appsApi.patchNamespacedStatefulSetScale(name, namespace, patch, undefined, undefined, undefined, undefined, undefined, STRATEGIC_MERGE_PATCH_OPTS);
        break;
      }
      case 'cordon':
      case 'uncordon': {
        if (kind !== 'nodes') return { ok: false, error: `${action} only supported for nodes` };
        const patch = { spec: { unschedulable: action === 'cordon' } };
        await coreApi.patchNode(name, patch, undefined, undefined, undefined, undefined, undefined, STRATEGIC_MERGE_PATCH_OPTS);
        break;
      }
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function applyResourceYaml(ref, contextName, namespace, kind, name, yamlText, resourceVersion, auditDb, readManageObject, resolveClusterId, recordAudit) {
  if (!MANAGE_KINDS.includes(kind)) return { ok: false, error: `Unknown resource kind: ${kind}`, kind: 'validation' };
  let parsed;
  try {
    parsed = k8s.loadYaml(yamlText);
  } catch (e) {
    return { ok: false, error: `YAML parse error: ${e.message}`, kind: 'parse' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'Expected a single YAML object/document', kind: 'parse' };
  }
  if (parsed.kind !== MANAGE_KIND_LABEL[kind]) {
    return { ok: false, error: `Expected kind "${MANAGE_KIND_LABEL[kind]}", got "${parsed.kind}"`, kind: 'validation' };
  }
  if (parsed.metadata?.name !== name) {
    return { ok: false, error: `metadata.name ("${parsed.metadata?.name}") must match "${name}"`, kind: 'validation' };
  }
  const namespaced = !MANAGE_CLUSTER_SCOPED_KINDS.includes(kind);
  if (namespaced && parsed.metadata?.namespace && parsed.metadata.namespace !== namespace) {
    return { ok: false, error: `metadata.namespace ("${parsed.metadata.namespace}") must match "${namespace}"`, kind: 'validation' };
  }
  const rv = resourceVersion || parsed.metadata?.resourceVersion;
  if (!rv) {
    return { ok: false, error: 'Missing metadata.resourceVersion — reload the YAML and try again.', kind: 'validation' };
  }
  if (!parsed.metadata) parsed.metadata = {};
  parsed.metadata.resourceVersion = rv;
  if (kind === 'secrets' && parsed.data && Object.values(parsed.data).some((v) => v === '***REDACTED***')) {
    return { ok: false, error: 'This YAML still contains redacted placeholder values. Enable "Reveal secret values", reload, then edit.', kind: 'validation' };
  }

  try {
    const kc = buildKubeConfig(ref, contextName);
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);
    const appsApi = kc.makeApiClient(k8s.AppsV1Api);
    const batchApi = kc.makeApiClient(k8s.BatchV1Api);
    const networkingApi = kc.makeApiClient(k8s.NetworkingV1Api);
    const autoscalingApi = kc.makeApiClient(k8s.AutoscalingV2Api);
    const rbacApi = kc.makeApiClient(k8s.RbacAuthorizationV1Api);
    const storageApi = kc.makeApiClient(k8s.StorageV1Api);

    let oldObj = null;
    let editVersion = 0;
    if (auditDb && auditDb.status && auditDb.status().connected && readManageObject && resolveClusterId) {
      try { oldObj = await readManageObject(ref, contextName, namespace, kind, name); } catch { /* best-effort */ }
      const clusterId = resolveClusterId(ref, contextName);
      const dbNext = await auditDb.nextEditVersion({ clusterId, namespace, kind, name });
      const currentAnno = parseInt(oldObj?.metadata?.annotations?.['k8senvdiff-edit-resource-version'] || '0', 10);
      editVersion = Math.max(dbNext, currentAnno + 1);
      if (!parsed.metadata.annotations) parsed.metadata.annotations = {};
      parsed.metadata.annotations['k8senvdiff-edit-resource-version'] = String(editVersion);
    }

    let res;
    switch (kind) {
      case 'pods': res = await withTimeout(coreApi.replaceNamespacedPod(name, namespace, parsed), 20000, 'Timed out applying pod'); break;
      case 'deployments': res = await withTimeout(appsApi.replaceNamespacedDeployment(name, namespace, parsed), 20000, 'Timed out applying deployment'); break;
      case 'statefulsets': res = await withTimeout(appsApi.replaceNamespacedStatefulSet(name, namespace, parsed), 20000, 'Timed out applying statefulset'); break;
      case 'daemonsets': res = await withTimeout(appsApi.replaceNamespacedDaemonSet(name, namespace, parsed), 20000, 'Timed out applying daemonset'); break;
      case 'replicasets': res = await withTimeout(appsApi.replaceNamespacedReplicaSet(name, namespace, parsed), 20000, 'Timed out applying replicaset'); break;
      case 'services': res = await withTimeout(coreApi.replaceNamespacedService(name, namespace, parsed), 20000, 'Timed out applying service'); break;
      case 'ingresses': res = await withTimeout(networkingApi.replaceNamespacedIngress(name, namespace, parsed), 20000, 'Timed out applying ingress'); break;
      case 'configmaps': res = await withTimeout(coreApi.replaceNamespacedConfigMap(name, namespace, parsed), 20000, 'Timed out applying configmap'); break;
      case 'secrets': res = await withTimeout(coreApi.replaceNamespacedSecret(name, namespace, parsed), 20000, 'Timed out applying secret'); break;
      case 'jobs': res = await withTimeout(batchApi.replaceNamespacedJob(name, namespace, parsed), 20000, 'Timed out applying job'); break;
      case 'cronjobs': res = await withTimeout(batchApi.replaceNamespacedCronJob(name, namespace, parsed), 20000, 'Timed out applying cronjob'); break;
      case 'pvcs': res = await withTimeout(coreApi.replaceNamespacedPersistentVolumeClaim(name, namespace, parsed), 20000, 'Timed out applying PVC'); break;
      case 'hpas': res = await withTimeout(autoscalingApi.replaceNamespacedHorizontalPodAutoscaler(name, namespace, parsed), 20000, 'Timed out applying HPA'); break;
      case 'nodes': res = await withTimeout(coreApi.replaceNode(name, parsed), 20000, 'Timed out applying node'); break;
      case 'pvs': res = await withTimeout(coreApi.replacePersistentVolume(name, parsed), 20000, 'Timed out applying PV'); break;
      case 'namespaces': res = await withTimeout(coreApi.replaceNamespace(name, parsed), 20000, 'Timed out applying namespace'); break;
      case 'events': res = await withTimeout(coreApi.replaceNamespacedEvent(name, namespace, parsed), 20000, 'Timed out applying event'); break;
      case 'serviceaccounts': res = await withTimeout(coreApi.replaceNamespacedServiceAccount(name, namespace, parsed), 20000, 'Timed out applying service account'); break;
      case 'roles': res = await withTimeout(rbacApi.replaceNamespacedRole(name, namespace, parsed), 20000, 'Timed out applying role'); break;
      case 'rolebindings': res = await withTimeout(rbacApi.replaceNamespacedRoleBinding(name, namespace, parsed), 20000, 'Timed out applying role binding'); break;
      case 'clusterroles': res = await withTimeout(rbacApi.replaceClusterRole(name, parsed), 20000, 'Timed out applying cluster role'); break;
      case 'clusterrolebindings': res = await withTimeout(rbacApi.replaceClusterRoleBinding(name, parsed), 20000, 'Timed out applying cluster role binding'); break;
      case 'networkpolicies': res = await withTimeout(networkingApi.replaceNamespacedNetworkPolicy(name, namespace, parsed), 20000, 'Timed out applying network policy'); break;
      case 'storageclasses': res = await withTimeout(storageApi.replaceStorageClass(name, parsed), 20000, 'Timed out applying storage class'); break;
      case 'resourcequotas': res = await withTimeout(coreApi.replaceNamespacedResourceQuota(name, namespace, parsed), 20000, 'Timed out applying resource quota'); break;
      case 'limitranges': res = await withTimeout(coreApi.replaceNamespacedLimitRange(name, namespace, parsed), 20000, 'Timed out applying limit range'); break;
    }

    let obj = res.body;
    if (obj.metadata) delete obj.metadata.managedFields;
    const redacted = kind === 'secrets';

    let auditWarning = null;
    if (auditDb && auditDb.status && auditDb.status().connected && recordAudit) {
      auditWarning = await recordAudit({
        ref, contextName, namespace, kind, name, action: 'edit',
        oldObj, newObj: res.body, editVersion,
      });
    }

    return { ok: true, yaml: k8s.dumpYaml(redacted ? redactSecretData(obj) : obj), auditWarning };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function customResourceAction(ref, contextName, namespace, group, version, plural, name, namespaced, action) {
  if (action !== 'delete') return { ok: false, error: `Action "${action}" not supported for custom resources` };
  try {
    const kc = buildKubeConfig(ref, contextName);
    const customApi = kc.makeApiClient(k8s.CustomObjectsApi);
    if (namespaced) {
      await withTimeout(customApi.deleteNamespacedCustomObject(group, version, namespace, plural, name), 20000, 'Timed out deleting custom resource');
    } else {
      await withTimeout(customApi.deleteClusterCustomObject(group, version, plural, name), 20000, 'Timed out deleting custom resource');
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function applyCustomResourceYaml(ref, contextName, namespace, group, version, plural, name, namespaced, yamlText, resourceVersion) {
  let parsed;
  try {
    parsed = k8s.loadYaml(yamlText);
  } catch (e) {
    return { ok: false, error: `YAML parse error: ${e.message}`, kind: 'parse' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'Expected a single YAML object/document', kind: 'parse' };
  }
  if (parsed.metadata?.name !== name) {
    return { ok: false, error: `metadata.name ("${parsed.metadata?.name}") must match "${name}"`, kind: 'validation' };
  }
  if (namespaced && parsed.metadata?.namespace && parsed.metadata.namespace !== namespace) {
    return { ok: false, error: `metadata.namespace ("${parsed.metadata.namespace}") must match "${namespace}"`, kind: 'validation' };
  }
  const rv = resourceVersion || parsed.metadata?.resourceVersion;
  if (!rv) {
    return { ok: false, error: 'Missing metadata.resourceVersion — reload the YAML and try again.', kind: 'validation' };
  }
  if (!parsed.metadata) parsed.metadata = {};
  parsed.metadata.resourceVersion = rv;

  try {
    const kc = buildKubeConfig(ref, contextName);
    const customApi = kc.makeApiClient(k8s.CustomObjectsApi);
    const res = namespaced
      ? await withTimeout(customApi.replaceNamespacedCustomObject(group, version, namespace, plural, name, parsed), 20000, 'Timed out applying custom resource')
      : await withTimeout(customApi.replaceClusterCustomObject(group, version, plural, name, parsed), 20000, 'Timed out applying custom resource');
    const obj = res.body;
    if (obj.metadata) delete obj.metadata.managedFields;
    return { ok: true, yaml: k8s.dumpYaml(obj) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = {
  resourceAction,
  applyResourceYaml,
  customResourceAction,
  applyCustomResourceYaml,
};
