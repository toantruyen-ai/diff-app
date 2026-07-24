const k8s = require('@kubernetes/client-node');
const eventsDb = require('../db/eventsDb');
const { buildKubeConfig } = require('../utils/k8sHelper');

let activeWatcherRequest = null;
let isWatchingEvents = false;
let eventWatchTimeout = null;
let currentWatcherRef = null;
let currentWatcherContext = null;
let currentWatcherNamespace = null;
let currentWatcherRetention = 0;

async function startEventWatch(ref, contextName, namespace, retentionDays) {
  stopEventWatch();
  
  if (!ref) return;

  isWatchingEvents = true;
  currentWatcherRef = ref;
  currentWatcherContext = contextName;
  currentWatcherNamespace = namespace;
  currentWatcherRetention = Number(retentionDays) || 0;

  eventsDb.switchCluster(ref, contextName);

  const makeWatch = async () => {
    if (!isWatchingEvents) return;
    
    try {
      const kc = buildKubeConfig(ref, contextName);
      const watch = new k8s.Watch(kc);
      
      const allNs = namespace === '__all__' || !namespace;
      const watchPath = allNs ? '/api/v1/events' : `/api/v1/namespaces/${namespace}/events`;
      
      console.log(`[Event Watcher] Starting watcher on path: ${watchPath}`);
      
      const req = await watch.watch(
        watchPath,
        { allowWatchBookmarks: true },
        async (type, obj) => {
          if (!isWatchingEvents) return;
          if (type === 'ADDED' || type === 'MODIFIED') {
            try {
              await eventsDb.saveEvent({
                uid: obj.metadata?.uid,
                namespace: obj.metadata?.namespace,
                involvedKind: obj.involvedObject?.kind,
                involvedName: obj.involvedObject?.name,
                reason: obj.reason,
                message: obj.message,
                type: obj.type,
                count: obj.count,
                firstTimestamp: obj.firstTimestamp,
                lastTimestamp: obj.lastTimestamp
              });
              
              if (currentWatcherRetention > 0) {
                await eventsDb.cleanOldEvents(currentWatcherRetention);
              }
            } catch (err) {
              console.error('[Event Watcher] Error saving event to SQLite:', err.message);
            }
          }
        },
        (err) => {
          if (err) {
            console.error('[Event Watcher] Watcher error callback:', err.message);
          }
          if (isWatchingEvents) {
            console.log('[Event Watcher] Reconnecting event watcher in 5s...');
            clearTimeout(eventWatchTimeout);
            eventWatchTimeout = setTimeout(makeWatch, 5000);
          }
        }
      );
      
      activeWatcherRequest = req;
    } catch (e) {
      console.error('[Event Watcher] Failed to initialize event watch:', e.message);
      if (isWatchingEvents) {
        clearTimeout(eventWatchTimeout);
        eventWatchTimeout = setTimeout(makeWatch, 10000);
      }
    }
  };

  await makeWatch();
}

function stopEventWatch() {
  isWatchingEvents = false;
  clearTimeout(eventWatchTimeout);
  if (activeWatcherRequest) {
    try {
      activeWatcherRequest.abort();
    } catch { /* ignore */ }
    activeWatcherRequest = null;
  }
}

function setEventRetention(retentionDays) {
  currentWatcherRetention = Number(retentionDays) || 0;
  if (currentWatcherRetention > 0) {
    return eventsDb.cleanOldEvents(currentWatcherRetention);
  }
  return Promise.resolve();
}

module.exports = {
  eventsDb,
  startEventWatch,
  stopEventWatch,
  setEventRetention,
};
