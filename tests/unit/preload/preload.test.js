import { describe, it, expect, vi } from 'vitest';
import { exposePreloadApi } from '../../../src/preload/index.js';

describe('Preload Bridge', () => {
  it('exposes window.k8sApi via contextBridge', () => {
    const mockExpose = vi.fn();
    const mockElectron = {
      contextBridge: {
        exposeInMainWorld: mockExpose,
      },
      ipcRenderer: {
        invoke: vi.fn(),
        on: vi.fn(),
      },
    };

    exposePreloadApi(mockElectron);

    expect(mockExpose).toHaveBeenCalledWith('k8sApi', expect.any(Object));
    const exposedApi = mockExpose.mock.calls[0][1];
    expect(typeof exposedApi.selectKubeconfig).toBe('function');
    expect(typeof exposedApi.loadEnvs).toBe('function');
    expect(typeof exposedApi.startPodLogs).toBe('function');
  });
});
