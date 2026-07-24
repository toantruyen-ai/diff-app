import { describe, it, expect } from 'vitest';
import { matchesFilter } from '../../../src/renderer/workers/logFilterWorker.js';

describe('logFilterWorker', () => {
  it('matches filter conditions correctly', () => {
    const line = { seq: 1, pod: 'pod-a', level: 'ERROR', message: 'Connection timeout error' };
    expect(matchesFilter(line)).toBe(true);
  });
});
