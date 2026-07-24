const { Writable, PassThrough } = require('stream');
const k8s = require('@kubernetes/client-node');
const { buildKubeConfig } = require('../utils/k8sHelper');
const { sessionManager } = require('./sessionManagerService');

function stopExecSession(sid, getMainWindow = null) {
  sessionManager.removeSession(sid, getMainWindow);
}

function stopAllExecSessions(getMainWindow = null) {
  for (const session of sessionManager.sessions.values()) {
    if (session.kind === 'exec') {
      stopExecSession(session.id, getMainWindow);
    }
  }
}

async function execStart(ref, contextName, namespace, pod, container, sid, getMainWindow, shellCmd) {
  stopExecSession(sid, getMainWindow);

  sessionManager.emitSessionEvent(
    { kind: 'exec', type: 'status', sessionId: sid, status: 'connecting' },
    getMainWindow
  );

  const stdin = new PassThrough();
  stdin.on('error', () => {});
  const stdout = new Writable({
    write(chunk, _enc, callback) {
      try {
        const win = getMainWindow ? getMainWindow() : null;
        if (win && !win.isDestroyed() && win.webContents && (typeof win.webContents.isDestroyed !== 'function' || !win.webContents.isDestroyed())) {
          win.webContents.send(`exec-data:${sid}`, chunk.toString('utf8'));
        }
      } catch (err) {
        console.error(`Error sending exec-data for session ${sid}:`, err);
      }
      callback();
    },
  });
  stdout.rows = 24;
  stdout.columns = 80;

  const command = shellCmd
    ? [shellCmd]
    : ['/bin/sh', '-c', 'exec /bin/bash || exec /bin/sh'];

  try {
    const kc = buildKubeConfig(ref, contextName);
    const execApi = new k8s.Exec(kc);

    const ws = await execApi.exec(
      namespace,
      pod,
      container,
      command,
      stdout,
      stdout,
      stdin,
      true,
      (status) => {
        try {
          const win = getMainWindow ? getMainWindow() : null;
          if (win && !win.isDestroyed() && win.webContents && (typeof win.webContents.isDestroyed !== 'function' || !win.webContents.isDestroyed())) {
            win.webContents.send(`exec-exit:${sid}`, status);
          }
        } catch (err) {
          console.error(`Error sending exec-exit for session ${sid}:`, err);
        }
        sessionManager.emitSessionEvent(
          { kind: 'exec', type: 'exit', sessionId: sid, exitCode: status.code || 0, status: 'closed' },
          getMainWindow
        );
        stopExecSession(sid, getMainWindow);
      }
    );

    const execSession = {
      id: sid,
      kind: 'exec',
      status: 'active',
      metadata: { context: contextName, namespace, pod, container, createdAt: new Date().toISOString() },
      stdin,
      stdout,
      ws,
      describe() {
        return {
          sessionId: sid,
          kind: 'exec',
          status: this.status,
          metadata: this.metadata,
        };
      },
      dispose() {
        try { stdin.end(); } catch { /* ignore */ }
        try { if (ws) ws.close(); } catch { /* ignore */ }
      },
    };

    sessionManager.registerSession(execSession);
    sessionManager.emitSessionEvent(
      { kind: 'exec', type: 'status', sessionId: sid, status: 'active' },
      getMainWindow
    );

    ws.on('error', (err) => {
      sessionManager.emitSessionEvent(
        { kind: 'exec', type: 'status', sessionId: sid, status: 'error', message: err.message },
        getMainWindow
      );
      stopExecSession(sid, getMainWindow);
    });

    ws.on('close', () => stopExecSession(sid, getMainWindow));

    return { ok: true, sessionId: sid };
  } catch (e) {
    sessionManager.emitSessionEvent(
      { kind: 'exec', type: 'status', sessionId: sid, status: 'error', message: e.message },
      getMainWindow
    );
    stopExecSession(sid, getMainWindow);
    return { ok: false, error: e.message };
  }
}

function execWrite(sid, data) {
  const session = sessionManager.getSession(sid);
  if (session && session.stdin && !session.stdin.destroyed) {
    try {
      session.stdin.write(data);
    } catch {
      // ignore stream write errors on destroyed/closed stdin
    }
  }
}

function execResize(sid, cols, rows) {
  const session = sessionManager.getSession(sid);
  if (!session || !session.stdout) return;
  session.stdout.columns = cols;
  session.stdout.rows = rows;
  session.stdout.emit('resize');
}

async function execStop(sid, getMainWindow = null) {
  stopExecSession(sid, getMainWindow);
  return { ok: true };
}

module.exports = {
  stopExecSession,
  stopAllExecSessions,
  execStart,
  execWrite,
  execResize,
  execStop,
};
