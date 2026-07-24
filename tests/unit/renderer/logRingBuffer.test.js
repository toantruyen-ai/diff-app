import { describe, it, expect } from 'vitest';
import { LogRingBuffer } from '../../../src/renderer/utils/logRingBuffer.js';

describe('LogRingBuffer', () => {
  it('appends log lines and looks up items by seq', () => {
    const ring = new LogRingBuffer(3);
    ring.append({ seq: 1, message: 'line 1' });
    ring.append({ seq: 2, message: 'line 2' });
    ring.append({ seq: 3, message: 'line 3' });

    expect(ring.firstSeq).toBe(1);
    expect(ring.lastSeq).toBe(3);
    expect(ring.getItemBySeq(2)).toEqual({ seq: 2, message: 'line 2' });
  });

  it('evicts oldest items when capacity is reached', () => {
    const ring = new LogRingBuffer(2);
    ring.append({ seq: 10, message: 'line 10' });
    ring.append({ seq: 11, message: 'line 11' });
    ring.append({ seq: 12, message: 'line 12' });

    expect(ring.firstSeq).toBe(11);
    expect(ring.lastSeq).toBe(12);
    expect(ring.getItemBySeq(10)).toBeNull();
    expect(ring.getItemBySeq(11)).toEqual({ seq: 11, message: 'line 11' });
  });
});
