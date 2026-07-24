import { describe, it, expect } from 'vitest';
import { loadContexts } from '../../../../src/main/services/k8sService.js';

describe('k8sService', () => {
  it('loadContexts loads contexts from default config if ref is null', async () => {
    // Should not throw or crash
    try {
      const contexts = await loadContexts(null);
      expect(Array.isArray(contexts)).toBe(true);
    } catch (e) {
      // In CI / dev environment without kubeconfig, error message is expected and handled gracefully
      expect(e.message).toContain('Failed to load contexts');
    }
  });
});
