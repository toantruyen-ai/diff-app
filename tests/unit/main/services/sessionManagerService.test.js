import { describe, it, expect, beforeEach, vi } from 'vitest';
const { sessionManager } = require('../../../../src/main/services/sessionManagerService');

describe('sessionManagerService', () => {
  beforeEach(() => {
    sessionManager.stopAllSessions();
  });

  it('registers and retrieves a session', () => {
    const session = {
      id: 'session-1',
      kind: 'exec',
      status: 'active',
      describe: () => ({ sessionId: 'session-1', kind: 'exec', status: 'active' }),
      dispose: vi.fn(),
    };
    expect(sessionManager.registerSession(session)).toBe(true);
    expect(sessionManager.getSession('session-1')).toBe(session);
    expect(sessionManager.listSessions()).toEqual([
      { sessionId: 'session-1', kind: 'exec', status: 'active' },
    ]);
  });

  it('removes session and calls dispose', () => {
    const disposeFn = vi.fn();
    const session = {
      id: 'session-2',
      kind: 'port-forward',
      status: 'active',
      dispose: disposeFn,
    };
    sessionManager.registerSession(session);
    const removed = sessionManager.removeSession('session-2');
    expect(removed).toBe(true);
    expect(disposeFn).toHaveBeenCalled();
    expect(sessionManager.getSession('session-2')).toBeNull();
  });

  it('emits session events to window', () => {
    const sendFn = vi.fn();
    const getMainWindow = () => ({
      isDestroyed: () => false,
      webContents: { send: sendFn },
    });

    sessionManager.emitSessionEvent({ kind: 'exec', type: 'status', sessionId: 's1', status: 'active' }, getMainWindow);
    expect(sendFn).toHaveBeenCalledWith('session:event', {
      kind: 'exec',
      type: 'status',
      sessionId: 's1',
      status: 'active',
    });
  });
});
