function createPinnedLogStore() {
  const pins = new Map();
  let version = 0;
  const listeners = new Set();

  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function notify() {
    version++;
    for (const listener of listeners) {
      try {
        listener();
      } catch {}
    }
  }

  function pin(line) {
    if (!line || line.seq == null) return;
    pins.set(line.seq, {
      seq: line.seq,
      pod: line.pod || '',
      container: line.container || '',
      ts: line.ts,
      message: line.message || '',
      level: line.level || 'INFO',
    });
    notify();
  }

  function unpin(seq) {
    if (pins.has(seq)) {
      pins.delete(seq);
      notify();
    }
  }

  function isPinned(seq) {
    return pins.has(seq);
  }

  function getAll() {
    return Array.from(pins.values());
  }

  function clear() {
    if (pins.size > 0) {
      pins.clear();
      notify();
    }
  }

  return {
    subscribe,
    getVersion: () => version,
    pin,
    unpin,
    isPinned,
    getAll,
    clear,
  };
}

module.exports = {
  createPinnedLogStore,
};
