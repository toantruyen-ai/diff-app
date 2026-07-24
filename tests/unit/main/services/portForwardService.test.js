import { describe, it, expect, beforeEach, vi } from 'vitest';
const { pfStart, pfStop, stopAllPortForwardSessions } = require('../../../../src/main/services/portForwardService');
const { sessionManager } = require('../../../../src/main/services/sessionManagerService');

describe('portForwardService', () => {
  beforeEach(() => {
    stopAllPortForwardSessions();
  });

  it('handles pfStart and pfStop with target pod', async () => {
    const res = await pfStart(null, null, 'default', { kind: 'pod', name: 'test-pod', remotePort: 8080 }, 0, 'pf-session-1');
    expect(res.ok).toBe(true);
    expect(res.localPort).toBeGreaterThanOrEqual(30000);

    const session = sessionManager.getSession('pf-session-1');
    expect(session).not.toBeNull();
    expect(session.kind).toBe('port-forward');

    const stopRes = await pfStop('pf-session-1');
    expect(stopRes.ok).toBe(true);
    expect(sessionManager.getSession('pf-session-1')).toBeNull();

    // Verify port is freed and cannot be re-connected
    await expect(new Promise((resolve, reject) => {
      const client = require('net').connect(res.localPort, '127.0.0.1');
      client.on('connect', () => { client.end(); resolve('connected'); });
      client.on('error', (err) => reject(err));
    })).rejects.toThrow();
  });

  it('preserves requested remotePort in session metadata and assigns localPort >= 30000', async () => {
    const res = await pfStart(null, null, 'default', { kind: 'pod', name: 'test-pod', remotePort: 8080 }, 0, 'pf-session-2');
    expect(res.ok).toBe(true);
    expect(res.remotePort).toBe(8080);
    expect(res.localPort).toBeGreaterThanOrEqual(30000);

    const session = sessionManager.getSession('pf-session-2');
    expect(session.metadata.remotePort).toBe(8080);
    expect(session.metadata.localPort).toBeGreaterThanOrEqual(30000);
  });

  it('correctly handles positional parameters when targetArg is string pod name', async () => {
    const res = await pfStart(null, null, 'default', 'test-pod', 8080, 0, 'pf-session-3', () => null, { openBrowser: false });
    expect(res.ok).toBe(true);
    expect(res.remotePort).toBe(8080);
    expect(res.localPort).toBeGreaterThanOrEqual(30000);
    expect(res.localPort).not.toBe(8080);
  });

  it('validates openLocalBrowser', () => {
    const { openLocalBrowser } = require('../../../../src/main/services/portForwardService');
    const invalid = openLocalBrowser(0);
    expect(invalid.ok).toBe(false);

    const valid = openLocalBrowser(8080);
    expect(valid.url).toBe('http://localhost:8080');
  });
});
