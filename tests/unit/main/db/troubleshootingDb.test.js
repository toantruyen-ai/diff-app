import { describe, it, expect, beforeEach } from 'vitest';
const auditDb = require('../../../../src/main/db/auditDb');
const db = require('../../../../src/main/db/troubleshootingDb');

describe('troubleshootingDb (Audit DB persistence)', () => {
  const ref = 'test-config';
  const ctx = 'test-context';
  let memoryRecords = [];

  beforeEach(async () => {
    memoryRecords = [];

    // Create a mock pool to simulate Azure SQL Audit DB queries in memory
    const mockPool = {
      connected: true,
      request: () => {
        const inputs = {};
        const req = {
          input: (name, type, val) => {
            inputs[name] = val;
            return req;
          },
          query: async (sqlText) => {
            if (sqlText.includes('INSERT INTO k8senvdiff_ai_analysis')) {
              const record = {
                id: inputs.id,
                cluster_id: inputs.cluster_id,
                namespace: inputs.namespace,
                pod_name: inputs.pod_name,
                root_cause: inputs.root_cause,
                confidence: inputs.confidence,
                category: inputs.category,
                degraded: inputs.degraded,
                result_json: inputs.result_json,
                created_at: new Date().toISOString(),
              };
              memoryRecords.push(record);
              return { rowsAffected: [1] };
            }

            if (sqlText.includes('SELECT id, namespace, pod_name')) {
              let filtered = memoryRecords.filter((r) => r.cluster_id === inputs.cluster_id);
              if (inputs.namespace && inputs.namespace !== '__all__') {
                filtered = filtered.filter((r) => r.namespace === inputs.namespace);
              }
              if (inputs.pod_name) {
                filtered = filtered.filter((r) => r.pod_name === inputs.pod_name);
              }
              return { recordset: filtered };
            }

            if (sqlText.includes('DELETE FROM k8senvdiff_ai_analysis WHERE id')) {
              const countBefore = memoryRecords.length;
              memoryRecords = memoryRecords.filter((r) => r.id !== inputs.id);
              return { rowsAffected: [countBefore - memoryRecords.length] };
            }

            if (sqlText.includes('DELETE FROM k8senvdiff_ai_analysis WHERE 1=1')) {
              const countBefore = memoryRecords.length;
              memoryRecords = memoryRecords.filter((r) => {
                if (r.cluster_id !== inputs.cluster_id) return true;
                if (inputs.namespace && inputs.namespace !== '__all__') {
                  return r.namespace !== inputs.namespace;
                }
                return false;
              });
              return { rowsAffected: [countBefore - memoryRecords.length] };
            }

            return { recordset: [], rowsAffected: [0] };
          },
        };
        return req;
      },
    };

    auditDb._setPoolForTesting(mockPool);
  });

  it('saves and retrieves analysis history records via Audit DB', async () => {
    const record = {
      namespace: 'default',
      podName: 'my-pod-1',
      result: {
        rootCause: 'OOMKilled error',
        confidence: 'high',
        category: 'resource',
        evidence: ['exitCode: 137'],
        fixSteps: ['Increase RAM'],
      },
    };

    await db.saveAnalysisRecord(ref, ctx, record);
    const history = await db.getAnalysisHistory(ref, ctx, 'default', 'my-pod-1');
    expect(history.length).toBe(1);
    expect(history[0].podName).toBe('my-pod-1');
    expect(history[0].rootCause).toBe('OOMKilled error');
    expect(history[0].result.confidence).toBe('high');
  });

  it('deletes a single record by ID from Audit DB', async () => {
    const saved = await db.saveAnalysisRecord(ref, ctx, {
      namespace: 'default',
      podName: 'my-pod-2',
      result: { rootCause: 'Config error' },
    });

    let history = await db.getAnalysisHistory(ref, ctx, 'default', 'my-pod-2');
    expect(history.length).toBe(1);

    await db.deleteAnalysisById(ref, ctx, saved.id);
    history = await db.getAnalysisHistory(ref, ctx, 'default', 'my-pod-2');
    expect(history.length).toBe(0);
  });

  it('clears all history in namespace from Audit DB', async () => {
    await db.saveAnalysisRecord(ref, ctx, { namespace: 'default', podName: 'p1', result: { rootCause: 'err1' } });
    await db.saveAnalysisRecord(ref, ctx, { namespace: 'default', podName: 'p2', result: { rootCause: 'err2' } });

    await db.clearAnalysisHistory(ref, ctx, 'default');
    const history = await db.getAnalysisHistory(ref, ctx, 'default');
    expect(history.length).toBe(0);
  });
});
