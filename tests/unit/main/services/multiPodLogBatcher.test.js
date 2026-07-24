import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createBatcher } from '../../../../src/main/services/multiPodLogBatcher.js';

describe('multiPodLogBatcher', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('assigns monotonic seq numbers and flushes on batch size', () => {
    const flushes = [];
    const batcher = createBatcher({
      onFlush: (batch) => flushes.push(batch),
      flushBatchSize: 2,
      flushIntervalMs: 1000,
    });

    batcher.addLog('pod-1', 'container-a', '2026-07-24T12:00:00Z Log line 1');
    expect(flushes.length).toBe(0);

    batcher.addLog('pod-1', 'container-a', '2026-07-24T12:00:01Z Log line 2');
    expect(flushes.length).toBe(1);
    expect(flushes[0].firstSeq).toBe(1);
    expect(flushes[0].lastSeq).toBe(2);
    expect(flushes[0].lines.length).toBe(2);

    batcher.destroy();
  });

  it('flushes on interval timeout', () => {
    const flushes = [];
    const batcher = createBatcher({
      onFlush: (batch) => flushes.push(batch),
      flushBatchSize: 100,
      flushIntervalMs: 80,
    });

    batcher.addLog('pod-1', 'container-a', 'Single log line');
    expect(flushes.length).toBe(0);

    vi.advanceTimersByTime(100);
    expect(flushes.length).toBe(1);
    expect(flushes[0].firstSeq).toBe(1);

    batcher.destroy();
  });
});
