import { describe, it, expect } from 'vitest';
import { isKubeconfigContent } from '../../../../src/main/utils/k8sHelper.js';

describe('k8sHelper', () => {
  describe('isKubeconfigContent', () => {
    it('returns true for strings starting with apiVersion: or ---', () => {
      expect(isKubeconfigContent('apiVersion: v1\nkind: Config')).toBe(true);
      expect(isKubeconfigContent('--- \napiVersion: v1')).toBe(true);
    });

    it('returns false for file paths or invalid input', () => {
      expect(isKubeconfigContent('/Users/user/.kube/config')).toBe(false);
      expect(isKubeconfigContent(null)).toBe(false);
      expect(isKubeconfigContent(123)).toBe(false);
    });
  });
});
