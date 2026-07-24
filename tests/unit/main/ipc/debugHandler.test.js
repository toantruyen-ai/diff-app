import { describe, it, expect, vi, beforeEach } from 'vitest';
const { isValidIdentifier } = require('../../../../src/main/ipc/debugHandler');

describe('debugHandler', () => {
  it('validates identifier inputs strictly', () => {
    expect(isValidIdentifier('my-pod-1')).toBe(true);
    expect(isValidIdentifier('default')).toBe(true);
    expect(isValidIdentifier('../traversal')).toBe(false);
    expect(isValidIdentifier('pod; rm -rf /')).toBe(false);
  });
});
