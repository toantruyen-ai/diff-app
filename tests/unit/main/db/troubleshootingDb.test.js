import { describe, it, expect, beforeEach } from 'vitest';
const db = require('../../../../src/main/db/troubleshootingDb');

describe('troubleshootingDb', () => {
  const ref = 'test-config';
  const ctx = 'test-context';

  beforeEach(async () => {
    db.switchCluster(ref, ctx);
    await db.clearAnalysisHistory(ref, ctx);
  });

  it('saves and retrieves analysis history records', async () => {
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

  it('deletes a single record by ID', async () => {
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

  it('clears all history in namespace', async () => {
    await db.saveAnalysisRecord(ref, ctx, { namespace: 'default', podName: 'p1', result: { rootCause: 'err1' } });
    await db.saveAnalysisRecord(ref, ctx, { namespace: 'default', podName: 'p2', result: { rootCause: 'err2' } });

    await db.clearAnalysisHistory(ref, ctx, 'default');
    const history = await db.getAnalysisHistory(ref, ctx, 'default');
    expect(history.length).toBe(0);
  });
});
