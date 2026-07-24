import { describe, it, expect, vi } from 'vitest';
import { createPinnedLogStore } from '../../../src/renderer/utils/logPinStore.js';

describe('logPinStore', () => {
  it('pins and unpins log lines correctly', () => {
    const store = createPinnedLogStore();
    const line1 = { seq: 101, pod: 'pod-a', container: 'c1', message: 'Hello' };
    const line2 = { seq: 102, pod: 'pod-b', container: 'c2', message: 'World' };

    expect(store.isPinned(101)).toBe(false);

    store.pin(line1);
    store.pin(line2);

    expect(store.isPinned(101)).toBe(true);
    expect(store.isPinned(102)).toBe(true);
    expect(store.getAll()).toHaveLength(2);
    expect(store.getAll()[0].pod).toBe('pod-a');

    store.unpin(101);
    expect(store.isPinned(101)).toBe(false);
    expect(store.getAll()).toHaveLength(1);
    expect(store.getAll()[0].seq).toBe(102);
  });

  it('notifies subscribers on pin, unpin, and clear', () => {
    const store = createPinnedLogStore();
    const listener = vi.fn();
    store.subscribe(listener);

    const line = { seq: 1, pod: 'p', message: 'm' };
    store.pin(line);
    expect(listener).toHaveBeenCalledTimes(1);

    store.unpin(1);
    expect(listener).toHaveBeenCalledTimes(2);

    store.pin(line);
    expect(listener).toHaveBeenCalledTimes(3);

    store.clear();
    expect(listener).toHaveBeenCalledTimes(4);
    expect(store.getAll()).toHaveLength(0);
  });

  it('returns unsubscribe function from subscribe', () => {
    const store = createPinnedLogStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    store.pin({ seq: 1, message: 'a' });
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    store.pin({ seq: 2, message: 'b' });
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
