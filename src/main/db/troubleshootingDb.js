const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sqlite3 = require('sqlite3').verbose();
const { app } = require('electron');

let currentDb = null;
let currentClusterId = null;

function getClusterId(ref, contextName) {
  const source = `${ref || 'default'}::${contextName || 'default'}`;
  return crypto.createHash('md5').update(source).digest('hex');
}

function switchCluster(ref, contextName) {
  const clusterId = getClusterId(ref, contextName);
  if (currentClusterId === clusterId && currentDb) {
    return currentDb;
  }

  if (currentDb) {
    try {
      currentDb.close();
    } catch {
      /* ignore close error */
    }
    currentDb = null;
  }

  currentClusterId = clusterId;

  const userDataPath = app ? app.getPath('userData') : process.cwd();
  const dbFolder = path.join(userDataPath, 'databases');
  if (!fs.existsSync(dbFolder)) {
    fs.mkdirSync(dbFolder, { recursive: true });
  }

  const dbPath = path.join(dbFolder, `k8s_ai_analysis_${clusterId}.db`);
  currentDb = new sqlite3.Database(dbPath);

  currentDb.serialize(() => {
    currentDb.run(`
      CREATE TABLE IF NOT EXISTS ai_analysis_history (
        id TEXT PRIMARY KEY,
        namespace TEXT,
        pod_name TEXT,
        timestamp TEXT,
        root_cause TEXT,
        confidence TEXT,
        category TEXT,
        degraded INTEGER,
        result_json TEXT
      )
    `);
    currentDb.run(`CREATE INDEX IF NOT EXISTS idx_ai_analysis_pod ON ai_analysis_history(namespace, pod_name)`);
    currentDb.run(`CREATE INDEX IF NOT EXISTS idx_ai_analysis_time ON ai_analysis_history(timestamp)`);
  });

  return currentDb;
}

function saveAnalysisRecord(ref, contextName, record) {
  const db = switchCluster(ref, contextName);
  return new Promise((resolve, reject) => {
    const id = record.id || crypto.randomUUID();
    const nowIso = record.timestamp || new Date().toISOString();
    const resultJson = typeof record.result === 'object' ? JSON.stringify(record.result) : record.resultJson || '{}';

    const query = `
      INSERT INTO ai_analysis_history (
        id, namespace, pod_name, timestamp, root_cause, confidence, category, degraded, result_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    db.run(
      query,
      [
        id,
        record.namespace || '',
        record.podName || '',
        nowIso,
        record.result?.rootCause || record.rootCause || '',
        record.result?.confidence || record.confidence || 'medium',
        record.result?.category || record.category || 'app',
        record.result?.degraded ? 1 : 0,
        resultJson,
      ],
      function (err) {
        if (err) reject(err);
        else resolve({ id, ...record });
      }
    );
  });
}

function getAnalysisHistory(ref, contextName, namespace, podName) {
  const db = switchCluster(ref, contextName);
  return new Promise((resolve, reject) => {
    let query = `SELECT * FROM ai_analysis_history WHERE 1=1`;
    const params = [];

    if (namespace && namespace !== '__all__') {
      query += ` AND namespace = ?`;
      params.push(namespace);
    }

    if (podName) {
      query += ` AND pod_name = ?`;
      params.push(podName);
    }

    query += ` ORDER BY timestamp DESC LIMIT 200`;

    db.all(query, params, (err, rows) => {
      if (err) return reject(err);
      const mapped = (rows || []).map((r) => {
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
          timestamp: r.timestamp,
          rootCause: r.root_cause,
          confidence: r.confidence,
          category: r.category,
          degraded: r.degraded === 1,
          result: resultObj,
        };
      });
      resolve(mapped);
    });
  });
}

function deleteAnalysisById(ref, contextName, id) {
  const db = switchCluster(ref, contextName);
  return new Promise((resolve, reject) => {
    db.run(`DELETE FROM ai_analysis_history WHERE id = ?`, [id], function (err) {
      if (err) reject(err);
      else resolve({ changes: this.changes });
    });
  });
}

function clearAnalysisHistory(ref, contextName, namespace) {
  const db = switchCluster(ref, contextName);
  return new Promise((resolve, reject) => {
    let query = `DELETE FROM ai_analysis_history`;
    const params = [];
    if (namespace && namespace !== '__all__') {
      query += ` WHERE namespace = ?`;
      params.push(namespace);
    }
    db.run(query, params, function (err) {
      if (err) reject(err);
      else resolve({ changes: this.changes });
    });
  });
}

module.exports = {
  switchCluster,
  saveAnalysisRecord,
  getAnalysisHistory,
  deleteAnalysisById,
  clearAnalysisHistory,
};
