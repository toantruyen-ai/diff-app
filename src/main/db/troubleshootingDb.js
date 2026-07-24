/**
 * troubleshootingDb.js — AI Analysis persistence delegate using Audit Database (Azure SQL).
 */

const auditDb = require('./auditDb');

function switchCluster(ref, contextName) {
  return auditDb;
}

async function saveAnalysisRecord(ref, contextName, record) {
  return await auditDb.saveAnalysisRecord(ref, contextName, record);
}

async function getAnalysisHistory(ref, contextName, namespace, podName) {
  return await auditDb.getAnalysisHistory(ref, contextName, namespace, podName);
}

async function deleteAnalysisById(ref, contextName, id) {
  return await auditDb.deleteAnalysisById(ref, contextName, id);
}

async function clearAnalysisHistory(ref, contextName, namespace) {
  return await auditDb.clearAnalysisHistory(ref, contextName, namespace);
}

module.exports = {
  switchCluster,
  saveAnalysisRecord,
  getAnalysisHistory,
  deleteAnalysisById,
  clearAnalysisHistory,
};
