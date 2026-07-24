import { describe, it, expect, vi } from 'vitest';
const {
  filterAndRankPods,
  resolveServiceTargetPort,
  resolveTargetPod,
} = require('../../../../src/main/services/targetResolverService');

describe('targetResolverService', () => {
  describe('filterAndRankPods', () => {
    it('filters out non-ready or terminating pods and ranks by newest startTime', () => {
      const pods = [
        {
          metadata: { name: 'pod-old', creationTimestamp: '2026-01-01T00:00:00Z' },
          status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }], startTime: '2026-01-01T00:00:00Z' },
        },
        {
          metadata: { name: 'pod-terminating', deletionTimestamp: '2026-01-02T00:00:00Z' },
          status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] },
        },
        {
          metadata: { name: 'pod-not-ready' },
          status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'False' }] },
        },
        {
          metadata: { name: 'pod-new', creationTimestamp: '2026-01-02T00:00:00Z' },
          status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }], startTime: '2026-01-02T00:00:00Z' },
        },
      ];

      const ranked = filterAndRankPods(pods);
      expect(ranked.map((p) => p.metadata.name)).toEqual(['pod-new', 'pod-old']);
    });

    it('honors sticky selection if currentPodName is still ready', () => {
      const pods = [
        {
          metadata: { name: 'pod-old' },
          status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }], startTime: '2026-01-01T00:00:00Z' },
        },
        {
          metadata: { name: 'pod-new' },
          status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }], startTime: '2026-01-02T00:00:00Z' },
        },
      ];

      const ranked = filterAndRankPods(pods, 'pod-old');
      expect(ranked[0].metadata.name).toBe('pod-old');
    });
  });

  describe('resolveServiceTargetPort', () => {
    it('resolves named port via container port in pod spec', () => {
      const service = { spec: { ports: [{ name: 'http', port: 80, targetPort: 'http-web' }] } };
      const pod = {
        spec: {
          containers: [
            { ports: [{ name: 'http-web', containerPort: 8080 }] },
          ],
        },
      };

      const resolved = resolveServiceTargetPort(service, pod, 'http');
      expect(resolved).toBe(8080);
    });

    it('resolves numeric targetPort directly', () => {
      const service = { spec: { ports: [{ port: 80, targetPort: 3000 }] } };
      const pod = { spec: {} };

      const resolved = resolveServiceTargetPort(service, pod, 80);
      expect(resolved).toBe(3000);
    });
  });

  describe('resolveTargetPod', () => {
    it('resolves direct pod kind immediately', async () => {
      const res = await resolveTargetPod(null, null, 'default', { kind: 'pod', name: 'my-pod', remotePort: 8080 });
      expect(res).toEqual({ ok: true, podName: 'my-pod', containerPort: 8080 });
    });

    it('auto-detects container port when remotePort is missing', async () => {
      const { detectFirstPort } = require('../../../../src/main/services/targetResolverService');
      const pod = {
        spec: {
          containers: [{ ports: [{ containerPort: 3000 }] }],
        },
      };
      expect(detectFirstPort(pod)).toBe(3000);
    });
  });
});
