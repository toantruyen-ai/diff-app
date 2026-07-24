import { describe, it, expect } from 'vitest';
import { computeStructuredDiff } from '../../../../src/main/utils/yamlDiffHelper.js';

describe('yamlDiffHelper', () => {
  it('computes diff when creating a new resource (live is null)', () => {
    const dryRun = {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: { name: 'my-pod' },
      spec: { containers: [{ name: 'app', image: 'nginx:1.25' }] },
    };
    const userManifest = {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: { name: 'my-pod' },
      spec: { containers: [{ name: 'app', image: 'nginx:1.25' }] },
    };

    const diffs = computeStructuredDiff(null, dryRun, userManifest);
    expect(diffs.length).toBeGreaterThan(0);
    const containerDiff = diffs.find((d) => d.path.join('.').includes('containers'));
    expect(containerDiff).toBeDefined();
    expect(containerDiff.kind).toBe('add');
    expect(containerDiff.source).toBe('user');
  });

  it('computes diffs between live and dryRun, attributing user vs server changes', () => {
    const live = {
      metadata: { name: 'app-deploy' },
      spec: {
        replicas: 2,
        template: {
          spec: {
            containers: [
              { name: 'app', image: 'nginx:1.21' },
            ],
          },
        },
      },
    };

    const dryRun = {
      metadata: { name: 'app-deploy' },
      spec: {
        replicas: 3,
        template: {
          spec: {
            containers: [
              { name: 'app', image: 'nginx:1.25', imagePullPolicy: 'Always' },
            ],
          },
        },
      },
    };

    // User only updated replicas and image, not imagePullPolicy
    const userManifest = {
      metadata: { name: 'app-deploy' },
      spec: {
        replicas: 3,
        template: {
          spec: {
            containers: [
              { name: 'app', image: 'nginx:1.25' },
            ],
          },
        },
      },
    };

    const diffs = computeStructuredDiff(live, dryRun, userManifest);

    const replicasDiff = diffs.find((d) => d.path.includes('replicas'));
    expect(replicasDiff).toBeDefined();
    expect(replicasDiff.kind).toBe('change');
    expect(replicasDiff.before).toBe(2);
    expect(replicasDiff.after).toBe(3);
    expect(replicasDiff.source).toBe('user');

    const imageDiff = diffs.find((d) => d.path.includes('image'));
    expect(imageDiff).toBeDefined();
    expect(imageDiff.before).toBe('nginx:1.21');
    expect(imageDiff.after).toBe('nginx:1.25');
    expect(imageDiff.source).toBe('user');

    const policyDiff = diffs.find((d) => d.path.includes('imagePullPolicy'));
    expect(policyDiff).toBeDefined();
    expect(policyDiff.kind).toBe('add');
    expect(policyDiff.after).toBe('Always');
    expect(policyDiff.source).toBe('server');
  });
});
