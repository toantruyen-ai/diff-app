const { LogRingBuffer } = require('./logRingBuffer');

function createFilteredLogStore(capacity = 50000) {
  const ringBuffer = new LogRingBuffer(capacity);
  let matchedSeqs = [];
  let version = 0;
  const listeners = new Set();

  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function notify() {
    version++;
    for (const listener of listeners) {
      try { listener(); } catch {}
    }
  }

  function appendBatch(lines = []) {
    ringBuffer.appendBatch(lines);
    // Default append seqs to matchedSeqs if filter is empty
    for (const line of lines) {
      matchedSeqs.push(line.seq);
    }
    if (matchedSeqs.length > capacity) {
      const minSeq = ringBuffer.firstSeq;
      if (minSeq != null && minSeq > 0) {
        matchedSeqs = matchedSeqs.filter((s) => s >= minSeq);
      } else {
        matchedSeqs = matchedSeqs.slice(matchedSeqs.length - capacity);
      }
    }
    notify();
  }

  function setMatchedSeqs(seqs = []) {
    matchedSeqs = seqs;
    notify();
  }

  function getVisibleSlice(startIndex, count) {
    const sliceSeqs = matchedSeqs.slice(startIndex, startIndex + count);
    const result = [];
    for (const seq of sliceSeqs) {
      const item = ringBuffer.getItemBySeq(seq);
      if (item) result.push(item);
    }
    return result;
  }

  function clear() {
    ringBuffer.clear();
    matchedSeqs = [];
    notify();
  }

  return {
    subscribe,
    getVersion: () => version,
    getTotalCount: () => matchedSeqs.length,
    getRawCount: () => ringBuffer.count,
    appendBatch,
    setMatchedSeqs,
    getVisibleSlice,
    getItemBySeq: (seq) => ringBuffer.getItemBySeq(seq),
    clear,
  };
}

module.exports = {
  createFilteredLogStore,
};
