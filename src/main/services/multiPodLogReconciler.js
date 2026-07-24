function computeDesiredStreams(podList = []) {
  const desired = new Set();
  for (const pod of podList) {
    const podName = pod?.metadata?.name;
    if (!podName) continue;

    const containerStatuses = [
      ...(pod.status?.containerStatuses || []),
      ...(pod.status?.initContainerStatuses || []),
      ...(pod.status?.ephemeralContainerStatuses || []),
    ];

    for (const cStatus of containerStatuses) {
      const cName = cStatus.name;
      const isRunning = !!cStatus.state?.running;
      if (isRunning) {
        desired.add(`${podName}/${cName}`);
      }
    }
  }
  return desired;
}

function reconcileStreams({ podList, streamManager, ref, contextName, namespace, opts, onLog, onTopologyChange }) {
  const desiredKeys = computeDesiredStreams(podList);
  const currentTopology = streamManager.getTopologySnapshot();
  const actualKeys = new Set(currentTopology.map((s) => s.streamKey));

  const totalDesiredCount = Math.max(1, desiredKeys.size);
  const targetTail = opts?.tailLines != null ? parseInt(opts.tailLines, 10) : 500;
  const perStreamTailLines = Math.max(10, Math.floor(targetTail / totalDesiredCount));
  const perStreamOpts = {
    ...opts,
    tailLines: perStreamTailLines,
  };

  let changed = false;

  // Open missing streams
  for (const key of desiredKeys) {
    if (!actualKeys.has(key)) {
      const [pod, container] = key.split('/');
      streamManager.openStream({
        ref,
        contextName,
        namespace,
        pod,
        container,
        opts: perStreamOpts,
        onLog,
        onStateChange: () => {
          if (onTopologyChange) onTopologyChange(streamManager.getTopologySnapshot());
        },
      });
      changed = true;
    }
  }

  // Close streams no longer in desired set
  for (const key of actualKeys) {
    if (!desiredKeys.has(key)) {
      streamManager.closeStream(key);
      changed = true;
    }
  }

  if (changed && onTopologyChange) {
    onTopologyChange(streamManager.getTopologySnapshot());
  }

  return streamManager.getTopologySnapshot();
}

module.exports = {
  computeDesiredStreams,
  reconcileStreams,
};
