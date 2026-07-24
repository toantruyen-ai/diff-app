const k8s = require('@kubernetes/client-node');
const { buildKubeConfig } = require('../utils/k8sHelper');
const { redactContext } = require('./troubleshootingRedactorService');

async function collectPodContext(ref, contextName, namespace, podName, opts = {}) {
  const tailLines = opts.tailLines || 200;
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

  const mainContainerName = containers[0]?.name || pod.spec?.containers?.[0]?.name;

  let logsPrevious = '';
  let logsCurrent = '';

  if (mainContainerName) {
    try {
      const prevRes = await coreApi.readNamespacedPodLog(
        podName,
        namespace,
        mainContainerName,
        undefined,
        false,
        undefined,
        undefined,
        false,
        undefined,
        tailLines,
        true
      );
      logsPrevious = typeof prevRes.body === 'string' ? prevRes.body : JSON.stringify(prevRes.body || '');
    } catch {
      logsPrevious = '';
    }

    try {
      const currRes = await coreApi.readNamespacedPodLog(
        podName,
        namespace,
        mainContainerName,
        undefined,
        false,
        undefined,
        undefined,
        false,
        undefined,
        tailLines,
        false
      );
      logsCurrent = typeof currRes.body === 'string' ? currRes.body : JSON.stringify(currRes.body || '');
    } catch {
      logsCurrent = '';
    }
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
  };

  return redactContext(rawContext);
}

module.exports = {
  collectPodContext,
};
