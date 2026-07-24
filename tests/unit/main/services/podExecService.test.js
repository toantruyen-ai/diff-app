import { describe, it, expect, beforeEach, vi } from 'vitest';
const { execStart, execStop, execWrite, execResize, stopAllExecSessions } = require('../../../../src/main/services/podExecService');
const { sessionManager } = require('../../../../src/main/services/sessionManagerService');
const k8s = require('@kubernetes/client-node');

describe('podExecService', () => {
  beforeEach(() => {
    stopAllExecSessions();
  });

  it('starts, writes to, resizes, and stops exec session', async () => {
    const mockWs = {
      on: vi.fn(),
      close: vi.fn(),
    };
    vi.spyOn(k8s.Exec.prototype, 'exec').mockResolvedValue(mockWs);

    const res = await execStart(null, null, 'default', 'my-pod', 'main', 'exec-1');
    expect(res.ok).toBe(true);

    const session = sessionManager.getSession('exec-1');
    expect(session).not.toBeNull();

    execWrite('exec-1', 'ls -la\n');
    execResize('exec-1', 120, 40);

    const stopRes = await execStop('exec-1');
    expect(stopRes.ok).toBe(true);
    expect(sessionManager.getSession('exec-1')).toBeNull();
  });
});
