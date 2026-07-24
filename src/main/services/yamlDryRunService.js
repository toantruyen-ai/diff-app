const k8s = require('@kubernetes/client-node');
const { withTimeout } = require('../utils/timeout');
const { buildKubeConfig } = require('../utils/k8sHelper');
const { computeStructuredDiff } = require('../utils/yamlDiffHelper');
const { parseSsaConflicts } = require('../utils/yamlConflictParser');
const { splitYamlDocs, sortDocsForApply, KIND_APPLY_ORDER } = require('../utils/yamlMultiDocHelper');

const FIELD_MANAGER = 'k8s-env-diff';
const APPLY_PATCH_HEADERS = { headers: { 'Content-Type': 'application/apply-patch+yaml' } };

function getObjApi(ref, contextName) {
  const kc = buildKubeConfig(ref, contextName);
  return k8s.KubernetesObjectApi.makeApiClient(kc);
}

function extractK8sErrorMessage(e) {
  if (!e) return 'Unknown error';

  const body = e.body || e.response?.body;
  if (body) {
    if (typeof body === 'object' && body.message) {
      return body.message;
    }
    if (typeof body === 'string') {
      try {
        const parsed = JSON.parse(body);
        if (parsed && parsed.message) return parsed.message;
      } catch (_) {
        if (body.trim()) return body;
      }
    }
  }

  if (e.message && e.message !== 'HTTP request failed') {
    return e.message;
  }

  const status = e.statusCode || e.response?.statusCode;
  const statusText = e.response?.statusMessage;
  if (status && statusText) {
    return `HTTP ${status} ${statusText}`;
  } else if (status) {
    return `HTTP ${status}`;
  }

  return e.message || String(e);
}

async function dryRunApply(ref, contextName, manifestYaml, injectObjApi = null) {
  let spec;
  try {
    spec = k8s.loadYaml(manifestYaml);
  } catch (e) {
    return { ok: false, error: `YAML parse error: ${e.message}`, kind: 'parse' };
  }
  if (!spec || typeof spec !== 'object' || Array.isArray(spec) || !spec.kind || !spec.metadata?.name) {
    return { ok: false, error: 'Expected a single valid K8s manifest object', kind: 'parse' };
  }

  try {
    const objApi = injectObjApi || getObjApi(ref, contextName);

    let live = null;
    try {
      const readRes = await withTimeout(objApi.read(spec), 15000, 'Timed out reading live object');
      live = readRes.body || readRes;
    } catch (e) {
      if (e?.statusCode !== 404 && e?.response?.statusCode !== 404) {
        // Proceed with live=null if not found, else log/catch
      }
    }

    const patchRes = await withTimeout(
      objApi.patch(spec, undefined, 'All', FIELD_MANAGER, false, APPLY_PATCH_HEADERS),
      30000,
      'Timed out performing dry-run SSA'
    );

    const dryRun = patchRes.body || patchRes;
    const diffs = computeStructuredDiff(live, dryRun, spec);

    return {
      ok: true,
      live,
      dryRun,
      diffs,
    };
  } catch (e) {
    const status = e?.statusCode || e?.response?.statusCode;
    if (status === 409) {
      return {
        ok: false,
        kind: 'conflict',
        status: 409,
        error: 'Apply conflict detected',
        conflicts: parseSsaConflicts(e?.body || e?.response?.body),
      };
    }
    return { ok: false, kind: 'error', error: extractK8sErrorMessage(e) };
  }
}

async function applySsa(ref, contextName, manifestYaml, force = false, injectObjApi = null) {
  let spec;
  try {
    spec = k8s.loadYaml(manifestYaml);
  } catch (e) {
    return { ok: false, error: `YAML parse error: ${e.message}`, kind: 'parse' };
  }
  if (!spec || typeof spec !== 'object' || Array.isArray(spec) || !spec.kind || !spec.metadata?.name) {
    return { ok: false, error: 'Expected a single valid K8s manifest object', kind: 'parse' };
  }

  try {
    const objApi = injectObjApi || getObjApi(ref, contextName);
    const patchRes = await withTimeout(
      objApi.patch(spec, undefined, undefined, FIELD_MANAGER, force, APPLY_PATCH_HEADERS),
      30000,
      'Timed out applying SSA'
    );
    const applied = patchRes.body || patchRes;
    return { ok: true, applied };
  } catch (e) {
    const status = e?.statusCode || e?.response?.statusCode;
    if (status === 409) {
      return {
        ok: false,
        kind: 'conflict',
        status: 409,
        error: 'Apply conflict detected',
        conflicts: parseSsaConflicts(e?.body || e?.response?.body),
      };
    }
    return { ok: false, kind: 'error', error: extractK8sErrorMessage(e) };
  }
}

async function dryRunBatch(ref, contextName, manifestYaml, injectObjApi = null) {
  const docs = splitYamlDocs(manifestYaml);
  if (docs.length === 0) {
    return { ok: false, error: 'No valid YAML documents found in batch', results: [] };
  }

  const results = [];
  let allOk = true;

  for (let i = 0; i < docs.length; i++) {
    const item = docs[i];
    const res = await dryRunApply(ref, contextName, item.text, injectObjApi);
    if (!res.ok) allOk = false;
    results.push({
      index: i,
      kind: item.doc?.kind,
      name: item.doc?.metadata?.name,
      result: res,
    });
  }

  return { ok: allOk, results };
}

async function applyBatch(ref, contextName, manifestYaml, force = false, injectObjApi = null) {
  const docs = splitYamlDocs(manifestYaml);
  if (docs.length === 0) {
    return { ok: false, error: 'No valid YAML documents found in batch', results: [] };
  }

  const sortedDocs = sortDocsForApply(docs);
  const results = [];
  let allOk = true;

  for (let i = 0; i < sortedDocs.length; i++) {
    const item = sortedDocs[i];
    const res = await applySsa(ref, contextName, item.text, force, injectObjApi);
    if (!res.ok) allOk = false;
    results.push({
      index: i,
      kind: item.doc?.kind,
      name: item.doc?.metadata?.name,
      result: res,
    });
  }

  return { ok: allOk, results };
}

module.exports = {
  dryRunApply,
  applySsa,
  dryRunBatch,
  applyBatch,
  sortDocsForApply,
  FIELD_MANAGER,
};

