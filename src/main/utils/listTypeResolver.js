const FALLBACK_LIST_META = {
  containers: { type: 'map', keys: ['name'] },
  initContainers: { type: 'map', keys: ['name'] },
  ephemeralContainers: { type: 'map', keys: ['name'] },
  volumes: { type: 'map', keys: ['name'] },
  volumeMounts: { type: 'map', keys: ['mountPath'] },
  volumeDevices: { type: 'map', keys: ['devicePath'] },
  env: { type: 'map', keys: ['name'] },
  ports: { type: 'map', keys: ['containerPort', 'protocol'] },
  imagePullSecrets: { type: 'map', keys: ['name'] },
  tolerations: { type: 'map', keys: ['key', 'operator', 'effect'] },
  topologySpreadConstraints: { type: 'map', keys: ['topologyKey', 'whenUnsatisfiable'] },
  finalizers: { type: 'set' },
  command: { type: 'atomic' },
  args: { type: 'atomic' },
  rules: { type: 'atomic' },
};

function resolveListMeta(path) {
  if (!Array.isArray(path) || path.length === 0) {
    return { type: 'atomic' };
  }
  const lastKey = path[path.length - 1];
  if (FALLBACK_LIST_META[lastKey]) {
    return FALLBACK_LIST_META[lastKey];
  }
  return { type: 'atomic' };
}

module.exports = {
  resolveListMeta,
  FALLBACK_LIST_META,
};
