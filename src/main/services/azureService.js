const { execSync, spawn, exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const path = require('path');
const fs = require('fs');
const os = require('os');
const k8s = require('@kubernetes/client-node');
const { storeAksKc } = require('./kubeconfigStoreService');

async function checkAzureAuth() {
  try {
    execSync('az account get-access-token --output none', { encoding: 'utf8', timeout: 8000, stdio: 'pipe' });
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

async function checkKubeloginAuth() {
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
        } catch { /* skip unreadable */ }
      }
    }
  } catch { /* ignore */ }
  return { ok: true };
}

async function getTokenExpiry() {
  try {
    const output = execSync('az account get-access-token --output json', {
      encoding: 'utf8',
      timeout: 10000,
      stdio: 'pipe',
    });
    const data = JSON.parse(output);
    const expiresAt = data.expires_on
      ? data.expires_on * 1000
      : new Date(data.expiresOn.replace(' ', 'T')).getTime();
    return { ok: true, expiresAt };
  } catch {
    return { ok: false };
  }
}

async function azLogout() {
  try {
    execSync('az logout', { encoding: 'utf8', timeout: 5000, stdio: 'pipe' });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e.stderr || e.message) };
  }
}

async function azLogin() {
  return new Promise((resolve) => {
    const proc = spawn('az', ['login'], { shell: true, stdio: 'pipe' });
    proc.on('close', (code) => resolve({ ok: code === 0 }));
    proc.on('error', (err) => resolve({ ok: false, error: err.message }));
  });
}

async function kubeloginRefresh() {
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
}

async function listAksClusters() {
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
}

async function getAksCredentials(name, resourceGroup) {
  const tmpFile = path.join(os.tmpdir(), `k8senvdiff-${process.pid}-${Date.now()}.yaml`);
  try {
    execSync(
      `az aks get-credentials --name "${name}" --resource-group "${resourceGroup}" --file "${tmpFile}" --overwrite-existing`,
      { encoding: 'utf8', timeout: 30000, stdio: 'pipe' }
    );
    try {
      execSync(`kubelogin convert-kubeconfig -l azurecli --kubeconfig "${tmpFile}"`, {
        encoding: 'utf8',
        timeout: 10000,
        stdio: 'pipe',
      });
    } catch {
      /* proceed with original */
    }
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
}

async function listStorageAccounts() {
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
}

async function listStorageContainers(accounts) {
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
}

async function listServicebusNamespaces() {
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
}

async function listServicebusQueues(namespaces) {
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
}

module.exports = {
  checkAzureAuth,
  checkKubeloginAuth,
  getTokenExpiry,
  azLogout,
  azLogin,
  kubeloginRefresh,
  listAksClusters,
  getAksCredentials,
  listStorageAccounts,
  listStorageContainers,
  listServicebusNamespaces,
  listServicebusQueues,
};
