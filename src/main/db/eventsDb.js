const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sqlite3 = require('sqlite3').verbose();
const { app } = require('electron');

const { resolveClusterId } = require('../utils/k8sHelper');

let currentDb = null;
let currentClusterId = null;

/**
 * Switch sang database của cluster mới.
 */
function switchCluster(ref, contextName) {
  const clusterId = resolveClusterId(ref, contextName);
  
  if (currentClusterId === clusterId && currentDb) {
    return currentDb;
  }

  // Đóng database hiện tại
  if (currentDb) {
    try {
      currentDb.close();
    } catch (err) {
      console.error('Error closing database:', err);
    }
    currentDb = null;
  }

  currentClusterId = clusterId;

  // Tạo thư mục databases nếu chưa có
  const userDataPath = app.getPath('userData');
  const dbFolder = path.join(userDataPath, 'databases');
  if (!fs.existsSync(dbFolder)) {
    fs.mkdirSync(dbFolder, { recursive: true });
  }

  const dbPath = path.join(dbFolder, `k8s_events_${clusterId}.db`);
  console.log(`Switching K8s Events DB to: ${dbPath}`);

  currentDb = new sqlite3.Database(dbPath);

  // Tạo bảng nếu chưa tồn tại
  currentDb.serialize(() => {
    currentDb.run(`
      CREATE TABLE IF NOT EXISTS k8s_events (
        id TEXT PRIMARY KEY,
        namespace TEXT,
        involved_kind TEXT,
        involved_name TEXT,
        reason TEXT,
        message TEXT,
        type TEXT,
        count INTEGER,
        first_timestamp TEXT,
        last_timestamp TEXT,
        first_seen TEXT,
        last_seen TEXT
      )
    `);
    
    // Tạo index để query nhanh hơn
    currentDb.run(`CREATE INDEX IF NOT EXISTS idx_k8s_events_resource ON k8s_events(involved_kind, involved_name)`);
    currentDb.run(`CREATE INDEX IF NOT EXISTS idx_k8s_events_last_seen ON k8s_events(last_seen)`);
  });

  return currentDb;
}

/**
 * Lưu một event mới hoặc cập nhật event hiện có.
 */
function saveEvent(event) {
  if (!currentDb) return Promise.reject(new Error('No active database connection'));

  return new Promise((resolve, reject) => {
    const query = `
      INSERT OR REPLACE INTO k8s_events (
        id, namespace, involved_kind, involved_name, reason, message, type, count, first_timestamp, last_timestamp, first_seen, last_seen
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    const nowIso = new Date().toISOString();
    const firstSeen = event.firstTimestamp || event.eventTime || nowIso;
    const lastSeen = event.lastTimestamp || event.eventTime || nowIso;

    currentDb.run(
      query,
      [
        event.uid,
        event.namespace || '',
        event.involvedKind || '',
        event.involvedName || '',
        event.reason || '',
        event.message || '',
        event.type || 'Normal',
        event.count || 1,
        event.firstTimestamp || event.eventTime || '',
        event.lastTimestamp || event.eventTime || '',
        firstSeen,
        lastSeen
      ],
      function (err) {
        if (err) reject(err);
        else resolve(this.lastID);
      }
    );
  });
}

/**
 * Lấy danh sách local events của một resource cụ thể (hoặc toàn bộ namespace).
 */
function getLocalEvents(namespace, kind, name) {
  if (!currentDb) return Promise.resolve([]);

  return new Promise((resolve, reject) => {
    let query = `SELECT * FROM k8s_events WHERE 1=1`;
    const params = [];

    if (namespace && namespace !== '__all__') {
      query += ` AND namespace = ?`;
      params.push(namespace);
    }

    if (kind) {
      query += ` AND involved_kind = ?`;
      params.push(kind);
    }

    if (name) {
      query += ` AND involved_name = ?`;
      params.push(name);
    }

    query += ` ORDER BY last_seen DESC LIMIT 500`;

    currentDb.all(query, params, (err, rows) => {
      if (err) reject(err);
      else {
        // Map lại trường dữ liệu cho khớp với format K8s events UI mong đợi
        const mapped = rows.map((r) => ({
          uid: r.id,
          namespace: r.namespace,
          involvedKind: r.involved_kind,
          involvedName: r.involved_name,
          reason: r.reason,
          message: r.message,
          type: r.type,
          count: r.count,
          firstTimestamp: r.first_timestamp,
          lastTimestamp: r.last_timestamp,
          lastSeen: r.last_seen,
          isLocalDb: true // Cờ đánh dấu để phân biệt trên UI
        }));
        resolve(mapped);
      }
    });
  });
}

/**
 * Áp dụng retention policy (Xoá event cũ).
 */
function cleanOldEvents(days) {
  if (!currentDb || !days || days <= 0) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const query = `DELETE FROM k8s_events WHERE last_seen < datetime('now', '-' || ? || ' days')`;
    currentDb.run(query, [days], function (err) {
      if (err) reject(err);
      else {
        if (this.changes > 0) {
          console.log(`[Retention] Removed ${this.changes} events older than ${days} days.`);
        }
        resolve(this.changes);
      }
    });
  });
}

/**
 * Xóa toàn bộ database events của cluster hiện tại.
 */
function clearEvents() {
  if (!currentDb) return Promise.reject(new Error('No active database connection'));

  return new Promise((resolve, reject) => {
    currentDb.run(`DELETE FROM k8s_events`, function (err) {
      if (err) reject(err);
      else resolve(this.changes);
    });
  });
}

module.exports = {
  switchCluster,
  saveEvent,
  getLocalEvents,
  cleanOldEvents,
  clearEvents
};
