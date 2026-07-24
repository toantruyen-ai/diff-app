import { describe, it, expect } from 'vitest';
import { withTimeout } from '../../../../src/main/utils/timeout.js';

describe('withTimeout', () => {
  it('resolves if promise finishes before timeout', async () => {
    const result = await withTimeout(Promise.resolve('ok'), 100);
    expect(result).toBe('ok');
  });

  it('rejects with timeout error if promise exceeds duration', async () => {
    const slowPromise = new Promise((resolve) => setTimeout(resolve, 200));
    await expect(withTimeout(slowPromise, 50, 'Custom timeout')).rejects.toThrow('Custom timeout');
  });
});
