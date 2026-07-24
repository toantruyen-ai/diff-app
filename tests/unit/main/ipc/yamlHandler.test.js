import { describe, it, expect, vi, beforeEach } from 'vitest';

const { registerYamlHandler } = require('../../../../src/main/ipc/yamlHandler');

describe('yamlHandler', () => {
  let handlers = {};
  const mockIpcMain = {
    handle: vi.fn((channel, fn) => {
      handlers[channel] = fn;
    }),
  };

  beforeEach(() => {
    handlers = {};
    mockIpcMain.handle.mockClear();
    registerYamlHandler({ ipcMain: mockIpcMain });
  });

  it('registers expected IPC channels', () => {
    expect(mockIpcMain.handle).toHaveBeenCalledWith('dry-run-yaml', expect.any(Function));
    expect(mockIpcMain.handle).toHaveBeenCalledWith('apply-ssa-yaml', expect.any(Function));
    expect(mockIpcMain.handle).toHaveBeenCalledWith('dry-run-batch-yaml', expect.any(Function));
    expect(mockIpcMain.handle).toHaveBeenCalledWith('apply-batch-yaml', expect.any(Function));
    expect(mockIpcMain.handle).toHaveBeenCalledWith('lint-yaml', expect.any(Function));
    expect(mockIpcMain.handle).toHaveBeenCalledWith('map-yaml-pos', expect.any(Function));
  });

  it('validates IPC input arguments cleanly', async () => {
    const resDryRun = await handlers['dry-run-yaml']({}, null, 'ctx1', '');
    expect(resDryRun).toEqual({ ok: false, reason: 'invalid-input', error: 'Invalid or missing arguments' });

    const resLint = await handlers['lint-yaml']({}, 123);
    expect(resLint).toEqual({ ok: false, reason: 'invalid-input', error: 'Invalid YAML text argument' });

    const resMapPos = await handlers['map-yaml-pos']({}, 'valid text', 'not an array');
    expect(resMapPos).toEqual({ ok: false, reason: 'invalid-input', error: 'Invalid arguments for map-yaml-pos' });
  });
});
