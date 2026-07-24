import { describe, it, expect } from 'vitest';

function resolveDefaultNamespace(namespaces) {
  if (!Array.isArray(namespaces) || namespaces.length === 0) return null;
  if (namespaces.includes('brand')) return 'brand';
  if (namespaces.includes('default')) return 'default';
  return namespaces[0];
}

describe('Default Namespace Resolver', () => {
  it('selects "brand" if present', () => {
    expect(resolveDefaultNamespace(['default', 'brand', 'kube-system'])).toBe('brand');
  });

  it('selects "default" if "brand" is absent', () => {
    expect(resolveDefaultNamespace(['kube-system', 'default', 'ingress'])).toBe('default');
  });

  it('selects first namespace if neither "brand" nor "default" is present', () => {
    expect(resolveDefaultNamespace(['kube-system', 'ingress', 'monitoring'])).toBe('kube-system');
  });

  it('returns null for empty namespace lists', () => {
    expect(resolveDefaultNamespace([])).toBe(null);
    expect(resolveDefaultNamespace(null)).toBe(null);
  });
});
