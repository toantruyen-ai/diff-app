const { getCachedApiClients } = require('../utils/k8sHelper');
const { withTimeout } = require('../utils/timeout');
const { podStatus, dedupeEvents } = require('../utils/resourceFormatter');
const { parseCpuMillis, parseMemoryBytes } = require('../utils/unitParser');
const { ALL_NAMESPACES } = require('../constants/k8sConstants');

const MANAGE_METRICS_SCOPES = ['pods', 'nodes'];

async function getManageOverview(ref, contextName) {
  try {
    const { apis } = getCachedApiClients(ref, contextName);
    const coreApi = apis.core;
    const appsApi = apis.apps;
    const [podsRes, deploymentsRes, nodesRes, eventsRes] = await Promise.all([
      withTimeout(coreApi.listPodForAllNamespaces(), 15000, 'Timed out listing pods'),
      withTimeout(appsApi.listDeploymentForAllNamespaces(), 15000, 'Timed out listing deployments'),
      withTimeout(coreApi.listNode(), 15000, 'Timed out listing nodes'),
      withTimeout(coreApi.listEventForAllNamespaces(), 15000, 'Timed out listing events'),
    ]);

    const podsNotReady = (podsRes.body.items || [])
      .filter((p) => !['Succeeded', 'Completed'].includes(podStatus(p)) && podStatus(p) !== 'Running')
      .map((p) => ({ namespace: p.metadata.namespace, name: p.metadata.name, status: podStatus(p) }));

    const deploymentsUnhealthy = (deploymentsRes.body.items || [])
      .filter((d) => (d.status?.readyReplicas || 0) < (d.spec?.replicas ?? 0))
      .map((d) => ({
        namespace: d.metadata.namespace, name: d.metadata.name,
        ready: `${d.status?.readyReplicas || 0}/${d.spec?.replicas ?? 0}`,
      }));

    const nodesNotReady = (nodesRes.body.items || [])
      .filter((n) => {
        const cond = (n.status?.conditions || []).find((c) => c.type === 'Ready');
        return !(cond && cond.status === 'True');
      })
      .map((n) => ({ namespace: '', name: n.metadata.name, status: 'NotReady' }));

    const warningEvents = dedupeEvents(eventsRes.body.items || [], 10);

    return {
      ok: true,
      digest: {
        podsNotReady: { count: podsNotReady.length, items: podsNotReady.slice(0, 10) },
        deploymentsUnhealthy: { count: deploymentsUnhealthy.length, items: deploymentsUnhealthy.slice(0, 10) },
        nodesNotReady: { count: nodesNotReady.length, items: nodesNotReady.slice(0, 10) },
        warningEvents: { count: warningEvents.length, items: warningEvents },
      },
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function getMetrics(ref, contextName, namespace, scope) {
  if (!MANAGE_METRICS_SCOPES.includes(scope)) return { ok: false, error: `Unknown metrics scope: ${scope}` };
  try {
    const { metricsApi } = getCachedApiClients(ref, contextName);
    const res = scope === 'nodes'
      ? await withTimeout(metricsApi.getNodeMetrics(), 10000, 'Timed out fetching node metrics')
      : await withTimeout(
          namespace === ALL_NAMESPACES ? metricsApi.getPodMetrics() : metricsApi.getPodMetrics(namespace),
          10000,
          'Timed out fetching pod metrics'
        );

    const rows = (res.items || []).map((item) => {
      const usages = scope === 'nodes' ? [item.usage || {}] : (item.containers || []).map((c) => c.usage || {});
      const cpu = usages.reduce((sum, u) => sum + parseCpuMillis(u.cpu), 0);
      const memory = usages.reduce((sum, u) => sum + parseMemoryBytes(u.memory), 0);
      return { name: item.metadata.name, namespace: item.metadata.namespace || '', cpu, memory };
    });
    return { ok: true, rows };
  } catch (e) {
    return { ok: false, reason: 'metrics-server-unavailable', error: e.message };
  }
}

module.exports = {
  getManageOverview,
  getMetrics,
};
