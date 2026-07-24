import { describe, it, expect } from 'vitest';
import {
  ageOf,
  podStatus,
  projectRow,
  redactSecretData,
  stripForRecreate,
  dedupeEvents,
} from '../../../../src/main/utils/resourceFormatter.js';

describe('resourceFormatter', () => {
  it('ageOf formats valid timestamps', () => {
    const iso = '2026-07-24T00:00:00.000Z';
    expect(ageOf(iso)).toBe(iso);
    expect(ageOf(null)).toBe(null);
  });

  it('podStatus resolves waiting reason, bad terminated, or phase', () => {
    expect(podStatus({
      status: {
        containerStatuses: [{ state: { waiting: { reason: 'CrashLoopBackOff' } } }],
      },
    })).toBe('CrashLoopBackOff');

    expect(podStatus({
      status: {
        phase: 'Running',
        containerStatuses: [{ state: { running: {} } }],
      },
    })).toBe('Running');
  });

  it('projectRow projects pods and deployments into concise rows', () => {
    const pod = {
      metadata: { name: 'test-pod', namespace: 'default', creationTimestamp: '2026-01-01T00:00:00.000Z' },
      status: { phase: 'Running', containerStatuses: [{ ready: true, restartCount: 2 }] },
      spec: { nodeName: 'node-1', containers: [{ name: 'app' }] },
    };
    const projectedPod = projectRow('pods', pod);
    expect(projectedPod.name).toBe('test-pod');
    expect(projectedPod.ready).toBe('1/1');
    expect(projectedPod.restarts).toBe(2);
    expect(projectedPod.node).toBe('node-1');

    const dep = {
      metadata: { name: 'test-dep', namespace: 'prod' },
      spec: { replicas: 3 },
      status: { readyReplicas: 3, updatedReplicas: 3, availableReplicas: 3 },
    };
    const projectedDep = projectRow('deployments', dep);
    expect(projectedDep.name).toBe('test-dep');
    expect(projectedDep.ready).toBe('3/3');
  });

  it('redactSecretData replaces data values with placeholder', () => {
    const secret = { metadata: { name: 'my-secret' }, data: { key1: 'c2VjcmV0', key2: 'dmFsdWU=' } };
    const redacted = redactSecretData(secret);
    expect(redacted.data.key1).toBe('***REDACTED***');
    expect(redacted.data.key2).toBe('***REDACTED***');
  });

  it('stripForRecreate removes transient Kubernetes metadata', () => {
    const obj = {
      metadata: { name: 'my-pod', resourceVersion: '123', uid: 'abc', annotations: { 'k8senvdiff-edit-resource-version': '123' } },
      status: { phase: 'Failed' },
    };
    const cleaned = stripForRecreate(obj);
    expect(cleaned.metadata.resourceVersion).toBeUndefined();
    expect(cleaned.metadata.uid).toBeUndefined();
    expect(cleaned.status).toBeUndefined();
  });

  it('dedupeEvents deduplicates Warning events and limits results', () => {
    const events = [
      { type: 'Warning', involvedObject: { kind: 'Pod', name: 'p1', namespace: 'default' }, reason: 'OOMKilled', count: 1, lastTimestamp: '2026-07-24T08:00:00Z' },
      { type: 'Warning', involvedObject: { kind: 'Pod', name: 'p1', namespace: 'default' }, reason: 'OOMKilled', count: 2, lastTimestamp: '2026-07-24T08:05:00Z' },
      { type: 'Normal', involvedObject: { kind: 'Pod', name: 'p1', namespace: 'default' }, reason: 'Scheduled' },
    ];
    const deduped = dedupeEvents(events, 10);
    expect(deduped).toHaveLength(1);
    expect(deduped[0].count).toBe(2);
    expect(deduped[0].reason).toBe('OOMKilled');
  });
});
