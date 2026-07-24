import { describe, it, expect, vi } from 'vitest';
const { analyzePod } = require('../../../../src/main/services/troubleshootingService');

describe('troubleshootingService', () => {
  it('analyzes pod successfully with CLI mock', async () => {
    const mockCollector = vi.fn().mockResolvedValueOnce({
      namespace: 'default',
      podName: 'my-crashing-pod',
      containers: [{ name: 'app', exitCode: 137, terminatedReason: 'OOMKilled' }],
      events: [],
      logsPrevious: 'OOMKilled in main thread',
    });

    const mockCliRunner = vi.fn().mockResolvedValueOnce({
      ok: true,
      text: JSON.stringify({
        rootCause: 'Node memory pressure caused OOMKilled',
        confidence: 'high',
        category: 'resource',
        evidence: ['OOMKilled in main thread'],
        fixSteps: ['Increase RAM'],
      }),
    });

    const res = await analyzePod('/path/to/kubeconfig', 'my-ctx', 'default', 'my-crashing-pod', {
      collector: mockCollector,
      cliRunner: mockCliRunner,
    });

    expect(res.ok).toBe(true);
    expect(res.result.degraded).toBe(false);
    expect(res.result.rootCause).toContain('Node memory pressure');
  });

  it('falls back to rule engine result when CLI fails', async () => {
    const mockCollector = vi.fn().mockResolvedValueOnce({
      namespace: 'default',
      podName: 'my-crashing-pod',
      containers: [{ name: 'app', exitCode: 137, terminatedReason: 'OOMKilled' }],
      events: [],
    });

    const mockCliRunner = vi.fn().mockResolvedValueOnce({
      ok: false,
      error: 'CLI executable not found',
    });

    const res = await analyzePod('/path/to/kubeconfig', 'my-ctx', 'default', 'my-crashing-pod', {
      collector: mockCollector,
      cliRunner: mockCliRunner,
    });

    expect(res.ok).toBe(true);
    expect(res.result.degraded).toBe(true);
  });

  it('runs testAiCli with mock tester', async () => {
    const { testAiCli } = require('../../../../src/main/services/troubleshootingService');
    const mockTester = vi.fn().mockResolvedValueOnce({
      ok: true,
      text: 'Hello from mock CLI',
      command: 'claude',
    });

    const res = await testAiCli('claude', { cliTester: mockTester });
    expect(res.ok).toBe(true);
    expect(res.text).toBe('Hello from mock CLI');
    expect(mockTester).toHaveBeenCalledWith('claude', expect.any(Object));
  });
});
