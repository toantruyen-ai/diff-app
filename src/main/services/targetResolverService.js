const k8sHelper = require('../utils/k8sHelper');

function filterAndRankPods(pods, currentPodName) {
  if (!pods || !Array.isArray(pods)) return [];

  const activePods = pods.filter((p) => {
    if (!p.metadata || p.metadata.deletionTimestamp) return false;
    if (!p.status || p.status.phase !== 'Running') return false;
    const readyCond = p.status.conditions && p.status.conditions.find((c) => c.type === 'Ready');
    return readyCond && readyCond.status === 'True';
  });

  if (activePods.length === 0) return [];

  if (currentPodName) {
    const current = activePods.find((p) => p.metadata && p.metadata.name === currentPodName);
    if (current) return [current];
  }

  activePods.sort((a, b) => {
    const timeA = new Date(a.status?.startTime || a.metadata?.creationTimestamp || 0).getTime();
    const timeB = new Date(b.status?.startTime || b.metadata?.creationTimestamp || 0).getTime();
    return timeB - timeA;
  });

  return activePods;
}

function detectFirstPort(pod, serviceObj) {
  if (serviceObj && serviceObj.spec && Array.isArray(serviceObj.spec.ports) && serviceObj.spec.ports.length > 0) {
    const p = serviceObj.spec.ports[0];
    return p.targetPort || p.port || 80;
  }
  if (pod && pod.spec && Array.isArray(pod.spec.containers)) {
    for (const c of pod.spec.containers) {
      if (Array.isArray(c.ports) && c.ports.length > 0 && c.ports[0].containerPort) {
        return c.ports[0].containerPort;
      }
    }
  }
  return 80;
}

function resolveServiceTargetPort(service, pod, remotePort) {
  if (!remotePort) {
    return detectFirstPort(pod, service);
  }

  const ports = service.spec?.ports || [];
  let matchedPort = null;

  if (typeof remotePort === 'number' || /^\d+$/.test(String(remotePort))) {
    const numPort = Number(remotePort);
    matchedPort = ports.find((p) => p.port === numPort || p.targetPort === numPort);
  } else {
    matchedPort = ports.find((p) => p.name === remotePort || p.targetPort === remotePort);
  }

  const targetPort = matchedPort ? matchedPort.targetPort : remotePort;

  if (typeof targetPort === 'number' || /^\d+$/.test(String(targetPort))) {
    return Number(targetPort);
  }

  const containers = pod.spec?.containers || [];
  for (const c of containers) {
    const cPorts = c.ports || [];
    const found = cPorts.find((cp) => cp.name === targetPort);
    if (found && found.containerPort) {
      return found.containerPort;
    }
  }

  const fallback = Number(remotePort);
  return Number.isNaN(fallback) ? 80 : fallback;
}

async function resolveTargetPod(ref, contextName, namespace, target) {
  if (!target || !target.name) {
    return { ok: false, error: 'Target name is required' };
  }

  const kind = (target.kind || 'pod').toLowerCase();
  let remotePort = target.remotePort;

  if (kind === 'pod') {
    if (!remotePort) {
      try {
        const apis = k8sHelper.getCachedApiClients(ref, contextName).apis;
        const pRes = await apis.core.readNamespacedPod(target.name, namespace);
        const podObj = pRes.body || pRes;
        remotePort = detectFirstPort(podObj);
      } catch {
        remotePort = 80;
      }
    }
    return { ok: true, podName: target.name, containerPort: Number(remotePort) || 80 };
  }

  const apis = k8sHelper.getCachedApiClients(ref, contextName).apis;

  try {
    let selector = null;
    let serviceObj = null;

    if (kind === 'service') {
      const sRes = await apis.core.readNamespacedService(target.name, namespace);
      serviceObj = sRes.body || sRes;
      selector = serviceObj.spec?.selector;
    } else if (kind === 'deployment') {
      const dRes = await apis.apps.readNamespacedDeployment(target.name, namespace);
      selector = (dRes.body || dRes).spec?.selector?.matchLabels;
    } else if (kind === 'statefulset') {
      const ssRes = await apis.apps.readNamespacedStatefulSet(target.name, namespace);
      selector = (ssRes.body || ssRes).spec?.selector?.matchLabels;
    } else if (kind === 'replicaset') {
      const rsRes = await apis.apps.readNamespacedReplicaSet(target.name, namespace);
      selector = (rsRes.body || rsRes).spec?.selector?.matchLabels;
    }

    if (!selector || Object.keys(selector).length === 0) {
      return { ok: false, error: `No label selector found for ${kind}/${target.name}` };
    }

    const labelSelector = Object.entries(selector)
      .map(([k, v]) => `${k}=${v}`)
      .join(',');

    const podListRes = await apis.core.listNamespacedPod(
      namespace,
      undefined,
      undefined,
      undefined,
      undefined,
      labelSelector
    );
    const pods = (podListRes.body || podListRes).items || [];
    const readyPods = filterAndRankPods(pods, target.currentPodName);

    if (readyPods.length === 0) {
      return { ok: false, status: 'pending', reason: 'no-ready-pod' };
    }

    const selectedPod = readyPods[0];
    const podName = selectedPod.metadata.name;
    let containerPort;

    if (!remotePort) {
      containerPort = detectFirstPort(selectedPod, serviceObj);
    } else if (kind === 'service' && serviceObj) {
      containerPort = resolveServiceTargetPort(serviceObj, selectedPod, remotePort);
    } else {
      containerPort = Number(remotePort) || 80;
    }

    return { ok: true, podName, containerPort, labelSelector };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

module.exports = {
  resolveTargetPod,
  filterAndRankPods,
  resolveServiceTargetPort,
  detectFirstPort,
};
