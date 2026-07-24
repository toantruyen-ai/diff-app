const { Writable, PassThrough } = require('stream');
const k8s = require('@kubernetes/client-node');
const { buildKubeConfig } = require('../utils/k8sHelper');

const execSessions = new Map();

function stopExecSession(sid) {
  const session = execSessions.get(sid);
  if (!session) return;
  try { session.stdin.end(); } catch { /* already closed */ }
  try { session.ws && session.ws.close(); } catch { /* already closed */ }
  execSessions.delete(sid);
}

function stopAllExecSessions() {
  for (const sid of execSessions.keys()) {
    stopExecSession(sid);
  }
}

async function execStart(ref, contextName, namespace, pod, container, sid, getMainWindow) {
  stopExecSession(sid);

  const sendIfAlive = (channel, ...args) => {
    const win = getMainWindow ? getMainWindow() : null;
    if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
  };

  const stdin = new PassThrough();
  const stdout = new Writable({
    write(chunk, _enc, callback) {
      sendIfAlive(`exec-data:${sid}`, chunk.toString('utf8'));
      callback();
    },
  });
  stdout.rows = 24;
  stdout.columns = 80;

  const session = { stdin, stdout, ws: null };
  execSessions.set(sid, session);

  try {
    const kc = buildKubeConfig(ref, contextName);
    const execApi = new k8s.Exec(kc);
    const ws = await execApi.exec(
      namespace,
      pod,
      container,
      ['/bin/sh', '-c', 'exec /bin/bash || exec /bin/sh'],
      stdout,
      stdout,
      stdin,
      true,
      (status) => {
        sendIfAlive(`exec-exit:${sid}`, status);
        stopExecSession(sid);
      }
    );
    if (!execSessions.has(sid)) {
      try { ws.close(); } catch { /* ignore */ }
      return { ok: true };
    }
    session.ws = ws;
    ws.on('error', (err) => {
      sendIfAlive(`exec-exit:${sid}`, { status: 'Failure', message: err.message });
      stopExecSession(sid);
    });
    ws.on('close', () => stopExecSession(sid));
    return { ok: true };
  } catch (e) {
    stopExecSession(sid);
    sendIfAlive(`exec-exit:${sid}`, { status: 'Failure', message: e.message });
    return { ok: false, error: e.message };
  }
}

function execWrite(sid, data) {
  const session = execSessions.get(sid);
  if (session) session.stdin.write(data);
}

function execResize(sid, cols, rows) {
  const session = execSessions.get(sid);
  if (!session) return;
  session.stdout.columns = cols;
  session.stdout.rows = rows;
  session.stdout.emit('resize');
}

async function execStop(sid) {
  stopExecSession(sid);
  return { ok: true };
}

module.exports = {
  execSessions,
  stopExecSession,
  stopAllExecSessions,
  execStart,
  execWrite,
  execResize,
  execStop,
};
