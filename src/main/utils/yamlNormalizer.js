const NOISE_METADATA_KEYS = [
  'managedFields',
  'resourceVersion',
  'uid',
  'generation',
  'creationTimestamp',
  'selfLink',
];

function normalizeYamlObject(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const o = structuredClone(obj);
  if (o.metadata && typeof o.metadata === 'object') {
    for (const key of NOISE_METADATA_KEYS) {
      delete o.metadata[key];
    }
    if (o.metadata.annotations && typeof o.metadata.annotations === 'object') {
      delete o.metadata.annotations['kubectl.kubernetes.io/last-applied-configuration'];
      if (Object.keys(o.metadata.annotations).length === 0) {
        delete o.metadata.annotations;
      }
    }
  }
  delete o.status;
  return o;
}

module.exports = {
  normalizeYamlObject,
};
