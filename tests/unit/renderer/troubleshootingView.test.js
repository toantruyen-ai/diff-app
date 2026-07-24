import { describe, it, expect } from 'vitest';
const { renderAnalysisResult } = require('../../../src/renderer/utils/troubleshootingView');

describe('troubleshootingView', () => {
  it('renders analysis result card cleanly into container', () => {
    const mockContainer = {
      innerHTML: '',
      querySelectorAll: () => [],
    };
    const result = {
      rootCause: 'Pod memory limit reached (OOMKilled)',
      confidence: 'high',
      category: 'resource',
      evidence: ['exitCode: 137', 'OOMKilled'],
      fixSteps: ['Increase RAM limit'],
      commands: ['kubectl set resources pod my-pod --limits=memory=512Mi'],
      degraded: false,
    };

    renderAnalysisResult(mockContainer, result);
    expect(mockContainer.innerHTML).toContain('Pod memory limit reached');
    expect(mockContainer.innerHTML).toContain('HIGH');
    expect(mockContainer.innerHTML).toContain('resource');
    expect(mockContainer.innerHTML).toContain('AI Powered');
    expect(mockContainer.innerHTML).toContain('kubectl set resources');
  });

  it('renders degraded analysis result with Rule-based fallback badge and fallbackReason banner', () => {
    const mockContainer = {
      innerHTML: '',
      querySelectorAll: () => [],
    };
    const result = {
      rootCause: 'Pod is experiencing unexpected crashes or restarts.',
      confidence: 'low',
      category: 'unknown',
      degraded: true,
      fallbackReason: "CLI executable 'claude' was not found in PATH",
    };

    renderAnalysisResult(mockContainer, result);
    expect(mockContainer.innerHTML).toContain('LOW');
    expect(mockContainer.innerHTML).toContain('unknown');
    expect(mockContainer.innerHTML).toContain('Rule-based fallback');
    expect(mockContainer.innerHTML).toContain('was not found in PATH');
  });
});

