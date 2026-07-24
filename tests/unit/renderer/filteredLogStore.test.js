import { describe, it, expect, vi } from 'vitest';
import { createFilteredLogStore } from '../../../src/renderer/utils/filteredLogStore.js';

describe('filteredLogStore', () => {
  it('notifies subscribers on batch append and provides visible slices', () => {
    const store = createFilteredLogStore(100);
    const listener = vi.fn();
    store.subscribe(listener);

    store.appendBatch([
      { seq: 1, pod: 'pod-1', message: 'msg 1' },
      { seq: 2, pod: 'pod-1', message: 'msg 2' },
    ]);

    expect(listener).toHaveBeenCalled();
    expect(store.getTotalCount()).toBe(2);
    const slice = store.getVisibleSlice(0, 1);
    expect(slice.length).toBe(1);
    expect(slice[0].seq).toBe(1);
  });

  it('trims matchedSeqs when capacity is exceeded to prevent memory leaks', () => {
    const store = createFilteredLogStore(5);
    const batch1 = Array.from({ length: 10 }, (_, i) => ({ seq: i + 1, pod: 'p', message: `msg ${i + 1}` }));
    store.appendBatch(batch1);

    expect(store.getRawCount()).toBe(5);
    expect(store.getTotalCount()).toBeLessThanOrEqual(5);
  });
});
