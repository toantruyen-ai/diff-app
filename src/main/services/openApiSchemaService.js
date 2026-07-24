const schemaCache = new Map();

function findRootSchemaName(schemas, apiVersion, kind) {
  if (!schemas || typeof schemas !== 'object' || !apiVersion || !kind) return null;

  const [group, version] = apiVersion.includes('/')
    ? apiVersion.split('/')
    : ['', apiVersion];

  for (const [name, s] of Object.entries(schemas)) {
    const gvks = s['x-kubernetes-group-version-kind'];
    if (Array.isArray(gvks)) {
      const match = gvks.some(
        (g) => (g.group || '') === group && g.version === version && g.kind === kind
      );
      if (match) return name;
    }
  }
  return null;
}

function resolveSchemaListMeta(schemas, rootSchemaName, path) {
  if (!schemas || !rootSchemaName || !Array.isArray(path) || path.length === 0) {
    return null;
  }

  let currName = rootSchemaName;

  for (let i = 0; i < path.length; i++) {
    const seg = path[i];
    const currSchema = schemas[currName];
    if (!currSchema) return null;

    let props = currSchema.properties;
    if (!props && currSchema.items) {
      if (currSchema.items.$ref) {
        const refName = currSchema.items.$ref.replace('#/components/schemas/', '');
        props = schemas[refName]?.properties;
      }
    }
    if (!props) return null;

    const cleanSeg = seg.includes('=') ? seg.split('=')[0] : seg;
    const propSchema = props[cleanSeg];

    if (!propSchema) return null;

    if (i === path.length - 1) {
      const listType = propSchema['x-kubernetes-list-type'];
      const mapKeys = propSchema['x-kubernetes-list-map-keys'];
      if (listType) {
        return {
          type: listType,
          keys: Array.isArray(mapKeys) ? mapKeys : undefined,
        };
      }
    }

    if (propSchema.$ref) {
      currName = propSchema.$ref.replace('#/components/schemas/', '');
    } else if (propSchema.items?.$ref) {
      currName = propSchema.items.$ref.replace('#/components/schemas/', '');
    }
  }

  return null;
}

function cacheGvkSchema(cacheKey, schema) {
  schemaCache.set(cacheKey, { schema, timestamp: Date.now() });
}

function getCachedGvkSchema(cacheKey) {
  const cached = schemaCache.get(cacheKey);
  if (!cached) return null;
  if (Date.now() - cached.timestamp > 10 * 60 * 1000) { // 10m TTL
    schemaCache.delete(cacheKey);
    return null;
  }
  return cached.schema;
}

module.exports = {
  findRootSchemaName,
  resolveSchemaListMeta,
  cacheGvkSchema,
  getCachedGvkSchema,
};
