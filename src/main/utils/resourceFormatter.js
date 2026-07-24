/**
 * Formats a timestamp into an ISO string or null.
 * @param {string|Date} ts 
 * @returns {string|null}
 */
function ageOf(ts) {
  return ts ? new Date(ts).toISOString() : null;
}

/**
 * Evaluates pod phase/status from containerStatuses.
 * @param {object} pod 
 * @returns {string}
 */
function podStatus(pod) {
  const statuses = pod.status?.containerStatuses || [];
  const waiting = statuses.find((s) => s.state && s.state.waiting);
  if (waiting) return waiting.state.waiting.reason || 'Waiting';
  const badTerminated = statuses.find(
    (s) => s.state && s.state.terminated && s.state.terminated.reason && s.state.terminated.reason !== 'Completed'
  );
  if (badTerminated) return badTerminated.state.terminated.reason;
  return pod.status?.phase || 'Unknown';
}

/**
 * Projects full Kubernetes API objects into UI table rows.
 * @param {string} kind 
 * @param {object} item 
 * @returns {object}
 */
function projectRow(kind, item) {
  const meta = item.metadata || {};
  const base = { namespace: meta.namespace || '' };
  switch (kind) {
    case 'pods': {
      const statuses = item.status?.containerStatuses || [];
      const restarts = statuses.reduce((sum, s) => sum + (s.restartCount || 0), 0);
      return {
        ...base,
        name: meta.name,
        ready: `${statuses.filter((s) => s.ready).length}/${statuses.length}`,
        status: podStatus(item),
        restarts,
        node: item.spec?.nodeName || '',
        age: ageOf(meta.creationTimestamp),
        containers: (item.spec?.containers || []).map((c) => c.name),
      };
    }
    case 'deployments': {
      const spec = item.spec || {};
      const status = item.status || {};
      return {
        ...base,
        name: meta.name,
        ready: `${status.readyReplicas || 0}/${spec.replicas ?? 0}`,
        upToDate: status.updatedReplicas || 0,
        available: status.availableReplicas || 0,
        age: ageOf(meta.creationTimestamp),
      };
    }
    case 'statefulsets': {
      const spec = item.spec || {};
      const status = item.status || {};
      return {
        ...base,
        name: meta.name,
        ready: `${status.readyReplicas || 0}/${spec.replicas ?? 0}`,
        age: ageOf(meta.creationTimestamp),
      };
    }
    case 'daemonsets': {
      const status = item.status || {};
      return {
        ...base,
        name: meta.name,
        desired: status.desiredNumberScheduled || 0,
        current: status.currentNumberScheduled || 0,
        ready: status.numberReady || 0,
        age: ageOf(meta.creationTimestamp),
      };
    }
    case 'replicasets': {
      const spec = item.spec || {};
      const status = item.status || {};
      return {
        ...base,
        name: meta.name,
        desired: spec.replicas ?? 0,
        current: status.replicas || 0,
        ready: status.readyReplicas || 0,
        age: ageOf(meta.creationTimestamp),
      };
    }
    case 'services': {
      const spec = item.spec || {};
      const lbIngress = (item.status?.loadBalancer?.ingress || []).map((i) => i.ip || i.hostname);
      const ports = (spec.ports || [])
        .map((p) => `${p.port}${p.nodePort ? `:${p.nodePort}` : ''}/${p.protocol}`)
        .join(', ');
      return {
        ...base,
        name: meta.name,
        type: spec.type || 'ClusterIP',
        clusterIp: spec.clusterIP || '',
        externalIp: [...(spec.externalIPs || []), ...lbIngress].join(', '),
        ports,
        age: ageOf(meta.creationTimestamp),
      };
    }
    case 'ingresses': {
      const spec = item.spec || {};
      const hosts = (spec.rules || []).map((r) => r.host).filter(Boolean).join(', ');
      const address = (item.status?.loadBalancer?.ingress || []).map((i) => i.ip || i.hostname).join(', ');
      return {
        ...base,
        name: meta.name,
        class: spec.ingressClassName || '',
        hosts,
        address,
        age: ageOf(meta.creationTimestamp),
      };
    }
    case 'configmaps': {
      return { ...base, name: meta.name, keys: Object.keys(item.data || {}).length, age: ageOf(meta.creationTimestamp) };
    }
    case 'secrets': {
      return {
        ...base,
        name: meta.name,
        type: item.type || 'Opaque',
        keys: Object.keys(item.data || {}).length,
        age: ageOf(meta.creationTimestamp),
      };
    }
    case 'jobs': {
      const spec = item.spec || {};
      const status = item.status || {};
      return {
        ...base,
        name: meta.name,
        completions: `${status.succeeded || 0}/${spec.completions ?? 1}`,
        age: ageOf(meta.creationTimestamp),
      };
    }
    case 'cronjobs': {
      const spec = item.spec || {};
      const status = item.status || {};
      return {
        ...base,
        name: meta.name,
        schedule: spec.schedule || '',
        suspend: !!spec.suspend,
        active: (status.active || []).length,
        lastSchedule: ageOf(status.lastScheduleTime),
        age: ageOf(meta.creationTimestamp),
      };
    }
    case 'pvcs': {
      const spec = item.spec || {};
      const status = item.status || {};
      return {
        ...base,
        name: meta.name,
        status: status.phase || '',
        volume: spec.volumeName || '',
        capacity: status.capacity?.storage || '',
        storageClass: spec.storageClassName || '',
        age: ageOf(meta.creationTimestamp),
      };
    }
    case 'hpas': {
      const spec = item.spec || {};
      const status = item.status || {};
      return {
        ...base,
        name: meta.name,
        reference: spec.scaleTargetRef ? `${spec.scaleTargetRef.kind}/${spec.scaleTargetRef.name}` : '',
        minPods: spec.minReplicas ?? 1,
        maxPods: spec.maxReplicas ?? 0,
        replicas: status.currentReplicas || 0,
        age: ageOf(meta.creationTimestamp),
      };
    }
    case 'nodes': {
      const conditions = item.status?.conditions || [];
      const readyCond = conditions.find((c) => c.type === 'Ready');
      const roles = Object.keys(meta.labels || {})
        .filter((l) => l.startsWith('node-role.kubernetes.io/'))
        .map((l) => l.replace('node-role.kubernetes.io/', ''));
      return {
        ...base,
        name: meta.name,
        status: readyCond && readyCond.status === 'True' ? 'Ready' : 'NotReady',
        roles: roles.length ? roles.join(',') : '<none>',
        version: item.status?.nodeInfo?.kubeletVersion || '',
        age: ageOf(meta.creationTimestamp),
        unschedulable: !!item.spec?.unschedulable,
      };
    }
    case 'pvs': {
      const spec = item.spec || {};
      const status = item.status || {};
      return {
        ...base,
        name: meta.name,
        capacity: spec.capacity?.storage || '',
        status: status.phase || '',
        claim: spec.claimRef ? `${spec.claimRef.namespace}/${spec.claimRef.name}` : '',
        storageClass: spec.storageClassName || '',
        age: ageOf(meta.creationTimestamp),
      };
    }
    case 'namespaces': {
      return { ...base, name: meta.name, status: item.status?.phase || '', age: ageOf(meta.creationTimestamp) };
    }
    case 'events': {
      return {
        ...base,
        name: meta.name,
        type: item.type || '',
        reason: item.reason || '',
        object: item.involvedObject ? `${item.involvedObject.kind}/${item.involvedObject.name}` : '',
        message: item.message || '',
        age: ageOf(item.lastTimestamp || item.eventTime || meta.creationTimestamp),
      };
    }
    case 'serviceaccounts':
      return { ...base, name: meta.name, secrets: (item.secrets || []).length, age: ageOf(meta.creationTimestamp) };
    case 'roles':
      return { ...base, name: meta.name, rules: (item.rules || []).length, age: ageOf(meta.creationTimestamp) };
    case 'rolebindings':
      return {
        ...base, name: meta.name,
        role: item.roleRef ? `${item.roleRef.kind}/${item.roleRef.name}` : '',
        subjects: (item.subjects || []).length,
        age: ageOf(meta.creationTimestamp),
      };
    case 'clusterroles':
      return { ...base, name: meta.name, rules: (item.rules || []).length, age: ageOf(meta.creationTimestamp) };
    case 'clusterrolebindings':
      return {
        ...base, name: meta.name,
        role: item.roleRef ? `${item.roleRef.kind}/${item.roleRef.name}` : '',
        subjects: (item.subjects || []).length,
        age: ageOf(meta.creationTimestamp),
      };
    case 'networkpolicies': {
      const spec = item.spec || {};
      return {
        ...base,
        name: meta.name,
        podSelector: (spec.podSelector && Object.keys(spec.podSelector.matchLabels || {}).length)
          ? JSON.stringify(spec.podSelector.matchLabels) : '<all pods>',
        policyTypes: (spec.policyTypes || []).join(', '),
        ingressRules: (spec.ingress || []).length,
        egressRules: (spec.egress || []).length,
        age: ageOf(meta.creationTimestamp),
      };
    }
    case 'storageclasses':
      return {
        ...base,
        name: meta.name,
        provisioner: item.provisioner || '',
        reclaimPolicy: item.reclaimPolicy || '',
        volumeBindingMode: item.volumeBindingMode || '',
        isDefault: (meta.annotations || {})['storageclass.kubernetes.io/is-default-class'] === 'true',
        age: ageOf(meta.creationTimestamp),
      };
    case 'resourcequotas': {
      const hard = item.status?.hard || {};
      const used = item.status?.used || {};
      return {
        ...base,
        name: meta.name,
        summary: Object.keys(hard).map((k) => `${k}: ${used[k] ?? '0'}/${hard[k]}`).join(', '),
        age: ageOf(meta.creationTimestamp),
      };
    }
    case 'limitranges':
      return {
        ...base,
        name: meta.name,
        limits: (item.spec?.limits || []).map((l) => l.type).join(', '),
        age: ageOf(meta.creationTimestamp),
      };
    default:
      return { ...base, name: meta.name, age: ageOf(meta.creationTimestamp) };
  }
}

/**
 * Redacts secret data values.
 * @param {object} obj 
 * @returns {object}
 */
function redactSecretData(obj) {
  if (!obj || !obj.data) return obj;
  const redacted = {};
  for (const k of Object.keys(obj.data)) redacted[k] = '***REDACTED***';
  return { ...obj, data: redacted };
}

/**
 * Cleans object metadata for recreate actions.
 * @param {object} parsed 
 * @returns {object}
 */
function stripForRecreate(parsed) {
  if (parsed.metadata) {
    delete parsed.metadata.resourceVersion;
    delete parsed.metadata.uid;
    delete parsed.metadata.creationTimestamp;
    delete parsed.metadata.generation;
    delete parsed.metadata.managedFields;
    delete parsed.metadata.selfLink;
    delete parsed.metadata.ownerReferences;
    if (parsed.metadata.annotations) {
      delete parsed.metadata.annotations['k8senvdiff-edit-resource-version'];
      delete parsed.metadata.annotations['kubectl.kubernetes.io/last-applied-configuration'];
    }
  }
  delete parsed.status;
  return parsed;
}

/**
 * Deduplicates warning events for cluster overview.
 * @param {Array<object>} items 
 * @param {number} limit 
 * @returns {Array<object>}
 */
function dedupeEvents(items, limit) {
  const byKey = new Map();
  for (const item of items) {
    if (item.type !== 'Warning') continue;
    const obj = item.involvedObject || {};
    const key = `${obj.namespace || ''}/${obj.kind || ''}/${obj.name || ''}/${item.reason || ''}`;
    const ts = item.lastTimestamp || item.eventTime || item.metadata?.creationTimestamp;
    const existing = byKey.get(key);
    if (!existing || new Date(ts || 0) > new Date(existing._ts || 0)) {
      byKey.set(key, {
        namespace: obj.namespace || '',
        object: obj.kind ? `${obj.kind}/${obj.name}` : '',
        reason: item.reason || '',
        message: item.message || '',
        count: item.count || 1,
        _ts: ts,
      });
    }
  }
  return Array.from(byKey.values())
    .sort((a, b) => new Date(b._ts || 0) - new Date(a._ts || 0))
    .slice(0, limit)
    .map(({ _ts, ...rest }) => ({ ...rest, age: ageOf(_ts) }));
}

module.exports = {
  ageOf,
  podStatus,
  projectRow,
  redactSecretData,
  stripForRecreate,
  dedupeEvents,
};
