/**
 * audit-db.js — Azure SQL audit trail for K8s Manage mutations.
 *
 * Mirrors the events-db.js pattern (singleton connection, module-level state).
 * Uses mssql (pure JS / tedious) — no native rebuild needed for electron-builder.
 */

const { execSync } = require('child_process');
const crypto = require('crypto');

let sql; // lazy-require mssql so the rest of the app still loads even if the package is missing

const { getClusterId, resolveClusterId } = require('../utils/k8sHelper');

// ── Module state ──────────────────────────────────────────────────────────────

let pool = null;
let discovered = null;  // { server, database, resourceGroup } | null
let _azureIdentity = null;
let _azureIdentityTs = 0;
const IDENTITY_TTL_MS = 5 * 60 * 1000; // 5 minutes

// ── Azure identity ────────────────────────────────────────────────────────────

function getAzureIdentity() {
  if (_azureIdentity && Date.now() - _azureIdentityTs < IDENTITY_TTL_MS) return _azureIdentity;
  try {
    _azureIdentity = execSync('az account show --query user.name -o tsv', {
      encoding: 'utf8',
      timeout: 8000,
      stdio: 'pipe',
    }).trim();
    _azureIdentityTs = Date.now();
  } catch {
    _azureIdentity = '';
  }
  return _azureIdentity;
}

// ── Discovery ─────────────────────────────────────────────────────────────────

async function discover() {
  try {
    const output = execSync(
      'az sql server list --query "[?tags.\\"aks-database-backup\\"==\'k8s-env-diff\']" --output json',
      { encoding: 'utf8', timeout: 30000, stdio: 'pipe' }
    );
    const servers = JSON.parse(output);
    if (!servers || servers.length === 0) return { ok: false };
    const match = servers[0]; // take first matching server
    discovered = {
      server: match.fullyQualifiedDomainName,
      database: (match.tags && match.tags.dbname) || 'K8sBackup',
      resourceGroup: match.resourceGroup,
    };
    return { ok: true, server: discovered.server, database: discovered.database };
  } catch (e) {
    return { ok: false, error: String(e.stderr || e.message) };
  }
}

// ── Connection ────────────────────────────────────────────────────────────────

async function connect({ server, database, user, password }) {
  try {
    if (!sql) sql = require('mssql');
  } catch (e) {
    return { ok: false, error: 'mssql package not installed: ' + e.message };
  }

  // Close existing pool if any
  if (pool) {
    try { await pool.close(); } catch { /* ignore */ }
    pool = null;
  }

  try {
    pool = await sql.connect({
      server: server || (discovered && discovered.server),
      database: database || (discovered && discovered.database) || 'K8sBackup',
      user,
      password,
      port: 1433,
      options: {
        encrypt: true,
        trustServerCertificate: false,
      },
      connectionTimeout: 10000,
      requestTimeout: 15000,
    });

    // Listen for pool errors (connection drops)
    pool.on('error', (err) => {
      console.error('[audit-db] Pool error:', err.message);
      pool = null;
    });

    await ensureSchema();
    return { ok: true };
  } catch (e) {
    pool = null;
    return { ok: false, error: e.message };
  }
}

// ── Schema ────────────────────────────────────────────────────────────────────

async function ensureSchema() {
  if (!pool) return;
  await pool.request().query(`
    IF OBJECT_ID('k8senvdiff_audit', 'U') IS NULL
    CREATE TABLE k8senvdiff_audit (
      id              NVARCHAR(64)   PRIMARY KEY,
      cluster_id      NVARCHAR(64)   NOT NULL,
      namespace       NVARCHAR(256)  NOT NULL DEFAULT '',
      kind            NVARCHAR(128)  NOT NULL,
      name            NVARCHAR(256)  NOT NULL,
      action          NVARCHAR(16)   NOT NULL,
      edit_version    INT            NOT NULL DEFAULT 0,
      k8s_resource_version NVARCHAR(64) NOT NULL DEFAULT '',
      old_yaml        NVARCHAR(MAX),
      new_yaml        NVARCHAR(MAX),
      updated_by      NVARCHAR(256)  NOT NULL DEFAULT '',
      updated_at      DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME()
    )
  `);
  await pool.request().query(`
    IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_audit_resource')
    CREATE INDEX IX_audit_resource ON k8senvdiff_audit (cluster_id, namespace, kind, name, edit_version)
  `);
  await pool.request().query(`
    IF OBJECT_ID('k8senvdiff_ai_analysis', 'U') IS NULL
    CREATE TABLE k8senvdiff_ai_analysis (
      id              NVARCHAR(64)   PRIMARY KEY,
      cluster_id      NVARCHAR(64)   NOT NULL,
      namespace       NVARCHAR(256)  NOT NULL DEFAULT '',
      pod_name        NVARCHAR(256)  NOT NULL DEFAULT '',
      root_cause      NVARCHAR(MAX),
      confidence      NVARCHAR(32),
      category        NVARCHAR(64),
      degraded        BIT            NOT NULL DEFAULT 0,
      result_json     NVARCHAR(MAX),
      created_at      DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME()
    )
  `);
  await pool.request().query(`
    IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_ai_analysis_pod')
    CREATE INDEX IX_ai_analysis_pod ON k8senvdiff_ai_analysis (cluster_id, namespace, pod_name, created_at DESC)
  `);
  await pool.request().query(`
    IF OBJECT_ID('k8senvdiff_ai_config', 'U') IS NULL
    CREATE TABLE k8senvdiff_ai_config (
      cluster_id             NVARCHAR(64)   PRIMARY KEY,
      grafana_url            NVARCHAR(512)  NOT NULL DEFAULT '',
      service_account_token  NVARCHAR(MAX)  NOT NULL DEFAULT '',
      loki_datasource        NVARCHAR(256)  NOT NULL DEFAULT '',
      mimir_datasource       NVARCHAR(256)  NOT NULL DEFAULT '',
      tempo_datasource       NVARCHAR(256)  NOT NULL DEFAULT '',
      updated_at             DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME()
    )
  `);
}

// ── Audit CRUD ────────────────────────────────────────────────────────────────

const MAX_YAML_SIZE = 1024 * 1024; // 1 MB — truncate beyond this

function truncateYaml(yamlStr) {
  if (!yamlStr) return yamlStr;
  if (yamlStr.length > MAX_YAML_SIZE) {
    return yamlStr.substring(0, MAX_YAML_SIZE) + '\n# ... truncated (>1MB) ...';
  }
  return yamlStr;
}

async function insertAudit({ clusterId, namespace, kind, name, action, editVersion, k8sResourceVersion, oldYaml, newYaml, updatedBy }) {
  if (!pool) throw new Error('Not connected');
  if (!sql) sql = require('mssql');
  const id = crypto.randomUUID();
  const req = pool.request();
  req.input('id', sql.NVarChar(64), id);
  req.input('cluster_id', sql.NVarChar(64), clusterId);
  req.input('namespace', sql.NVarChar(256), namespace || '');
  req.input('kind', sql.NVarChar(128), kind);
  req.input('name', sql.NVarChar(256), name);
  req.input('action', sql.NVarChar(16), action);
  req.input('edit_version', sql.Int, editVersion || 0);
  req.input('k8s_resource_version', sql.NVarChar(64), k8sResourceVersion || '');
  req.input('old_yaml', sql.NVarChar(sql.MAX), truncateYaml(oldYaml));
  req.input('new_yaml', sql.NVarChar(sql.MAX), truncateYaml(newYaml));
  req.input('updated_by', sql.NVarChar(256), updatedBy || '');
  await req.query(`
    INSERT INTO k8senvdiff_audit
      (id, cluster_id, namespace, kind, name, action, edit_version, k8s_resource_version, old_yaml, new_yaml, updated_by, updated_at)
    VALUES
      (@id, @cluster_id, @namespace, @kind, @name, @action, @edit_version, @k8s_resource_version, @old_yaml, @new_yaml, @updated_by, SYSUTCDATETIME())
  `);
  return id;
}

async function getVersions({ clusterId, namespace, kind, name, limit }) {
  console.log('[audit-db] getVersions called with:', { clusterId, namespace, kind, name, limit });
  if (!pool) {
    console.warn('[audit-db] getVersions aborted: connection pool is null/disconnected');
    return [];
  }
  if (!sql) sql = require('mssql');
  try {
    const req = pool.request();
    req.input('cluster_id', sql.NVarChar(64), clusterId);
    req.input('namespace', sql.NVarChar(256), namespace || '');
    req.input('kind', sql.NVarChar(128), kind);
    req.input('name', sql.NVarChar(256), name);
    req.input('fetchLimit', sql.Int, Math.min(limit || 50, 200));
    const result = await req.query(`
      SELECT id, action, edit_version, k8s_resource_version, updated_by, updated_at
      FROM k8senvdiff_audit
      WHERE cluster_id = @cluster_id AND namespace = @namespace AND kind = @kind AND name = @name
      ORDER BY updated_at DESC
      OFFSET 0 ROWS FETCH NEXT @fetchLimit ROWS ONLY
    `);
    console.log('[audit-db] getVersions query executed successfully');
    return result.recordset;
  } catch (err) {
    console.error('[audit-db] getVersions query failed:', err);
    throw err;
  }
}

async function getVersionYaml(id) {
  if (!pool) return null;
  if (!sql) sql = require('mssql');
  const req = pool.request();
  req.input('id', sql.NVarChar(64), id);
  const result = await req.query(`
    SELECT old_yaml, new_yaml, action, edit_version, updated_by, updated_at
    FROM k8senvdiff_audit
    WHERE id = @id
  `);
  return result.recordset[0] || null;
}

async function getDeletedResources({ clusterId, namespace, limit }) {
  if (!pool) return [];
  if (!sql) sql = require('mssql');
  const req = pool.request();
  req.input('cluster_id', sql.NVarChar(64), clusterId);
  req.input('namespace', sql.NVarChar(256), namespace || '');
  req.input('fetchLimit', sql.Int, Math.min(limit || 100, 200));
  const result = await req.query(`
    WITH latest AS (
      SELECT id, namespace, kind, name, action, edit_version, updated_by, updated_at,
             ROW_NUMBER() OVER (PARTITION BY namespace, kind, name ORDER BY updated_at DESC) rn
      FROM k8senvdiff_audit
      WHERE cluster_id = @cluster_id
        AND (@namespace = '' OR namespace = @namespace)
    )
    SELECT id, namespace, kind, name, edit_version, updated_by, updated_at
    FROM latest
    WHERE rn = 1 AND action = 'delete'
    ORDER BY updated_at DESC
    OFFSET 0 ROWS FETCH NEXT @fetchLimit ROWS ONLY
  `);
  return result.recordset;
}

async function nextEditVersion({ clusterId, namespace, kind, name }) {
  if (!pool) return 1;
  if (!sql) sql = require('mssql');
  const req = pool.request();
  req.input('cluster_id', sql.NVarChar(64), clusterId);
  req.input('namespace', sql.NVarChar(256), namespace || '');
  req.input('kind', sql.NVarChar(128), kind);
  req.input('name', sql.NVarChar(256), name);
  const result = await req.query(`
    SELECT ISNULL(MAX(edit_version), 0) AS max_version
    FROM k8senvdiff_audit
    WHERE cluster_id = @cluster_id AND namespace = @namespace AND kind = @kind AND name = @name
  `);
  return (result.recordset[0]?.max_version || 0) + 1;
}

// ── Status / Close ────────────────────────────────────────────────────────────

function status() {
  return {
    connected: !!pool && pool.connected,
    server: discovered ? discovered.server : null,
    database: discovered ? discovered.database : null,
  };
}

async function close() {
  if (pool) {
    try { await pool.close(); } catch { /* ignore */ }
    pool = null;
  }
}

// ── AI Analysis CRUD (Audit Database) ─────────────────────────────────────────

async function saveAnalysisRecord(ref, contextName, record) {
  const id = record.id || crypto.randomUUID();
  if (!pool) {
    console.warn('[audit-db] saveAnalysisRecord skipped: Audit DB pool not connected');
    return { id, ...record };
  }
  if (!sql) sql = require('mssql');

  const clusterId = resolveClusterId(ref, contextName);
  const resultJson = typeof record.result === 'object' ? JSON.stringify(record.result) : (record.resultJson || '{}');

  const req = pool.request();
  req.input('id', sql.NVarChar(64), id);
  req.input('cluster_id', sql.NVarChar(64), clusterId);
  req.input('namespace', sql.NVarChar(256), record.namespace || '');
  req.input('pod_name', sql.NVarChar(256), record.podName || '');
  req.input('root_cause', sql.NVarChar(sql.MAX), record.result?.rootCause || record.rootCause || '');
  req.input('confidence', sql.NVarChar(32), record.result?.confidence || record.confidence || 'medium');
  req.input('category', sql.NVarChar(64), record.result?.category || record.category || 'app');
  req.input('degraded', sql.Bit, record.result?.degraded ? 1 : 0);
  req.input('result_json', sql.NVarChar(sql.MAX), resultJson);

  await req.query(`
    INSERT INTO k8senvdiff_ai_analysis
      (id, cluster_id, namespace, pod_name, root_cause, confidence, category, degraded, result_json, created_at)
    VALUES
      (@id, @cluster_id, @namespace, @pod_name, @root_cause, @confidence, @category, @degraded, @result_json, SYSUTCDATETIME())
  `);
  return { id, ...record };
}

async function getAnalysisHistory(ref, contextName, namespace, podName) {
  if (!pool) return [];
  if (!sql) sql = require('mssql');

  const clusterId = resolveClusterId(ref, contextName);
  const req = pool.request();
  req.input('cluster_id', sql.NVarChar(64), clusterId);
  req.input('namespace', sql.NVarChar(256), namespace || '');
  req.input('pod_name', sql.NVarChar(256), podName || '');

  let whereClause = 'WHERE 1=1';
  if (clusterId) {
    whereClause += ' AND cluster_id = @cluster_id';
  }
  if (namespace && namespace !== '__all__') {
    whereClause += ' AND namespace = @namespace';
  }
  if (podName) {
    whereClause += ' AND pod_name = @pod_name';
  }

  const result = await req.query(`
    SELECT id, namespace, pod_name, root_cause, confidence, category, degraded, result_json, created_at
    FROM k8senvdiff_ai_analysis
    ${whereClause}
    ORDER BY created_at DESC
    OFFSET 0 ROWS FETCH NEXT 200 ROWS ONLY
  `);

  return (result.recordset || []).map((r) => {
    let resultObj = null;
    try {
      resultObj = JSON.parse(r.result_json);
    } catch {
      resultObj = {};
    }
    return {
      id: r.id,
      namespace: r.namespace,
      podName: r.pod_name,
      timestamp: r.created_at ? new Date(r.created_at).toISOString() : new Date().toISOString(),
      rootCause: r.root_cause,
      confidence: r.confidence,
      category: r.category,
      degraded: !!r.degraded,
      result: resultObj,
    };
  });
}

async function deleteAnalysisById(arg1, arg2, arg3) {
  const targetId = arg3 || arg1;
  if (!pool || !targetId) return { changes: 0 };
  if (!sql) sql = require('mssql');

  const req = pool.request();
  req.input('id', sql.NVarChar(64), targetId);
  const result = await req.query(`
    DELETE FROM k8senvdiff_ai_analysis WHERE id = @id
  `);
  return { changes: result.rowsAffected[0] || 0 };
}

async function clearAnalysisHistory(ref, contextName, namespace) {
  if (!pool) return { changes: 0 };
  if (!sql) sql = require('mssql');

  const clusterId = resolveClusterId(ref, contextName);
  const req = pool.request();
  req.input('cluster_id', sql.NVarChar(64), clusterId);
  req.input('namespace', sql.NVarChar(256), namespace || '');

  let query = 'DELETE FROM k8senvdiff_ai_analysis WHERE 1=1';
  if (clusterId) {
    query += ' AND cluster_id = @cluster_id';
  }
  if (namespace && namespace !== '__all__') {
    query += ' AND namespace = @namespace';
  }

  const result = await req.query(query);
  return { changes: result.rowsAffected[0] || 0 };
}

async function saveAiConfig(ref, contextName, config = {}) {
  if (!pool) {
    console.warn('[audit-db] saveAiConfig skipped: Audit DB pool not connected');
    return { ok: false, error: 'Audit DB pool not connected' };
  }
  if (!sql) sql = require('mssql');

  const clusterId = resolveClusterId(ref, contextName);
  if (!clusterId) {
    return { ok: false, error: 'Invalid cluster reference' };
  }

  const req = pool.request();
  req.input('cluster_id', sql.NVarChar(64), clusterId);
  req.input('grafana_url', sql.NVarChar(512), config.grafanaUrl || '');
  req.input('service_account_token', sql.NVarChar(sql.MAX), config.serviceAccountToken || '');
  req.input('loki_datasource', sql.NVarChar(256), config.lokiDatasource || '');
  req.input('mimir_datasource', sql.NVarChar(256), config.mimirDatasource || '');
  req.input('tempo_datasource', sql.NVarChar(256), config.tempoDatasource || '');

  await req.query(`
    IF EXISTS (SELECT 1 FROM k8senvdiff_ai_config WHERE cluster_id = @cluster_id)
    BEGIN
      UPDATE k8senvdiff_ai_config
      SET grafana_url = @grafana_url,
          service_account_token = @service_account_token,
          loki_datasource = @loki_datasource,
          mimir_datasource = @mimir_datasource,
          tempo_datasource = @tempo_datasource,
          updated_at = SYSUTCDATETIME()
      WHERE cluster_id = @cluster_id
    END
    ELSE
    BEGIN
      INSERT INTO k8senvdiff_ai_config
        (cluster_id, grafana_url, service_account_token, loki_datasource, mimir_datasource, tempo_datasource, updated_at)
      VALUES
        (@cluster_id, @grafana_url, @service_account_token, @loki_datasource, @mimir_datasource, @tempo_datasource, SYSUTCDATETIME())
    END
  `);

  return { ok: true, clusterId };
}

async function getAiConfig(ref, contextName) {
  if (!pool) {
    return { ok: true, config: { grafanaUrl: '', serviceAccountToken: '', lokiDatasource: '', mimirDatasource: '', tempoDatasource: '' } };
  }
  if (!sql) sql = require('mssql');

  const clusterId = resolveClusterId(ref, contextName);
  if (!clusterId) {
    return { ok: true, config: { grafanaUrl: '', serviceAccountToken: '', lokiDatasource: '', mimirDatasource: '', tempoDatasource: '' } };
  }

  const req = pool.request();
  req.input('cluster_id', sql.NVarChar(64), clusterId);

  const res = await req.query(`
    SELECT cluster_id, grafana_url, service_account_token, loki_datasource, mimir_datasource, tempo_datasource, updated_at
    FROM k8senvdiff_ai_config
    WHERE cluster_id = @cluster_id
  `);

  const row = res.recordset && res.recordset[0];
  if (!row) {
    return {
      ok: true,
      config: { grafanaUrl: '', serviceAccountToken: '', lokiDatasource: '', mimirDatasource: '', tempoDatasource: '' },
    };
  }

  return {
    ok: true,
    config: {
      grafanaUrl: row.grafana_url || '',
      serviceAccountToken: row.service_account_token || '',
      lokiDatasource: row.loki_datasource || '',
      mimirDatasource: row.mimir_datasource || '',
      tempoDatasource: row.tempo_datasource || '',
      updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
    },
  };
}

function _setPoolForTesting(mockPool) {
  pool = mockPool;
}

module.exports = {
  getClusterId,
  getAzureIdentity,
  discover,
  connect,
  insertAudit,
  getVersions,
  getVersionYaml,
  getDeletedResources,
  nextEditVersion,
  status,
  close,
  saveAnalysisRecord,
  getAnalysisHistory,
  deleteAnalysisById,
  clearAnalysisHistory,
  saveAiConfig,
  getAiConfig,
  _setPoolForTesting,
};
