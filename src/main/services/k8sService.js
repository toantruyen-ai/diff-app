const k8s = require('@kubernetes/client-node');
const { buildKubeConfig, getCachedApiClients, extractK8sErrorMessage } = require('../utils/k8sHelper');
const { withTimeout } = require('../utils/timeout');
const { ageOf, projectRow, redactSecretData } = require('../utils/resourceFormatter');
const {
  MANAGE_KINDS,
  ALL_NAMESPACES,
  MANAGE_CLUSTER_SCOPED_KINDS,
  MANAGE_ACCESS_VERBS,
  MANAGE_KIND_LABEL,
  MANAGE_KIND_GVR,
} = require('../constants/k8sConstants');

const MANAGE_SEARCH_EXCLUDE_KINDS = ['events'];

async function loadContexts(ref) {
  try {
    const kc = buildKubeConfig(ref, null);
    return kc.getContexts().map((ctx) => ctx.name);
  } catch (e) {
    throw new Error(`Failed to load contexts: ${e.message}`);
  }
}

async function loadNamespaces(kubeconfigPath, contextName) {
  try {
    const kc = buildKubeConfig(kubeconfigPath, contextName);
    try {
      const coreApi = kc.makeApiClient(k8s.CoreV1Api);
      const res = await withTimeout(
        coreApi.listNamespace(),
        20000,
        'Timed out listing namespaces — kubelogin may need re-authentication'
      );
      return res.body.items.map((ns) => ns.metadata.name).sort();
    } catch (apiErr) {
      const namespaces = new Set();
      kc.getContexts().forEach((ctx) => {
        if (ctx.namespace) namespaces.add(ctx.namespace);
      });
      if (namespaces.size === 0) throw new Error(`Cannot list namespaces: ${apiErr.message}`);
      return Array.from(namespaces).sort();
    }
  } catch (e) {
    throw new Error(e.message);
  }
}

async function loadDeployments(kubeconfigPath, contextName, namespace) {
  try {
    const kc = buildKubeConfig(kubeconfigPath, contextName);
    const appsApi = kc.makeApiClient(k8s.AppsV1Api);
    const res = await withTimeout(
      appsApi.listNamespacedDeployment(namespace),
      20000,
      'Timed out listing deployments — kubelogin may need re-authentication'
    );
    return res.body.items.map((d) => d.metadata.name).sort();
  } catch (e) {
    throw new Error(`Failed to load deployments: ${e.message}`);
  }
}

async function listKindItems(apis, kind, namespace, allNs) {
  const { core: coreApi, apps: appsApi, batch: batchApi, networking: networkingApi, autoscaling: autoscalingApi, rbac: rbacApi, storage: storageApi } = apis;
  let res;
  switch (kind) {
    case 'pods':
      res = allNs
        ? await withTimeout(coreApi.listPodForAllNamespaces(), 20000, 'Timed out listing pods')
        : await withTimeout(coreApi.listNamespacedPod(namespace), 20000, 'Timed out listing pods');
      break;
    case 'deployments':
      res = allNs
        ? await withTimeout(appsApi.listDeploymentForAllNamespaces(), 20000, 'Timed out listing deployments')
        : await withTimeout(appsApi.listNamespacedDeployment(namespace), 20000, 'Timed out listing deployments');
      break;
    case 'statefulsets':
      res = allNs
        ? await withTimeout(appsApi.listStatefulSetForAllNamespaces(), 20000, 'Timed out listing statefulsets')
        : await withTimeout(appsApi.listNamespacedStatefulSet(namespace), 20000, 'Timed out listing statefulsets');
      break;
    case 'daemonsets':
      res = allNs
        ? await withTimeout(appsApi.listDaemonSetForAllNamespaces(), 20000, 'Timed out listing daemonsets')
        : await withTimeout(appsApi.listNamespacedDaemonSet(namespace), 20000, 'Timed out listing daemonsets');
      break;
    case 'replicasets':
      res = allNs
        ? await withTimeout(appsApi.listReplicaSetForAllNamespaces(), 20000, 'Timed out listing replicasets')
        : await withTimeout(appsApi.listNamespacedReplicaSet(namespace), 20000, 'Timed out listing replicasets');
      break;
    case 'services':
      res = allNs
        ? await withTimeout(coreApi.listServiceForAllNamespaces(), 20000, 'Timed out listing services')
        : await withTimeout(coreApi.listNamespacedService(namespace), 20000, 'Timed out listing services');
      break;
    case 'ingresses':
      res = allNs
        ? await withTimeout(networkingApi.listIngressForAllNamespaces(), 20000, 'Timed out listing ingresses')
        : await withTimeout(networkingApi.listNamespacedIngress(namespace), 20000, 'Timed out listing ingresses');
      break;
    case 'configmaps':
      res = allNs
        ? await withTimeout(coreApi.listConfigMapForAllNamespaces(), 20000, 'Timed out listing configmaps')
        : await withTimeout(coreApi.listNamespacedConfigMap(namespace), 20000, 'Timed out listing configmaps');
      break;
    case 'secrets':
      res = allNs
        ? await withTimeout(coreApi.listSecretForAllNamespaces(), 20000, 'Timed out listing secrets')
        : await withTimeout(coreApi.listNamespacedSecret(namespace), 20000, 'Timed out listing secrets');
      break;
    case 'jobs':
      res = allNs
        ? await withTimeout(batchApi.listJobForAllNamespaces(), 20000, 'Timed out listing jobs')
        : await withTimeout(batchApi.listNamespacedJob(namespace), 20000, 'Timed out listing jobs');
      break;
    case 'cronjobs':
      res = allNs
        ? await withTimeout(batchApi.listCronJobForAllNamespaces(), 20000, 'Timed out listing cronjobs')
        : await withTimeout(batchApi.listNamespacedCronJob(namespace), 20000, 'Timed out listing cronjobs');
      break;
    case 'pvcs':
      res = allNs
        ? await withTimeout(coreApi.listPersistentVolumeClaimForAllNamespaces(), 20000, 'Timed out listing PVCs')
        : await withTimeout(coreApi.listNamespacedPersistentVolumeClaim(namespace), 20000, 'Timed out listing PVCs');
      break;
    case 'hpas':
      res = allNs
        ? await withTimeout(autoscalingApi.listHorizontalPodAutoscalerForAllNamespaces(), 20000, 'Timed out listing HPAs')
        : await withTimeout(autoscalingApi.listNamespacedHorizontalPodAutoscaler(namespace), 20000, 'Timed out listing HPAs');
      break;
    case 'nodes': res = await withTimeout(coreApi.listNode(), 20000, 'Timed out listing nodes'); break;
    case 'pvs': res = await withTimeout(coreApi.listPersistentVolume(), 20000, 'Timed out listing PVs'); break;
    case 'namespaces': res = await withTimeout(coreApi.listNamespace(), 20000, 'Timed out listing namespaces'); break;
    case 'events':
      res = allNs
        ? await withTimeout(coreApi.listEventForAllNamespaces(), 20000, 'Timed out listing events')
        : await withTimeout(coreApi.listNamespacedEvent(namespace), 20000, 'Timed out listing events');
      break;
    case 'serviceaccounts':
      res = allNs
        ? await withTimeout(coreApi.listServiceAccountForAllNamespaces(), 20000, 'Timed out listing service accounts')
        : await withTimeout(coreApi.listNamespacedServiceAccount(namespace), 20000, 'Timed out listing service accounts');
      break;
    case 'roles':
      res = allNs
        ? await withTimeout(rbacApi.listRoleForAllNamespaces(), 20000, 'Timed out listing roles')
        : await withTimeout(rbacApi.listNamespacedRole(namespace), 20000, 'Timed out listing roles');
      break;
    case 'rolebindings':
      res = allNs
        ? await withTimeout(rbacApi.listRoleBindingForAllNamespaces(), 20000, 'Timed out listing role bindings')
        : await withTimeout(rbacApi.listNamespacedRoleBinding(namespace), 20000, 'Timed out listing role bindings');
      break;
    case 'clusterroles':
      res = await withTimeout(rbacApi.listClusterRole(), 20000, 'Timed out listing cluster roles');
      break;
    case 'clusterrolebindings':
      res = await withTimeout(rbacApi.listClusterRoleBinding(), 20000, 'Timed out listing cluster role bindings');
      break;
    case 'networkpolicies':
      res = allNs
        ? await withTimeout(networkingApi.listNetworkPolicyForAllNamespaces(), 20000, 'Timed out listing network policies')
        : await withTimeout(networkingApi.listNamespacedNetworkPolicy(namespace), 20000, 'Timed out listing network policies');
      break;
    case 'storageclasses':
      res = await withTimeout(storageApi.listStorageClass(), 20000, 'Timed out listing storage classes');
      break;
    case 'resourcequotas':
      res = allNs
        ? await withTimeout(coreApi.listResourceQuotaForAllNamespaces(), 20000, 'Timed out listing resource quotas')
        : await withTimeout(coreApi.listNamespacedResourceQuota(namespace), 20000, 'Timed out listing resource quotas');
      break;
    case 'limitranges':
      res = allNs
        ? await withTimeout(coreApi.listLimitRangeForAllNamespaces(), 20000, 'Timed out listing limit ranges')
        : await withTimeout(coreApi.listNamespacedLimitRange(namespace), 20000, 'Timed out listing limit ranges');
      break;
    default:
      throw new Error(`Unknown resource kind: ${kind}`);
  }
  return res.body;
}

async function listResource(ref, contextName, namespace, kind) {
  if (!MANAGE_KINDS.includes(kind)) return { ok: false, error: `Unknown resource kind: ${kind}` };
  try {
    const { apis } = getCachedApiClients(ref, contextName);
    const allNs = namespace === ALL_NAMESPACES;
    const items = (await listKindItems(apis, kind, namespace, allNs)).items || [];
    const rows = items.map((item) => projectRow(kind, item));
    return { ok: true, rows };
  } catch (e) {
    return { ok: false, error: extractK8sErrorMessage(e) };
  }
}

async function searchResources(ref, contextName, namespace, query, crds) {
  try {
    const { apis } = getCachedApiClients(ref, contextName);
    const allNs = namespace === ALL_NAMESPACES;
    const kinds = MANAGE_KINDS.filter((k) => !MANAGE_SEARCH_EXCLUDE_KINDS.includes(k));
    const q = String(query || '').toLowerCase();

    const settled = await Promise.allSettled(kinds.map(async (kind) => {
      const items = (await listKindItems(apis, kind, namespace, allNs)).items || [];
      return items
        .filter((item) => (item.metadata?.name || '').toLowerCase().includes(q))
        .slice(0, 20)
        .map((item) => ({ kind, ...projectRow(kind, item) }));
    }));

    const results = [];
    const errors = [];
    settled.forEach((r, i) => {
      if (r.status === 'fulfilled') results.push(...r.value);
      else errors.push({ kind: kinds[i], error: r.reason.message });
    });

    const kcForCrds = buildKubeConfig(ref, contextName);
    const crdApi = kcForCrds.makeApiClient(k8s.CustomObjectsApi);
    const crdSettled = await Promise.allSettled((crds || []).map(async (crd) => {
      const allNsForCrd = crd.namespaced && !allNs;
      const res = allNsForCrd
        ? await withTimeout(crdApi.listNamespacedCustomObject(crd.group, crd.version, namespace, crd.plural), 20000, 'Timed out listing custom resources')
        : await withTimeout(crdApi.listClusterCustomObject(crd.group, crd.version, crd.plural), 20000, 'Timed out listing custom resources');
      return (res.body.items || [])
        .filter((item) => (item.metadata?.name || '').toLowerCase().includes(q))
        .slice(0, 20)
        .map((item) => ({
          crd: true, group: crd.group, version: crd.version, plural: crd.plural, kind: crd.kind, namespaced: crd.namespaced,
          crdName: crd.name,
          name: item.metadata.name, namespace: item.metadata.namespace || '', age: ageOf(item.metadata.creationTimestamp),
        }));
    }));
    crdSettled.forEach((r, i) => {
      if (r.status === 'fulfilled') results.push(...r.value);
      else errors.push({ kind: crds[i].kind, error: r.reason.message });
    });

    return { ok: true, results, errors };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function getResourceYaml(ref, contextName, namespace, kind, name, opts) {
  if (!MANAGE_KINDS.includes(kind)) return { ok: false, error: `Unknown resource kind: ${kind}` };
  try {
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
      case 'pods': res = await withTimeout(coreApi.readNamespacedPod(name, namespace), 20000, 'Timed out reading pod'); break;
      case 'deployments': res = await withTimeout(appsApi.readNamespacedDeployment(name, namespace), 20000, 'Timed out reading deployment'); break;
      case 'statefulsets': res = await withTimeout(appsApi.readNamespacedStatefulSet(name, namespace), 20000, 'Timed out reading statefulset'); break;
      case 'daemonsets': res = await withTimeout(appsApi.readNamespacedDaemonSet(name, namespace), 20000, 'Timed out reading daemonset'); break;
      case 'replicasets': res = await withTimeout(appsApi.readNamespacedReplicaSet(name, namespace), 20000, 'Timed out reading replicaset'); break;
      case 'services': res = await withTimeout(coreApi.readNamespacedService(name, namespace), 20000, 'Timed out reading service'); break;
      case 'ingresses': res = await withTimeout(networkingApi.readNamespacedIngress(name, namespace), 20000, 'Timed out reading ingress'); break;
      case 'configmaps': res = await withTimeout(coreApi.readNamespacedConfigMap(name, namespace), 20000, 'Timed out reading configmap'); break;
      case 'secrets': res = await withTimeout(coreApi.readNamespacedSecret(name, namespace), 20000, 'Timed out reading secret'); break;
      case 'jobs': res = await withTimeout(batchApi.readNamespacedJob(name, namespace), 20000, 'Timed out reading job'); break;
      case 'cronjobs': res = await withTimeout(batchApi.readNamespacedCronJob(name, namespace), 20000, 'Timed out reading cronjob'); break;
      case 'pvcs': res = await withTimeout(coreApi.readNamespacedPersistentVolumeClaim(name, namespace), 20000, 'Timed out reading PVC'); break;
      case 'hpas': res = await withTimeout(autoscalingApi.readNamespacedHorizontalPodAutoscaler(name, namespace), 20000, 'Timed out reading HPA'); break;
      case 'nodes': res = await withTimeout(coreApi.readNode(name), 20000, 'Timed out reading node'); break;
      case 'pvs': res = await withTimeout(coreApi.readPersistentVolume(name), 20000, 'Timed out reading PV'); break;
      case 'namespaces': res = await withTimeout(coreApi.readNamespace(name), 20000, 'Timed out reading namespace'); break;
      case 'events': res = await withTimeout(coreApi.readNamespacedEvent(name, namespace), 20000, 'Timed out reading event'); break;
      case 'serviceaccounts': res = await withTimeout(coreApi.readNamespacedServiceAccount(name, namespace), 20000, 'Timed out reading service account'); break;
      case 'roles': res = await withTimeout(rbacApi.readNamespacedRole(name, namespace), 20000, 'Timed out reading role'); break;
      case 'rolebindings': res = await withTimeout(rbacApi.readNamespacedRoleBinding(name, namespace), 20000, 'Timed out reading role binding'); break;
      case 'clusterroles': res = await withTimeout(rbacApi.readClusterRole(name), 20000, 'Timed out reading cluster role'); break;
      case 'clusterrolebindings': res = await withTimeout(rbacApi.readClusterRoleBinding(name), 20000, 'Timed out reading cluster role binding'); break;
      case 'networkpolicies': res = await withTimeout(networkingApi.readNamespacedNetworkPolicy(name, namespace), 20000, 'Timed out reading network policy'); break;
      case 'storageclasses': res = await withTimeout(storageApi.readStorageClass(name), 20000, 'Timed out reading storage class'); break;
      case 'resourcequotas': res = await withTimeout(coreApi.readNamespacedResourceQuota(name, namespace), 20000, 'Timed out reading resource quota'); break;
      case 'limitranges': res = await withTimeout(coreApi.readNamespacedLimitRange(name, namespace), 20000, 'Timed out reading limit range'); break;
    }

    let obj = res.body;
    if (obj.metadata) {
      delete obj.metadata.managedFields;
      delete obj.metadata.uid;
      delete obj.metadata.creationTimestamp;
      if (!(opts && opts.forEdit)) delete obj.metadata.resourceVersion;
      if (obj.metadata.annotations) {
        delete obj.metadata.annotations['kubectl.kubernetes.io/last-applied-configuration'];
      }
    }
    delete obj.status;
    const redacted = kind === 'secrets' && !(opts && opts.reveal);
    if (redacted) obj = redactSecretData(obj);
    const editable = !(kind === 'secrets' && redacted);
    return { ok: true, yaml: k8s.dumpYaml(obj), redacted, editable };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function getResourceEvents(ref, contextName, namespace, kind, name) {
  if (!MANAGE_KINDS.includes(kind)) return { ok: false, error: `Unknown resource kind: ${kind}` };
  try {
    const kc = buildKubeConfig(ref, contextName);
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);
    const fieldSelector = `involvedObject.name=${name},involvedObject.kind=${MANAGE_KIND_LABEL[kind]}`;
    const res = MANAGE_CLUSTER_SCOPED_KINDS.includes(kind)
      ? await withTimeout(coreApi.listEventForAllNamespaces(undefined, undefined, fieldSelector), 20000, 'Timed out listing events')
      : await withTimeout(coreApi.listNamespacedEvent(namespace, undefined, undefined, undefined, fieldSelector), 20000, 'Timed out listing events');
    const rows = (res.body.items || [])
      .map((item) => ({
        uid: item.metadata?.uid || '',
        type: item.type || '',
        reason: item.reason || '',
        message: item.message || '',
        count: item.count || 1,
        _ts: item.lastTimestamp || item.eventTime || item.metadata?.creationTimestamp,
      }))
      .sort((a, b) => new Date(b._ts || 0) - new Date(a._ts || 0))
      .map((item) => ({ ...item, age: ageOf(item._ts) }));
    return { ok: true, rows };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function runAccessCheck(authApi, { namespace, namespaced, group, resource, name }) {
  const results = await Promise.allSettled(MANAGE_ACCESS_VERBS.map((verb) =>
    withTimeout(
      authApi.createSelfSubjectAccessReview({
        spec: { resourceAttributes: { namespace: namespaced ? namespace : undefined, verb, group, resource, name } },
      }),
      10000,
      `Timed out checking ${verb}`
    )
  ));
  return results.map((r, i) => r.status === 'fulfilled'
    ? { verb: MANAGE_ACCESS_VERBS[i], allowed: !!r.value.body.status.allowed, reason: r.value.body.status.reason || '' }
    : { verb: MANAGE_ACCESS_VERBS[i], allowed: false, reason: r.reason.message });
}

async function checkAccess(ref, contextName, namespace, kind, name) {
  const gvr = MANAGE_KIND_GVR[kind];
  if (!gvr) return { ok: false, error: `Unknown resource kind: ${kind}` };
  try {
    const kc = buildKubeConfig(ref, contextName);
    const authApi = kc.makeApiClient(k8s.AuthorizationV1Api);
    const namespaced = !MANAGE_CLUSTER_SCOPED_KINDS.includes(kind);
    const rows = await runAccessCheck(authApi, { namespace, namespaced, group: gvr.group, resource: gvr.resource, name });
    return { ok: true, rows };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function checkCustomResourceAccess(ref, contextName, namespace, group, resource, namespaced, name) {
  try {
    const kc = buildKubeConfig(ref, contextName);
    const authApi = kc.makeApiClient(k8s.AuthorizationV1Api);
    const rows = await runAccessCheck(authApi, { namespace, namespaced, group, resource, name });
    return { ok: true, rows };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function listCrds(ref, contextName) {
  try {
    const kc = buildKubeConfig(ref, contextName);
    const crdApi = kc.makeApiClient(k8s.ApiextensionsV1Api);
    const res = await withTimeout(crdApi.listCustomResourceDefinition(), 20000, 'Timed out listing CRDs');
    const items = (res.body.items || []).map((item) => {
      const spec = item.spec || {};
      const version = (spec.versions || []).find((v) => v.served) || spec.versions?.[0];
      return {
        name: item.metadata?.name || '',
        group: spec.group || '',
        version: version?.name || '',
        plural: spec.names?.plural || '',
        singular: spec.names?.singular || '',
        kind: spec.names?.kind || '',
        scope: spec.scope || 'Namespaced',
        namespaced: spec.scope === 'Namespaced',
        age: ageOf(item.metadata?.creationTimestamp),
      };
    });
    return { ok: true, crds: items };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function listCustomResource(ref, contextName, namespace, group, version, plural, namespaced) {
  try {
    const kc = buildKubeConfig(ref, contextName);
    const customApi = kc.makeApiClient(k8s.CustomObjectsApi);
    const allNs = namespace === ALL_NAMESPACES;
    const res = (namespaced && !allNs)
      ? await withTimeout(customApi.listNamespacedCustomObject(group, version, namespace, plural), 20000, 'Timed out listing custom resource')
      : await withTimeout(customApi.listClusterCustomObject(group, version, plural), 20000, 'Timed out listing custom resource');
    const rows = (res.body.items || []).map((item) => ({
      name: item.metadata?.name || '',
      namespace: item.metadata?.namespace || '',
      age: ageOf(item.metadata?.creationTimestamp),
    }));
    return { ok: true, rows };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function getCustomResourceYaml(ref, contextName, namespace, group, version, plural, name, namespaced, opts) {
  try {
    const kc = buildKubeConfig(ref, contextName);
    const customApi = kc.makeApiClient(k8s.CustomObjectsApi);
    const res = namespaced
      ? await withTimeout(customApi.getNamespacedCustomObject(group, version, namespace, plural, name), 20000, 'Timed out reading custom resource')
      : await withTimeout(customApi.getClusterCustomObject(group, version, plural, name), 20000, 'Timed out reading custom resource');
    let obj = res.body;
    if (obj.metadata) {
      delete obj.metadata.managedFields;
      delete obj.metadata.uid;
      delete obj.metadata.creationTimestamp;
      if (!(opts && opts.forEdit)) delete obj.metadata.resourceVersion;
      if (obj.metadata.annotations) {
        delete obj.metadata.annotations['kubectl.kubernetes.io/last-applied-configuration'];
      }
    }
    delete obj.status;
    return { ok: true, yaml: k8s.dumpYaml(obj) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function getCustomResourceEvents(ref, contextName, namespace, involvedObjectKind, name, namespaced) {
  try {
    const kc = buildKubeConfig(ref, contextName);
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);
    const fieldSelector = `involvedObject.name=${name},involvedObject.kind=${involvedObjectKind}`;
    const res = namespaced
      ? await withTimeout(coreApi.listNamespacedEvent(namespace, undefined, undefined, undefined, fieldSelector), 20000, 'Timed out listing custom resource events')
      : await withTimeout(coreApi.listEventForAllNamespaces(undefined, undefined, fieldSelector), 20000, 'Timed out listing custom resource events');
    const rows = (res.body.items || [])
      .map((item) => ({
        uid: item.metadata?.uid || '',
        type: item.type || '',
        reason: item.reason || '',
        message: item.message || '',
        count: item.count || 1,
        _ts: item.lastTimestamp || item.eventTime || item.metadata?.creationTimestamp,
      }))
      .sort((a, b) => new Date(b._ts || 0) - new Date(a._ts || 0))
      .map((item) => ({ ...item, age: ageOf(item._ts) }));
    return { ok: true, rows };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = {
  loadContexts,
  loadNamespaces,
  loadDeployments,
  listKindItems,
  listResource,
  searchResources,
  getResourceYaml,
  getResourceEvents,
  checkAccess,
  checkCustomResourceAccess,
  listCrds,
  listCustomResource,
  getCustomResourceYaml,
  getCustomResourceEvents,
};
