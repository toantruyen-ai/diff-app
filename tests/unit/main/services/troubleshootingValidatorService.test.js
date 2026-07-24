import { describe, it, expect, vi } from 'vitest';
const { validateAnalysisResult, analyzeWithRetry } = require('../../../../src/main/services/troubleshootingValidatorService');

describe('troubleshootingValidatorService', () => {
  it('validates a valid AnalysisResult JSON string', () => {
    const validJson = JSON.stringify({
      rootCause: 'Out of Memory in application container',
      confidence: 'high',
      category: 'resource',
      evidence: ['exitCode: 137', 'OOMKilled'],
      fixSteps: ['Increase memory limits'],
      commands: ['kubectl set resources pod my-pod --limits=memory=512Mi'],
    });

    const res = validateAnalysisResult(validJson);
    expect(res.ok).toBe(true);
    expect(res.data.rootCause).toContain('Out of Memory');
  });

  it('rejects invalid schema missing evidence or fixSteps', () => {
    const invalidJson = JSON.stringify({
      rootCause: 'Bad config',
      confidence: 'high',
      category: 'config',
    });

    const res = validateAnalysisResult(invalidJson);
    expect(res.ok).toBe(false);
  });

  it('retries with corrective prompt on initial validation failure', async () => {
    const mockRunner = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        text: '{"rootCause":"Bad config"}', // Missing fields -> fail validation
      })
      .mockResolvedValueOnce({
        ok: true,
        text: JSON.stringify({
          rootCause: 'Bad config resolved',
          confidence: 'high',
          category: 'config',
          evidence: ['Failed to mount ConfigMap'],
          fixSteps: ['Create ConfigMap'],
        }),
      });

    const res = await analyzeWithRetry('Original Prompt', { cliRunner: mockRunner });
    expect(res.ok).toBe(true);
    expect(res.attempts).toBe(2);
    expect(mockRunner).toHaveBeenCalledTimes(2);
  });
});
