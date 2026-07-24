const k8s = require('@kubernetes/client-node');
const { hasAksKc, touchAksKc } = require('../services/kubeconfigStoreService');

function isKubeconfigContent(str) {
  if (typeof str !== 'string') return false;
  const s = str.replace(/^﻿/, '').trimStart();
  return s.startsWith('apiVersion:') || s.startsWith('---');
}

function buildKubeConfig(ref, contextName) {
  const kc = new k8s.KubeConfig();
  if (!ref) {
    kc.loadFromDefault();
  } else if (hasAksKc(ref)) {
    kc.loadFromString(touchAksKc(ref));
  } else if (isKubeconfigContent(ref)) {
    kc.loadFromString(ref.replace(/^﻿/, '').trimStart());
  } else {
    kc.loadFromFile(ref);
  }

  if (contextName) {
    const exists = kc.getContexts().some((ctx) => ctx.name === contextName);
    if (exists) kc.setCurrentContext(contextName);
  }

  const execAuth = kc.authenticators && kc.authenticators.find(
    (a) => a.constructor && a.constructor.name === 'ExecAuth'
  );
  if (execAuth && execAuth.execFn) {
    const origExecFn = execAuth.execFn;
    execAuth.execFn = (command, args, opts) => {
      const result = origExecFn(command, args, { ...opts, timeout: 15000 });
      if (result.error && result.error.code === 'ETIMEDOUT') {
        return {
          status: 1,
          stdout: Buffer.from(''),
          stderr: Buffer.from(
            'kubelogin timed out after 15s — token may be expired. Run: kubelogin convert-kubeconfig -l azurecli'
          ),
          signal: result.signal,
        };
      }
      return result;
    };
  }

  return kc;
}

function makeManageApiClients(kc) {
  return {
    core: kc.makeApiClient(k8s.CoreV1Api),
    apps: kc.makeApiClient(k8s.AppsV1Api),
    batch: kc.makeApiClient(k8s.BatchV1Api),
    networking: kc.makeApiClient(k8s.NetworkingV1Api),
    autoscaling: kc.makeApiClient(k8s.AutoscalingV2Api),
    rbac: kc.makeApiClient(k8s.RbacAuthorizationV1Api),
    storage: kc.makeApiClient(k8s.StorageV1Api),
  };
}

const _apiClientCache = new Map();
const _apiClientCacheTTL = 5 * 60 * 1000; // 5 minutes

function getCachedApiClients(ref, contextName) {
  const cacheKey = `${ref || '__default__'}::${contextName || ''}`;
  const cached = _apiClientCache.get(cacheKey);
  if (cached && (Date.now() - cached.ts) < _apiClientCacheTTL) {
    return cached;
  }
  const kc = buildKubeConfig(ref, contextName);
  const apis = makeManageApiClients(kc);
  const metricsApi = new k8s.Metrics(kc);
  const entry = { kc, apis, metricsApi, ts: Date.now() };
  _apiClientCache.set(cacheKey, entry);
  return entry;
}

function clearApiClientCache() {
  _apiClientCache.clear();
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

module.exports = {
  isKubeconfigContent,
  buildKubeConfig,
  makeManageApiClients,
  getCachedApiClients,
  clearApiClientCache,
  extractK8sErrorMessage,
};
