const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const k8s = require('@kubernetes/client-node');
const fs = require('fs');

// When launched as a packaged .app on macOS, the process inherits a bare PATH
// (/usr/bin:/bin:/usr/sbin:/sbin) — kubelogin/kubectl plugins are not found.
// Spawn a login shell once to read the user's real PATH and inject it.
if (process.platform === 'darwin' && app.isPackaged) {
  const { execSync } = require('child_process');
  const os = require('os');
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

ipcMain.handle('load-contexts', async (_e, kubeconfigPath) => {
  try {
    const kc = new k8s.KubeConfig();
    if (kubeconfigPath) {
      kc.loadFromFile(kubeconfigPath);
    } else {
      kc.loadFromDefault();
    }
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

// ── helpers ───────────────────────────────────────────────────────────────────

function buildKubeConfig(kubeconfigPath, contextName) {
  const kc = new k8s.KubeConfig();
  if (kubeconfigPath) {
    kc.loadFromFile(kubeconfigPath);
  } else {
    kc.loadFromDefault();
  }
  if (contextName) {
    kc.setCurrentContext(contextName);
  }
  return kc;
}
