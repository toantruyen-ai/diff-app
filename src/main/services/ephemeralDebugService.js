const k8sHelper = require('../utils/k8sHelper');

async function injectEphemeralContainer(
  ref,
  contextName,
  namespace,
  podName,
  targetContainer,
  image
) {
  if (!podName || typeof podName !== 'string') {
    return { ok: false, error: 'podName is required' };
  }

  const ephemeralImage = image || 'nicolaka/netshoot';
  const containerName = `debugger-${Math.random().toString(36).substring(2, 7)}`;
  const apis = k8sHelper.getCachedApiClients(ref, contextName).apis;

  try {
    const podRes = await apis.core.readNamespacedPod(podName, namespace);
    const pod = podRes.body || podRes;

    const newEphemeralContainer = {
      name: containerName,
      image: ephemeralImage,
      stdin: true,
      tty: true,
      targetContainerName: targetContainer || undefined,
    };

    const existingEphemeral = pod.spec?.ephemeralContainers || [];
    const updatedEphemeral = [...existingEphemeral, newEphemeralContainer];

    const patchPayload = {
      spec: {
        ephemeralContainers: updatedEphemeral,
      },
    };

    // Use strategic merge patch / patch for ephemeralcontainers subresource
    const options = {
      headers: { 'Content-Type': 'application/strategic-merge-patch+json' },
    };

    if (typeof apis.core.patchNamespacedPodEphemeralContainers === 'function') {
      await apis.core.patchNamespacedPodEphemeralContainers(
        podName,
        namespace,
        patchPayload,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        options
      );
    } else {
      await apis.core.patchNamespacedPod(
        podName,
        namespace,
        patchPayload,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        options
      );
    }

    return { ok: true, containerName };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

async function copyPodToDebug(
  ref,
  contextName,
  namespace,
  podName,
  containerToOverride,
  newImage,
  newCommand
) {
  if (!podName || typeof podName !== 'string') {
    return { ok: false, error: 'podName is required' };
  }

  const apis = k8sHelper.getCachedApiClients(ref, contextName).apis;

  try {
    const podRes = await apis.core.readNamespacedPod(podName, namespace);
    const originalPod = podRes.body || podRes;

    const newPodName = `${podName}-debug-${Math.random().toString(36).substring(2, 7)}`;

    const debugPodSpec = JSON.parse(JSON.stringify(originalPod.spec));

    // Remove nodeName / cluster specific bindings
    delete debugPodSpec.nodeName;

    if (Array.isArray(debugPodSpec.containers) && debugPodSpec.containers.length > 0) {
      let targetIdx = 0;
      if (containerToOverride) {
        const found = debugPodSpec.containers.findIndex((c) => c.name === containerToOverride);
        if (found !== -1) targetIdx = found;
      }

      if (newImage) {
        debugPodSpec.containers[targetIdx].image = newImage;
      }
      if (newCommand) {
        debugPodSpec.containers[targetIdx].command = Array.isArray(newCommand)
          ? newCommand
          : [newCommand];
      }
    }

    const newPodManifest = {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: {
        name: newPodName,
        namespace: namespace,
        labels: {
          ...(originalPod.metadata?.labels || {}),
          'app.kubernetes.io/debug-copy': 'true',
        },
      },
      spec: debugPodSpec,
    };

    await apis.core.createNamespacedPod(namespace, newPodManifest);

    return { ok: true, newPodName };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

module.exports = {
  injectEphemeralContainer,
  copyPodToDebug,
};
