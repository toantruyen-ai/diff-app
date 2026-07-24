import { describe, it, expect, vi } from 'vitest';
import { getK8sApi } from '../../../src/renderer/api/index.js';

describe('renderer API bridge', () => {
  it('returns window.k8sApi when defined', () => {
    const dummyApi = { selectKubeconfig: vi.fn() };
    global.window = { k8sApi: dummyApi };
    expect(getK8sApi()).toBe(dummyApi);
  });

  it('throws error when window.k8sApi is missing', () => {
    global.window = {};
    expect(() => getK8sApi()).toThrow('window.k8sApi is not available');
  });
});
