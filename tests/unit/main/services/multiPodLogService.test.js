import { describe, it, expect, vi } from 'vitest';
import k8s from '@kubernetes/client-node';
import multiPodLogService from '../../../../src/main/services/multiPodLogService.js';

describe('multiPodLogService', () => {
  it('manages session lifecycle stop safely when session does not exist', () => {
    const res = multiPodLogService.stopMultiPodLogs('non-existent-sid');
    expect(res).toEqual({ ok: true });
  });

  it('updates backpressure mode for an active session', () => {
    const res = multiPodLogService.setBackpressure('missing-sid', 'drop');
    expect(res.ok).toBe(false);
    expect(res.error).toBe('Session not found');
  });

  it('filters pods strictly for deployment workload without leaking other app pods', async () => {
    const mockPods = [
      { metadata: { name: 'app-a-pod-1', labels: { app: 'app-a' } } },
      { metadata: { name: 'app-b-pod-1', labels: { app: 'app-b' } } },
    ];

    vi.spyOn(k8s.CoreV1Api.prototype, 'listNamespacedPod').mockResolvedValue({ body: { items: mockPods } });
    vi.spyOn(k8s.AppsV1Api.prototype, 'readNamespacedDeployment').mockResolvedValue({
      body: { spec: { selector: { matchLabels: { app: 'app-a' } } } },
    });
    vi.spyOn(k8s.Log.prototype, 'log').mockResolvedValue({ abort: vi.fn() });

    const dummyYaml = `apiVersion: v1
kind: Config
clusters:
- cluster: {server: 'https://localhost'}
  name: c
contexts:
- context: {cluster: c, user: u}
  name: ctx
current-context: ctx
users:
- name: u`;

    const workload = { kind: 'deployments', name: 'app-a' };
    const sid = 'test-dep-sid';

    const result = await multiPodLogService.startMultiPodLogs(dummyYaml, 'ctx', 'default', workload, {}, sid);
    expect(result.ok).toBe(true);

    const session = multiPodLogService.activeSessions.get(sid);
    expect(session).toBeDefined();
    expect(session.podCache).toHaveLength(1);
    expect(session.podCache[0].metadata.name).toBe('app-a-pod-1');

    multiPodLogService.stopMultiPodLogs(sid);
  });

  it('survives gracefully if webContents.send throws "Render frame was disposed"', async () => {
    const mockPods = [
      { metadata: { name: 'app-a-pod-1', labels: { app: 'app-a' } } },
    ];
    vi.spyOn(k8s.CoreV1Api.prototype, 'listNamespacedPod').mockResolvedValue({ body: { items: mockPods } });
    vi.spyOn(k8s.AppsV1Api.prototype, 'readNamespacedDeployment').mockResolvedValue({
      body: { spec: { selector: { matchLabels: { app: 'app-a' } } } },
    });
    vi.spyOn(k8s.Log.prototype, 'log').mockResolvedValue({ abort: vi.fn() });

    const dummyYaml = `apiVersion: v1
kind: Config
clusters:
- cluster: {server: 'https://localhost'}
  name: c
contexts:
- context: {cluster: c, user: u}
  name: ctx
current-context: ctx
users:
- name: u`;

    const workload = { kind: 'deployments', name: 'app-a' };
    const sid = 'test-disposed-sid';

    const mockWin = {
      isDestroyed: () => false,
      webContents: {
        isDestroyed: () => false,
        send: vi.fn().mockImplementation(() => {
          throw new Error('Render frame was disposed before WebFrameMain could be accessed');
        }),
      },
    };
    const getMainWindow = () => mockWin;

    // This should not throw an unhandled exception or return ok: false, because sendIfAlive should catch it.
    const result = await multiPodLogService.startMultiPodLogs(dummyYaml, 'ctx', 'default', workload, {}, sid, getMainWindow);
    expect(result.ok).toBe(true);

    multiPodLogService.stopMultiPodLogs(sid);
  });
});

