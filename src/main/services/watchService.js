const k8s = require('@kubernetes/client-node');
const { buildKubeConfig, getCachedApiClients } = require('../utils/k8sHelper');
const { projectRow } = require('../utils/resourceFormatter');
const { ALL_NAMESPACES, KIND_WATCH_META } = require('../constants/k8sConstants');
const { listKindItems } = require('./k8sService');

const watchSessions = new Map();

function stopWatchSession(sid) {
  const session = watchSessions.get(sid);
  if (!session) return;
  session.stopped = true;
  clearTimeout(session.reconnectTimer);
  try { session.req && session.req.abort(); } catch { /* already closed */ }
  watchSessions.delete(sid);
}

function stopAllWatchSessions() {
  for (const sid of watchSessions.keys()) {
    stopWatchSession(sid);
  }
}

async function seedAndWatch(sid, ref, contextName, namespace, kind, getMainWindow) {
  const session = watchSessions.get(sid);
  if (!session || session.stopped) return;
  const sendIfAlive = (channel, ...args) => {
    const win = getMainWindow ? getMainWindow() : null;
    if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
  };
  let body;
  try {
    const { apis } = getCachedApiClients(ref, contextName);
    const allNs = namespace === ALL_NAMESPACES;
    body = await listKindItems(apis, kind, namespace, allNs);
  } catch (e) {
    if (session.stopped) return;
    sendIfAlive(`watch-error:${sid}`, { message: e.message, permanent: true });
    return;
  }
  if (session.stopped) return;
  sendIfAlive(`watch-sync:${sid}`, { rows: (body.items || []).map((item) => projectRow(kind, item)) });
  session.resourceVersion = body.metadata?.resourceVersion || null;
  runWatchLoop(sid, ref, contextName, namespace, kind, getMainWindow);
}

function runWatchLoop(sid, ref, contextName, namespace, kind, getMainWindow) {
  const session = watchSessions.get(sid);
  if (!session || session.stopped) return;
  const sendIfAlive = (channel, ...args) => {
    const win = getMainWindow ? getMainWindow() : null;
    if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
  };

  function scheduleReconnect() {
    if (session.stopped || session.reconnectTimer) return;
    sendIfAlive(`watch-error:${sid}`, { message: 'Reconnecting…', permanent: false });
    session.backoffMs = Math.min(session.backoffMs * 2, 30000);
    session.reconnectTimer = setTimeout(() => {
      session.reconnectTimer = null;
      seedAndWatch(sid, ref, contextName, namespace, kind, getMainWindow);
    }, session.backoffMs);
  }

  const meta = KIND_WATCH_META[kind];
  const allNs = namespace === ALL_NAMESPACES;
  const path = meta.path(meta.namespaced && !allNs ? namespace : null);

  let kc;
  try {
    kc = buildKubeConfig(ref, contextName);
  } catch (e) {
    if (!session.everConnected) { sendIfAlive(`watch-error:${sid}`, { message: e.message, permanent: true }); return; }
    scheduleReconnect();
    return;
  }
  const watch = new k8s.Watch(kc);

  watch.watch(path, { resourceVersion: session.resourceVersion, allowWatchBookmarks: true }, (phase, apiObj) => {
    if (session.stopped) return;
    session.everConnected = true;
    if (phase === 'ERROR') {
      try { session.req && session.req.abort(); } catch { /* already closing */ }
      scheduleReconnect();
      return;
    }
    if (phase === 'BOOKMARK') {
      session.resourceVersion = apiObj.metadata?.resourceVersion || session.resourceVersion;
      return;
    }
    session.backoffMs = 1000;
    session.resourceVersion = apiObj.metadata?.resourceVersion || session.resourceVersion;
    sendIfAlive(`watch-event:${sid}`, { type: phase, row: projectRow(kind, apiObj) });
  }, (err) => {
    if (session.stopped) return;
    if (!session.everConnected) {
      sendIfAlive(`watch-error:${sid}`, { message: err ? err.message : 'Watch closed', permanent: true });
      return;
    }
    scheduleReconnect();
  }).then((req) => {
    if (session.stopped) { try { req.abort(); } catch { /* already closing */ } return; }
    session.req = req;
  }).catch((e) => {
    if (session.stopped) return;
    if (!session.everConnected) {
      sendIfAlive(`watch-error:${sid}`, { message: e.message, permanent: true });
      return;
    }
    scheduleReconnect();
  });
}

async function watchStart(ref, contextName, namespace, kind, sid, getMainWindow) {
  if (!KIND_WATCH_META[kind]) return { ok: false, error: `Kind not watchable: ${kind}` };
  stopWatchSession(sid);
  watchSessions.set(sid, {
    stopped: false, req: null, resourceVersion: null,
    backoffMs: 1000, everConnected: false, reconnectTimer: null,
  });
  seedAndWatch(sid, ref, contextName, namespace, kind, getMainWindow);
  return { ok: true };
}

async function watchStop(sid) {
  stopWatchSession(sid);
  return { ok: true };
}

module.exports = {
  watchSessions,
  stopWatchSession,
  stopAllWatchSessions,
  watchStart,
  watchStop,
};
