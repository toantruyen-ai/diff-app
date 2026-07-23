const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const k8s = require('@kubernetes/client-node');
const fs = require('fs');
const { execSync, spawn, exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const os = require('os');

function withTimeout(promise, ms, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(message || `Request timed out after ${ms / 1000}s`)), ms)
    ),
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
    // Pod log streams and exec sessions hold open connections to the cluster —
    // abort them all, otherwise they keep running after the window is gone.
    for (const sid of logSessions.keys()) stopLogSession(sid);
    for (const sid of execSessions.keys()) stopExecSession(sid);
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
    const kcId = `aks:${++aksKcIdSeq}`;
    aksKcStore.set(kcId, raw);
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

const MANAGE_KINDS = ['pods', 'deployments', 'statefulsets', 'daemonsets', 'services', 'configmaps', 'secrets', 'nodes', 'events'];

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
function projectRow(kind, item) {
  const meta = item.metadata || {};
  switch (kind) {
    case 'pods': {
      const statuses = item.status?.containerStatuses || [];
      const restarts = statuses.reduce((sum, s) => sum + (s.restartCount || 0), 0);
      return {
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
        name: meta.name,
        ready: `${status.readyReplicas || 0}/${spec.replicas ?? 0}`,
        age: ageOf(meta.creationTimestamp),
      };
    }
    case 'daemonsets': {
      const status = item.status || {};
      return {
        name: meta.name,
        desired: status.desiredNumberScheduled || 0,
        current: status.currentNumberScheduled || 0,
        ready: status.numberReady || 0,
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
        name: meta.name,
        type: spec.type || 'ClusterIP',
        clusterIp: spec.clusterIP || '',
        externalIp: [...(spec.externalIPs || []), ...lbIngress].join(', '),
        ports,
        age: ageOf(meta.creationTimestamp),
      };
    }
    case 'configmaps': {
      return { name: meta.name, keys: Object.keys(item.data || {}).length, age: ageOf(meta.creationTimestamp) };
    }
    case 'secrets': {
      return {
        name: meta.name,
        type: item.type || 'Opaque',
        keys: Object.keys(item.data || {}).length,
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
        name: meta.name,
        status: readyCond && readyCond.status === 'True' ? 'Ready' : 'NotReady',
        roles: roles.length ? roles.join(',') : '<none>',
        version: item.status?.nodeInfo?.kubeletVersion || '',
        age: ageOf(meta.creationTimestamp),
      };
    }
    case 'events': {
      return {
        name: meta.name,
        type: item.type || '',
        reason: item.reason || '',
        object: item.involvedObject ? `${item.involvedObject.kind}/${item.involvedObject.name}` : '',
        message: item.message || '',
        age: ageOf(item.lastTimestamp || item.eventTime || meta.creationTimestamp),
      };
    }
    default:
      return { name: meta.name, age: ageOf(meta.creationTimestamp) };
  }
}

ipcMain.handle('list-resource', async (_e, ref, contextName, namespace, kind) => {
  if (!MANAGE_KINDS.includes(kind)) return { ok: false, error: `Unknown resource kind: ${kind}` };
  try {
    const kc = buildKubeConfig(ref, contextName);
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);
    const appsApi = kc.makeApiClient(k8s.AppsV1Api);

    let res;
    switch (kind) {
      case 'pods':         res = await withTimeout(coreApi.listNamespacedPod(namespace), 20000, 'Timed out listing pods'); break;
      case 'deployments':  res = await withTimeout(appsApi.listNamespacedDeployment(namespace), 20000, 'Timed out listing deployments'); break;
      case 'statefulsets': res = await withTimeout(appsApi.listNamespacedStatefulSet(namespace), 20000, 'Timed out listing statefulsets'); break;
      case 'daemonsets':   res = await withTimeout(appsApi.listNamespacedDaemonSet(namespace), 20000, 'Timed out listing daemonsets'); break;
      case 'services':     res = await withTimeout(coreApi.listNamespacedService(namespace), 20000, 'Timed out listing services'); break;
      case 'configmaps':   res = await withTimeout(coreApi.listNamespacedConfigMap(namespace), 20000, 'Timed out listing configmaps'); break;
      case 'secrets':      res = await withTimeout(coreApi.listNamespacedSecret(namespace), 20000, 'Timed out listing secrets'); break;
      case 'nodes':        res = await withTimeout(coreApi.listNode(), 20000, 'Timed out listing nodes'); break;
      case 'events':       res = await withTimeout(coreApi.listNamespacedEvent(namespace), 20000, 'Timed out listing events'); break;
    }

    const rows = (res.body.items || []).map((item) => projectRow(kind, item));
    return { ok: true, rows };
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
    const kc = buildKubeConfig(ref, contextName);
    const metricsApi = new k8s.Metrics(kc);
    const res = scope === 'nodes'
      ? await withTimeout(metricsApi.getNodeMetrics(), 10000, 'Timed out fetching node metrics')
      : await withTimeout(metricsApi.getPodMetrics(namespace), 10000, 'Timed out fetching pod metrics');

    const rows = (res.items || []).map((item) => {
      const usages = scope === 'nodes' ? [item.usage || {}] : (item.containers || []).map((c) => c.usage || {});
      const cpu = usages.reduce((sum, u) => sum + parseCpuMillis(u.cpu), 0);
      const memory = usages.reduce((sum, u) => sum + parseMemoryBytes(u.memory), 0);
      return { name: item.metadata.name, cpu, memory };
    });
    return { ok: true, rows };
  } catch (e) {
    // metrics-server not installed/unreachable is the overwhelmingly common failure here —
    // callers stop polling and show a notice instead of alerting.
    return { ok: false, reason: 'metrics-server-unavailable', error: e.message };
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
    kc.loadFromString(aksKcStore.get(ref));
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
