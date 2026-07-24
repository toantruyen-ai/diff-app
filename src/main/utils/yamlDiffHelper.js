const { normalizeYamlObject } = require('./yamlNormalizer');
const { resolveListMeta } = require('./listTypeResolver');

function hasPath(obj, path) {
  if (!obj || typeof obj !== 'object') return false;
  let curr = obj;
  for (const seg of path) {
    if (curr === null || curr === undefined || typeof curr !== 'object') return false;
    if (Array.isArray(curr)) {
      if (typeof seg === 'string' && seg.includes('=')) {
        const parts = seg.split(',');
        curr = curr.find((item) => {
          if (!item || typeof item !== 'object') return false;
          return parts.every((p) => {
            const [k, v] = p.split('=');
            return String(item[k]) === v;
          });
        });
      } else {
        const idx = parseInt(seg, 10);
        if (isNaN(idx) || idx < 0 || idx >= curr.length) return false;
        curr = curr[idx];
      }
    } else if (typeof curr === 'object' && seg in curr) {
      curr = curr[seg];
    } else {
      return false;
    }
  }
  return curr !== undefined;
}

function stableKey(item) {
  if (item === null || item === undefined) return '';
  if (typeof item !== 'object') return String(item);
  return JSON.stringify(item);
}

function diffValues(before, after, path, out) {
  if (before === after) return;

  const bObj = (before && typeof before === 'object') ? before : null;
  const aObj = (after && typeof after === 'object') ? after : null;

  if (Array.isArray(before) || Array.isArray(after)) {
    const bArr = Array.isArray(before) ? before : [];
    const aArr = Array.isArray(after) ? after : [];
    diffArrays(bArr, aArr, path, out);
    return;
  }

  if (bObj || aObj) {
    const bMap = bObj || {};
    const aMap = aObj || {};
    const keys = new Set([...Object.keys(bMap), ...Object.keys(aMap)]);
    for (const key of keys) {
      diffValues(bMap[key], aMap[key], [...path, key], out);
    }
    return;
  }

  if (before === undefined && after !== undefined) {
    out.push({ path, kind: 'add', after, source: 'unknown' });
    return;
  }
  if (before !== undefined && after === undefined) {
    out.push({ path, kind: 'remove', before, source: 'unknown' });
    return;
  }

  out.push({ path, kind: 'change', before, after, source: 'unknown' });
}

function diffArrays(before, after, path, out) {
  const meta = resolveListMeta(path);

  if (meta.type === 'atomic') {
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      out.push({ path, kind: 'change', before, after, source: 'unknown' });
    }
    return;
  }

  if (meta.type === 'set') {
    const bSet = new Set(before.map(stableKey));
    const aSet = new Set(after.map(stableKey));
    for (const el of after) {
      if (!bSet.has(stableKey(el))) {
        out.push({ path: [...path, `~${stableKey(el)}`], kind: 'add', after: el, source: 'unknown' });
      }
    }
    for (const el of before) {
      if (!aSet.has(stableKey(el))) {
        out.push({ path: [...path, `~${stableKey(el)}`], kind: 'remove', before: el, source: 'unknown' });
      }
    }
    return;
  }

  // map: match by merge-keys
  const keyOf = (el) => (meta.keys || ['name']).map((k) => `${k}=${el?.[k]}`).join(',');
  const bById = new Map();
  const aById = new Map();

  for (const el of before) bById.set(keyOf(el), el);
  for (const el of after) aById.set(keyOf(el), el);

  const allKeys = new Set([...bById.keys(), ...aById.keys()]);
  for (const id of allKeys) {
    const bEl = bById.get(id);
    const aEl = aById.get(id);
    if (bEl && !aEl) {
      out.push({ path: [...path, id], kind: 'remove', before: bEl, source: 'unknown' });
    } else if (!bEl && aEl) {
      out.push({ path: [...path, id], kind: 'add', after: aEl, source: 'unknown' });
    } else if (bEl && aEl) {
      diffValues(bEl, aEl, [...path, id], out);
    }
  }
}

function attributeSources(ops, userManifest) {
  const normUser = normalizeYamlObject(userManifest);
  return ops.map((op) => {
    const isDeclared = hasPath(normUser, op.path);
    return { ...op, source: isDeclared ? 'user' : 'server' };
  });
}

function computeStructuredDiff(live, dryRun, userManifest) {
  const normLive = normalizeYamlObject(live);
  const normDryRun = normalizeYamlObject(dryRun);
  const rawOps = [];

  diffValues(normLive || {}, normDryRun || {}, [], rawOps);
  return attributeSources(rawOps, userManifest);
}

module.exports = {
  computeStructuredDiff,
  attributeSources,
  diffValues,
};
