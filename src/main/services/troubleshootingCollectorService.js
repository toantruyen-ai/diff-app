const k8s = require('@kubernetes/client-node');
const { buildKubeConfig } = require('../utils/k8sHelper');
const { redactContext } = require('./troubleshootingRedactorService');

async function collectPodContext(ref, contextName, namespace, podName, opts = {}) {
  const tailLines = opts.tailLines || 70;
  const kc = buildKubeConfig(ref, contextName);
  const coreApi = kc.makeApiClient(k8s.CoreV1Api);

  let podRes;
  try {
    podRes = await coreApi.readNamespacedPod(podName, namespace);
  } catch (e) {
    throw new Error(`Failed to read pod ${podName} in ${namespace}: ${e.message}`);
  }

  const pod = podRes.body;
  const uid = pod.metadata?.uid;

  let events = [];
  try {
    const fieldSelector = uid ? `involvedObject.uid=${uid}` : `involvedObject.name=${podName}`;
    const evRes = await coreApi.listNamespacedEvent(namespace, undefined, undefined, undefined, fieldSelector);
    events = (evRes.body?.items || []).map((e) => ({
      reason: e.reason,
      message: e.message,
      type: e.type,
      count: e.count || 1,
      lastTimestamp: e.lastTimestamp || e.eventTime,
    }));
  } catch {
    events = [];
  }

  const containers = (pod.status?.containerStatuses || []).map((cs) => {
    const specContainer = (pod.spec?.containers || []).find((c) => c.name === cs.name) || {};
    const terminated = cs.lastState?.terminated || cs.state?.terminated || {};
    return {
      name: cs.name,
      restartCount: cs.restartCount || 0,
      waitingReason: cs.state?.waiting?.reason,
      terminatedReason: terminated.reason,
      exitCode: terminated.exitCode,
      signal: terminated.signal,
      finishedAt: terminated.finishedAt,
      env: specContainer.env || [],
    };
  });

  const allContainers = [
    ...(pod.spec?.initContainers || []).map((c) => ({ name: c.name, isInit: true })),
    ...(pod.spec?.containers || []).map((c) => ({ name: c.name, isInit: false })),
  ];

  const combinedLogsPrevious = [];
  const combinedLogsCurrent = [];

  for (const c of allContainers) {
    const cs = containers.find((item) => item.name === c.name) || {};
    const restartCount = cs.restartCount || 0;

    if (restartCount > 0) {
      try {
        const prevRes = await coreApi.readNamespacedPodLog(
          podName,
          namespace,
          c.name,
          false,
          undefined,
          undefined,
          undefined,
          true,
          undefined,
          tailLines,
          false
        );
        const pText = typeof prevRes.body === 'string' ? prevRes.body : JSON.stringify(prevRes.body || '');
        if (pText && pText.trim()) {
          combinedLogsPrevious.push(`=== Previous Log (--previous) [container: ${c.name}${c.isInit ? ' (init)' : ''} | restarts: ${restartCount}] ===\n${pText.trim()}`);
        } else {
          combinedLogsPrevious.push(`=== Previous Log (--previous) [container: ${c.name}] ===\n(Container restarted ${restartCount} times, but previous log was empty or rotated by Node)`);
        }
      } catch (err) {
        combinedLogsPrevious.push(`=== Previous Log (--previous) [container: ${c.name}] ===\n(Container restarted ${restartCount} times, but API returned: ${err.message || 'Log unavailable'})`);
      }
    } else {
      combinedLogsPrevious.push(`=== Previous Log (--previous) [container: ${c.name}] ===\n(No previous crash log — container has restartCount = 0)`);
    }

    try {
      const currRes = await coreApi.readNamespacedPodLog(
        podName,
        namespace,
        c.name,
        false,
        undefined,
        undefined,
        undefined,
        false,
        undefined,
        tailLines,
        false
      );
      const cText = typeof currRes.body === 'string' ? currRes.body : JSON.stringify(currRes.body || '');
      if (cText && cText.trim()) {
        combinedLogsCurrent.push(`=== Current Log [container: ${c.name}${c.isInit ? ' (init)' : ''}] ===\n${cText.trim()}`);
      }
    } catch {
      /* ignore log read error */
    }
  }

  const logsPrevious = combinedLogsPrevious.join('\n\n');
  const logsCurrent = combinedLogsCurrent.join('\n\n');

  let grafanaTelemetry = null;
  try {
    const auditDb = require('../db/auditDb');
    const res = await auditDb.getAiConfig(ref, contextName);
    if (res && res.ok && res.config && res.config.grafanaUrl) {
      const { grafanaUrl, serviceAccountToken, lokiDatasource, mimirDatasource } = res.config;
      const headers = {};
      if (serviceAccountToken) headers['Authorization'] = `Bearer ${serviceAccountToken}`;
      const baseUrl = grafanaUrl.replace(/\/+$/, '');

      grafanaTelemetry = { grafanaUrl, lokiLogs: [], mimirMetrics: [] };

      // Helper with timeout
      const fetchTimeout = async (url, ms = 3000) => {
        const controller = new AbortController();
        const tid = setTimeout(() => controller.abort(), ms);
        try {
          const response = await fetch(url, { signal: controller.signal, headers });
          clearTimeout(tid);
          if (!response.ok) return null;
          return await response.json();
        } catch {
          clearTimeout(tid);
          return null;
        }
      };

      if (lokiDatasource) {
        const lokiUrl = `${baseUrl}/api/datasources/proxy/uid/${encodeURIComponent(lokiDatasource)}/loki/api/v1/query_range?query=${encodeURIComponent(`{namespace="${namespace}",pod="${podName}"}`)}&limit=30`;
        const lokiData = await fetchTimeout(lokiUrl);
        if (lokiData?.data?.result) {
          grafanaTelemetry.lokiLogs = lokiData.data.result.map((s) => ({
            stream: s.stream,
            lines: (s.values || []).slice(-15).map((v) => v[1] || ''),
          }));
        }
      }

      if (mimirDatasource) {
        const now = Math.floor(Date.now() / 1000);
        const start = now - 1800;
        const mimirUrl = `${baseUrl}/api/datasources/proxy/uid/${encodeURIComponent(mimirDatasource)}/api/v1/query_range?query=${encodeURIComponent(`container_memory_working_set_bytes{namespace="${namespace}",pod="${podName}"}`)}&start=${start}&end=${now}&step=120`;
        const mimirData = await fetchTimeout(mimirUrl);
        if (mimirData?.data?.result) {
          grafanaTelemetry.mimirMetrics = mimirData.data.result.map((m) => ({
            metric: m.metric,
            samples: (m.values || []).slice(-10),
          }));
        }
      }
    }
  } catch (err) {
    console.warn('[troubleshooting] Grafana telemetry fetch error:', err.message);
  }

  const rawContext = {
    namespace,
    podName,
    containers,
    events,
    logsPrevious,
    logsCurrent,
    limits: pod.spec?.containers?.[0]?.resources?.limits,
    requests: pod.spec?.containers?.[0]?.resources?.requests,
    missingRefs: [],
    grafanaTelemetry,
  };

  return redactContext(rawContext);
}

module.exports = {
  collectPodContext,
};
