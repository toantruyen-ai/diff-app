import { describe, it, expect, vi } from 'vitest';
import { registerMultiPodLogHandlers } from '../../../../src/main/ipc/multiPodLogHandler.js';

describe('multiPodLogHandler IPC validation', () => {
  let handlers = {};
  const mockIpcMain = {
    handle: vi.fn((channel, handler) => {
      handlers[channel] = handler;
    }),
  };

  it('registers IPC handlers and rejects invalid identifiers', async () => {
    registerMultiPodLogHandlers(() => null, mockIpcMain);

    const startHandler = handlers['multi-pod-log-start'];
    expect(startHandler).toBeDefined();

    const resInvalid = await startHandler({}, 'ref', 'ctx', '../invalid', {}, {}, 'sid-1');
    expect(resInvalid).toEqual({ ok: false, error: 'Invalid input identifiers' });

    const stopHandler = handlers['multi-pod-log-stop'];
    expect(stopHandler).toBeDefined();

    const resStopInvalid = await stopHandler({}, 'invalid id with spaces');
    expect(resStopInvalid).toEqual({ ok: false, error: 'Invalid session ID' });
  });
});
