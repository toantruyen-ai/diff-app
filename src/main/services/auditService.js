const k8s = require('@kubernetes/client-node');
const auditDb = require('../db/auditDb');
const { buildKubeConfig } = require('../utils/k8sHelper');
const { redactSecretData, stripForRecreate } = require('../utils/resourceFormatter');
const { RESTORABLE_KINDS } = require('../constants/k8sConstants');

function resolveClusterId(ref, contextName) {
  let identity = ref;
  try {
    const kc = buildKubeConfig(ref, contextName);
    const cluster = kc.getCurrentCluster();
    if (cluster && cluster.server) identity = cluster.server;
  } catch { /* fallback to ref */ }
  return auditDb.getClusterId(identity, contextName);
}

async function recordAudit({ ref, contextName, namespace, kind, name, action, oldObj, newObj, editVersion }) {
  try {
    const clusterId = resolveClusterId(ref, contextName);
    const updatedBy = auditDb.getAzureIdentity();
    const oldYaml = oldObj ? k8s.dumpYaml(kind === 'secrets' ? redactSecretData(oldObj) : oldObj) : null;
    const newYaml = newObj ? k8s.dumpYaml(kind === 'secrets' ? redactSecretData(newObj) : newObj) : null;
    const k8sResourceVersion = (newObj || oldObj)?.metadata?.resourceVersion || '';
    await auditDb.insertAudit({
      clusterId,
      namespace: namespace || '',
      kind,
      name,
      action,
      editVersion: editVersion || 0,
      k8sResourceVersion,
      oldYaml,
      newYaml,
      updatedBy,
    });
    return null;
  } catch (e) {
    console.error('[audit] Failed to record audit:', e.message);
    return `Audit recording failed: ${e.message}`;
  }
}

async function readManageObject(ref, contextName, namespace, kind, name) {
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
    case 'pods': res = await coreApi.readNamespacedPod(name, namespace); break;
    case 'deployments': res = await appsApi.readNamespacedDeployment(name, namespace); break;
    case 'statefulsets': res = await appsApi.readNamespacedStatefulSet(name, namespace); break;
    case 'daemonsets': res = await appsApi.readNamespacedDaemonSet(name, namespace); break;
    case 'replicasets': res = await appsApi.readNamespacedReplicaSet(name, namespace); break;
    case 'services': res = await coreApi.readNamespacedService(name, namespace); break;
    case 'ingresses': res = await networkingApi.readNamespacedIngress(name, namespace); break;
    case 'configmaps': res = await coreApi.readNamespacedConfigMap(name, namespace); break;
    case 'secrets': res = await coreApi.readNamespacedSecret(name, namespace); break;
    case 'jobs': res = await batchApi.readNamespacedJob(name, namespace); break;
    case 'cronjobs': res = await batchApi.readNamespacedCronJob(name, namespace); break;
    case 'pvcs': res = await coreApi.readNamespacedPersistentVolumeClaim(name, namespace); break;
    case 'hpas': res = await autoscalingApi.readNamespacedHorizontalPodAutoscaler(name, namespace); break;
    case 'nodes': res = await coreApi.readNode(name); break;
    case 'pvs': res = await coreApi.readPersistentVolume(name); break;
    case 'namespaces': res = await coreApi.readNamespace(name); break;
    case 'events': res = await coreApi.readNamespacedEvent(name, namespace); break;
    case 'serviceaccounts': res = await coreApi.readNamespacedServiceAccount(name, namespace); break;
    case 'roles': res = await rbacApi.readNamespacedRole(name, namespace); break;
    case 'rolebindings': res = await rbacApi.readNamespacedRoleBinding(name, namespace); break;
    case 'clusterroles': res = await rbacApi.readClusterRole(name); break;
    case 'clusterrolebindings': res = await rbacApi.readClusterRoleBinding(name); break;
    case 'networkpolicies': res = await networkingApi.readNamespacedNetworkPolicy(name, namespace); break;
    case 'storageclasses': res = await storageApi.readStorageClass(name); break;
    case 'resourcequotas': res = await coreApi.readNamespacedResourceQuota(name, namespace); break;
    case 'limitranges': res = await coreApi.readNamespacedLimitRange(name, namespace); break;
    default: return null;
  }
  return res.body;
}

async function createManageObject(ref, contextName, namespace, kind, parsed) {
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
    case 'deployments': res = await appsApi.createNamespacedDeployment(namespace, parsed); break;
    case 'statefulsets': res = await appsApi.createNamespacedStatefulSet(namespace, parsed); break;
    case 'daemonsets': res = await appsApi.createNamespacedDaemonSet(namespace, parsed); break;
    case 'services': res = await coreApi.createNamespacedService(namespace, parsed); break;
    case 'ingresses': res = await networkingApi.createNamespacedIngress(namespace, parsed); break;
    case 'configmaps': res = await coreApi.createNamespacedConfigMap(namespace, parsed); break;
    case 'jobs': res = await batchApi.createNamespacedJob(namespace, parsed); break;
    case 'cronjobs': res = await batchApi.createNamespacedCronJob(namespace, parsed); break;
    case 'pvcs': res = await coreApi.createNamespacedPersistentVolumeClaim(namespace, parsed); break;
    case 'hpas': res = await autoscalingApi.createNamespacedHorizontalPodAutoscaler(namespace, parsed); break;
    case 'namespaces': res = await coreApi.createNamespace(parsed); break;
    case 'serviceaccounts': res = await coreApi.createNamespacedServiceAccount(namespace, parsed); break;
    case 'roles': res = await rbacApi.createNamespacedRole(namespace, parsed); break;
    case 'rolebindings': res = await rbacApi.createNamespacedRoleBinding(namespace, parsed); break;
    case 'clusterroles': res = await rbacApi.createClusterRole(parsed); break;
    case 'clusterrolebindings': res = await rbacApi.createClusterRoleBinding(parsed); break;
    case 'networkpolicies': res = await networkingApi.createNamespacedNetworkPolicy(namespace, parsed); break;
    case 'storageclasses': res = await storageApi.createStorageClass(parsed); break;
    case 'resourcequotas': res = await coreApi.createNamespacedResourceQuota(namespace, parsed); break;
    case 'limitranges': res = await coreApi.createNamespacedLimitRange(namespace, parsed); break;
    default: return null;
  }
  return res.body;
}

module.exports = {
  auditDb,
  resolveClusterId,
  recordAudit,
  readManageObject,
  createManageObject,
};
