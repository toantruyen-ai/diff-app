const { parseLogLine } = require('../utils/logParserHelper');
const {
  DEFAULT_FLUSH_INTERVAL_MS,
  DEFAULT_FLUSH_BATCH_SIZE,
  DEFAULT_REORDER_WINDOW_MS,
  BACKPRESSURE_MODES,
} = require('./multiPodLogConstants');

function createBatcher(options = {}) {
  const onFlush = options.onFlush || (() => {});
  const flushIntervalMs = options.flushIntervalMs || DEFAULT_FLUSH_INTERVAL_MS;
  const flushBatchSize = options.flushBatchSize || DEFAULT_FLUSH_BATCH_SIZE;
  const reorderWindowMs = options.reorderWindowMs ?? DEFAULT_REORDER_WINDOW_MS;
  let backpressureMode = options.backpressureMode || BACKPRESSURE_MODES.DROP;

  let nextSeq = 1;
  let droppedCount = 0;
  let currentBatch = [];
  let reorderQueue = [];
  let timer = null;

  function flush() {
    if (reorderWindowMs > 0 && reorderQueue.length > 0) {
      const now = Date.now();
      const cutoff = now - reorderWindowMs;
      reorderQueue.sort((a, b) => a.ts - b.ts);
      const ready = [];
      const remaining = [];
      for (const item of reorderQueue) {
        if (item.ts <= cutoff) ready.push(item);
        else remaining.push(item);
      }
      reorderQueue = remaining;
      currentBatch.push(...ready);
    }

    if (currentBatch.length === 0) return;

    const firstSeq = currentBatch[0].seq;
    const lastSeq = currentBatch[currentBatch.length - 1].seq;
    const batchData = {
      lines: currentBatch,
      firstSeq,
      lastSeq,
      dropped: droppedCount,
    };
    droppedCount = 0;
    currentBatch = [];
    onFlush(batchData);
  }

  timer = setInterval(flush, flushIntervalMs);

  function addLog(pod, container, rawLine) {
    const seq = nextSeq++;
    const { ts, message, level } = parseLogLine(rawLine);
    const item = { seq, pod, container, ts, message, level };

    if (reorderWindowMs > 0) {
      reorderQueue.push(item);
    } else {
      currentBatch.push(item);
    }

    if (currentBatch.length >= flushBatchSize) {
      flush();
    }
  }

  function registerDrop(count = 1) {
    droppedCount += count;
  }

  function setBackpressureMode(mode) {
    if (Object.values(BACKPRESSURE_MODES).includes(mode)) {
      backpressureMode = mode;
    }
  }

  function destroy() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    if (reorderQueue.length > 0) {
      reorderQueue.sort((a, b) => a.ts - b.ts);
      currentBatch.push(...reorderQueue);
      reorderQueue = [];
    }
    flush();
  }

  return {
    addLog,
    registerDrop,
    setBackpressureMode,
    getBackpressureMode: () => backpressureMode,
    flush,
    destroy,
    getNextSeq: () => nextSeq,
  };
}

module.exports = {
  createBatcher,
};
