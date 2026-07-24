import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const child_process = require('child_process');

// Spy on child_process before loading the module
const execSyncSpy = vi.spyOn(child_process, 'execSync');

// Dynamically import the service so the destructuring gets the spy
const { checkKubeloginAuth, getTokenExpiry } = await import('../../../../src/main/services/azureService.js');

describe('azureService', () => {
  beforeEach(() => {
    execSyncSpy.mockReset();
  });

  it('checkKubeloginAuth returns { ok: true } safely', async () => {
    const res = await checkKubeloginAuth();
    expect(res).toEqual({ ok: true });
  });

  it('getTokenExpiry success with expires_on', async () => {
    execSyncSpy.mockReturnValue(JSON.stringify({ expires_on: 1600000000 }));
    const res = await getTokenExpiry();
    expect(res).toEqual({ ok: true, expiresAt: 1600000000000 });
    expect(execSyncSpy).toHaveBeenCalledWith('az account get-access-token --output json', expect.any(Object));
  });

  it('getTokenExpiry success with expiresOn', async () => {
    execSyncSpy.mockReturnValue(JSON.stringify({ expiresOn: '2026-07-24 10:00:00' }));
    const res = await getTokenExpiry();
    expect(res.ok).toBe(true);
    expect(res.expiresAt).toBe(new Date('2026-07-24T10:00:00').getTime());
  });

  it('getTokenExpiry handles error safely', async () => {
    execSyncSpy.mockImplementation(() => { throw new Error('exec failed'); });
    const res = await getTokenExpiry();
    expect(res).toEqual({ ok: false });
  });
});
