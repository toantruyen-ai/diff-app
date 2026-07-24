const k8s = require('@kubernetes/client-node');
const k8sHelper = require('../utils/k8sHelper');
const { createStreamManager } = require('./multiPodLogStreamManager');
const { createBatcher } = require('./multiPodLogBatcher');
const { reconcileStreams } = require('./multiPodLogReconciler');

const activeSessions = new Map();

function sendIfAlive(getMainWindow, channel, ...args) {
  try {
    const win = getMainWindow ? getMainWindow() : null;
    if (win && !win.isDestroyed() && win.webContents && (typeof win.webContents.isDestroyed !== 'function' || !win.webContents.isDestroyed())) {
      win.webContents.send(channel, ...args);
    }
  } catch (err) {
    console.error(`Error sending from webFrameMain on channel ${channel}:`, err);
  }
}

async function resolveMatchLabels(kc, namespace, workload) {
  if (!workload || !workload.name || !workload.kind) return null;
  if (workload.matchLabels && Object.keys(workload.matchLabels).length > 0) {
    return workload.matchLabels;
  }
  const kindLower = workload.kind.toLowerCase();
  if (kindLower === 'pod' || kindLower === 'pods' || kindLower === 'clusterlogs') return null;

  try {
    if (kindLower.includes('deploy')) {
      const appsApi = kc.makeApiClient(k8s.AppsV1Api);
      const res = await appsApi.readNamespacedDeployment(workload.name, namespace);
      return res.body?.spec?.selector?.matchLabels || null;
    }
    if (kindLower.includes('stateful')) {
      const appsApi = kc.makeApiClient(k8s.AppsV1Api);
      const res = await appsApi.readNamespacedStatefulSet(workload.name, namespace);
      return res.body?.spec?.selector?.matchLabels || null;
    }
    if (kindLower.includes('daemon')) {
      const appsApi = kc.makeApiClient(k8s.AppsV1Api);
      const res = await appsApi.readNamespacedDaemonSet(workload.name, namespace);
      return res.body?.spec?.selector?.matchLabels || null;
    }
    if (kindLower.includes('replica')) {
      const appsApi = kc.makeApiClient(k8s.AppsV1Api);
      const res = await appsApi.readNamespacedReplicaSet(workload.name, namespace);
      return res.body?.spec?.selector?.matchLabels || null;
    }
    if (kindLower.includes('job')) {
      const batchApi = kc.makeApiClient(k8s.BatchV1Api);
      const res = await batchApi.readNamespacedJob(workload.name, namespace);
      return res.body?.spec?.selector?.matchLabels || null;
    }
  } catch {}
  return null;
}

function filterPodsForWorkload(items, workload, matchLabels) {
  if (!workload || !workload.kind) return items;
  const kindLower = workload.kind.toLowerCase();
  if (kindLower === 'clusterlogs') return items;

  if (kindLower === 'pod' || kindLower === 'pods') {
    if (workload.name) {
      return items.filter((p) => p.metadata?.name === workload.name);
    }
    return items;
  }

  if (matchLabels && Object.keys(matchLabels).length > 0) {
    return items.filter((p) => {
      const pLabels = p.metadata?.labels || {};
      return Object.entries(matchLabels).every(([k, v]) => pLabels[k] === v);
    });
  }

  if (workload.name) {
    const prefix = `${workload.name}-`;
    return items.filter((p) => {
      const pName = p.metadata?.name || '';
      if (pName.startsWith(prefix)) return true;
      const owners = p.metadata?.ownerReferences || [];
      return owners.some((o) => o.name === workload.name || o.name.startsWith(prefix));
    });
  }

  return items;
}

async function startMultiPodLogs(ref, contextName, namespace, workload, opts, sid, getMainWindow) {
  stopMultiPodLogs(sid);

  const batcher = createBatcher({
    flushIntervalMs: opts?.flushIntervalMs,
    flushBatchSize: opts?.flushBatchSize,
    reorderWindowMs: opts?.reorderWindowMs,
    backpressureMode: opts?.backpressureMode,
    onFlush: (batch) => {
      sendIfAlive(getMainWindow, `multi-pod-log-batch:${sid}`, batch);
    },
  });

  const streamManager = createStreamManager();

  const session = {
    sid,
    ref,
    contextName,
    namespace,
    workload,
    opts,
    streamManager,
    batcher,
    informer: null,
    podCache: [],
    reconcileTimer: null,
  };

  activeSessions.set(sid, session);

  const triggerReconcile = () => {
    if (!activeSessions.has(sid)) return;
    reconcileStreams({
      podList: session.podCache,
      streamManager,
      ref,
      contextName,
      namespace,
      opts,
      onLog: (pod, container, rawLine) => {
        batcher.addLog(pod, container, rawLine);
      },
      onTopologyChange: (topology) => {
        sendIfAlive(getMainWindow, `multi-pod-log-topology:${sid}`, topology);
      },
    });
  };

  try {
    const kc = k8sHelper.buildKubeConfig(ref, contextName);
    const k8sApi = kc.makeApiClient(k8s.CoreV1Api);

    const matchLabels = await resolveMatchLabels(kc, namespace, workload);
    const labelSelector = matchLabels && Object.keys(matchLabels).length > 0
      ? Object.entries(matchLabels).map(([k, v]) => `${k}=${v}`).join(',')
      : undefined;

    const res = await k8sApi.listNamespacedPod(
      namespace,
      undefined,
      undefined,
      undefined,
      undefined,
      labelSelector
    );

    session.podCache = filterPodsForWorkload(res.body?.items || [], workload, matchLabels);
    triggerReconcile();

    // Setup periodic polling / informer sync
    session.reconcileTimer = setInterval(async () => {
      try {
        const polled = await k8sApi.listNamespacedPod(
          namespace,
          undefined,
          undefined,
          undefined,
          undefined,
          labelSelector
        );
        session.podCache = filterPodsForWorkload(polled.body?.items || [], workload, matchLabels);
        triggerReconcile();
      } catch {}
    }, 5000);

    sendIfAlive(getMainWindow, `multi-pod-log-status:${sid}`, { state: 'synced' });
    return { ok: true, sessionId: sid };
  } catch (err) {
    console.error('EXACT CATCH ERR:', err);
    stopMultiPodLogs(sid);
    sendIfAlive(getMainWindow, `multi-pod-log-status:${sid}`, { state: 'error', error: err.message });
    return { ok: false, error: err.message };
  }
}

function stopMultiPodLogs(sid) {
  const session = activeSessions.get(sid);
  if (!session) return { ok: true };

  if (session.reconcileTimer) {
    clearInterval(session.reconcileTimer);
    session.reconcileTimer = null;
  }

  if (session.streamManager) {
    session.streamManager.closeAllStreams();
  }

  if (session.batcher) {
    session.batcher.destroy();
  }

  activeSessions.delete(sid);
  return { ok: true };
}

function stopAllMultiPodLogSessions() {
  for (const sid of Array.from(activeSessions.keys())) {
    stopMultiPodLogs(sid);
  }
}

function updateTail(sid, tailLines) {
  const session = activeSessions.get(sid);
  if (!session) return { ok: false, error: 'Session not found' };
  session.opts = { ...session.opts, tailLines };
  return { ok: true };
}

function setStreamEnabled(sid, streamKey, enabled) {
  const session = activeSessions.get(sid);
  if (!session) return { ok: false, error: 'Session not found' };
  const stream = session.streamManager.getStream(streamKey);
  if (stream) stream.enabledByUser = !!enabled;
  return { ok: true };
}

function setBackpressure(sid, mode) {
  const session = activeSessions.get(sid);
  if (!session) return { ok: false, error: 'Session not found' };
  session.batcher.setBackpressureMode(mode);
  return { ok: true };
}

module.exports = {
  activeSessions,
  startMultiPodLogs,
  stopMultiPodLogs,
  stopAllMultiPodLogSessions,
  updateTail,
  setStreamEnabled,
  setBackpressure,
};
