import { describe, it, expect, vi } from 'vitest';
const {
  injectEphemeralContainer,
  copyPodToDebug,
} = require('../../../../src/main/services/ephemeralDebugService');
const k8sHelper = require('../../../../src/main/utils/k8sHelper');

describe('ephemeralDebugService', () => {
  it('injects ephemeral container successfully', async () => {
    const mockPatch = vi.fn().mockResolvedValue({});
    const mockReadPod = vi.fn().mockResolvedValue({
      body: { metadata: { name: 'my-pod' }, spec: { containers: [{ name: 'app' }] } },
    });

    vi.spyOn(k8sHelper, 'getCachedApiClients').mockReturnValue({
      apis: {
        core: {
          readNamespacedPod: mockReadPod,
          patchNamespacedPod: mockPatch,
        },
      },
    });

    const res = await injectEphemeralContainer(null, null, 'default', 'my-pod', 'app', 'busybox');
    if (!res.ok) console.error('injectEphemeralContainer error:', res.error);
    expect(res.ok).toBe(true);
    expect(res.containerName).toMatch(/^debugger-/);
    expect(mockPatch).toHaveBeenCalled();
  });

  it('copies pod to debug manifest and creates new pod', async () => {
    const mockCreatePod = vi.fn().mockResolvedValue({});
    const mockReadPod = vi.fn().mockResolvedValue({
      body: {
        metadata: { name: 'app-pod', labels: { app: 'test' } },
        spec: { nodeName: 'node-1', containers: [{ name: 'main', image: 'nginx:1.19' }] },
      },
    });

    vi.spyOn(k8sHelper, 'getCachedApiClients').mockReturnValue({
      apis: {
        core: {
          readNamespacedPod: mockReadPod,
          createNamespacedPod: mockCreatePod,
        },
      },
    });

    const res = await copyPodToDebug(null, null, 'default', 'app-pod', 'main', 'nginx:1.20');
    expect(res.ok).toBe(true);
    expect(res.newPodName).toMatch(/^app-pod-debug-/);
    expect(mockCreatePod).toHaveBeenCalled();

    const createdManifest = mockCreatePod.mock.calls[0][1];
    expect(createdManifest.spec.containers[0].image).toBe('nginx:1.20');
    expect(createdManifest.spec.nodeName).toBeUndefined();
  });
});
