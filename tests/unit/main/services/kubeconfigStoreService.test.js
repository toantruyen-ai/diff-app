import { describe, it, expect, beforeEach } from 'vitest';
import {
  storeAksKc,
  touchAksKc,
  hasAksKc,
  clearAksKcStore,
  aksKcStore,
} from '../../../../src/main/services/kubeconfigStoreService.js';

describe('kubeconfigStoreService', () => {
  beforeEach(() => {
    clearAksKcStore();
  });

  it('stores and retrieves kubeconfig by generated ref ID', () => {
    const ref = storeAksKc('apiVersion: v1');
    expect(ref).toMatch(/^aks:\d+$/);
    expect(hasAksKc(ref)).toBe(true);
    expect(touchAksKc(ref)).toBe('apiVersion: v1');
  });

  it('evicts oldest entries when exceeding max capacity', () => {
    const firstRef = storeAksKc('kc-0');
    for (let i = 1; i <= 25; i++) {
      storeAksKc(`kc-${i}`);
    }
    expect(hasAksKc(firstRef)).toBe(false);
    expect(aksKcStore.size).toBeLessThanOrEqual(20);
  });
});
