const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const k8s = require('@kubernetes/client-node');
const fs = require('fs');
const eventsDb = require('./events-db');
const auditDb = require('./audit-db');
const { execSync, spawn, exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const os = require('os');

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message || `Request timed out after ${ms / 1000}s`)), ms);
    }),
  ]);
}

app.setName('Diff-App');

// ── Auto-updater (packaged app only) ──────────────────────────────────────────
let autoUpdater = null;
if (app.isPackaged) {
  try {
    autoUpdater = require('electron-updater').autoUpdater;
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.logger = null;

    autoUpdater.on('update-available', (info) => {
      if (mainWindow) mainWindow.webContents.send('update-available', info.version);
    });
  } catch {
    autoUpdater = null;
  }
}

// When launched as a packaged app, the process inherits a bare PATH and
// kubelogin/kubectl plugins are not found. Spawn a login shell once to
// read the user's real PATH and inject it. Applies to macOS and Linux.
if ((process.platform === 'darwin' || process.platform === 'linux') && app.isPackaged) {
  try {
    const shell = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
    const shellPath = execSync(`${shell} -l -c 'echo $PATH'`, {
      encoding: 'utf8',
      timeout: 3000,
    }).trim();
    if (shellPath) process.env.PATH = shellPath;
  } catch {
    // Fallback: prepend common kubelogin install locations
    const home = os.homedir();
    const extra = process.platform === 'darwin'
      ? ['/opt/homebrew/bin']
      : ['/usr/bin', '/snap/bin'];
    process.env.PATH = [
      `${home}/.krew/bin`,
      '/usr/local/bin',
      ...extra,
      process.env.PATH,
    ].join(':');
  }
}

let mainWindow;

const ICON_PATH = path.join(__dirname, 'build', 'icon.png');

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0f1117',
    icon: ICON_PATH,
    show: false,
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    // Check for updates 5 s after window is visible to not block startup
    if (autoUpdater) setTimeout(() => autoUpdater.checkForUpdates().catch(() => { }), 5000);
  });
  mainWindow.on('closed', () => {
    // Pod log streams, exec sessions, and port-forward listeners hold open connections to the
    // cluster (or a local port) — abort them all, otherwise they keep running after the window is gone.
    for (const sid of logSessions.keys()) stopLogSession(sid);
    for (const sid of execSessions.keys()) stopExecSession(sid);
    for (const sid of pfSessions.keys()) stopPortForwardSession(sid);
    for (const sid of watchSessions.keys()) stopWatchSession(sid);
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  if (process.platform === 'darwin' && app.dock) {
    try { app.dock.setIcon(ICON_PATH); } catch { /* icon missing — non-fatal */ }
  }
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ── In-memory kubeconfig store (AKS credentials) ─────────────────────────────
// Keys: 'aks:N'. Values: raw YAML string (normalized). Avoids passing large
// YAML blobs through IPC on every k8s API call.
const aksKcStore = new Map();
let aksKcIdSeq = 0;

// LRU-capped: picking clusters repeatedly (re-opening the picker, switching back and forth)
// would otherwise grow this Map forever since entries were never evicted.
const AKS_KC_STORE_MAX = 20;

function storeAksKc(raw) {
  const kcId = `aks:${++aksKcIdSeq}`;
  aksKcStore.set(kcId, raw);
  while (aksKcStore.size > AKS_KC_STORE_MAX) {
    aksKcStore.delete(aksKcStore.keys().next().value); // oldest (insertion order)
  }
  return kcId;
}

// Bumps an entry to "most recently used" on read so an actively-polled cluster is never
// evicted purely due to insertion order — only genuinely stale/abandoned entries are.
function touchAksKc(ref) {
  const raw = aksKcStore.get(ref);
  aksKcStore.delete(ref);
  aksKcStore.set(ref, raw);
  return raw;
}

// ── IPC handlers ──────────────────────────────────────────────────────────────

ipcMain.handle('trigger-update', () => {
  const cmd = `curl -fsSL https://raw.githubusercontent.com/toantruyen-ai/diff-app/refs/heads/main/install.sh | bash`;
  exec(`osascript -e 'tell application "Terminal" to activate' -e 'tell application "Terminal" to do script "${cmd}"'`);
});

ipcMain.handle('select-kubeconfig', async () => {
  const { filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Select kubeconfig file',
    defaultPath: path.join(app.getPath('home'), '.kube'),
    filters: [
      { name: 'kubeconfig', extensions: ['yaml', 'yml', 'json', ''] },
      { name: 'All Files', extensions: ['*'] },
    ],
    properties: ['openFile'],
  });
  return filePaths[0] || null;
});

ipcMain.handle('load-contexts', async (_e, ref) => {
  try {
    const kc = buildKubeConfig(ref, null);
    return kc.getContexts().map((ctx) => ctx.name);
  } catch (e) {
    throw new Error(`Failed to load contexts: ${e.message}`);
  }
});

ipcMain.handle('load-namespaces', async (_e, kubeconfigPath, contextName) => {
  try {
    const kc = buildKubeConfig(kubeconfigPath, contextName);
    // Try cluster-wide namespace list first; fall back to kubeconfig context namespaces
    try {
      const coreApi = kc.makeApiClient(k8s.CoreV1Api);
      const res = await withTimeout(
        coreApi.listNamespace(),
        20000,
        'Timed out listing namespaces — kubelogin may need re-authentication (run: kubelogin convert-kubeconfig -l azurecli)'
      );
      return res.body.items.map((ns) => ns.metadata.name).sort();
    } catch (apiErr) {
      // RBAC may deny cluster-wide list — extract namespaces from kubeconfig contexts
      const namespaces = new Set();
      kc.getContexts().forEach((ctx) => {
        if (ctx.namespace) namespaces.add(ctx.namespace);
      });
      if (namespaces.size === 0) throw new Error(`Cannot list namespaces: ${apiErr.message}`);
      return Array.from(namespaces).sort();
    }
  } catch (e) {
    throw new Error(e.message);
  }
});

ipcMain.handle('load-deployments', async (_e, kubeconfigPath, contextName, namespace) => {
  try {
    const kc = buildKubeConfig(kubeconfigPath, contextName);
    const appsApi = kc.makeApiClient(k8s.AppsV1Api);
    const res = await withTimeout(
      appsApi.listNamespacedDeployment(namespace),
      20000,
      'Timed out listing deployments — kubelogin may need re-authentication'
    );
    return res.body.items.map((d) => d.metadata.name).sort();
  } catch (e) {
    throw new Error(`Failed to load deployments: ${e.message}`);
  }
});

ipcMain.handle('load-envs', async (_e, kubeconfigPath, contextName, namespace, deploymentName) => {
  const kc = buildKubeConfig(kubeconfigPath, contextName);
  const appsApi = kc.makeApiClient(k8s.AppsV1Api);
  const coreApi = kc.makeApiClient(k8s.CoreV1Api);

  const depRes = await withTimeout(
    appsApi.readNamespacedDeployment(deploymentName, namespace),
    20000,
    'Timed out reading deployment — kubelogin may need re-authentication'
  );
  const containers = depRes.body.spec.template.spec.containers || [];

  const envMap = {};

  for (const container of containers) {
    // 1. envFrom: configmap / secret bulk import
    for (const envFrom of container.envFrom || []) {
      if (envFrom.configMapRef) {
        const cmName = envFrom.configMapRef.name;
        try {
          const cmRes = await coreApi.readNamespacedConfigMap(cmName, namespace);
          const data = cmRes.body.data || {};
          const prefix = envFrom.prefix || '';
          for (const [k, v] of Object.entries(data)) {
            envMap[prefix + k] = { value: v, source: `ConfigMap:${cmName}` };
          }
        } catch {
          envMap[`<${cmName}>`] = { value: '<error reading configmap>', source: `ConfigMap:${cmName}` };
        }
      }
      if (envFrom.secretRef) {
        const secName = envFrom.secretRef.name;
        try {
          const secRes = await coreApi.readNamespacedSecret(secName, namespace);
          const data = secRes.body.data || {};
          const prefix = envFrom.prefix || '';
          for (const [k, v] of Object.entries(data)) {
            const decoded = Buffer.from(v, 'base64').toString('utf-8');
            envMap[prefix + k] = { value: decoded, source: `Secret:${secName}` };
          }
        } catch {
          envMap[`<${secName}>`] = { value: '<error reading secret>', source: `Secret:${secName}` };
        }
      }
    }

    // 2. Direct env / valueFrom
    for (const envVar of container.env || []) {
      if (envVar.value !== undefined) {
        envMap[envVar.name] = { value: envVar.value, source: 'Direct' };
      } else if (envVar.valueFrom) {
        const vf = envVar.valueFrom;
        if (vf.configMapKeyRef) {
          const cmName = vf.configMapKeyRef.name;
          const cmKey = vf.configMapKeyRef.key;
          try {
            const cmRes = await coreApi.readNamespacedConfigMap(cmName, namespace);
            const val = (cmRes.body.data || {})[cmKey];
            envMap[envVar.name] = { value: val ?? '<key not found>', source: `ConfigMap:${cmName}[${cmKey}]` };
          } catch {
            envMap[envVar.name] = { value: '<error reading configmap>', source: `ConfigMap:${cmName}[${cmKey}]` };
          }
        } else if (vf.secretKeyRef) {
          const secName = vf.secretKeyRef.name;
          const secKey = vf.secretKeyRef.key;
          try {
            const secRes = await coreApi.readNamespacedSecret(secName, namespace);
            const raw = (secRes.body.data || {})[secKey];
            const val = raw ? Buffer.from(raw, 'base64').toString('utf-8') : '<key not found>';
            envMap[envVar.name] = { value: val, source: `Secret:${secName}[${secKey}]` };
          } catch {
            envMap[envVar.name] = { value: '<error reading secret>', source: `Secret:${secName}[${secKey}]` };
          }
        } else if (vf.fieldRef) {
          envMap[envVar.name] = { value: `fieldRef:${vf.fieldRef.fieldPath}`, source: 'FieldRef' };
        } else if (vf.resourceFieldRef) {
          envMap[envVar.name] = { value: `resourceField:${vf.resourceFieldRef.resource}`, source: 'ResourceFieldRef' };
        }
      }
    }
  }

  return envMap;
});

ipcMain.handle('get-token-expiry', async () => {
  try {
    const output = execSync('az account get-access-token --output json', {
      encoding: 'utf8',
      timeout: 10000,
      stdio: 'pipe',
    });
    const data = JSON.parse(output);
    // expires_on is a Unix timestamp (seconds); expiresOn is a datetime string
    const expiresAt = data.expires_on
      ? data.expires_on * 1000
      : new Date(data.expiresOn.replace(' ', 'T')).getTime();
    return { ok: true, expiresAt };
  } catch {
    return { ok: false };
  }
});

ipcMain.handle('check-azure-auth', async () => {
  try {
    execSync('az account get-access-token --output none', { encoding: 'utf8', timeout: 8000, stdio: 'pipe' });
    return { ok: true };
  } catch {
    return { ok: false };
  }
});

ipcMain.handle('check-kubelogin-auth', async () => {
  // We always convert AKS kubeconfigs to azurecli login mode, which reads tokens
  // directly from Azure CLI and does not use this cache directory.
  // Stale cache files from old non-azurecli sessions would cause false positives,
  // so we clean them up and skip the check — Azure CLI auth (check-azure-auth) is sufficient.
  const cacheDir = path.join(os.homedir(), '.kube', 'cache', 'kubelogin');
  try {
    if (fs.existsSync(cacheDir)) {
      const now = Math.floor(Date.now() / 1000);
      for (const file of fs.readdirSync(cacheDir).filter((f) => f.endsWith('.json'))) {
        try {
          const filePath = path.join(cacheDir, file);
          const content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
          const token = content.accessToken || content.access_token;
          if (token) {
            const parts = token.split('.');
            if (parts.length === 3) {
              const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
              if (payload.exp && payload.exp < now) {
                try { fs.unlinkSync(filePath); } catch { /* ignore */ }
              }
            }
          }
        } catch { /* skip unreadable cache file */ }
      }
    }
  } catch { /* ignore */ }
  return { ok: true };
});

ipcMain.handle('az-logout', async () => {
  try {
    execSync('az logout', { encoding: 'utf8', timeout: 5000, stdio: 'pipe' });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e.stderr || e.message) };
  }
});

ipcMain.handle('az-login', async () => {
  return new Promise((resolve) => {
    const proc = spawn('az', ['login'], { shell: true, stdio: 'pipe' });
    proc.on('close', (code) => resolve({ ok: code === 0 }));
    proc.on('error', (err) => resolve({ ok: false, error: err.message }));
  });
});

ipcMain.handle('kubelogin-refresh', async () => {
  try {
    execSync('kubelogin convert-kubeconfig -l azurecli', {
      encoding: 'utf8',
      timeout: 10000,
      stdio: 'pipe',
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e.stderr || e.message) };
  }
});

ipcMain.handle('list-aks-clusters', async () => {
  try {
    const output = execSync(
      'az aks list --query "[?tags.diff==\'true\']" --output json',
      { encoding: 'utf8', timeout: 30000, stdio: 'pipe' }
    );
    const clusters = JSON.parse(output);
    return {
      ok: true,
      clusters: clusters.map((c) => ({
        name: c.name,
        resourceGroup: c.resourceGroup,
        location: c.location,
        kubernetesVersion: c.kubernetesVersion,
        environment: (c.tags && c.tags.environment) ? c.tags.environment : '',
      })),
    };
  } catch (e) {
    return { ok: false, error: String(e.stderr || e.message) };
  }
});

ipcMain.handle('get-aks-credentials', async (_e, name, resourceGroup) => {
  const tmpFile = path.join(os.tmpdir(), `k8senvdiff-${process.pid}-${Date.now()}.yaml`);
  try {
    execSync(
      `az aks get-credentials --name "${name}" --resource-group "${resourceGroup}" --file "${tmpFile}" --overwrite-existing`,
      { encoding: 'utf8', timeout: 30000, stdio: 'pipe' }
    );
    // Convert exec plugin to azurecli login mode so kubelogin uses the Azure CLI
    // token non-interactively. Without this, kubelogin defaults to device-code/browser auth.
    try {
      execSync(`kubelogin convert-kubeconfig -l azurecli --kubeconfig "${tmpFile}"`, {
        encoding: 'utf8',
        timeout: 10000,
        stdio: 'pipe',
      });
    } catch {
      // kubelogin not installed or conversion failed — proceed with original kubeconfig
    }
    // Normalize: strip BOM + leading whitespace, then validate by parsing once
    const raw = fs.readFileSync(tmpFile, 'utf8').replace(/^﻿/, '').trimStart();
    const kc = new k8s.KubeConfig();
    kc.loadFromString(raw);
    if (!kc.getCurrentCluster()) {
      return { ok: false, error: `Kubeconfig for "${name}" has no active cluster after parsing` };
    }
    const kcId = storeAksKc(raw);
    return { ok: true, kubeconfigId: kcId };
  } catch (e) {
    return { ok: false, error: String(e.stderr || e.message) };
  } finally {
    try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
  }
});

ipcMain.handle('list-storage-accounts', async () => {
  try {
    const output = execSync(
      'az storage account list --query "[?tags.diff==\'true\']" --output json',
      { encoding: 'utf8', timeout: 30000, stdio: 'pipe' }
    );
    const accounts = JSON.parse(output);
    return {
      ok: true,
      accounts: accounts.map((a) => ({
        name: a.name,
        resourceGroup: a.resourceGroup,
        location: a.location,
        environment: (a.tags && a.tags.environment) ? a.tags.environment : '',
      })),
    };
  } catch (e) {
    return { ok: false, error: String(e.stderr || e.message) };
  }
});

ipcMain.handle('list-storage-containers', async (_e, accounts) => {
  const results = await Promise.all(accounts.map(async (account) => {
    try {
      const { stdout } = await execAsync(
        `az storage container list --account-name "${account.name}" --auth-mode login --output json`,
        { timeout: 60000 }
      );
      const containers = JSON.parse(stdout.trim() || '[]');
      return {
        name: account.name,
        environment: account.environment || '',
        containers: containers.map((c) => c.name),
        ok: true,
      };
    } catch (e) {
      return {
        name: account.name,
        environment: account.environment || '',
        containers: [],
        ok: false,
        error: String(e.stderr || e.message).split('\n')[0],
      };
    }
  }));
  return results;
});

ipcMain.handle('list-servicebus-namespaces', async () => {
  try {
    const output = execSync(
      'az servicebus namespace list --query "[?tags.diff==\'true\']" --output json',
      { encoding: 'utf8', timeout: 30000, stdio: 'pipe' }
    );
    const namespaces = JSON.parse(output);
    return {
      ok: true,
      namespaces: namespaces.map((n) => ({
        name: n.name,
        resourceGroup: n.resourceGroup,
        location: n.location,
        environment: (n.tags && n.tags.environment) ? n.tags.environment : '',
      })),
    };
  } catch (e) {
    return { ok: false, error: String(e.stderr || e.message) };
  }
});

ipcMain.handle('list-servicebus-queues', async (_e, namespaces) => {
  const results = await Promise.all(namespaces.map(async (ns) => {
    try {
      const { stdout } = await execAsync(
        `az servicebus queue list --namespace-name "${ns.name}" --resource-group "${ns.resourceGroup}" --output json`,
        { timeout: 60000 }
      );
      const queues = JSON.parse(stdout.trim() || '[]');
      return {
        name: ns.name,
        environment: ns.environment || '',
        queues: queues.map((q) => q.name),
        ok: true,
      };
    } catch (e) {
      return {
        name: ns.name,
        environment: ns.environment || '',
        queues: [],
        ok: false,
        error: String(e.stderr || e.message).split('\n')[0],
      };
    }
  }));
  return results;
});

// ── K8s Manage: resource listing ─────────────────────────────────────────────

const MANAGE_KINDS = [
  'pods', 'deployments', 'statefulsets', 'daemonsets', 'replicasets',
  'services', 'ingresses', 'configmaps', 'secrets',
  'jobs', 'cronjobs', 'pvcs', 'hpas',
  'nodes', 'pvs', 'namespaces', 'events',
  'serviceaccounts', 'roles', 'rolebindings', 'clusterroles', 'clusterrolebindings',
  'networkpolicies', 'storageclasses', 'resourcequotas', 'limitranges',
];

// Sentinel the renderer sends as the `namespace` arg to browse a kind across every namespace.
const ALL_NAMESPACES = '__all__';

// These ignore whatever namespace is selected — always listed/read cluster-wide.
const MANAGE_CLUSTER_SCOPED_KINDS = ['nodes', 'pvs', 'namespaces', 'clusterroles', 'clusterrolebindings', 'storageclasses'];

// Kinds eligible for "restore a deleted resource" (Recycle Bin). Deliberately excludes
// owner-managed/infra kinds where recreating makes no sense (pods, replicasets — their
// parent recreates them; events — ephemeral; nodes/pvs — cluster/cloud-provisioned) and
// secrets (values are stored redacted at delete time and cannot be recovered).
const RESTORABLE_KINDS = new Set([
  'deployments', 'statefulsets', 'daemonsets', 'services', 'ingresses', 'configmaps',
  'jobs', 'cronjobs', 'pvcs', 'hpas', 'namespaces',
  'serviceaccounts', 'roles', 'rolebindings', 'clusterroles', 'clusterrolebindings',
  'networkpolicies', 'storageclasses', 'resourcequotas', 'limitranges',
]);

// ── K8s Manage: real-time watch (Phase 16) ───────────────────────────────────
// Only the high-churn workload-controller kinds get a real k8s watch stream — these are the
// resources that change *during normal operational activity* (a rollout cascades through
// Deployment → ReplicaSet → Pods; a scale changes Pod count; Events fire on every transition),
// and where the old 5s poll delay was most noticeable. Everything else (Services, ConfigMaps,
// Secrets, RBAC/Policy kinds, Nodes, PVs/PVCs, HPAs, CronJobs, Namespaces, and all CRDs) is
// genuinely low-churn or not worth the added complexity yet — it stays on the existing poll
// timer. Metrics (get-metrics) is unaffected either way — metrics-server has no watch API.
const WATCH_ENABLED_KINDS = ['pods', 'deployments', 'replicasets', 'statefulsets', 'daemonsets', 'jobs', 'events'];

// REST path builder + namespaced flag per watchable kind. k8s.Watch operates on a raw path,
// not a typed client method, so this is expressed as a path template rather than reusing
// listKindItems's per-method switch (which returns fully-typed list responses, not paths).
const KIND_WATCH_META = {
  pods:         { namespaced: true, path: (ns) => ns ? `/api/v1/namespaces/${ns}/pods` : '/api/v1/pods' },
  events:       { namespaced: true, path: (ns) => ns ? `/api/v1/namespaces/${ns}/events` : '/api/v1/events' },
  deployments:  { namespaced: true, path: (ns) => ns ? `/apis/apps/v1/namespaces/${ns}/deployments` : '/apis/apps/v1/deployments' },
  replicasets:  { namespaced: true, path: (ns) => ns ? `/apis/apps/v1/namespaces/${ns}/replicasets` : '/apis/apps/v1/replicasets' },
  statefulsets: { namespaced: true, path: (ns) => ns ? `/apis/apps/v1/namespaces/${ns}/statefulsets` : '/apis/apps/v1/statefulsets' },
  daemonsets:   { namespaced: true, path: (ns) => ns ? `/apis/apps/v1/namespaces/${ns}/daemonsets` : '/apis/apps/v1/daemonsets' },
  jobs:         { namespaced: true, path: (ns) => ns ? `/apis/batch/v1/namespaces/${ns}/jobs` : '/apis/batch/v1/jobs' },
};

function ageOf(ts) {
  return ts ? new Date(ts).toISOString() : null;
}

function podStatus(pod) {
  const statuses = pod.status?.containerStatuses || [];
  const waiting = statuses.find((s) => s.state && s.state.waiting);
  if (waiting) return waiting.state.waiting.reason || 'Waiting';
  const badTerminated = statuses.find(
    (s) => s.state && s.state.terminated && s.state.terminated.reason && s.state.terminated.reason !== 'Completed'
  );
  if (badTerminated) return badTerminated.state.terminated.reason;
  return pod.status?.phase || 'Unknown';
}

// Project full API objects down to the small set of fields the table/drawer need —
// keeps IPC payloads small and lets one handler cover every resource kind.
// Every row carries `namespace` (empty for cluster-scoped kinds) so the renderer can show a
// Namespace column and resolve the right namespace for per-row actions in all-namespaces mode.
function projectRow(kind, item) {
  const meta = item.metadata || {};
  const base = { namespace: meta.namespace || '' };
  switch (kind) {
    case 'pods': {
      const statuses = item.status?.containerStatuses || [];
      const restarts = statuses.reduce((sum, s) => sum + (s.restartCount || 0), 0);
      return {
        ...base,
        name: meta.name,
        ready: `${statuses.filter((s) => s.ready).length}/${statuses.length}`,
        status: podStatus(item),
        restarts,
        node: item.spec?.nodeName || '',
        age: ageOf(meta.creationTimestamp),
        containers: (item.spec?.containers || []).map((c) => c.name),
      };
    }
    case 'deployments': {
      const spec = item.spec || {};
      const status = item.status || {};
      return {
        ...base,
        name: meta.name,
        ready: `${status.readyReplicas || 0}/${spec.replicas ?? 0}`,
        upToDate: status.updatedReplicas || 0,
        available: status.availableReplicas || 0,
        age: ageOf(meta.creationTimestamp),
      };
    }
    case 'statefulsets': {
      const spec = item.spec || {};
      const status = item.status || {};
      return {
        ...base,
        name: meta.name,
        ready: `${status.readyReplicas || 0}/${spec.replicas ?? 0}`,
        age: ageOf(meta.creationTimestamp),
      };
    }
    case 'daemonsets': {
      const status = item.status || {};
      return {
        ...base,
        name: meta.name,
        desired: status.desiredNumberScheduled || 0,
        current: status.currentNumberScheduled || 0,
        ready: status.numberReady || 0,
        age: ageOf(meta.creationTimestamp),
      };
    }
    case 'replicasets': {
      const spec = item.spec || {};
      const status = item.status || {};
      return {
        ...base,
        name: meta.name,
        desired: spec.replicas ?? 0,
        current: status.replicas || 0,
        ready: status.readyReplicas || 0,
        age: ageOf(meta.creationTimestamp),
      };
    }
    case 'services': {
      const spec = item.spec || {};
      const lbIngress = (item.status?.loadBalancer?.ingress || []).map((i) => i.ip || i.hostname);
      const ports = (spec.ports || [])
        .map((p) => `${p.port}${p.nodePort ? `:${p.nodePort}` : ''}/${p.protocol}`)
        .join(', ');
      return {
        ...base,
        name: meta.name,
        type: spec.type || 'ClusterIP',
        clusterIp: spec.clusterIP || '',
        externalIp: [...(spec.externalIPs || []), ...lbIngress].join(', '),
        ports,
        age: ageOf(meta.creationTimestamp),
      };
    }
    case 'ingresses': {
      const spec = item.spec || {};
      const hosts = (spec.rules || []).map((r) => r.host).filter(Boolean).join(', ');
      const address = (item.status?.loadBalancer?.ingress || []).map((i) => i.ip || i.hostname).join(', ');
      return {
        ...base,
        name: meta.name,
        class: spec.ingressClassName || '',
        hosts,
        address,
        age: ageOf(meta.creationTimestamp),
      };
    }
    case 'configmaps': {
      return { ...base, name: meta.name, keys: Object.keys(item.data || {}).length, age: ageOf(meta.creationTimestamp) };
    }
    case 'secrets': {
      return {
        ...base,
        name: meta.name,
        type: item.type || 'Opaque',
        keys: Object.keys(item.data || {}).length,
        age: ageOf(meta.creationTimestamp),
      };
    }
    case 'jobs': {
      const spec = item.spec || {};
      const status = item.status || {};
      return {
        ...base,
        name: meta.name,
        completions: `${status.succeeded || 0}/${spec.completions ?? 1}`,
        age: ageOf(meta.creationTimestamp),
      };
    }
    case 'cronjobs': {
      const spec = item.spec || {};
      const status = item.status || {};
      return {
        ...base,
        name: meta.name,
        schedule: spec.schedule || '',
        suspend: !!spec.suspend,
        active: (status.active || []).length,
        lastSchedule: ageOf(status.lastScheduleTime),
        age: ageOf(meta.creationTimestamp),
      };
    }
    case 'pvcs': {
      const spec = item.spec || {};
      const status = item.status || {};
      return {
        ...base,
        name: meta.name,
        status: status.phase || '',
        volume: spec.volumeName || '',
        capacity: status.capacity?.storage || '',
        storageClass: spec.storageClassName || '',
        age: ageOf(meta.creationTimestamp),
      };
    }
    case 'hpas': {
      const spec = item.spec || {};
      const status = item.status || {};
      return {
        ...base,
        name: meta.name,
        reference: spec.scaleTargetRef ? `${spec.scaleTargetRef.kind}/${spec.scaleTargetRef.name}` : '',
        minPods: spec.minReplicas ?? 1,
        maxPods: spec.maxReplicas ?? 0,
        replicas: status.currentReplicas || 0,
        age: ageOf(meta.creationTimestamp),
      };
    }
    case 'nodes': {
      const conditions = item.status?.conditions || [];
      const readyCond = conditions.find((c) => c.type === 'Ready');
      const roles = Object.keys(meta.labels || {})
        .filter((l) => l.startsWith('node-role.kubernetes.io/'))
        .map((l) => l.replace('node-role.kubernetes.io/', ''));
      return {
        ...base,
        name: meta.name,
        status: readyCond && readyCond.status === 'True' ? 'Ready' : 'NotReady',
        roles: roles.length ? roles.join(',') : '<none>',
        version: item.status?.nodeInfo?.kubeletVersion || '',
        age: ageOf(meta.creationTimestamp),
        unschedulable: !!item.spec?.unschedulable, // drives the Cordon/Uncordon action button, not shown as a column
      };
    }
    case 'pvs': {
      const spec = item.spec || {};
      const status = item.status || {};
      return {
        ...base,
        name: meta.name,
        capacity: spec.capacity?.storage || '',
        status: status.phase || '',
        claim: spec.claimRef ? `${spec.claimRef.namespace}/${spec.claimRef.name}` : '',
        storageClass: spec.storageClassName || '',
        age: ageOf(meta.creationTimestamp),
      };
    }
    case 'namespaces': {
      return { ...base, name: meta.name, status: item.status?.phase || '', age: ageOf(meta.creationTimestamp) };
    }
    case 'events': {
      return {
        ...base,
        name: meta.name,
        type: item.type || '',
        reason: item.reason || '',
        object: item.involvedObject ? `${item.involvedObject.kind}/${item.involvedObject.name}` : '',
        message: item.message || '',
        age: ageOf(item.lastTimestamp || item.eventTime || meta.creationTimestamp),
      };
    }
    case 'serviceaccounts':
      return { ...base, name: meta.name, secrets: (item.secrets || []).length, age: ageOf(meta.creationTimestamp) };
    case 'roles':
      return { ...base, name: meta.name, rules: (item.rules || []).length, age: ageOf(meta.creationTimestamp) };
    case 'rolebindings':
      return {
        ...base, name: meta.name,
        role: item.roleRef ? `${item.roleRef.kind}/${item.roleRef.name}` : '',
        subjects: (item.subjects || []).length,
        age: ageOf(meta.creationTimestamp),
      };
    case 'clusterroles':
      return { ...base, name: meta.name, rules: (item.rules || []).length, age: ageOf(meta.creationTimestamp) };
    case 'clusterrolebindings':
      return {
        ...base, name: meta.name,
        role: item.roleRef ? `${item.roleRef.kind}/${item.roleRef.name}` : '',
        subjects: (item.subjects || []).length,
        age: ageOf(meta.creationTimestamp),
      };
    case 'networkpolicies': {
      const spec = item.spec || {};
      return {
        ...base,
        name: meta.name,
        podSelector: (spec.podSelector && Object.keys(spec.podSelector.matchLabels || {}).length)
          ? JSON.stringify(spec.podSelector.matchLabels) : '<all pods>',
        policyTypes: (spec.policyTypes || []).join(', '),
        ingressRules: (spec.ingress || []).length,
        egressRules: (spec.egress || []).length,
        age: ageOf(meta.creationTimestamp),
      };
    }
    case 'storageclasses':
      return {
        ...base,
        name: meta.name,
        provisioner: item.provisioner || '',
        reclaimPolicy: item.reclaimPolicy || '',
        volumeBindingMode: item.volumeBindingMode || '',
        isDefault: (meta.annotations || {})['storageclass.kubernetes.io/is-default-class'] === 'true',
        age: ageOf(meta.creationTimestamp),
      };
    case 'resourcequotas': {
      const hard = item.status?.hard || {};
      const used = item.status?.used || {};
      return {
        ...base,
        name: meta.name,
        summary: Object.keys(hard).map((k) => `${k}: ${used[k] ?? '0'}/${hard[k]}`).join(', '),
        age: ageOf(meta.creationTimestamp),
      };
    }
    case 'limitranges':
      return {
        ...base,
        name: meta.name,
        limits: (item.spec?.limits || []).map((l) => l.type).join(', '),
        age: ageOf(meta.creationTimestamp),
      };
    default:
      return { ...base, name: meta.name, age: ageOf(meta.creationTimestamp) };
  }
}

function makeManageApiClients(kc) {
  return {
    core: kc.makeApiClient(k8s.CoreV1Api),
    apps: kc.makeApiClient(k8s.AppsV1Api),
    batch: kc.makeApiClient(k8s.BatchV1Api),
    networking: kc.makeApiClient(k8s.NetworkingV1Api),
    autoscaling: kc.makeApiClient(k8s.AutoscalingV2Api),
    rbac: kc.makeApiClient(k8s.RbacAuthorizationV1Api),
    storage: kc.makeApiClient(k8s.StorageV1Api),
  };
}

// ── Cached KubeConfig + API clients ──────────────────────────────────────────
// Polling handlers (list-resource every 5s, get-metrics every 10s) used to
// rebuild the KubeConfig (YAML parse + authenticator patch) and instantiate 7
// API clients from scratch on every single poll.  This cache stores them keyed
// by (ref, contextName), auto-expiring after 5 minutes so credential rotations
// are still picked up reasonably quickly.
const _apiClientCache = new Map();
const _apiClientCacheTTL = 5 * 60 * 1000; // 5 minutes

function getCachedApiClients(ref, contextName) {
  const cacheKey = `${ref || '__default__'}::${contextName || ''}`;
  const cached = _apiClientCache.get(cacheKey);
  if (cached && (Date.now() - cached.ts) < _apiClientCacheTTL) {
    return cached;
  }
  const kc = buildKubeConfig(ref, contextName);
  const apis = makeManageApiClients(kc);
  const metricsApi = new k8s.Metrics(kc);
  const entry = { kc, apis, metricsApi, ts: Date.now() };
  _apiClientCache.set(cacheKey, entry);
  return entry;
}

// Shared kind-dispatch used by both list-resource and search-resources — avoids duplicating
// the per-kind switch twice. Returns raw API items (not yet projected).
async function listKindItems(apis, kind, namespace, allNs) {
  const { core: coreApi, apps: appsApi, batch: batchApi, networking: networkingApi, autoscaling: autoscalingApi, rbac: rbacApi, storage: storageApi } = apis;
  let res;
  switch (kind) {
    case 'pods':
      res = allNs
        ? await withTimeout(coreApi.listPodForAllNamespaces(), 20000, 'Timed out listing pods')
        : await withTimeout(coreApi.listNamespacedPod(namespace), 20000, 'Timed out listing pods');
      break;
    case 'deployments':
      res = allNs
        ? await withTimeout(appsApi.listDeploymentForAllNamespaces(), 20000, 'Timed out listing deployments')
        : await withTimeout(appsApi.listNamespacedDeployment(namespace), 20000, 'Timed out listing deployments');
      break;
    case 'statefulsets':
      res = allNs
        ? await withTimeout(appsApi.listStatefulSetForAllNamespaces(), 20000, 'Timed out listing statefulsets')
        : await withTimeout(appsApi.listNamespacedStatefulSet(namespace), 20000, 'Timed out listing statefulsets');
      break;
    case 'daemonsets':
      res = allNs
        ? await withTimeout(appsApi.listDaemonSetForAllNamespaces(), 20000, 'Timed out listing daemonsets')
        : await withTimeout(appsApi.listNamespacedDaemonSet(namespace), 20000, 'Timed out listing daemonsets');
      break;
    case 'replicasets':
      res = allNs
        ? await withTimeout(appsApi.listReplicaSetForAllNamespaces(), 20000, 'Timed out listing replicasets')
        : await withTimeout(appsApi.listNamespacedReplicaSet(namespace), 20000, 'Timed out listing replicasets');
      break;
    case 'services':
      res = allNs
        ? await withTimeout(coreApi.listServiceForAllNamespaces(), 20000, 'Timed out listing services')
        : await withTimeout(coreApi.listNamespacedService(namespace), 20000, 'Timed out listing services');
      break;
    case 'ingresses':
      res = allNs
        ? await withTimeout(networkingApi.listIngressForAllNamespaces(), 20000, 'Timed out listing ingresses')
        : await withTimeout(networkingApi.listNamespacedIngress(namespace), 20000, 'Timed out listing ingresses');
      break;
    case 'configmaps':
      res = allNs
        ? await withTimeout(coreApi.listConfigMapForAllNamespaces(), 20000, 'Timed out listing configmaps')
        : await withTimeout(coreApi.listNamespacedConfigMap(namespace), 20000, 'Timed out listing configmaps');
      break;
    case 'secrets':
      res = allNs
        ? await withTimeout(coreApi.listSecretForAllNamespaces(), 20000, 'Timed out listing secrets')
        : await withTimeout(coreApi.listNamespacedSecret(namespace), 20000, 'Timed out listing secrets');
      break;
    case 'jobs':
      res = allNs
        ? await withTimeout(batchApi.listJobForAllNamespaces(), 20000, 'Timed out listing jobs')
        : await withTimeout(batchApi.listNamespacedJob(namespace), 20000, 'Timed out listing jobs');
      break;
    case 'cronjobs':
      res = allNs
        ? await withTimeout(batchApi.listCronJobForAllNamespaces(), 20000, 'Timed out listing cronjobs')
        : await withTimeout(batchApi.listNamespacedCronJob(namespace), 20000, 'Timed out listing cronjobs');
      break;
    case 'pvcs':
      res = allNs
        ? await withTimeout(coreApi.listPersistentVolumeClaimForAllNamespaces(), 20000, 'Timed out listing PVCs')
        : await withTimeout(coreApi.listNamespacedPersistentVolumeClaim(namespace), 20000, 'Timed out listing PVCs');
      break;
    case 'hpas':
      res = allNs
        ? await withTimeout(autoscalingApi.listHorizontalPodAutoscalerForAllNamespaces(), 20000, 'Timed out listing HPAs')
        : await withTimeout(autoscalingApi.listNamespacedHorizontalPodAutoscaler(namespace), 20000, 'Timed out listing HPAs');
      break;
    case 'nodes':      res = await withTimeout(coreApi.listNode(), 20000, 'Timed out listing nodes'); break;
    case 'pvs':        res = await withTimeout(coreApi.listPersistentVolume(), 20000, 'Timed out listing PVs'); break;
    case 'namespaces': res = await withTimeout(coreApi.listNamespace(), 20000, 'Timed out listing namespaces'); break;
    case 'events':
      res = allNs
        ? await withTimeout(coreApi.listEventForAllNamespaces(), 20000, 'Timed out listing events')
        : await withTimeout(coreApi.listNamespacedEvent(namespace), 20000, 'Timed out listing events');
      break;
    case 'serviceaccounts':
      res = allNs
        ? await withTimeout(coreApi.listServiceAccountForAllNamespaces(), 20000, 'Timed out listing service accounts')
        : await withTimeout(coreApi.listNamespacedServiceAccount(namespace), 20000, 'Timed out listing service accounts');
      break;
    case 'roles':
      res = allNs
        ? await withTimeout(rbacApi.listRoleForAllNamespaces(), 20000, 'Timed out listing roles')
        : await withTimeout(rbacApi.listNamespacedRole(namespace), 20000, 'Timed out listing roles');
      break;
    case 'rolebindings':
      res = allNs
        ? await withTimeout(rbacApi.listRoleBindingForAllNamespaces(), 20000, 'Timed out listing role bindings')
        : await withTimeout(rbacApi.listNamespacedRoleBinding(namespace), 20000, 'Timed out listing role bindings');
      break;
    case 'clusterroles':
      res = await withTimeout(rbacApi.listClusterRole(), 20000, 'Timed out listing cluster roles');
      break;
    case 'clusterrolebindings':
      res = await withTimeout(rbacApi.listClusterRoleBinding(), 20000, 'Timed out listing cluster role bindings');
      break;
    case 'networkpolicies':
      res = allNs
        ? await withTimeout(networkingApi.listNetworkPolicyForAllNamespaces(), 20000, 'Timed out listing network policies')
        : await withTimeout(networkingApi.listNamespacedNetworkPolicy(namespace), 20000, 'Timed out listing network policies');
      break;
    case 'storageclasses':
      res = await withTimeout(storageApi.listStorageClass(), 20000, 'Timed out listing storage classes');
      break;
    case 'resourcequotas':
      res = allNs
        ? await withTimeout(coreApi.listResourceQuotaForAllNamespaces(), 20000, 'Timed out listing resource quotas')
        : await withTimeout(coreApi.listNamespacedResourceQuota(namespace), 20000, 'Timed out listing resource quotas');
      break;
    case 'limitranges':
      res = allNs
        ? await withTimeout(coreApi.listLimitRangeForAllNamespaces(), 20000, 'Timed out listing limit ranges')
        : await withTimeout(coreApi.listNamespacedLimitRange(namespace), 20000, 'Timed out listing limit ranges');
      break;
    default:
      throw new Error(`Unknown resource kind: ${kind}`);
  }
  // Full body (not just .items) — the watch-session seeder (below) also needs
  // res.body.metadata.resourceVersion as the starting point for its watch stream.
  return res.body;
}

ipcMain.handle('list-resource', async (_e, ref, contextName, namespace, kind) => {
  if (!MANAGE_KINDS.includes(kind)) return { ok: false, error: `Unknown resource kind: ${kind}` };
  try {
    const { apis } = getCachedApiClients(ref, contextName);
    const allNs = namespace === ALL_NAMESPACES;
    const items = (await listKindItems(apis, kind, namespace, allNs)).items || [];
    const rows = items.map((item) => projectRow(kind, item));
    return { ok: true, rows };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// High-volume/low-signal for a name-substring search — excluded to keep fan-out latency down.
const MANAGE_SEARCH_EXCLUDE_KINDS = ['events'];

// Fan-out name search across every (non-excluded) kind at once — explicitly user-triggered
// (Enter/click in the renderer), not per-keystroke, to bound worst-case load to one burst per search.
// `crds` (optional) is the renderer's already-fetched list-crds result — CRDs are per-cluster
// discovered data, not a static kind table, so re-discovering them here on every search would
// add a redundant round trip; the renderer passes what it already has cached.
ipcMain.handle('search-resources', async (_e, ref, contextName, namespace, query, crds) => {
  try {
    const { apis } = getCachedApiClients(ref, contextName);
    const allNs = namespace === ALL_NAMESPACES;
    const kinds = MANAGE_KINDS.filter((k) => !MANAGE_SEARCH_EXCLUDE_KINDS.includes(k));
    const q = String(query || '').toLowerCase();

    const settled = await Promise.allSettled(kinds.map(async (kind) => {
      const items = (await listKindItems(apis, kind, namespace, allNs)).items || [];
      return items
        .filter((item) => (item.metadata?.name || '').toLowerCase().includes(q))
        .slice(0, 20) // cap per kind — keeps the IPC payload small
        .map((item) => ({ kind, ...projectRow(kind, item) }));
    }));

    const results = [];
    const errors = [];
    settled.forEach((r, i) => {
      if (r.status === 'fulfilled') results.push(...r.value);
      else errors.push({ kind: kinds[i], error: r.reason.message });
    });

    const customApi = kc => kc.makeApiClient(k8s.CustomObjectsApi);
    const kcForCrds = buildKubeConfig(ref, contextName);
    const crdApi = customApi(kcForCrds);
    const crdSettled = await Promise.allSettled((crds || []).map(async (crd) => {
      const allNsForCrd = crd.namespaced && !allNs;
      const res = allNsForCrd
        ? await withTimeout(crdApi.listNamespacedCustomObject(crd.group, crd.version, namespace, crd.plural), 20000, 'Timed out listing custom resources')
        : await withTimeout(crdApi.listClusterCustomObject(crd.group, crd.version, crd.plural), 20000, 'Timed out listing custom resources');
      return (res.body.items || [])
        .filter((item) => (item.metadata?.name || '').toLowerCase().includes(q))
        .slice(0, 20)
        .map((item) => ({
          crd: true, group: crd.group, version: crd.version, plural: crd.plural, kind: crd.kind, namespaced: crd.namespaced,
          crdName: crd.name,
          name: item.metadata.name, namespace: item.metadata.namespace || '', age: ageOf(item.metadata.creationTimestamp),
        }));
    }));
    crdSettled.forEach((r, i) => {
      if (r.status === 'fulfilled') results.push(...r.value);
      else errors.push({ kind: crds[i].kind, error: r.reason.message });
    });

    return { ok: true, results, errors };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ── K8s Manage: real-time watch sessions (Phase 16) ──────────────────────────
// One session per (ref, context, namespace, kind) the renderer is currently viewing, following
// the same Map-keyed-by-session-id idiom as logSessions/execSessions/pfSessions (below): session
// tracked in a Map, IPC events pushed over per-session channels, explicit stop, torn down on
// mainWindow 'closed'.
const watchSessions = new Map(); // sid -> { stopped, req, resourceVersion, backoffMs, everConnected, reconnectTimer }

function stopWatchSession(sid) {
  const session = watchSessions.get(sid);
  if (!session) return;
  session.stopped = true;
  clearTimeout(session.reconnectTimer);
  try { session.req && session.req.abort(); } catch { /* already closed */ }
  watchSessions.delete(sid);
}

ipcMain.handle('watch-start', async (_e, ref, contextName, namespace, kind, sid) => {
  if (!KIND_WATCH_META[kind]) return { ok: false, error: `Kind not watchable: ${kind}` };
  stopWatchSession(sid); // idempotent restart, mirrors start-pod-logs
  watchSessions.set(sid, {
    stopped: false, req: null, resourceVersion: null,
    backoffMs: 1000, everConnected: false, reconnectTimer: null,
  });
  seedAndWatch(sid, ref, contextName, namespace, kind);
  return { ok: true };
});

ipcMain.handle('watch-stop', async (_e, sid) => {
  stopWatchSession(sid);
  return { ok: true };
});

// Initial full snapshot (LIST) to seed the table, then hands off to the live watch stream.
// Also the reconnect entry point — on every reconnect we re-list from scratch rather than trying
// to resume from the stored resourceVersion: a resourceVersion can go stale (410 Gone) after being
// disconnected more than a few minutes, and reliably distinguishing "410 Gone" from a generic
// network error across transports is itself fragile. Always-relist trades a slightly heavier
// reconnect (one extra LIST call, only on genuine disconnects) for eliminating an entire class of
// "missed delta after reconnect" bugs.
async function seedAndWatch(sid, ref, contextName, namespace, kind) {
  const session = watchSessions.get(sid);
  if (!session || session.stopped) return;
  const sendIfAlive = (channel, ...args) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, ...args);
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
  if (session.stopped) return; // stopped while the LIST was in flight
  sendIfAlive(`watch-sync:${sid}`, { rows: (body.items || []).map((item) => projectRow(kind, item)) });
  session.resourceVersion = body.metadata?.resourceVersion || null;
  runWatchLoop(sid, ref, contextName, namespace, kind);
}

function runWatchLoop(sid, ref, contextName, namespace, kind) {
  const session = watchSessions.get(sid);
  if (!session || session.stopped) return;
  const sendIfAlive = (channel, ...args) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, ...args);
  };

  function scheduleReconnect() {
    if (session.stopped || session.reconnectTimer) return; // already scheduled, or explicitly stopped
    sendIfAlive(`watch-error:${sid}`, { message: 'Reconnecting…', permanent: false });
    session.backoffMs = Math.min(session.backoffMs * 2, 30000);
    session.reconnectTimer = setTimeout(() => {
      session.reconnectTimer = null;
      seedAndWatch(sid, ref, contextName, namespace, kind);
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
    // Any message at all — including a structured ERROR event — proves the watch endpoint is
    // reachable and the `watch` verb is permitted, so this is never treated as a permanent failure.
    session.everConnected = true;
    if (phase === 'ERROR') {
      // Typically a 410 Gone (resourceVersion too old to resume from) — abort and relist.
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
    // Fires on any close: server-side timeout, network blip, or our own explicit abort().
    if (session.stopped) return;
    if (!session.everConnected) {
      // Never received a single event/bookmark on this session — most likely the `watch` verb is
      // RBAC-denied (list/get can be allowed independently of watch) or unsupported here. Don't
      // retry against something that can't be watched at all; the renderer falls back to polling.
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

// Cluster-wide health digest for the Overview landing page — a handful of targeted calls
// (not a fan-out over all 17+ kinds), ignores the namespace selector by design.
function dedupeEvents(items, limit) {
  const byKey = new Map();
  for (const item of items) {
    if (item.type !== 'Warning') continue;
    const obj = item.involvedObject || {};
    const key = `${obj.namespace || ''}/${obj.kind || ''}/${obj.name || ''}/${item.reason || ''}`;
    const ts = item.lastTimestamp || item.eventTime || item.metadata?.creationTimestamp;
    const existing = byKey.get(key);
    if (!existing || new Date(ts || 0) > new Date(existing._ts || 0)) {
      byKey.set(key, {
        namespace: obj.namespace || '', object: obj.kind ? `${obj.kind}/${obj.name}` : '',
        reason: item.reason || '', message: item.message || '', count: item.count || 1, _ts: ts,
      });
    }
  }
  return Array.from(byKey.values())
    .sort((a, b) => new Date(b._ts || 0) - new Date(a._ts || 0))
    .slice(0, limit)
    .map(({ _ts, ...rest }) => ({ ...rest, age: ageOf(_ts) }));
}

ipcMain.handle('get-manage-overview', async (_e, ref, contextName) => {
  try {
    const { apis } = getCachedApiClients(ref, contextName);
    const coreApi = apis.core;
    const appsApi = apis.apps;
    const [podsRes, deploymentsRes, nodesRes, eventsRes] = await Promise.all([
      withTimeout(coreApi.listPodForAllNamespaces(), 15000, 'Timed out listing pods'),
      withTimeout(appsApi.listDeploymentForAllNamespaces(), 15000, 'Timed out listing deployments'),
      withTimeout(coreApi.listNode(), 15000, 'Timed out listing nodes'),
      withTimeout(coreApi.listEventForAllNamespaces(), 15000, 'Timed out listing events'),
    ]);

    const podsNotReady = (podsRes.body.items || [])
      .filter((p) => !['Succeeded', 'Completed'].includes(podStatus(p)) && podStatus(p) !== 'Running')
      .map((p) => ({ namespace: p.metadata.namespace, name: p.metadata.name, status: podStatus(p) }));

    const deploymentsUnhealthy = (deploymentsRes.body.items || [])
      .filter((d) => (d.status?.readyReplicas || 0) < (d.spec?.replicas ?? 0))
      .map((d) => ({
        namespace: d.metadata.namespace, name: d.metadata.name,
        ready: `${d.status?.readyReplicas || 0}/${d.spec?.replicas ?? 0}`,
      }));

    const nodesNotReady = (nodesRes.body.items || [])
      .filter((n) => {
        const cond = (n.status?.conditions || []).find((c) => c.type === 'Ready');
        return !(cond && cond.status === 'True');
      })
      .map((n) => ({ namespace: '', name: n.metadata.name, status: 'NotReady' }));

    const warningEvents = dedupeEvents(eventsRes.body.items || [], 10);

    return {
      ok: true,
      digest: {
        podsNotReady: { count: podsNotReady.length, items: podsNotReady.slice(0, 10) },
        deploymentsUnhealthy: { count: deploymentsUnhealthy.length, items: deploymentsUnhealthy.slice(0, 10) },
        nodesNotReady: { count: nodesNotReady.length, items: nodesNotReady.slice(0, 10) },
        warningEvents: { count: warningEvents.length, items: warningEvents },
      },
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ── K8s Manage: metrics ──────────────────────────────────────────────────────

const MANAGE_METRICS_SCOPES = ['pods', 'nodes'];

// '250m'->250, '1'->1000, '1500000000n'->1.5, '2000u'->2
function parseCpuMillis(cpu) {
  const s = String(cpu || '0');
  if (s.endsWith('n')) return parseFloat(s) / 1e6;
  if (s.endsWith('u')) return parseFloat(s) / 1e3;
  if (s.endsWith('m')) return parseFloat(s);
  return parseFloat(s) * 1000;
}

// '128974848' (bytes), '512Ki'/'256Mi'/'1Gi', '500k'/'2M' -> bytes
function parseMemoryBytes(mem) {
  const match = String(mem || '0').match(/^(\d+(?:\.\d+)?)([A-Za-z]*)$/);
  if (!match) return 0;
  const units = { Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4, K: 1000, M: 1000 ** 2, G: 1000 ** 3 };
  return parseFloat(match[1]) * (units[match[2]] || 1);
}

// scope='pods' sums per-container usage into a pod-level total; scope='nodes' reads node usage directly.
// Metrics API returns raw parsed JSON (no {body} wrapper, unlike the typed k8s.*Api clients).
ipcMain.handle('get-metrics', async (_e, ref, contextName, namespace, scope) => {
  if (!MANAGE_METRICS_SCOPES.includes(scope)) return { ok: false, error: `Unknown metrics scope: ${scope}` };
  try {
    const { metricsApi } = getCachedApiClients(ref, contextName);
    const res = scope === 'nodes'
      ? await withTimeout(metricsApi.getNodeMetrics(), 10000, 'Timed out fetching node metrics')
      : await withTimeout(
          namespace === ALL_NAMESPACES ? metricsApi.getPodMetrics() : metricsApi.getPodMetrics(namespace),
          10000,
          'Timed out fetching pod metrics'
        );

    const rows = (res.items || []).map((item) => {
      const usages = scope === 'nodes' ? [item.usage || {}] : (item.containers || []).map((c) => c.usage || {});
      const cpu = usages.reduce((sum, u) => sum + parseCpuMillis(u.cpu), 0);
      const memory = usages.reduce((sum, u) => sum + parseMemoryBytes(u.memory), 0);
      return { name: item.metadata.name, namespace: item.metadata.namespace || '', cpu, memory };
    });
    return { ok: true, rows };
  } catch (e) {
    // metrics-server not installed/unreachable is the overwhelmingly common failure here —
    // callers stop polling and show a notice instead of alerting.
    return { ok: false, reason: 'metrics-server-unavailable', error: e.message };
  }
});

// ── K8s Manage: resource YAML + scoped events ────────────────────────────────

// Maps our internal `kind` key to the k8s `involvedObject.kind` value events are filed under.
const MANAGE_KIND_LABEL = {
  pods: 'Pod', deployments: 'Deployment', statefulsets: 'StatefulSet', daemonsets: 'DaemonSet',
  replicasets: 'ReplicaSet', services: 'Service', ingresses: 'Ingress', configmaps: 'ConfigMap',
  secrets: 'Secret', jobs: 'Job', cronjobs: 'CronJob', pvcs: 'PersistentVolumeClaim',
  hpas: 'HorizontalPodAutoscaler', nodes: 'Node', pvs: 'PersistentVolume', namespaces: 'Namespace', events: 'Event',
  serviceaccounts: 'ServiceAccount', roles: 'Role', rolebindings: 'RoleBinding',
  clusterroles: 'ClusterRole', clusterrolebindings: 'ClusterRoleBinding',
  networkpolicies: 'NetworkPolicy', storageclasses: 'StorageClass',
  resourcequotas: 'ResourceQuota', limitranges: 'LimitRange',
};

// Maps our internal `kind` key to its API group + plural resource name — needed for
// SelfSubjectAccessReview ("can-i") checks (check-access handler, below).
const MANAGE_KIND_GVR = {
  pods: { group: '', resource: 'pods' }, deployments: { group: 'apps', resource: 'deployments' },
  statefulsets: { group: 'apps', resource: 'statefulsets' }, daemonsets: { group: 'apps', resource: 'daemonsets' },
  replicasets: { group: 'apps', resource: 'replicasets' }, services: { group: '', resource: 'services' },
  ingresses: { group: 'networking.k8s.io', resource: 'ingresses' }, configmaps: { group: '', resource: 'configmaps' },
  secrets: { group: '', resource: 'secrets' }, jobs: { group: 'batch', resource: 'jobs' },
  cronjobs: { group: 'batch', resource: 'cronjobs' }, pvcs: { group: '', resource: 'persistentvolumeclaims' },
  hpas: { group: 'autoscaling', resource: 'horizontalpodautoscalers' }, nodes: { group: '', resource: 'nodes' },
  pvs: { group: '', resource: 'persistentvolumes' }, namespaces: { group: '', resource: 'namespaces' },
  events: { group: '', resource: 'events' },
  serviceaccounts: { group: '', resource: 'serviceaccounts' }, roles: { group: 'rbac.authorization.k8s.io', resource: 'roles' },
  rolebindings: { group: 'rbac.authorization.k8s.io', resource: 'rolebindings' },
  clusterroles: { group: 'rbac.authorization.k8s.io', resource: 'clusterroles' },
  clusterrolebindings: { group: 'rbac.authorization.k8s.io', resource: 'clusterrolebindings' },
  networkpolicies: { group: 'networking.k8s.io', resource: 'networkpolicies' },
  storageclasses: { group: 'storage.k8s.io', resource: 'storageclasses' },
  resourcequotas: { group: '', resource: 'resourcequotas' },
  limitranges: { group: '', resource: 'limitranges' },
};
const MANAGE_ACCESS_VERBS = ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete'];

// Secret `data` is base64 but trivially decodable — redact by default (a fixed-length placeholder,
// not derived from value length, so byte-size metadata isn't leaked either) unless explicitly revealed.
function redactSecretData(obj) {
  if (!obj || !obj.data) return obj;
  const redacted = {};
  for (const k of Object.keys(obj.data)) redacted[k] = '***REDACTED***';
  return { ...obj, data: redacted };
}

ipcMain.handle('get-resource-yaml', async (_e, ref, contextName, namespace, kind, name, opts) => {
  if (!MANAGE_KINDS.includes(kind)) return { ok: false, error: `Unknown resource kind: ${kind}` };
  try {
    const kc = buildKubeConfig(ref, contextName);
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);
    const appsApi = kc.makeApiClient(k8s.AppsV1Api);
    const batchApi = kc.makeApiClient(k8s.BatchV1Api);
    const networkingApi = kc.makeApiClient(k8s.NetworkingV1Api);
    const autoscalingApi = kc.makeApiClient(k8s.AutoscalingV2Api);
    const rbacApi = kc.makeApiClient(k8s.RbacAuthorizationV1Api);
    const storageApi = kc.makeApiClient(k8s.StorageV1Api);

    let res;
    switch (kind) {
      case 'pods':         res = await withTimeout(coreApi.readNamespacedPod(name, namespace), 20000, 'Timed out reading pod'); break;
      case 'deployments':  res = await withTimeout(appsApi.readNamespacedDeployment(name, namespace), 20000, 'Timed out reading deployment'); break;
      case 'statefulsets': res = await withTimeout(appsApi.readNamespacedStatefulSet(name, namespace), 20000, 'Timed out reading statefulset'); break;
      case 'daemonsets':   res = await withTimeout(appsApi.readNamespacedDaemonSet(name, namespace), 20000, 'Timed out reading daemonset'); break;
      case 'replicasets':  res = await withTimeout(appsApi.readNamespacedReplicaSet(name, namespace), 20000, 'Timed out reading replicaset'); break;
      case 'services':     res = await withTimeout(coreApi.readNamespacedService(name, namespace), 20000, 'Timed out reading service'); break;
      case 'ingresses':    res = await withTimeout(networkingApi.readNamespacedIngress(name, namespace), 20000, 'Timed out reading ingress'); break;
      case 'configmaps':   res = await withTimeout(coreApi.readNamespacedConfigMap(name, namespace), 20000, 'Timed out reading configmap'); break;
      case 'secrets':      res = await withTimeout(coreApi.readNamespacedSecret(name, namespace), 20000, 'Timed out reading secret'); break;
      case 'jobs':         res = await withTimeout(batchApi.readNamespacedJob(name, namespace), 20000, 'Timed out reading job'); break;
      case 'cronjobs':     res = await withTimeout(batchApi.readNamespacedCronJob(name, namespace), 20000, 'Timed out reading cronjob'); break;
      case 'pvcs':         res = await withTimeout(coreApi.readNamespacedPersistentVolumeClaim(name, namespace), 20000, 'Timed out reading PVC'); break;
      case 'hpas':         res = await withTimeout(autoscalingApi.readNamespacedHorizontalPodAutoscaler(name, namespace), 20000, 'Timed out reading HPA'); break;
      case 'nodes':        res = await withTimeout(coreApi.readNode(name), 20000, 'Timed out reading node'); break;
      case 'pvs':          res = await withTimeout(coreApi.readPersistentVolume(name), 20000, 'Timed out reading PV'); break;
      case 'namespaces':   res = await withTimeout(coreApi.readNamespace(name), 20000, 'Timed out reading namespace'); break;
      case 'events':       res = await withTimeout(coreApi.readNamespacedEvent(name, namespace), 20000, 'Timed out reading event'); break;
      case 'serviceaccounts':     res = await withTimeout(coreApi.readNamespacedServiceAccount(name, namespace), 20000, 'Timed out reading service account'); break;
      case 'roles':               res = await withTimeout(rbacApi.readNamespacedRole(name, namespace), 20000, 'Timed out reading role'); break;
      case 'rolebindings':        res = await withTimeout(rbacApi.readNamespacedRoleBinding(name, namespace), 20000, 'Timed out reading role binding'); break;
      case 'clusterroles':        res = await withTimeout(rbacApi.readClusterRole(name), 20000, 'Timed out reading cluster role'); break;
      case 'clusterrolebindings': res = await withTimeout(rbacApi.readClusterRoleBinding(name), 20000, 'Timed out reading cluster role binding'); break;
      case 'networkpolicies':    res = await withTimeout(networkingApi.readNamespacedNetworkPolicy(name, namespace), 20000, 'Timed out reading network policy'); break;
      case 'storageclasses':     res = await withTimeout(storageApi.readStorageClass(name), 20000, 'Timed out reading storage class'); break;
      case 'resourcequotas':     res = await withTimeout(coreApi.readNamespacedResourceQuota(name, namespace), 20000, 'Timed out reading resource quota'); break;
      case 'limitranges':        res = await withTimeout(coreApi.readNamespacedLimitRange(name, namespace), 20000, 'Timed out reading limit range'); break;
    }

    let obj = res.body;
    if (obj.metadata) {
      delete obj.metadata.managedFields;
      delete obj.metadata.uid;
      delete obj.metadata.creationTimestamp;
      // Edit mode needs resourceVersion preserved for optimistic-concurrency on apply — only the
      // read-only view strips it as declutter.
      if (!(opts && opts.forEdit)) delete obj.metadata.resourceVersion;
      if (obj.metadata.annotations) {
        delete obj.metadata.annotations['kubectl.kubernetes.io/last-applied-configuration'];
      }
    }
    delete obj.status;
    const redacted = kind === 'secrets' && !(opts && opts.reveal);
    if (redacted) obj = redactSecretData(obj);
    // Editing a redacted Secret would silently write "***REDACTED***" over the real values —
    // block edit mode client-side until Reveal is on (apply-resource-yaml also guards server-side).
    const editable = !(kind === 'secrets' && redacted);
    return { ok: true, yaml: k8s.dumpYaml(obj), redacted, editable };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('get-resource-events', async (_e, ref, contextName, namespace, kind, name) => {
  if (!MANAGE_KINDS.includes(kind)) return { ok: false, error: `Unknown resource kind: ${kind}` };
  try {
    const kc = buildKubeConfig(ref, contextName);
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);
    const fieldSelector = `involvedObject.name=${name},involvedObject.kind=${MANAGE_KIND_LABEL[kind]}`;
    const res = MANAGE_CLUSTER_SCOPED_KINDS.includes(kind)
      ? await withTimeout(coreApi.listEventForAllNamespaces(undefined, undefined, fieldSelector), 20000, 'Timed out listing events')
      : await withTimeout(coreApi.listNamespacedEvent(namespace, undefined, undefined, undefined, fieldSelector), 20000, 'Timed out listing events');
    const rows = (res.body.items || [])
      .map((item) => ({
        uid: item.metadata?.uid || '',
        type: item.type || '',
        reason: item.reason || '',
        message: item.message || '',
        count: item.count || 1,
        _ts: item.lastTimestamp || item.eventTime || item.metadata?.creationTimestamp,
      }))
      .sort((a, b) => new Date(b._ts || 0) - new Date(a._ts || 0))
      .map((item) => ({ ...item, age: ageOf(item._ts) }));
    return { ok: true, rows };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// "can-i" check: fires a SelfSubjectAccessReview per verb so the drawer can show what the
// current identity is actually allowed to do — kind-agnostic, shared by both the built-in-kind
// path (check-access, using MANAGE_KIND_GVR) and the CRD path (check-custom-resource-access,
// using the CRD's own discovered group/plural).
async function runAccessCheck(authApi, { namespace, namespaced, group, resource, name }) {
  const results = await Promise.allSettled(MANAGE_ACCESS_VERBS.map((verb) =>
    withTimeout(
      authApi.createSelfSubjectAccessReview({
        spec: { resourceAttributes: { namespace: namespaced ? namespace : undefined, verb, group, resource, name } },
      }),
      10000,
      `Timed out checking ${verb}`
    )
  ));
  return results.map((r, i) => r.status === 'fulfilled'
    ? { verb: MANAGE_ACCESS_VERBS[i], allowed: !!r.value.body.status.allowed, reason: r.value.body.status.reason || '' }
    : { verb: MANAGE_ACCESS_VERBS[i], allowed: false, reason: r.reason.message });
}

ipcMain.handle('check-access', async (_e, ref, contextName, namespace, kind, name) => {
  const gvr = MANAGE_KIND_GVR[kind];
  if (!gvr) return { ok: false, error: `Unknown resource kind: ${kind}` };
  try {
    const kc = buildKubeConfig(ref, contextName);
    const authApi = kc.makeApiClient(k8s.AuthorizationV1Api);
    const namespaced = !MANAGE_CLUSTER_SCOPED_KINDS.includes(kind);
    const rows = await runAccessCheck(authApi, { namespace, namespaced, group: gvr.group, resource: gvr.resource, name });
    return { ok: true, rows };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// CRD counterpart of check-access — the CRD's group/plural is already known to the renderer
// from list-crds, so no MANAGE_KIND_GVR lookup is needed here.
ipcMain.handle('check-custom-resource-access', async (_e, ref, contextName, namespace, group, resource, namespaced, name) => {
  try {
    const kc = buildKubeConfig(ref, contextName);
    const authApi = kc.makeApiClient(k8s.AuthorizationV1Api);
    const rows = await runAccessCheck(authApi, { namespace, namespaced, group, resource, name });
    return { ok: true, rows };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ── K8s Manage: safe resource actions ────────────────────────────────────────
// Fixed allow-list of bounded, well-understood mutations — no arbitrary YAML apply.
// The renderer is responsible for typed-confirmation UX before invoking this.

const MANAGE_ACTIONS = ['restart', 'scale', 'delete', 'cordon', 'uncordon'];
const STRATEGIC_MERGE_PATCH_OPTS = { headers: { 'Content-Type': 'application/strategic-merge-patch+json' } };

ipcMain.handle('resource-action', async (_e, ref, contextName, namespace, kind, name, action, payload) => {
  if (!MANAGE_ACTIONS.includes(action)) return { ok: false, error: `Unknown action: ${action}` };
  try {
    const kc = buildKubeConfig(ref, contextName);
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);
    const appsApi = kc.makeApiClient(k8s.AppsV1Api);
    const batchApi = kc.makeApiClient(k8s.BatchV1Api);
    const networkingApi = kc.makeApiClient(k8s.NetworkingV1Api);
    const autoscalingApi = kc.makeApiClient(k8s.AutoscalingV2Api);
    const rbacApi = kc.makeApiClient(k8s.RbacAuthorizationV1Api);
    const storageApi = kc.makeApiClient(k8s.StorageV1Api);

    switch (action) {
      case 'delete': {
        // ── Audit: capture old snapshot before delete ──
        let oldObj = null;
        let auditEditVersion = 0;
        if (auditDb.status().connected) {
          try { oldObj = await readManageObject(ref, contextName, namespace, kind, name); } catch { /* best-effort */ }
          auditEditVersion = parseInt(oldObj?.metadata?.annotations?.['k8senvdiff-edit-resource-version'] || '0', 10);
        }

        switch (kind) {
          case 'pods':         await coreApi.deleteNamespacedPod(name, namespace); break;
          case 'deployments':  await appsApi.deleteNamespacedDeployment(name, namespace); break;
          case 'statefulsets': await appsApi.deleteNamespacedStatefulSet(name, namespace); break;
          case 'daemonsets':   await appsApi.deleteNamespacedDaemonSet(name, namespace); break;
          case 'replicasets':  await appsApi.deleteNamespacedReplicaSet(name, namespace); break;
          case 'services':     await coreApi.deleteNamespacedService(name, namespace); break;
          case 'ingresses':    await networkingApi.deleteNamespacedIngress(name, namespace); break;
          case 'configmaps':   await coreApi.deleteNamespacedConfigMap(name, namespace); break;
          case 'secrets':      await coreApi.deleteNamespacedSecret(name, namespace); break;
          case 'jobs':         await batchApi.deleteNamespacedJob(name, namespace); break;
          case 'cronjobs':     await batchApi.deleteNamespacedCronJob(name, namespace); break;
          case 'pvcs':         await coreApi.deleteNamespacedPersistentVolumeClaim(name, namespace); break;
          case 'hpas':         await autoscalingApi.deleteNamespacedHorizontalPodAutoscaler(name, namespace); break;
          case 'nodes':        await coreApi.deleteNode(name); break;
          case 'pvs':          await coreApi.deletePersistentVolume(name); break;
          case 'namespaces':   await coreApi.deleteNamespace(name); break;
          case 'events':       await coreApi.deleteNamespacedEvent(name, namespace); break;
          case 'serviceaccounts':      await coreApi.deleteNamespacedServiceAccount(name, namespace); break;
          case 'roles':                await rbacApi.deleteNamespacedRole(name, namespace); break;
          case 'rolebindings':         await rbacApi.deleteNamespacedRoleBinding(name, namespace); break;
          case 'clusterroles':         await rbacApi.deleteClusterRole(name); break;
          case 'clusterrolebindings':  await rbacApi.deleteClusterRoleBinding(name); break;
          case 'networkpolicies':      await networkingApi.deleteNamespacedNetworkPolicy(name, namespace); break;
          case 'storageclasses':       await storageApi.deleteStorageClass(name); break;
          case 'resourcequotas':       await coreApi.deleteNamespacedResourceQuota(name, namespace); break;
          case 'limitranges':          await coreApi.deleteNamespacedLimitRange(name, namespace); break;
          default: return { ok: false, error: `Delete not supported for kind: ${kind}` };
        }

        // ── Audit: record after delete ──
        if (auditDb.status().connected && oldObj) {
          await recordAudit({
            ref, contextName, namespace, kind, name, action: 'delete',
            oldObj, newObj: null, editVersion: auditEditVersion,
          });
        }
        break;
      }
      case 'restart': {
        if (!['deployments', 'statefulsets', 'daemonsets'].includes(kind)) {
          return { ok: false, error: `Rollout restart not supported for kind: ${kind}` };
        }
        // Same trick `kubectl rollout restart` uses: touching this annotation forces the
        // controller to roll every pod even though the pod template is otherwise unchanged.
        const patch = {
          spec: { template: { metadata: { annotations: { 'kubectl.kubernetes.io/restartedAt': new Date().toISOString() } } } },
        };
        if (kind === 'deployments')  await appsApi.patchNamespacedDeployment(name, namespace, patch, undefined, undefined, undefined, undefined, undefined, STRATEGIC_MERGE_PATCH_OPTS);
        if (kind === 'statefulsets') await appsApi.patchNamespacedStatefulSet(name, namespace, patch, undefined, undefined, undefined, undefined, undefined, STRATEGIC_MERGE_PATCH_OPTS);
        if (kind === 'daemonsets')   await appsApi.patchNamespacedDaemonSet(name, namespace, patch, undefined, undefined, undefined, undefined, undefined, STRATEGIC_MERGE_PATCH_OPTS);
        break;
      }
      case 'scale': {
        if (!['deployments', 'statefulsets'].includes(kind)) {
          return { ok: false, error: `Scale not supported for kind: ${kind}` };
        }
        const replicas = Number(payload && payload.replicas);
        if (!Number.isInteger(replicas) || replicas < 0) return { ok: false, error: 'Invalid replica count' };
        const patch = { spec: { replicas } };
        if (kind === 'deployments')  await appsApi.patchNamespacedDeploymentScale(name, namespace, patch, undefined, undefined, undefined, undefined, undefined, STRATEGIC_MERGE_PATCH_OPTS);
        if (kind === 'statefulsets') await appsApi.patchNamespacedStatefulSetScale(name, namespace, patch, undefined, undefined, undefined, undefined, undefined, STRATEGIC_MERGE_PATCH_OPTS);
        break;
      }
      case 'cordon':
      case 'uncordon': {
        if (kind !== 'nodes') return { ok: false, error: `${action} only supported for nodes` };
        const patch = { spec: { unschedulable: action === 'cordon' } };
        await coreApi.patchNode(name, patch, undefined, undefined, undefined, undefined, undefined, STRATEGIC_MERGE_PATCH_OPTS);
        break;
      }
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ── K8s Manage: YAML edit & apply ─────────────────────────────────────────────
// Full-object replace (PUT), not patch — the resourceVersion the renderer fetched with
// opts.forEdit gives free optimistic-concurrency (409 on conflict), which a merge-patch
// would not. Edit-existing only: kind/name/namespace must match what the tab was opened
// for, so this can never create a new resource or silently overwrite an unrelated one.
ipcMain.handle('apply-resource-yaml', async (_e, ref, contextName, namespace, kind, name, yamlText, resourceVersion) => {
  if (!MANAGE_KINDS.includes(kind)) return { ok: false, error: `Unknown resource kind: ${kind}`, kind: 'validation' };
  let parsed;
  try {
    parsed = k8s.loadYaml(yamlText);
  } catch (e) {
    return { ok: false, error: `YAML parse error: ${e.message}`, kind: 'parse' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'Expected a single YAML object/document', kind: 'parse' };
  }
  if (parsed.kind !== MANAGE_KIND_LABEL[kind]) {
    return { ok: false, error: `Expected kind "${MANAGE_KIND_LABEL[kind]}", got "${parsed.kind}"`, kind: 'validation' };
  }
  if (parsed.metadata?.name !== name) {
    return { ok: false, error: `metadata.name ("${parsed.metadata?.name}") must match "${name}"`, kind: 'validation' };
  }
  const namespaced = !MANAGE_CLUSTER_SCOPED_KINDS.includes(kind);
  if (namespaced && parsed.metadata?.namespace && parsed.metadata.namespace !== namespace) {
    return { ok: false, error: `metadata.namespace ("${parsed.metadata.namespace}") must match "${namespace}"`, kind: 'validation' };
  }
  const rv = resourceVersion || parsed.metadata?.resourceVersion;
  if (!rv) {
    return { ok: false, error: 'Missing metadata.resourceVersion — reload the YAML and try again.', kind: 'validation' };
  }
  if (!parsed.metadata) parsed.metadata = {};
  parsed.metadata.resourceVersion = rv;
  if (kind === 'secrets' && parsed.data && Object.values(parsed.data).some((v) => v === '***REDACTED***')) {
    return { ok: false, error: 'This YAML still contains redacted placeholder values. Enable "Reveal secret values", reload, then edit.', kind: 'validation' };
  }

  try {
    const kc = buildKubeConfig(ref, contextName);
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);
    const appsApi = kc.makeApiClient(k8s.AppsV1Api);
    const batchApi = kc.makeApiClient(k8s.BatchV1Api);
    const networkingApi = kc.makeApiClient(k8s.NetworkingV1Api);
    const autoscalingApi = kc.makeApiClient(k8s.AutoscalingV2Api);
    const rbacApi = kc.makeApiClient(k8s.RbacAuthorizationV1Api);
    const storageApi = kc.makeApiClient(k8s.StorageV1Api);

    // ── Audit: capture old snapshot + bump annotation ──
    let oldObj = null;
    let editVersion = 0;
    if (auditDb.status().connected) {
      try { oldObj = await readManageObject(ref, contextName, namespace, kind, name); } catch { /* best-effort */ }
      const clusterId = resolveClusterId(ref, contextName);
      const dbNext = await auditDb.nextEditVersion({ clusterId, namespace, kind, name });
      const currentAnno = parseInt(oldObj?.metadata?.annotations?.['k8senvdiff-edit-resource-version'] || '0', 10);
      editVersion = Math.max(dbNext, currentAnno + 1);
      if (!parsed.metadata.annotations) parsed.metadata.annotations = {};
      parsed.metadata.annotations['k8senvdiff-edit-resource-version'] = String(editVersion);
    }

    let res;
    switch (kind) {
      case 'pods':         res = await withTimeout(coreApi.replaceNamespacedPod(name, namespace, parsed), 20000, 'Timed out applying pod'); break;
      case 'deployments':  res = await withTimeout(appsApi.replaceNamespacedDeployment(name, namespace, parsed), 20000, 'Timed out applying deployment'); break;
      case 'statefulsets': res = await withTimeout(appsApi.replaceNamespacedStatefulSet(name, namespace, parsed), 20000, 'Timed out applying statefulset'); break;
      case 'daemonsets':   res = await withTimeout(appsApi.replaceNamespacedDaemonSet(name, namespace, parsed), 20000, 'Timed out applying daemonset'); break;
      case 'replicasets':  res = await withTimeout(appsApi.replaceNamespacedReplicaSet(name, namespace, parsed), 20000, 'Timed out applying replicaset'); break;
      case 'services':     res = await withTimeout(coreApi.replaceNamespacedService(name, namespace, parsed), 20000, 'Timed out applying service'); break;
      case 'ingresses':    res = await withTimeout(networkingApi.replaceNamespacedIngress(name, namespace, parsed), 20000, 'Timed out applying ingress'); break;
      case 'configmaps':   res = await withTimeout(coreApi.replaceNamespacedConfigMap(name, namespace, parsed), 20000, 'Timed out applying configmap'); break;
      case 'secrets':      res = await withTimeout(coreApi.replaceNamespacedSecret(name, namespace, parsed), 20000, 'Timed out applying secret'); break;
      case 'jobs':         res = await withTimeout(batchApi.replaceNamespacedJob(name, namespace, parsed), 20000, 'Timed out applying job'); break;
      case 'cronjobs':     res = await withTimeout(batchApi.replaceNamespacedCronJob(name, namespace, parsed), 20000, 'Timed out applying cronjob'); break;
      case 'pvcs':         res = await withTimeout(coreApi.replaceNamespacedPersistentVolumeClaim(name, namespace, parsed), 20000, 'Timed out applying PVC'); break;
      case 'hpas':         res = await withTimeout(autoscalingApi.replaceNamespacedHorizontalPodAutoscaler(name, namespace, parsed), 20000, 'Timed out applying HPA'); break;
      case 'nodes':        res = await withTimeout(coreApi.replaceNode(name, parsed), 20000, 'Timed out applying node'); break;
      case 'pvs':          res = await withTimeout(coreApi.replacePersistentVolume(name, parsed), 20000, 'Timed out applying PV'); break;
      case 'namespaces':   res = await withTimeout(coreApi.replaceNamespace(name, parsed), 20000, 'Timed out applying namespace'); break;
      case 'events':       res = await withTimeout(coreApi.replaceNamespacedEvent(name, namespace, parsed), 20000, 'Timed out applying event'); break;
      case 'serviceaccounts':     res = await withTimeout(coreApi.replaceNamespacedServiceAccount(name, namespace, parsed), 20000, 'Timed out applying service account'); break;
      case 'roles':               res = await withTimeout(rbacApi.replaceNamespacedRole(name, namespace, parsed), 20000, 'Timed out applying role'); break;
      case 'rolebindings':        res = await withTimeout(rbacApi.replaceNamespacedRoleBinding(name, namespace, parsed), 20000, 'Timed out applying role binding'); break;
      case 'clusterroles':        res = await withTimeout(rbacApi.replaceClusterRole(name, parsed), 20000, 'Timed out applying cluster role'); break;
      case 'clusterrolebindings': res = await withTimeout(rbacApi.replaceClusterRoleBinding(name, parsed), 20000, 'Timed out applying cluster role binding'); break;
      case 'networkpolicies':    res = await withTimeout(networkingApi.replaceNamespacedNetworkPolicy(name, namespace, parsed), 20000, 'Timed out applying network policy'); break;
      case 'storageclasses':     res = await withTimeout(storageApi.replaceStorageClass(name, parsed), 20000, 'Timed out applying storage class'); break;
      case 'resourcequotas':     res = await withTimeout(coreApi.replaceNamespacedResourceQuota(name, namespace, parsed), 20000, 'Timed out applying resource quota'); break;
      case 'limitranges':        res = await withTimeout(coreApi.replaceNamespacedLimitRange(name, namespace, parsed), 20000, 'Timed out applying limit range'); break;
    }

    let obj = res.body;
    if (obj.metadata) delete obj.metadata.managedFields; // keep resourceVersion — needed for the next edit
    const redacted = kind === 'secrets';

    // ── Audit: record after success ──
    let auditWarning = null;
    if (auditDb.status().connected) {
      auditWarning = await recordAudit({
        ref, contextName, namespace, kind, name, action: 'edit',
        oldObj, newObj: res.body, editVersion,
      });
    }

    return { ok: true, yaml: k8s.dumpYaml(redacted ? redactSecretData(obj) : obj), auditWarning };
  } catch (e) {
    if (e.statusCode === 409) {
      return { ok: false, error: 'This resource changed on the cluster since you loaded it. Reload the YAML and re-apply your edit.', kind: 'conflict' };
    }
    if (e.statusCode === 403) {
      return { ok: false, error: e.body?.message || e.message, kind: 'forbidden' };
    }
    if (e.statusCode === 400 || e.statusCode === 422) {
      return { ok: false, error: e.body?.message || e.message, kind: 'invalid' };
    }
    return { ok: false, error: e.message, kind: 'error' };
  }
});

// CRD counterpart of apply-resource-yaml — same validation shape, dispatched via CustomObjectsApi's
// replaceNamespacedCustomObject/replaceClusterCustomObject instead of a per-kind switch.
ipcMain.handle('apply-custom-resource-yaml', async (_e, ref, contextName, namespace, group, version, plural, name, namespaced, yamlText, resourceVersion) => {
  let parsed;
  try {
    parsed = k8s.loadYaml(yamlText);
  } catch (e) {
    return { ok: false, error: `YAML parse error: ${e.message}`, kind: 'parse' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'Expected a single YAML object/document', kind: 'parse' };
  }
  if (parsed.metadata?.name !== name) {
    return { ok: false, error: `metadata.name must match "${name}"`, kind: 'validation' };
  }
  if (namespaced && parsed.metadata?.namespace && parsed.metadata.namespace !== namespace) {
    return { ok: false, error: `metadata.namespace must match "${namespace}"`, kind: 'validation' };
  }
  const rv = resourceVersion || parsed.metadata?.resourceVersion;
  if (!rv) {
    return { ok: false, error: 'Missing metadata.resourceVersion — reload and try again.', kind: 'validation' };
  }
  if (!parsed.metadata) parsed.metadata = {};
  parsed.metadata.resourceVersion = rv;
  try {
    const kc = buildKubeConfig(ref, contextName);
    const customApi = kc.makeApiClient(k8s.CustomObjectsApi);

    // ── Audit: capture old CRD snapshot + bump annotation ──
    let oldObj = null;
    let editVersion = 0;
    const crdKind = parsed.kind || plural;
    if (auditDb.status().connected) {
      try {
        const oldRes = namespaced
          ? await customApi.getNamespacedCustomObject(group, version, namespace, plural, name)
          : await customApi.getClusterCustomObject(group, version, plural, name);
        oldObj = oldRes.body;
      } catch { /* best-effort */ }
      const clusterId = resolveClusterId(ref, contextName);
      const dbNext = await auditDb.nextEditVersion({ clusterId, namespace, kind: crdKind, name });
      const currentAnno = parseInt(oldObj?.metadata?.annotations?.['k8senvdiff-edit-resource-version'] || '0', 10);
      editVersion = Math.max(dbNext, currentAnno + 1);
      if (!parsed.metadata.annotations) parsed.metadata.annotations = {};
      parsed.metadata.annotations['k8senvdiff-edit-resource-version'] = String(editVersion);
    }

    const res = namespaced
      ? await withTimeout(customApi.replaceNamespacedCustomObject(group, version, namespace, plural, name, parsed), 20000, 'Timed out applying custom resource')
      : await withTimeout(customApi.replaceClusterCustomObject(group, version, plural, name, parsed), 20000, 'Timed out applying custom resource');
    const obj = res.body;
    if (obj.metadata) delete obj.metadata.managedFields;

    // ── Audit: record after success ──
    let auditWarning = null;
    if (auditDb.status().connected) {
      auditWarning = await recordAudit({
        ref, contextName, namespace, kind: crdKind, name, action: 'edit',
        oldObj, newObj: res.body, editVersion,
      });
    }

    return { ok: true, yaml: k8s.dumpYaml(obj), auditWarning };
  } catch (e) {
    if (e.statusCode === 409) return { ok: false, error: 'This custom resource changed since you loaded it. Reload and re-apply.', kind: 'conflict' };
    if (e.statusCode === 403) return { ok: false, error: e.body?.message || e.message, kind: 'forbidden' };
    if (e.statusCode === 400 || e.statusCode === 422) return { ok: false, error: e.body?.message || e.message, kind: 'invalid' };
    return { ok: false, error: e.message, kind: 'error' };
  }
});

// ── K8s Manage: Audit helpers ─────────────────────────────────────────────────

// Shared helper to read a live manage object by kind — reuses the same per-kind dispatch
// from get-resource-yaml but returns the raw body (no managedFields strip, no redaction).
async function readManageObject(ref, contextName, namespace, kind, name) {
  const kc = buildKubeConfig(ref, contextName);
  const coreApi = kc.makeApiClient(k8s.CoreV1Api);
  const appsApi = kc.makeApiClient(k8s.AppsV1Api);
  const batchApi = kc.makeApiClient(k8s.BatchV1Api);
  const networkingApi = kc.makeApiClient(k8s.NetworkingV1Api);
  const autoscalingApi = kc.makeApiClient(k8s.AutoscalingV2Api);
  const rbacApi = kc.makeApiClient(k8s.RbacAuthorizationV1Api);
  const storageApi = kc.makeApiClient(k8s.StorageV1Api);

  let res;
  switch (kind) {
    case 'pods':         res = await coreApi.readNamespacedPod(name, namespace); break;
    case 'deployments':  res = await appsApi.readNamespacedDeployment(name, namespace); break;
    case 'statefulsets': res = await appsApi.readNamespacedStatefulSet(name, namespace); break;
    case 'daemonsets':   res = await appsApi.readNamespacedDaemonSet(name, namespace); break;
    case 'replicasets':  res = await appsApi.readNamespacedReplicaSet(name, namespace); break;
    case 'services':     res = await coreApi.readNamespacedService(name, namespace); break;
    case 'ingresses':    res = await networkingApi.readNamespacedIngress(name, namespace); break;
    case 'configmaps':   res = await coreApi.readNamespacedConfigMap(name, namespace); break;
    case 'secrets':      res = await coreApi.readNamespacedSecret(name, namespace); break;
    case 'jobs':         res = await batchApi.readNamespacedJob(name, namespace); break;
    case 'cronjobs':     res = await batchApi.readNamespacedCronJob(name, namespace); break;
    case 'pvcs':         res = await coreApi.readNamespacedPersistentVolumeClaim(name, namespace); break;
    case 'hpas':         res = await autoscalingApi.readNamespacedHorizontalPodAutoscaler(name, namespace); break;
    case 'nodes':        res = await coreApi.readNode(name); break;
    case 'pvs':          res = await coreApi.readPersistentVolume(name); break;
    case 'namespaces':   res = await coreApi.readNamespace(name); break;
    case 'events':       res = await coreApi.readNamespacedEvent(name, namespace); break;
    case 'serviceaccounts':     res = await coreApi.readNamespacedServiceAccount(name, namespace); break;
    case 'roles':               res = await rbacApi.readNamespacedRole(name, namespace); break;
    case 'rolebindings':        res = await rbacApi.readNamespacedRoleBinding(name, namespace); break;
    case 'clusterroles':        res = await rbacApi.readClusterRole(name); break;
    case 'clusterrolebindings': res = await rbacApi.readClusterRoleBinding(name); break;
    case 'networkpolicies':    res = await networkingApi.readNamespacedNetworkPolicy(name, namespace); break;
    case 'storageclasses':     res = await storageApi.readStorageClass(name); break;
    case 'resourcequotas':     res = await coreApi.readNamespacedResourceQuota(name, namespace); break;
    case 'limitranges':        res = await coreApi.readNamespacedLimitRange(name, namespace); break;
    default: return null;
  }
  return res.body;
}

async function createManageObject(ref, contextName, namespace, kind, parsed) {
  const kc = buildKubeConfig(ref, contextName);
  const coreApi = kc.makeApiClient(k8s.CoreV1Api);
  const appsApi = kc.makeApiClient(k8s.AppsV1Api);
  const batchApi = kc.makeApiClient(k8s.BatchV1Api);
  const networkingApi = kc.makeApiClient(k8s.NetworkingV1Api);
  const autoscalingApi = kc.makeApiClient(k8s.AutoscalingV2Api);
  const rbacApi = kc.makeApiClient(k8s.RbacAuthorizationV1Api);
  const storageApi = kc.makeApiClient(k8s.StorageV1Api);

  let res;
  switch (kind) {
    case 'deployments':  res = await appsApi.createNamespacedDeployment(namespace, parsed); break;
    case 'statefulsets': res = await appsApi.createNamespacedStatefulSet(namespace, parsed); break;
    case 'daemonsets':   res = await appsApi.createNamespacedDaemonSet(namespace, parsed); break;
    case 'services':     res = await coreApi.createNamespacedService(namespace, parsed); break;
    case 'ingresses':    res = await networkingApi.createNamespacedIngress(namespace, parsed); break;
    case 'configmaps':   res = await coreApi.createNamespacedConfigMap(namespace, parsed); break;
    case 'jobs':         res = await batchApi.createNamespacedJob(namespace, parsed); break;
    case 'cronjobs':     res = await batchApi.createNamespacedCronJob(namespace, parsed); break;
    case 'pvcs':         res = await coreApi.createNamespacedPersistentVolumeClaim(namespace, parsed); break;
    case 'hpas':         res = await autoscalingApi.createNamespacedHorizontalPodAutoscaler(namespace, parsed); break;
    case 'namespaces':   res = await coreApi.createNamespace(parsed); break;
    case 'serviceaccounts':     res = await coreApi.createNamespacedServiceAccount(namespace, parsed); break;
    case 'roles':               res = await rbacApi.createNamespacedRole(namespace, parsed); break;
    case 'rolebindings':        res = await rbacApi.createNamespacedRoleBinding(namespace, parsed); break;
    case 'clusterroles':        res = await rbacApi.createClusterRole(parsed); break;
    case 'clusterrolebindings': res = await rbacApi.createClusterRoleBinding(parsed); break;
    case 'networkpolicies':     res = await networkingApi.createNamespacedNetworkPolicy(namespace, parsed); break;
    case 'storageclasses':      res = await storageApi.createStorageClass(parsed); break;
    case 'resourcequotas':      res = await coreApi.createNamespacedResourceQuota(namespace, parsed); break;
    case 'limitranges':         res = await coreApi.createNamespacedLimitRange(namespace, parsed); break;
    default: return null;
  }
  return res.body;
}

// Strips server-managed / binding fields from a stored manifest before recreating it via POST —
// the object no longer exists, so resourceVersion/uid are stale and ownerReferences would point
// at a (possibly gone) parent, causing the API server to garbage-collect the recreated object
// immediately.
function stripForRecreate(parsed) {
  if (parsed.metadata) {
    delete parsed.metadata.resourceVersion;
    delete parsed.metadata.uid;
    delete parsed.metadata.creationTimestamp;
    delete parsed.metadata.generation;
    delete parsed.metadata.managedFields;
    delete parsed.metadata.selfLink;
    delete parsed.metadata.ownerReferences;
    if (parsed.metadata.annotations) {
      delete parsed.metadata.annotations['k8senvdiff-edit-resource-version'];
      delete parsed.metadata.annotations['kubectl.kubernetes.io/last-applied-configuration'];
    }
  }
  delete parsed.status;
  return parsed;
}

// Audit clusterId must stay stable across app restarts, regardless of how the kubeconfig was
// obtained. The raw `ref` isn't reliable for that: an AKS-picked cluster's `ref` is an in-memory-
// only sequential id (`aksKcStore`, above) that's regenerated from scratch every time the process
// starts — hashing it directly would silently orphan every previously-written audit row on each
// restart. The cluster's own API server URL is what's actually stable no matter the source, so
// resolve that instead of trusting the caller-supplied ref.
function resolveClusterId(ref, contextName) {
  let identity = ref;
  try {
    const kc = buildKubeConfig(ref, contextName);
    const cluster = kc.getCurrentCluster();
    if (cluster && cluster.server) identity = cluster.server;
  } catch { /* fall back to raw ref rather than failing audit entirely */ }
  return auditDb.getClusterId(identity, contextName);
}

// Best-effort audit recording — never throws, returns warning string on failure.
async function recordAudit({ ref, contextName, namespace, kind, name, action, oldObj, newObj, editVersion }) {
  try {
    const clusterId = resolveClusterId(ref, contextName);
    const updatedBy = auditDb.getAzureIdentity();
    const oldYaml = oldObj ? k8s.dumpYaml(kind === 'secrets' ? redactSecretData(oldObj) : oldObj) : null;
    const newYaml = newObj ? k8s.dumpYaml(kind === 'secrets' ? redactSecretData(newObj) : newObj) : null;
    const k8sResourceVersion = (newObj || oldObj)?.metadata?.resourceVersion || '';
    await auditDb.insertAudit({
      clusterId,
      namespace: namespace || '',
      kind,
      name,
      action,
      editVersion: editVersion || 0,
      k8sResourceVersion,
      oldYaml,
      newYaml,
      updatedBy,
    });
    return null; // no warning
  } catch (e) {
    console.error('[audit] Failed to record audit:', e.message);
    return `Audit recording failed: ${e.message}`;
  }
}

// ── K8s Manage: Audit IPC handlers ────────────────────────────────────────────

ipcMain.handle('audit-db-discover', async () => {
  return auditDb.discover();
});

ipcMain.handle('audit-db-connect', async (_e, user, password) => {
  // Always auto-discover server from Azure tags
  let disc = auditDb.status();
  if (!disc.server) {
    const discResult = await auditDb.discover();
    if (!discResult.ok) return { ok: false, error: 'No Azure SQL server found with tag aks-database-backup=k8s-env-diff' };
    disc = { server: discResult.server, database: discResult.database };
  }
  const result = await auditDb.connect({ server: disc.server, database: disc.database, user, password });
  if (result.ok) {
    return { ok: true, server: disc.server, database: disc.database };
  }
  return result;
});

ipcMain.handle('audit-db-disconnect', async () => {
  await auditDb.close();
  return { ok: true };
});

ipcMain.handle('audit-db-status', async () => {
  return auditDb.status();
});

ipcMain.handle('get-resource-versions', async (_e, ref, contextName, namespace, kind, name) => {
  console.log('[main-ipc] get-resource-versions called:', { ref, contextName, namespace, kind, name });
  try {
    const clusterId = resolveClusterId(ref, contextName);
    console.log('[main-ipc] Computed clusterId:', clusterId);
    const rows = await auditDb.getVersions({ clusterId, namespace, kind, name });
    console.log('[main-ipc] getVersions returned rows count:', rows ? rows.length : 0);
    return { ok: true, rows };
  } catch (e) {
    console.error('[main-ipc] Error in get-resource-versions:', e);
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('get-version-yaml', async (_e, id) => {
  try {
    const row = await auditDb.getVersionYaml(id);
    if (!row) return { ok: false, error: 'Version not found' };
    return { ok: true, row };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('get-deleted-resources', async (_e, ref, contextName, namespace) => {
  try {
    const clusterId = resolveClusterId(ref, contextName);
    const rows = await auditDb.getDeletedResources({ clusterId, namespace });
    return { ok: true, rows };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('restore-deleted-resource', async (_e, ref, contextName, namespace, kind, name, id, crdMeta) => {
  if (!auditDb.status().connected) return { ok: false, error: 'Audit DB not connected', kind: 'forbidden' };
  if (!crdMeta && kind === 'secrets') {
    return { ok: false, error: 'Secrets cannot be restored — their values were redacted at delete time and were never saved.', kind: 'validation' };
  }
  if (!crdMeta && !RESTORABLE_KINDS.has(kind)) {
    return { ok: false, error: `Restore not supported for kind: ${kind}`, kind: 'validation' };
  }
  try {
    // 1. Fetch the deleted version's YAML
    const versionRow = await auditDb.getVersionYaml(id);
    if (!versionRow) return { ok: false, error: 'Version not found' };
    const targetYaml = versionRow.old_yaml;
    if (!targetYaml) return { ok: false, error: 'No YAML data in this version' };

    // 2. Parse and strip server-managed fields so the recreate isn't rejected or instantly GC'd
    let parsed = k8s.loadYaml(targetYaml);
    if (!parsed || typeof parsed !== 'object') return { ok: false, error: 'Invalid YAML in version', kind: 'parse' };
    parsed = stripForRecreate(parsed);

    // 3. Recreate
    let newObj;
    if (crdMeta) {
      const kc = buildKubeConfig(ref, contextName);
      const customApi = kc.makeApiClient(k8s.CustomObjectsApi);
      const res = crdMeta.namespaced
        ? await customApi.createNamespacedCustomObject(crdMeta.group, crdMeta.version, namespace, crdMeta.plural, parsed)
        : await customApi.createClusterCustomObject(crdMeta.group, crdMeta.version, crdMeta.plural, parsed);
      newObj = res.body;
    } else {
      newObj = await createManageObject(ref, contextName, namespace, kind, parsed);
      if (!newObj) return { ok: false, error: `Restore not supported for kind: ${kind}`, kind: 'validation' };
    }

    // 4. Record audit
    const clusterId = resolveClusterId(ref, contextName);
    const editVersion = await auditDb.nextEditVersion({ clusterId, namespace, kind, name });
    const auditWarning = await recordAudit({
      ref, contextName, namespace, kind, name, action: 'restore',
      oldObj: null, newObj, editVersion,
    });

    return { ok: true, auditWarning };
  } catch (e) {
    if (e.statusCode === 409) {
      return { ok: false, error: 'A resource with this name already exists — delete it first, or it was already restored.', kind: 'conflict' };
    }
    if (e.statusCode === 403) return { ok: false, error: e.body?.message || e.message, kind: 'forbidden' };
    if (e.statusCode === 400 || e.statusCode === 422) return { ok: false, error: e.body?.message || e.message, kind: 'invalid' };
    return { ok: false, error: e.message, kind: 'error' };
  }
});

ipcMain.handle('restore-resource-version', async (_e, ref, contextName, namespace, kind, name, id, crdMeta) => {
  if (!auditDb.status().connected) return { ok: false, error: 'Audit DB not connected', kind: 'forbidden' };
  try {
    // 1. Fetch the target version's YAML
    const versionRow = await auditDb.getVersionYaml(id);
    if (!versionRow) return { ok: false, error: 'Version not found' };
    const targetYaml = versionRow.new_yaml || versionRow.old_yaml;
    if (!targetYaml) return { ok: false, error: 'No YAML data in this version' };

    // 2. Parse and get live object's resourceVersion for optimistic concurrency
    const parsed = k8s.loadYaml(targetYaml);
    if (!parsed || typeof parsed !== 'object') return { ok: false, error: 'Invalid YAML in version', kind: 'parse' };

    let liveObj;
    if (crdMeta) {
      const kc = buildKubeConfig(ref, contextName);
      const customApi = kc.makeApiClient(k8s.CustomObjectsApi);
      const res = crdMeta.namespaced
        ? await customApi.getNamespacedCustomObject(crdMeta.group, crdMeta.version, namespace, crdMeta.plural, name)
        : await customApi.getClusterCustomObject(crdMeta.group, crdMeta.version, crdMeta.plural, name);
      liveObj = res.body;
    } else {
      liveObj = await readManageObject(ref, contextName, namespace, kind, name);
    }
    if (!liveObj) return { ok: false, error: 'Cannot read current resource' };

    // 3. Set the live resourceVersion on the parsed YAML
    if (!parsed.metadata) parsed.metadata = {};
    parsed.metadata.resourceVersion = liveObj.metadata.resourceVersion;

    // 4. Bump audit annotation
    const clusterId = resolveClusterId(ref, contextName);
    const dbNext = await auditDb.nextEditVersion({ clusterId, namespace, kind, name });
    const currentAnno = parseInt(liveObj.metadata?.annotations?.['k8senvdiff-edit-resource-version'] || '0', 10);
    const next = Math.max(dbNext, currentAnno + 1);
    if (!parsed.metadata.annotations) parsed.metadata.annotations = {};
    parsed.metadata.annotations['k8senvdiff-edit-resource-version'] = String(next);

    // 5. Apply (replace)
    let newObj;
    if (crdMeta) {
      const kc = buildKubeConfig(ref, contextName);
      const customApi = kc.makeApiClient(k8s.CustomObjectsApi);
      const res = crdMeta.namespaced
        ? await customApi.replaceNamespacedCustomObject(crdMeta.group, crdMeta.version, namespace, crdMeta.plural, name, parsed)
        : await customApi.replaceClusterCustomObject(crdMeta.group, crdMeta.version, crdMeta.plural, name, parsed);
      newObj = res.body;
    } else {
      // Re-use the same replace dispatch as apply-resource-yaml
      const kc = buildKubeConfig(ref, contextName);
      const coreApi = kc.makeApiClient(k8s.CoreV1Api);
      const appsApi = kc.makeApiClient(k8s.AppsV1Api);
      const batchApi = kc.makeApiClient(k8s.BatchV1Api);
      const networkingApi = kc.makeApiClient(k8s.NetworkingV1Api);
      const autoscalingApi = kc.makeApiClient(k8s.AutoscalingV2Api);
      const rbacApi = kc.makeApiClient(k8s.RbacAuthorizationV1Api);
      const storageApi = kc.makeApiClient(k8s.StorageV1Api);
      let res;
      switch (kind) {
        case 'pods':         res = await coreApi.replaceNamespacedPod(name, namespace, parsed); break;
        case 'deployments':  res = await appsApi.replaceNamespacedDeployment(name, namespace, parsed); break;
        case 'statefulsets': res = await appsApi.replaceNamespacedStatefulSet(name, namespace, parsed); break;
        case 'daemonsets':   res = await appsApi.replaceNamespacedDaemonSet(name, namespace, parsed); break;
        case 'replicasets':  res = await appsApi.replaceNamespacedReplicaSet(name, namespace, parsed); break;
        case 'services':     res = await coreApi.replaceNamespacedService(name, namespace, parsed); break;
        case 'ingresses':    res = await networkingApi.replaceNamespacedIngress(name, namespace, parsed); break;
        case 'configmaps':   res = await coreApi.replaceNamespacedConfigMap(name, namespace, parsed); break;
        case 'secrets':      res = await coreApi.replaceNamespacedSecret(name, namespace, parsed); break;
        case 'jobs':         res = await batchApi.replaceNamespacedJob(name, namespace, parsed); break;
        case 'cronjobs':     res = await batchApi.replaceNamespacedCronJob(name, namespace, parsed); break;
        case 'pvcs':         res = await coreApi.replaceNamespacedPersistentVolumeClaim(name, namespace, parsed); break;
        case 'hpas':         res = await autoscalingApi.replaceNamespacedHorizontalPodAutoscaler(name, namespace, parsed); break;
        case 'nodes':        res = await coreApi.replaceNode(name, parsed); break;
        case 'pvs':          res = await coreApi.replacePersistentVolume(name, parsed); break;
        case 'namespaces':   res = await coreApi.replaceNamespace(name, parsed); break;
        case 'events':       res = await coreApi.replaceNamespacedEvent(name, namespace, parsed); break;
        case 'serviceaccounts':     res = await coreApi.replaceNamespacedServiceAccount(name, namespace, parsed); break;
        case 'roles':               res = await rbacApi.replaceNamespacedRole(name, namespace, parsed); break;
        case 'rolebindings':        res = await rbacApi.replaceNamespacedRoleBinding(name, namespace, parsed); break;
        case 'clusterroles':        res = await rbacApi.replaceClusterRole(name, parsed); break;
        case 'clusterrolebindings': res = await rbacApi.replaceClusterRoleBinding(name, parsed); break;
        case 'networkpolicies':    res = await networkingApi.replaceNamespacedNetworkPolicy(name, namespace, parsed); break;
        case 'storageclasses':     res = await storageApi.replaceStorageClass(name, parsed); break;
        case 'resourcequotas':     res = await coreApi.replaceNamespacedResourceQuota(name, namespace, parsed); break;
        case 'limitranges':        res = await coreApi.replaceNamespacedLimitRange(name, namespace, parsed); break;
        default: return { ok: false, error: `Restore not supported for kind: ${kind}` };
      }
      newObj = res.body;
    }

    // 6. Record audit
    const auditWarning = await recordAudit({
      ref, contextName, namespace, kind, name, action: 'restore',
      oldObj: liveObj, newObj, editVersion: next,
    });

    return { ok: true, auditWarning };
  } catch (e) {
    if (e.statusCode === 409) return { ok: false, error: 'Resource changed since load — reload and retry.', kind: 'conflict' };
    if (e.statusCode === 403) return { ok: false, error: e.body?.message || e.message, kind: 'forbidden' };
    return { ok: false, error: e.message };
  }
});

// ── K8s Manage: CRDs (dynamic, keyed by group/version/plural — not a fixed kind string) ──────
// MANAGE_KINDS is a hardcoded list and doesn't scale to arbitrary CRDs, so this is a parallel,
// kind-agnostic path. All one-shot fetches — no session/Map/teardown needed (unlike logs/exec/pf).

ipcMain.handle('list-crds', async (_e, ref, contextName) => {
  try {
    const kc = buildKubeConfig(ref, contextName);
    const apiext = kc.makeApiClient(k8s.ApiextensionsV1Api);
    const res = await withTimeout(apiext.listCustomResourceDefinition(), 20000, 'Timed out listing CRDs');
    const crds = (res.body.items || []).map((crd) => {
      const spec = crd.spec || {};
      const versions = spec.versions || [];
      const served = versions.find((v) => v.served && v.storage) || versions.find((v) => v.served) || versions[0];
      return {
        name: crd.metadata.name,
        group: spec.group,
        version: served ? served.name : null,
        plural: spec.names?.plural,
        kind: spec.names?.kind,
        namespaced: spec.scope === 'Namespaced',
      };
    }).filter((c) => c.version && c.plural);
    return { ok: true, crds };
  } catch (e) {
    // Common case: no cluster-wide `list customresourcedefinitions` RBAC — non-fatal, renderer
    // shows "No CRDs found" and the rest of Manage (built-in kinds) is unaffected.
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('list-custom-resource', async (_e, ref, contextName, namespace, group, version, plural, namespaced) => {
  try {
    const kc = buildKubeConfig(ref, contextName);
    const customApi = kc.makeApiClient(k8s.CustomObjectsApi);
    const allNs = namespace === ALL_NAMESPACES;
    // listClusterCustomObject (no namespace segment) also serves as the natural "all namespaces"
    // fetch for namespaced CRDs, so the ALL_NAMESPACES sentinel needs no extra fan-out logic here.
    const res = (namespaced && !allNs)
      ? await withTimeout(customApi.listNamespacedCustomObject(group, version, namespace, plural), 20000, 'Timed out listing custom resources')
      : await withTimeout(customApi.listClusterCustomObject(group, version, plural), 20000, 'Timed out listing custom resources');
    const rows = (res.body.items || []).map((item) => {
      const meta = item.metadata || {};
      return { namespace: meta.namespace || '', name: meta.name, age: ageOf(meta.creationTimestamp) };
    });
    return { ok: true, rows };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('get-custom-resource-yaml', async (_e, ref, contextName, namespace, group, version, plural, name, namespaced, opts) => {
  try {
    const kc = buildKubeConfig(ref, contextName);
    const customApi = kc.makeApiClient(k8s.CustomObjectsApi);
    const res = namespaced
      ? await withTimeout(customApi.getNamespacedCustomObject(group, version, namespace, plural, name), 20000, 'Timed out reading custom resource')
      : await withTimeout(customApi.getClusterCustomObject(group, version, plural, name), 20000, 'Timed out reading custom resource');
    const obj = res.body;
    if (obj.metadata) {
      delete obj.metadata.managedFields;
      delete obj.metadata.uid;
      delete obj.metadata.creationTimestamp;
      // Edit mode needs resourceVersion preserved for optimistic-concurrency on apply — only the
      // read-only view strips it as declutter.
      if (!(opts && opts.forEdit)) delete obj.metadata.resourceVersion;
      if (obj.metadata.annotations) {
        delete obj.metadata.annotations['kubectl.kubernetes.io/last-applied-configuration'];
      }
    }
    delete obj.status;
    return { ok: true, yaml: k8s.dumpYaml(obj), editable: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('get-custom-resource-events', async (_e, ref, contextName, namespace, involvedObjectKind, name, namespaced) => {
  try {
    const kc = buildKubeConfig(ref, contextName);
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);
    const fieldSelector = `involvedObject.name=${name},involvedObject.kind=${involvedObjectKind}`;
    const res = !namespaced
      ? await withTimeout(coreApi.listEventForAllNamespaces(undefined, undefined, fieldSelector), 20000, 'Timed out listing events')
      : await withTimeout(coreApi.listNamespacedEvent(namespace, undefined, undefined, undefined, fieldSelector), 20000, 'Timed out listing events');
    const rows = (res.body.items || [])
      .map((item) => ({
        uid: item.metadata?.uid || '',
        type: item.type || '',
        reason: item.reason || '',
        message: item.message || '',
        count: item.count || 1,
        _ts: item.lastTimestamp || item.eventTime || item.metadata?.creationTimestamp,
      }))
      .sort((a, b) => new Date(b._ts || 0) - new Date(a._ts || 0))
      .map((item) => ({ ...item, age: ageOf(item._ts) }));
    return { ok: true, rows };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// Delete-only for v1 — mirrors the resource-action allow-list philosophy but keyed by GVR.
ipcMain.handle('custom-resource-action', async (_e, ref, contextName, namespace, group, version, plural, name, namespaced, action) => {
  if (action !== 'delete') return { ok: false, error: `Unknown custom resource action: ${action}` };
  try {
    const kc = buildKubeConfig(ref, contextName);
    const customApi = kc.makeApiClient(k8s.CustomObjectsApi);

    // ── Audit: capture old CRD snapshot before delete ──
    let oldObj = null;
    let crdKindLabel = plural;
    if (auditDb.status().connected) {
      try {
        const oldRes = namespaced
          ? await customApi.getNamespacedCustomObject(group, version, namespace, plural, name)
          : await customApi.getClusterCustomObject(group, version, plural, name);
        oldObj = oldRes.body;
        crdKindLabel = oldObj.kind || plural;
      } catch { /* best-effort */ }
    }

    if (namespaced) await customApi.deleteNamespacedCustomObject(group, version, namespace, plural, name);
    else await customApi.deleteClusterCustomObject(group, version, plural, name);

    // ── Audit: record after delete ──
    if (auditDb.status().connected && oldObj) {
      const editVersion = parseInt(oldObj.metadata?.annotations?.['k8senvdiff-edit-resource-version'] || '0', 10);
      await recordAudit({
        ref, contextName, namespace, kind: crdKindLabel, name, action: 'delete',
        oldObj, newObj: null, editVersion,
      });
    }

    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ── K8s Manage: pod log streaming ────────────────────────────────────────────
const { Writable } = require('stream');

// sid -> { buffer, flushTimer, req }. One entry per open drawer log view.
const logSessions = new Map();

function stopLogSession(sid) {
  const session = logSessions.get(sid);
  if (!session) return;
  clearInterval(session.flushTimer);
  try { session.req && session.req.abort(); } catch { /* already closed */ }
  logSessions.delete(sid);
}

ipcMain.handle('start-pod-logs', async (_e, ref, contextName, namespace, pod, container, opts, sid) => {
  stopLogSession(sid);

  const sendIfAlive = (channel, ...args) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, ...args);
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

  // Main does not send every chunk individually — coalesce into one flush per
  // interval so a chatty container can't flood the renderer with IPC messages.
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
      // stop-pod-logs was called while the connection was still opening
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
});

ipcMain.handle('stop-pod-logs', async (_e, sid) => {
  stopLogSession(sid);
  return { ok: true };
});

// ── K8s Manage: pod exec/shell ───────────────────────────────────────────────
const { PassThrough } = require('stream');

// sid -> { stdin, stdout, ws }. One entry per open drawer exec/terminal session.
const execSessions = new Map();

function stopExecSession(sid) {
  const session = execSessions.get(sid);
  if (!session) return;
  try { session.stdin.end(); } catch { /* already closed */ }
  try { session.ws && session.ws.close(); } catch { /* already closed */ }
  execSessions.delete(sid);
}

ipcMain.handle('exec-start', async (_e, ref, contextName, namespace, pod, container, sid) => {
  stopExecSession(sid);

  const sendIfAlive = (channel, ...args) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, ...args);
  };

  const stdin = new PassThrough();
  // stdout doubles as stderr — like a real terminal, both streams interleave into
  // one output. It also carries rows/columns + EventEmitter so Exec treats it as
  // resizable and opens the resize channel (see terminal-size-queue.js).
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
      // exec-stop was called while the connection was still opening
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
});

ipcMain.on('exec-write', (_e, sid, data) => {
  const session = execSessions.get(sid);
  if (session) session.stdin.write(data);
});

ipcMain.on('exec-resize', (_e, sid, cols, rows) => {
  const session = execSessions.get(sid);
  if (!session) return;
  session.stdout.columns = cols;
  session.stdout.rows = rows;
  session.stdout.emit('resize');
});

ipcMain.handle('exec-stop', async (_e, sid) => {
  stopExecSession(sid);
  return { ok: true };
});

// ── K8s Manage: port-forward ──────────────────────────────────────────────────
const net = require('net');

// sid -> { server }. One local TCP listener per open port-forward; a fresh
// portForward() WebSocket is opened per incoming local connection.
const pfSessions = new Map();

function stopPortForwardSession(sid) {
  const session = pfSessions.get(sid);
  if (!session) return;
  try { session.server.close(); } catch { /* already closed */ }
  pfSessions.delete(sid);
}

ipcMain.handle('pf-start', async (_e, ref, contextName, namespace, pod, targetPort, localPort, sid) => {
  stopPortForwardSession(sid);

  const sendIfAlive = (channel, ...args) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, ...args);
  };

  try {
    const kc = buildKubeConfig(ref, contextName);
    const forward = new k8s.PortForward(kc);

    const server = net.createServer((socket) => {
      // Each local TCP connection gets its own port-forward WebSocket; the socket itself
      // doubles as both the output (pod -> client) and input (client -> pod) stream.
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
});

ipcMain.handle('pf-stop', async (_e, sid) => {
  stopPortForwardSession(sid);
  return { ok: true };
});

// ── Event Auto-Capture & SQLite local storage ────────────────────────────────

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
        {
          allowWatchBookmarks: true
        },
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
          // Auto reconnect after 5s if still active
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
    } catch (e) {
      // ignore
    }
    activeWatcherRequest = null;
  }
}

ipcMain.handle('toggle-event-capture', async (_e, { enabled, ref, contextName, namespace, retentionDays }) => {
  try {
    if (enabled) {
      await startEventWatch(ref, contextName, namespace, retentionDays);
    } else {
      stopEventWatch();
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('set-event-retention', async (_e, { retentionDays }) => {
  try {
    currentWatcherRetention = Number(retentionDays) || 0;
    if (currentWatcherRetention > 0) {
      await eventsDb.cleanOldEvents(currentWatcherRetention);
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('clear-event-db', async () => {
  try {
    const changes = await eventsDb.clearEvents();
    return { ok: true, changes };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('get-local-events', async (_e, { namespace, kind, name }) => {
  try {
    const rows = await eventsDb.getLocalEvents(namespace, kind, name);
    return { ok: true, rows };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// Đảm bảo dừng watcher khi đóng app
app.on('will-quit', () => {
  stopEventWatch();
});

// ── helpers ───────────────────────────────────────────────────────────────────

function isKubeconfigContent(str) {
  if (typeof str !== 'string') return false;
  const s = str.replace(/^﻿/, '').trimStart();
  return s.startsWith('apiVersion:') || s.startsWith('---');
}

function buildKubeConfig(ref, contextName) {
  const kc = new k8s.KubeConfig();
  if (!ref) {
    kc.loadFromDefault();
  } else if (aksKcStore.has(ref)) {
    // Stored AKS kubeconfig — already validated at fetch time
    kc.loadFromString(touchAksKc(ref));
  } else if (isKubeconfigContent(ref)) {
    kc.loadFromString(ref.replace(/^﻿/, '').trimStart());
  } else {
    kc.loadFromFile(ref);
  }
  if (contextName) {
    // Only override if the context actually exists; otherwise keep current-context from YAML
    const exists = kc.getContexts().some((ctx) => ctx.name === contextName);
    if (exists) kc.setCurrentContext(contextName);
  }

  // Patch ExecAuth to use spawnSync with a timeout.
  // The default execFn is child_process.spawnSync with no timeout — if kubelogin
  // hangs waiting for browser auth it blocks the entire Node.js event loop forever.
  const execAuth = kc.authenticators && kc.authenticators.find(
    (a) => a.constructor && a.constructor.name === 'ExecAuth'
  );
  if (execAuth && execAuth.execFn) {
    const origExecFn = execAuth.execFn;
    execAuth.execFn = (command, args, opts) => {
      const result = origExecFn(command, args, { ...opts, timeout: 15000 });
      if (result.error && result.error.code === 'ETIMEDOUT') {
        return {
          status: 1,
          stdout: Buffer.from(''),
          stderr: Buffer.from(
            'kubelogin timed out after 15s — token may be expired. Run: kubelogin convert-kubeconfig -l azurecli'
          ),
          signal: result.signal,
        };
      }
      return result;
    };
  }

  return kc;
}
