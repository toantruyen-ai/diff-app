const { Writable } = require('stream');
const k8s = require('@kubernetes/client-node');
const k8sHelper = require('../utils/k8sHelper');
const { splitLines, parseLogLine, computeLineFingerprint } = require('../utils/logParserHelper');
const {
  STREAM_STATES,
  INITIAL_BACKOFF_MS,
  MAX_BACKOFF_MS,
  DEDUP_FINGERPRINT_CACHE_SIZE,
} = require('./multiPodLogConstants');

function createStreamManager(options = {}) {
  const streams = new Map(); // streamKey -> StreamHandle

  function getStreamKey(pod, container) {
    return `${pod}/${container}`;
  }

  function getTopologySnapshot() {
    const topology = [];
    for (const [key, handle] of streams.entries()) {
      topology.push({
        streamKey: key,
        pod: handle.pod,
        container: handle.container,
        state: handle.state,
        enabledByUser: handle.enabledByUser,
        lastTs: handle.lastTs,
      });
    }
    return topology;
  }

  function openStream({ ref, contextName, namespace, pod, container, opts, onLog, onStateChange }) {
    const streamKey = getStreamKey(pod, container);
    if (streams.has(streamKey)) {
      const existing = streams.get(streamKey);
      if (existing.state === STREAM_STATES.STREAMING || existing.state === STREAM_STATES.CONNECTING) {
        return existing;
      }
      closeStream(streamKey);
    }

    const handle = {
      streamKey,
      pod,
      container,
      state: STREAM_STATES.CONNECTING,
      enabledByUser: true,
      leftover: '',
      fingerprints: new Set(),
      lastTs: null,
      backoffMs: INITIAL_BACKOFF_MS,
      reconnectTimer: null,
      req: null,
    };

    streams.set(streamKey, handle);

    function updateState(newState) {
      handle.state = newState;
      if (onStateChange) onStateChange(streamKey, newState);
    }

    async function connect() {
      if (handle.state === STREAM_STATES.ENDED || !streams.has(streamKey)) return;
      updateState(STREAM_STATES.CONNECTING);

      const writable = new Writable({
        write(chunk, _enc, cb) {
          const { lines, leftover } = splitLines(chunk.toString('utf8'), handle.leftover);
          handle.leftover = leftover;

          for (const rawLine of lines) {
            if (!rawLine.trim()) continue;
            const parsed = parseLogLine(rawLine);
            const fp = computeLineFingerprint(parsed.ts, parsed.message);

            // Deduplicate lines arriving within the same second on reconnect
            if (handle.fingerprints.has(fp)) continue;

            handle.fingerprints.add(fp);
            if (handle.fingerprints.size > DEDUP_FINGERPRINT_CACHE_SIZE) {
              const firstVal = handle.fingerprints.values().next().value;
              handle.fingerprints.delete(firstVal);
            }

            handle.lastTs = parsed.ts;
            if (onLog) onLog(pod, container, rawLine);
          }
          cb();
        },
        final(cb) {
          cb();
          if (handle.leftover.trim() && onLog) {
            onLog(pod, container, handle.leftover);
            handle.leftover = '';
          }
        },
      });

      try {
        const kc = k8sHelper.buildKubeConfig(ref, contextName);
        const logApi = new k8s.Log(kc);
        const logOpts = {
          follow: true,
          tailLines: handle.lastTs ? undefined : (opts?.tailLines || 500),
          timestamps: true,
          sinceTime: handle.lastTs ? new Date(handle.lastTs).toISOString() : undefined,
        };

        const req = await logApi.log(namespace, pod, container, writable, logOpts);

        if (handle.state === STREAM_STATES.ENDED || !streams.has(streamKey)) {
          try { req.abort(); } catch {}
          return;
        }

        handle.req = req;
        handle.backoffMs = INITIAL_BACKOFF_MS; // reset backoff on successful connect
        updateState(STREAM_STATES.STREAMING);

        req.on('error', (err) => {
          if (handle.state === STREAM_STATES.ENDED) return;
          const status = err?.response?.statusCode || err?.statusCode;
          if (status === 401 || status === 403) {
            updateState(STREAM_STATES.ERROR_FATAL);
          } else {
            scheduleReconnect();
          }
        });
      } catch (err) {
        const status = err?.statusCode || err?.response?.statusCode;
        if (status === 401 || status === 403) {
          updateState(STREAM_STATES.ERROR_FATAL);
        } else {
          scheduleReconnect();
        }
      }
    }

    function scheduleReconnect() {
      if (handle.state === STREAM_STATES.ENDED || handle.state === STREAM_STATES.ERROR_FATAL) return;
      updateState(STREAM_STATES.BACKOFF);

      const jitter = Math.random() * 500;
      const delay = Math.min(handle.backoffMs + jitter, MAX_BACKOFF_MS);
      handle.backoffMs = Math.min(handle.backoffMs * 2, MAX_BACKOFF_MS);

      if (handle.reconnectTimer) clearTimeout(handle.reconnectTimer);
      handle.reconnectTimer = setTimeout(() => {
        handle.reconnectTimer = null;
        connect();
      }, delay);
    }

    connect();
    return handle;
  }

  function closeStream(streamKey) {
    const handle = streams.get(streamKey);
    if (!handle) return;

    handle.state = STREAM_STATES.ENDED;
    if (handle.reconnectTimer) {
      clearTimeout(handle.reconnectTimer);
      handle.reconnectTimer = null;
    }
    if (handle.req) {
      try { handle.req.abort(); } catch {}
      handle.req = null;
    }
    streams.delete(streamKey);
  }

  function closeAllStreams() {
    for (const key of Array.from(streams.keys())) {
      closeStream(key);
    }
  }

  return {
    openStream,
    closeStream,
    closeAllStreams,
    getTopologySnapshot,
    getStream: (streamKey) => streams.get(streamKey),
  };
}

module.exports = {
  createStreamManager,
};
