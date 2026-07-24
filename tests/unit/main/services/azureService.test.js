import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const child_process = require('child_process');

// Spy on child_process before loading the module
const execSyncSpy = vi.spyOn(child_process, 'execSync');
const execFileSyncSpy = vi.spyOn(child_process, 'execFileSync');
const execFileSpy = vi.spyOn(child_process, 'execFile');
const spawnSpy = vi.spyOn(child_process, 'spawn');

// Dynamically import the service so the destructuring gets the spy
const {
  checkKubeloginAuth,
  getTokenExpiry,
  azLogin,
  getAksCredentials,
  listStorageContainers,
  listServicebusQueues,
} = await import('../../../../src/main/services/azureService.js');

describe('azureService', () => {
  beforeEach(() => {
    execSyncSpy.mockReset();
    execFileSyncSpy.mockReset();
    execFileSpy.mockReset();
    spawnSpy.mockReset();
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

  it('azLogin calls spawn with shell: false', async () => {
    const mockProc = {
      on: vi.fn((event, cb) => {
        if (event === 'close') cb(0);
      }),
    };
    spawnSpy.mockReturnValue(mockProc);
    const res = await azLogin();
    expect(res).toEqual({ ok: true });
    expect(spawnSpy).toHaveBeenCalledWith('az', ['login'], { shell: false, stdio: 'pipe' });
  });

  it('getAksCredentials validates cluster name and resource group format', async () => {
    const resInvalidName = await getAksCredentials('invalid; injection', 'my-rg');
    expect(resInvalidName).toEqual({ ok: false, reason: 'invalid-input' });

    const resInvalidRg = await getAksCredentials('my-cluster', 'invalid$(id)');
    expect(resInvalidRg).toEqual({ ok: false, reason: 'invalid-input' });
  });

  it('listStorageContainers validates account.name identifier format', async () => {
    execFileSpy.mockImplementation((cmd, args, opts, callback) => {
      const cb = typeof opts === 'function' ? opts : callback;
      cb(null, { stdout: JSON.stringify([{ name: 'c1' }]), stderr: '' });
    });
    const accounts = [
      { name: 'validacc1', environment: 'prod' },
      { name: 'invalid account name!', environment: 'dev' },
    ];
    const results = await listStorageContainers(accounts);
    expect(results[0]).toEqual({
      name: 'validacc1',
      environment: 'prod',
      containers: ['c1'],
      ok: true,
    });
    expect(results[1]).toEqual({
      name: 'invalid account name!',
      environment: 'dev',
      containers: [],
      ok: false,
      reason: 'invalid-input',
    });
    expect(execFileSpy).toHaveBeenCalledWith(
      'az',
      ['storage', 'container', 'list', '--account-name', 'validacc1', '--auth-mode', 'login', '--output', 'json'],
      { timeout: 60000 },
      expect.any(Function)
    );
  });

  it('listServicebusQueues validates ns.name and ns.resourceGroup format', async () => {
    execFileSpy.mockImplementation((cmd, args, opts, callback) => {
      const cb = typeof opts === 'function' ? opts : callback;
      cb(null, { stdout: JSON.stringify([{ name: 'q1' }]), stderr: '' });
    });
    const namespaces = [
      { name: 'valid-ns', resourceGroup: 'valid-rg', environment: 'staging' },
      { name: 'bad ns; echo 1', resourceGroup: 'valid-rg', environment: 'staging' },
    ];
    const results = await listServicebusQueues(namespaces);
    expect(results[0]).toEqual({
      name: 'valid-ns',
      environment: 'staging',
      queues: ['q1'],
      ok: true,
    });
    expect(results[1]).toEqual({
      name: 'bad ns; echo 1',
      environment: 'staging',
      queues: [],
      ok: false,
      reason: 'invalid-input',
    });
    expect(execFileSpy).toHaveBeenCalledWith(
      'az',
      ['servicebus', 'queue', 'list', '--namespace-name', 'valid-ns', '--resource-group', 'valid-rg', '--output', 'json'],
      { timeout: 60000 },
      expect.any(Function)
    );
  });
});

