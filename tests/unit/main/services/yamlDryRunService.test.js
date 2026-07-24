import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const k8s = require('@kubernetes/client-node');

const {
  dryRunApply,
  applySsa,
  dryRunBatch,
  applyBatch,
  sortDocsForApply,
} = await import('../../../../src/main/services/yamlDryRunService.js');

describe('yamlDryRunService', () => {
  it('sorts multi-doc resources by Kubernetes dependency order', () => {
    const docs = [
      { kind: 'Deployment', metadata: { name: 'web' } },
      { kind: 'Namespace', metadata: { name: 'prod' } },
      { kind: 'ConfigMap', metadata: { name: 'web-config' } },
      { kind: 'Service', metadata: { name: 'web-svc' } },
    ];
    const sorted = sortDocsForApply(docs);
    expect(sorted.map((d) => d.kind)).toEqual([
      'Namespace',
      'ConfigMap',
      'Service',
      'Deployment',
    ]);
  });

  it('dryRunApply rejects invalid or multi-doc YAML in single mode', async () => {
    const res = await dryRunApply('ref1', 'ctx1', 'invalid: yaml: [');
    expect(res.ok).toBe(false);
    expect(res.kind).toBe('parse');
  });

  it('dryRunApply performs SSA dry-run and returns structured diff', async () => {
    const mockObjApi = {
      read: vi.fn().mockResolvedValue({
        apiVersion: 'v1',
        kind: 'ConfigMap',
        metadata: { name: 'my-config', namespace: 'default' },
        data: { key1: 'value1' },
      }),
      patch: vi.fn().mockResolvedValue({
        body: {
          apiVersion: 'v1',
          kind: 'ConfigMap',
          metadata: { name: 'my-config', namespace: 'default' },
          data: { key1: 'value1', key2: 'value2' },
        },
      }),
    };

    const yamlText = `
apiVersion: v1
kind: ConfigMap
metadata:
  name: my-config
  namespace: default
data:
  key1: value1
  key2: value2
`;

    const res = await dryRunApply('ref1', 'ctx1', yamlText, mockObjApi);
    expect(res.ok).toBe(true);
    expect(res.dryRun).toBeDefined();
    expect(res.diffs).toBeDefined();
    expect(mockObjApi.patch).toHaveBeenCalledWith(
      expect.anything(),
      undefined,
      'All',
      'k8s-env-diff',
      false,
      expect.objectContaining({
        headers: { 'Content-Type': 'application/apply-patch+yaml' },
      })
    );
  });

  it('applySsa performs real SSA patch with same fieldManager', async () => {
    const mockObjApi = {
      patch: vi.fn().mockResolvedValue({
        body: {
          apiVersion: 'v1',
          kind: 'ConfigMap',
          metadata: { name: 'my-config', namespace: 'default' },
          data: { key1: 'value1' },
        },
      }),
    };

    const yamlText = `
apiVersion: v1
kind: ConfigMap
metadata:
  name: my-config
  namespace: default
data:
  key1: value1
`;

    const res = await applySsa('ref1', 'ctx1', yamlText, false, mockObjApi);
    expect(res.ok).toBe(true);
    expect(mockObjApi.patch).toHaveBeenCalledWith(
      expect.anything(),
      undefined,
      undefined,
      'k8s-env-diff',
      false,
      expect.objectContaining({
        headers: { 'Content-Type': 'application/apply-patch+yaml' },
      })
    );
  });

  it('dryRunBatch processes all documents in multi-doc YAML', async () => {
    const mockObjApi = {
      read: vi.fn().mockResolvedValue({}),
      patch: vi.fn().mockResolvedValue({ body: {} }),
    };

    const multiDoc = `
apiVersion: v1
kind: Namespace
metadata:
  name: prod
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: app-cfg
`;

    const res = await dryRunBatch('ref1', 'ctx1', multiDoc, mockObjApi);
    expect(res.ok).toBe(true);
    expect(res.results.length).toBe(2);
  });

  it('builds KubeConfig using buildKubeConfig when injectObjApi is not provided', async () => {
    const { storeAksKc } = require('../../../../src/main/services/kubeconfigStoreService');
    const dummyKc = `
apiVersion: v1
clusters: []
contexts: []
current-context: ""
kind: Config
preferences: {}
users: []
`;
    const ref = storeAksKc(dummyKc);
    const yamlText = `
apiVersion: v1
kind: ConfigMap
metadata:
  name: my-config
  namespace: default
data:
  key1: value1
`;
    const res = await dryRunApply(ref, '', yamlText);
    expect(res.ok).toBe(false);
    expect(res.error).not.toContain('getKubeConfig is not a function');
  });

  it('extracts detailed K8s API error message instead of generic "HTTP request failed"', async () => {
    const mockObjApi = {
      read: vi.fn().mockResolvedValue({}),
      patch: vi.fn().mockRejectedValue({
        message: 'HTTP request failed',
        statusCode: 422,
        body: {
          kind: 'Status',
          status: 'Failure',
          message: 'admission webhook "validate.k8s.io" denied the request: invalid port number',
        },
      }),
    };

    const yamlText = `
apiVersion: v1
kind: ConfigMap
metadata:
  name: my-config
  namespace: default
`;

    const res = await dryRunApply('ref1', 'ctx1', yamlText, mockObjApi);
    expect(res.ok).toBe(false);
    expect(res.error).toBe('admission webhook "validate.k8s.io" denied the request: invalid port number');
  });
});



