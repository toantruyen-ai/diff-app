const { Writable } = require('stream');
const k8s = require('@kubernetes/client-node');
const { buildKubeConfig } = require('../utils/k8sHelper');

const logSessions = new Map();

function stopLogSession(sid) {
  const session = logSessions.get(sid);
  if (!session) return;
  clearInterval(session.flushTimer);
  try { session.req && session.req.abort(); } catch { /* already closed */ }
  logSessions.delete(sid);
}

function stopAllLogSessions() {
  for (const sid of logSessions.keys()) {
    stopLogSession(sid);
  }
}

async function startPodLogs(ref, contextName, namespace, pod, container, opts, sid, getMainWindow) {
  stopLogSession(sid);

  const sendIfAlive = (channel, ...args) => {
    const win = getMainWindow ? getMainWindow() : null;
    if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
  };

  const session = { buffer: '', flushTimer: null, req: null };
  logSessions.set(sid, session);

  const MAX_BUFFER = 256 * 1024;
  const writable = new Writable({
    write(chunk, _enc, callback) {
      session.buffer += chunk.toString('utf8');
      if (session.buffer.length > MAX_BUFFER) {
        session.buffer = `…(truncated — showing tail)…\n${session.buffer.slice(-MAX_BUFFER)}`;
      }
      callback();
    },
    final(callback) {
      callback();
      sendIfAlive(`pod-log-end:${sid}`);
      stopLogSession(sid);
    },
  });

  session.flushTimer = setInterval(() => {
    if (!session.buffer) return;
    const chunk = session.buffer;
    session.buffer = '';
    sendIfAlive(`pod-log-data:${sid}`, chunk);
  }, 150);

  try {
    const kc = buildKubeConfig(ref, contextName);
    const logApi = new k8s.Log(kc);
    const req = await logApi.log(namespace, pod, container, writable, {
      follow: opts?.follow !== false,
      tailLines: opts?.tailLines,
      timestamps: !!opts?.timestamps,
    });
    if (!logSessions.has(sid)) {
      try { req.abort(); } catch { /* ignore */ }
      return { ok: true };
    }
    session.req = req;
    req.on('error', (err) => {
      sendIfAlive(`pod-log-error:${sid}`, err.message);
      stopLogSession(sid);
    });
    return { ok: true };
  } catch (e) {
    stopLogSession(sid);
    sendIfAlive(`pod-log-error:${sid}`, e.message);
    return { ok: false, error: e.message };
  }
}

async function stopPodLogs(sid) {
  stopLogSession(sid);
  return { ok: true };
}

module.exports = {
  logSessions,
  stopLogSession,
  stopAllLogSessions,
  startPodLogs,
  stopPodLogs,
};
