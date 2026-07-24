import { describe, it, expect } from 'vitest';
const { runAnalyzers, findingsToResult } = require('../../../../src/main/services/troubleshootingAnalyzerService');

describe('troubleshootingAnalyzerService', () => {
  it('detects OOMKilled containers with high confidence', () => {
    const ctx = {
      podName: 'my-app-pod',
      namespace: 'production',
      containers: [
        {
          name: 'app',
          exitCode: 137,
          terminatedReason: 'OOMKilled',
        },
      ],
      limits: { memory: '256Mi' },
    };

    const findings = runAnalyzers(ctx);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0].category).toBe('resource');
    expect(findings[0].confidence).toBe('high');
    expect(findings[0].summary).toContain('OOMKilled');
  });

  it('detects ImagePullBackOff with high confidence', () => {
    const ctx = {
      podName: 'fe-pod',
      namespace: 'staging',
      containers: [
        {
          name: 'frontend',
          waitingReason: 'ImagePullBackOff',
        },
      ],
    };

    const findings = runAnalyzers(ctx);
    expect(findings[0].category).toBe('image');
    expect(findings[0].confidence).toBe('high');
  });

  it('converts findings to degraded AnalysisResult', () => {
    const ctx = { podName: 'my-pod', namespace: 'default' };
    const findings = [
      {
        title: 'Image Pull Error',
        summary: 'Image not found',
        category: 'image',
        confidence: 'high',
        evidence: ['ErrImagePull'],
        suggestedFixes: ['Fix image name'],
        commands: ['kubectl describe pod my-pod'],
      },
    ];

    const result = findingsToResult(findings, ctx);
    expect(result.degraded).toBe(true);
    expect(result.confidence).toBe('high');
    expect(result.category).toBe('image');
    expect(result.evidence).toContain('ErrImagePull');
  });
});
