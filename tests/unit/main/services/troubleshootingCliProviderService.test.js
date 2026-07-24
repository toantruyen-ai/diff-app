import { describe, it, expect } from 'vitest';
const { resolveCommand, getInstallInstructions, executeCli } = require('../../../../src/main/services/troubleshootingCliProviderService');

describe('troubleshootingCliProviderService', () => {
  it('resolves antigravity provider to agy executable', () => {
    expect(resolveCommand({ cliProvider: 'antigravity' })).toBe('agy');
    expect(resolveCommand({ cliProvider: 'agy' })).toBe('agy');
  });

  it('resolves claude provider to claude executable', () => {
    expect(resolveCommand({ cliProvider: 'claude' })).toBe('claude');
  });

  it('honors explicit cliCommand override', () => {
    expect(resolveCommand({ cliCommand: 'custom-cli' })).toBe('custom-cli');
  });

  it('provides install instructions with agy command', () => {
    const info = getInstallInstructions('antigravity');
    expect(info.authCmd).toBe('agy login');
    expect(info.steps[1]).toContain('agy login');
  });

  it('handles executeCli error gracefully when binary is missing', async () => {
    const res = await executeCli('test prompt', { cliProvider: 'non-existent-provider-xyz-999', timeoutMs: 500 });
    expect(res.ok).toBe(false);
    expect(res.error).toBeDefined();
  });

  it('handles child.stdin EPIPE error without throwing uncaught exception when process exits early', async () => {
    const res = await executeCli('A'.repeat(100000), {
      cliCommand: process.execPath,
      systemPrompt: 'test',
    });
    expect(res.ok).toBe(false);
  });
});

