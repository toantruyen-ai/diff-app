import { describe, it, expect, vi } from 'vitest';
import { computeDesiredStreams, reconcileStreams } from '../../../../src/main/services/multiPodLogReconciler.js';

describe('multiPodLogReconciler', () => {
  it('computes desired stream set only for running containers', () => {
    const podList = [
      {
        metadata: { name: 'pod-a' },
        status: {
          containerStatuses: [
            { name: 'app', state: { running: { startedAt: '2026-07-24T12:00:00Z' } } },
            { name: 'sidecar', state: { waiting: { reason: 'ContainerCreating' } } },
          ],
        },
      },
      {
        metadata: { name: 'pod-b' },
        status: {
          containerStatuses: [
            { name: 'app', state: { running: { startedAt: '2026-07-24T12:00:00Z' } } },
          ],
        },
      },
    ];

    const desired = computeDesiredStreams(podList);
    expect(desired.has('pod-a/app')).toBe(true);
    expect(desired.has('pod-a/sidecar')).toBe(false);
    expect(desired.has('pod-b/app')).toBe(true);
  });

  it('reconciles streams opening missing ones and closing extra ones', () => {
    const opened = [];
    const closed = [];
    const streamManager = {
      getTopologySnapshot: () => [{ streamKey: 'pod-old/app', pod: 'pod-old', container: 'app' }],
      openStream: (args) => opened.push(args),
      closeStream: (key) => closed.push(key),
    };

    const podList = [
      {
        metadata: { name: 'pod-new' },
        status: { containerStatuses: [{ name: 'app', state: { running: {} } }] },
      },
    ];

    reconcileStreams({
      podList,
      streamManager,
      ref: 'kubeconfig',
      contextName: 'ctx',
      namespace: 'default',
      opts: {},
      onLog: () => {},
    });

    expect(closed).toEqual(['pod-old/app']);
    expect(opened.length).toBe(1);
    expect(opened[0].pod).toBe('pod-new');
    expect(opened[0].container).toBe('app');
  });

  it('divides tailLines among active streams to prevent total line explosion', () => {
    const opened = [];
    const streamManager = {
      getTopologySnapshot: () => [],
      openStream: (args) => opened.push(args),
      closeStream: () => {},
    };

    const podList = [
      { metadata: { name: 'pod-1' }, status: { containerStatuses: [{ name: 'app', state: { running: {} } }] } },
      { metadata: { name: 'pod-2' }, status: { containerStatuses: [{ name: 'app', state: { running: {} } }] } },
      { metadata: { name: 'pod-3' }, status: { containerStatuses: [{ name: 'app', state: { running: {} } }] } },
      { metadata: { name: 'pod-4' }, status: { containerStatuses: [{ name: 'app', state: { running: {} } }] } },
      { metadata: { name: 'pod-5' }, status: { containerStatuses: [{ name: 'app', state: { running: {} } }] } },
    ];

    reconcileStreams({
      podList,
      streamManager,
      ref: 'kubeconfig',
      contextName: 'ctx',
      namespace: 'default',
      opts: { tailLines: 500 },
      onLog: () => {},
    });

    expect(opened.length).toBe(5);
    // 500 / 5 = 100 per stream
    expect(opened[0].opts.tailLines).toBe(100);
  });
});
