const net = require('net');
const path = require('path');
const fs = require('fs');
const { app, shell } = require('electron');
const k8s = require('@kubernetes/client-node');
const { buildKubeConfig } = require('../utils/k8sHelper');
const { sessionManager } = require('./sessionManagerService');
const { resolveTargetPod } = require('./targetResolverService');

function getForwardsFilePath() {
  const userDir = app ? app.getPath('userData') : process.cwd();
  return path.join(userDir, 'forwards.json');
}

function loadSavedForwards() {
  try {
    const file = getForwardsFilePath();
    if (!fs.existsSync(file)) return [];
    const text = fs.readFileSync(file, 'utf8');
    return JSON.parse(text);
  } catch {
    return [];
  }
}

function saveForwardsToFile(forwards) {
  try {
    const file = getForwardsFilePath();
    fs.writeFileSync(file, JSON.stringify(forwards, null, 2), 'utf8');
  } catch {
    /* ignore write errors */
  }
}

function persistAddForward(targetDescriptor) {
  const current = loadSavedForwards();
  const filtered = current.filter((f) => f.sid !== targetDescriptor.sid);
  filtered.push(targetDescriptor);
  saveForwardsToFile(filtered);
}

function persistRemoveForward(sid) {
  const current = loadSavedForwards();
  const filtered = current.filter((f) => f.sid !== sid);
  saveForwardsToFile(filtered);
}

function openLocalBrowser(localPort) {
  const port = Number(localPort);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return { ok: false, error: 'Invalid local port' };
  }
  const url = `http://localhost:${port}`;
  if (shell && typeof shell.openExternal === 'function') {
    try {
      shell.openExternal(url).catch(() => {});
    } catch {
      /* ignore shell open errors */
    }
  }
  return { ok: true, url };
}

function stopPortForwardSession(sid, getMainWindow = null) {
  sessionManager.removeSession(sid, getMainWindow);
  persistRemoveForward(sid);
}

function stopAllPortForwardSessions(getMainWindow = null) {
  for (const session of sessionManager.sessions.values()) {
    if (session.kind === 'port-forward') {
      stopPortForwardSession(session.id, getMainWindow);
    }
  }
}

async function isPortFree(port, host = '127.0.0.1') {
  if (!port || port < 1 || port > 65535) return false;
  return new Promise((resolve) => {
    const tester = net.createServer();
    tester.once('error', () => resolve(false));
    tester.once('listening', () => {
      tester.close(() => resolve(true));
    });
    tester.listen(port, host);
  });
}

async function getFreePortAbove30000(min = 30000, max = 65535) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const candidate = Math.floor(Math.random() * (max - min + 1)) + min;
    if (await isPortFree(candidate)) return candidate;
  }
  return 0;
}

async function pfStart(ref, contextName, namespace, targetArg, targetPortArg, localPortArg, sid, getMainWindow, opts = {}) {
  const isObjTarget = typeof targetArg === 'object' && targetArg !== null;
  const target = isObjTarget
    ? targetArg
    : { kind: 'pod', name: targetArg, remotePort: Number(targetPortArg) || 0 };

  let rawLocalPort = 0;
  if (isObjTarget) {
    rawLocalPort = Number(target.localPort) || (typeof targetPortArg === 'number' ? targetPortArg : 0);
  } else {
    rawLocalPort = Number(localPortArg) || 0;
  }

  let sessionId = isObjTarget ? target.sid : null;
  if (!sessionId) {
    if (typeof sid === 'string' && sid) sessionId = sid;
    else if (typeof localPortArg === 'string' && localPortArg) sessionId = localPortArg;
    else if (typeof targetPortArg === 'string' && targetPortArg) sessionId = targetPortArg;
    else sessionId = crypto.randomUUID();
  }

  const options = (typeof opts === 'object' && opts !== null) ? opts : ((typeof getMainWindow === 'object' && getMainWindow !== null) ? getMainWindow : {});
  const openBrowserOption = Boolean(options.openBrowser || target.openBrowser || options.autoOpen);

  sessionManager.removeSession(sessionId, getMainWindow);

  let requestedLocalPort = Number(rawLocalPort) || 0;

  const resolved = await resolveTargetPod(ref, contextName, namespace, target);
  if (!resolved.ok) {
    const statusMsg = resolved.status === 'pending' ? 'pending' : 'error';
    sessionManager.emitSessionEvent(
      { kind: 'port-forward', type: 'status', sessionId: sid, status: statusMsg, message: resolved.error || resolved.reason },
      getMainWindow
    );
    return { ok: false, status: statusMsg, error: resolved.error || resolved.reason };
  }

  if (!requestedLocalPort || requestedLocalPort === 0) {
    requestedLocalPort = await getFreePortAbove30000(30000, 65535);
  }

  const metadata = {
    context: contextName,
    namespace,
    kind: target.kind || 'pod',
    name: target.name || target.pod,
    remotePort: target.remotePort || resolved.containerPort,
    containerPort: resolved.containerPort,
    localPort: requestedLocalPort,
    displayName: target.displayName || target.name,
    openBrowser: openBrowserOption,
    createdAt: new Date().toISOString(),
  };

  try {
    const kc = buildKubeConfig(ref, contextName);
    const forward = new k8s.PortForward(kc);

    const sockets = new Set();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => sockets.delete(socket));

      forward.portForward(namespace, resolved.podName, [resolved.containerPort], socket, null, socket).catch((e) => {
        try { socket.destroy(); } catch { /* ignore */ }
        sessionManager.emitSessionEvent(
          { kind: 'port-forward', type: 'error', sessionId, message: e.message },
          getMainWindow
        );
      });
    });

    server.on('error', (e) => {
      sessionManager.emitSessionEvent(
        { kind: 'port-forward', type: 'status', sessionId, status: 'error', message: e.message },
        getMainWindow
      );
      stopPortForwardSession(sessionId, getMainWindow);
    });

    await new Promise((resolve, reject) => {
      const onError = (e) => reject(e);
      server.once('error', onError);
      server.listen(requestedLocalPort || 0, '127.0.0.1', () => {
        server.removeListener('error', onError);
        resolve();
      });
    });

    const boundPort = server.address().port;
    metadata.localPort = boundPort;

    const pfSession = {
      id: sessionId,
      kind: 'port-forward',
      status: 'active',
      metadata,
      server,
      sockets,
      describe() {
        return {
          sessionId,
          kind: 'port-forward',
          status: this.status,
          metadata: this.metadata,
        };
      },
      dispose() {
        try {
          if (typeof server.closeAllConnections === 'function') {
            server.closeAllConnections();
          }
        } catch { /* ignore */ }

        for (const socket of sockets) {
          try {
            socket.destroy();
          } catch { /* ignore */ }
        }
        sockets.clear();

        try {
          server.close();
        } catch { /* ignore */ }
      },
    };

    sessionManager.registerSession(pfSession);
    persistAddForward({ sid: sessionId, ref, contextName, namespace, target: { ...target, remotePort: resolved.containerPort }, localPort: boundPort, openBrowser: openBrowserOption });

    sessionManager.emitSessionEvent(
      { kind: 'port-forward', type: 'status', sessionId, status: 'active', localPort: boundPort, podName: resolved.podName },
      getMainWindow
    );

    if (openBrowserOption) {
      openLocalBrowser(boundPort);
    }

    return { ok: true, localPort: boundPort, podName: resolved.podName, containerPort: resolved.containerPort, remotePort: metadata.remotePort };
  } catch (e) {
    sessionManager.emitSessionEvent(
      { kind: 'port-forward', type: 'status', sessionId, status: 'error', message: e.message },
      getMainWindow
    );
    return { ok: false, error: e.message };
  }
}

async function pfStop(sid, getMainWindow = null) {
  stopPortForwardSession(sid, getMainWindow);
  return { ok: true };
}

async function restoreSavedForwards(ref, getMainWindow) {
  const saved = loadSavedForwards();
  const results = [];
  for (const entry of saved) {
    if (entry.sid && entry.target) {
      const res = await pfStart(entry.ref || ref, entry.contextName, entry.namespace, entry.target, entry.localPort, entry.sid, getMainWindow, { openBrowser: entry.openBrowser });
      results.push({ sid: entry.sid, ...res });
    }
  }
  return results;
}

module.exports = {
  pfStart,
  pfStop,
  openLocalBrowser,
  stopPortForwardSession,
  stopAllPortForwardSessions,
  restoreSavedForwards,
  loadSavedForwards,
};
