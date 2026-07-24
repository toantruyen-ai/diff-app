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
    expect(typeof exposedApi.startMultiPodLogs).toBe('function');
    expect(typeof exposedApi.stopMultiPodLogs).toBe('function');
    expect(typeof exposedApi.dryRunYaml).toBe('function');
    expect(typeof exposedApi.applySsaYaml).toBe('function');
    expect(typeof exposedApi.dryRunBatchYaml).toBe('function');
    expect(typeof exposedApi.applyBatchYaml).toBe('function');
    expect(typeof exposedApi.lintYaml).toBe('function');
    expect(typeof exposedApi.mapYamlPos).toBe('function');
    expect(typeof exposedApi.listSessions).toBe('function');
    expect(typeof exposedApi.injectEphemeralContainer).toBe('function');
    expect(typeof exposedApi.copyPodToDebug).toBe('function');
    expect(typeof exposedApi.onSessionEvent).toBe('function');
    exposedApi.getAppVersion();
    expect(mockElectron.ipcRenderer.invoke).toHaveBeenCalledWith('get-app-version');
    exposedApi.dryRunYaml('ref1', 'ctx1', 'yaml');
    expect(mockElectron.ipcRenderer.invoke).toHaveBeenCalledWith('dry-run-yaml', 'ref1', 'ctx1', 'yaml');
    exposedApi.auditDbDiscover();
    expect(mockElectron.ipcRenderer.invoke).toHaveBeenCalledWith('audit-db-discover');
    exposedApi.listSessions();
    expect(mockElectron.ipcRenderer.invoke).toHaveBeenCalledWith('session:list');
  });
});
