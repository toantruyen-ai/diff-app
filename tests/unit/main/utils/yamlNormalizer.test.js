import { describe, it, expect } from 'vitest';
import { normalizeYamlObject } from '../../../../src/main/utils/yamlNormalizer.js';

describe('yamlNormalizer', () => {
  it('returns null for null/falsy inputs', () => {
    expect(normalizeYamlObject(null)).toBeNull();
    expect(normalizeYamlObject(undefined)).toBeNull();
  });

  it('strips metadata noise fields and status block', () => {
    const input = {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: {
        name: 'test-pod',
        namespace: 'default',
        resourceVersion: '12345',
        uid: 'abc-123',
        generation: 1,
        creationTimestamp: '2026-01-01T00:00:00Z',
        managedFields: [{ manager: 'kubectl' }],
        selfLink: '/api/v1/namespaces/default/pods/test-pod',
        annotations: {
          'kubectl.kubernetes.io/last-applied-configuration': '{"foo":"bar"}',
          'app.custom/label': 'keep-me',
        },
      },
      spec: { containers: [{ name: 'app', image: 'nginx' }] },
      status: { phase: 'Running' },
    };

    const normalized = normalizeYamlObject(input);
    expect(normalized).toEqual({
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: {
        name: 'test-pod',
        namespace: 'default',
        annotations: {
          'app.custom/label': 'keep-me',
        },
      },
      spec: { containers: [{ name: 'app', image: 'nginx' }] },
    });
    expect(normalized.status).toBeUndefined();
    expect(normalized.metadata.resourceVersion).toBeUndefined();
    expect(normalized.metadata.managedFields).toBeUndefined();
  });

  it('removes annotations property if it becomes empty after stripping last-applied-configuration', () => {
    const input = {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: {
        name: 'test-svc',
        annotations: {
          'kubectl.kubernetes.io/last-applied-configuration': '{}',
        },
      },
    };

    const normalized = normalizeYamlObject(input);
    expect(normalized.metadata.annotations).toBeUndefined();
  });
});
