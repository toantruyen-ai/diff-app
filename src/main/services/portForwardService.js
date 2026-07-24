const net = require('net');
const k8s = require('@kubernetes/client-node');
const { buildKubeConfig } = require('../utils/k8sHelper');

const pfSessions = new Map();

function stopPortForwardSession(sid) {
  const session = pfSessions.get(sid);
  if (!session) return;
  try { session.server.close(); } catch { /* already closed */ }
  pfSessions.delete(sid);
}

function stopAllPortForwardSessions() {
  for (const sid of pfSessions.keys()) {
    stopPortForwardSession(sid);
  }
}

async function pfStart(ref, contextName, namespace, pod, targetPort, localPort, sid, getMainWindow) {
  stopPortForwardSession(sid);

  const sendIfAlive = (channel, ...args) => {
    const win = getMainWindow ? getMainWindow() : null;
    if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
  };

  try {
    const kc = buildKubeConfig(ref, contextName);
    const forward = new k8s.PortForward(kc);

    const server = net.createServer((socket) => {
      forward.portForward(namespace, pod, [targetPort], socket, null, socket).catch((e) => {
        try { socket.destroy(); } catch { /* already closed */ }
        sendIfAlive(`pf-error:${sid}`, e.message);
      });
    });
    server.on('error', (e) => {
      sendIfAlive(`pf-error:${sid}`, e.message);
      stopPortForwardSession(sid);
    });

    await new Promise((resolve, reject) => {
      const onError = (e) => reject(e);
      server.once('error', onError);
      server.listen(localPort || 0, '127.0.0.1', () => {
        server.removeListener('error', onError);
        resolve();
      });
    });

    pfSessions.set(sid, { server });
    return { ok: true, localPort: server.address().port };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function pfStop(sid) {
  stopPortForwardSession(sid);
  return { ok: true };
}

module.exports = {
  pfSessions,
  stopPortForwardSession,
  stopAllPortForwardSessions,
  pfStart,
  pfStop,
};
