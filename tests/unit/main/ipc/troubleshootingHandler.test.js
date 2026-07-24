import { describe, it, expect, vi } from 'vitest';
const { registerTroubleshootingHandlers, isValidIdentifier } = require('../../../../src/main/ipc/troubleshootingHandler');
const troubleshootingService = require('../../../../src/main/services/troubleshootingService');

describe('troubleshootingHandler', () => {
  it('validates safe identifiers', () => {
    expect(isValidIdentifier('default')).toBe(true);
    expect(isValidIdentifier('my-pod-1')).toBe(true);
    expect(isValidIdentifier('../bad/path')).toBe(false);
  });

  it('registers analyze-pod IPC handler and validates input', async () => {
    const handlers = {};
    const mockIpcMain = {
      handle: vi.fn((channel, fn) => {
        handlers[channel] = fn;
      }),
    };

    registerTroubleshootingHandlers({ ipcMain: mockIpcMain });
    expect(mockIpcMain.handle).toHaveBeenCalledWith('analyze-pod', expect.any(Function));

    const handler = handlers['analyze-pod'];

    const invalidRes = await handler({}, 'ref', 'ctx', 'invalid namespace!!', 'my-pod');
    expect(invalidRes.ok).toBe(false);
    expect(invalidRes.error).toContain('Invalid namespace');

    vi.spyOn(troubleshootingService, 'analyzePod').mockResolvedValueOnce({
      ok: true,
      result: { rootCause: 'OOM' },
    });

    const validRes = await handler({}, 'ref', 'ctx', 'default', 'my-pod');
    expect(validRes.ok).toBe(true);
    expect(validRes.result.rootCause).toBe('OOM');
  });
});
