const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const k8s = require('@kubernetes/client-node');
const fs = require('fs');
const { execSync, spawn, exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const os = require('os');

// When launched as a packaged .app on macOS, the process inherits a bare PATH
// (/usr/bin:/bin:/usr/sbin:/sbin) — kubelogin/kubectl plugins are not found.
// Spawn a login shell once to read the user's real PATH and inject it.
if (process.platform === 'darwin' && app.isPackaged) {
  try {
    const shell = process.env.SHELL || '/bin/zsh';
    const shellPath = execSync(`${shell} -l -c 'echo $PATH'`, {
      encoding: 'utf8',
      timeout: 3000,
    }).trim();
    if (shellPath) process.env.PATH = shellPath;
  } catch {
    // Fallback: prepend common kubelogin install locations
    const home = os.homedir();
    process.env.PATH = [
      `${home}/.krew/bin`,
      '/opt/homebrew/bin',
      '/usr/local/bin',
      process.env.PATH,
    ].join(':');
  }
}

let mainWindow;

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
    show: false,
  });

  mainWindow.loadFile('renderer/index.html');
  mainWindow.once('ready-to-show', () => mainWindow.show());
}

app.whenReady().then(() => {
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
      const res = await coreApi.listNamespace();
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
    const res = await appsApi.listNamespacedDeployment(namespace);
    return res.body.items.map((d) => d.metadata.name).sort();
  } catch (e) {
    throw new Error(`Failed to load deployments: ${e.message}`);
  }
});

ipcMain.handle('load-envs', async (_e, kubeconfigPath, contextName, namespace, deploymentName) => {
  const kc = buildKubeConfig(kubeconfigPath, contextName);
  const appsApi = kc.makeApiClient(k8s.AppsV1Api);
  const coreApi = kc.makeApiClient(k8s.CoreV1Api);

  const depRes = await appsApi.readNamespacedDeployment(deploymentName, namespace);
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
    execSync('az account show --output none', { encoding: 'utf8', timeout: 8000, stdio: 'pipe' });
    return { ok: true };
  } catch {
    return { ok: false };
  }
});

ipcMain.handle('check-kubelogin-auth', async () => {
  const cacheDir = path.join(os.homedir(), '.kube', 'cache', 'kubelogin');
  try {
    if (!fs.existsSync(cacheDir)) return { ok: true };
    const files = fs.readdirSync(cacheDir).filter((f) => f.endsWith('.json'));
    if (files.length === 0) return { ok: true };
    const now = Math.floor(Date.now() / 1000);
    for (const file of files) {
      try {
        const content = JSON.parse(fs.readFileSync(path.join(cacheDir, file), 'utf8'));
        const token = content.accessToken || content.access_token;
        if (token) {
          const parts = token.split('.');
          if (parts.length === 3) {
            const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
            if (payload.exp && payload.exp < now) return { ok: false };
          }
        }
      } catch { /* skip unreadable cache file */ }
    }
    return { ok: true };
  } catch {
    return { ok: true };
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
  return kc;
}
