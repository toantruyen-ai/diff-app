const { LogRingBuffer } = require('../utils/logRingBuffer');

let ringBuffer = new LogRingBuffer(50000);
let currentFilter = {
  includeText: '',
  excludeText: '',
  pods: null, // Set of pod names or null for all
  levels: null, // Set of levels or null for all
};
let includeRegex = null;
let excludeRegex = null;

function compileRegex(text) {
  if (!text) return null;
  try {
    return new RegExp(text, 'i');
  } catch {
    return null;
  }
}

function matchesFilter(line) {
  if (!line) return false;

  if (currentFilter.pods && currentFilter.pods.size > 0) {
    if (!currentFilter.pods.has(line.pod)) return false;
  }

  if (currentFilter.levels && currentFilter.levels.size > 0) {
    if (!currentFilter.levels.has(line.level)) return false;
  }

  if (excludeRegex && excludeRegex.test(line.message)) {
    return false;
  }

  if (includeRegex) {
    return includeRegex.test(line.message);
  } else if (currentFilter.includeText) {
    return line.message.toLowerCase().includes(currentFilter.includeText.toLowerCase());
  }

  return true;
}

function processMessage(event) {
  const { type, lines, filter, capacity } = event.data || {};

  if (type === 'INIT' && capacity) {
    ringBuffer = new LogRingBuffer(capacity);
  } else if (type === 'APPEND_BATCH' && Array.isArray(lines)) {
    ringBuffer.appendBatch(lines);
    const matchedSeqs = [];
    for (const line of lines) {
      if (matchesFilter(line)) {
        matchedSeqs.push(line.seq);
      }
    }
    self.postMessage({ type: 'MATCHED_BATCH', matchedSeqs });
  } else if (type === 'SET_FILTER') {
    currentFilter.includeText = filter?.includeText || '';
    currentFilter.excludeText = filter?.excludeText || '';
    currentFilter.pods = filter?.pods ? new Set(filter.pods) : null;
    currentFilter.levels = filter?.levels ? new Set(filter.levels) : null;
    includeRegex = compileRegex(currentFilter.includeText);
    excludeRegex = compileRegex(currentFilter.excludeText);

    const matchedSeqs = [];
    for (let seq = ringBuffer.firstSeq; seq <= ringBuffer.lastSeq; seq++) {
      const line = ringBuffer.getItemBySeq(seq);
      if (line && matchesFilter(line)) {
        matchedSeqs.push(line.seq);
      }
    }
    self.postMessage({ type: 'FILTERED_VIEW', matchedSeqs });
  } else if (type === 'CLEAR') {
    ringBuffer.clear();
    self.postMessage({ type: 'FILTERED_VIEW', matchedSeqs: [] });
  }
}

if (typeof self !== 'undefined') {
  self.onmessage = processMessage;
}

module.exports = {
  matchesFilter,
  processMessage,
};
