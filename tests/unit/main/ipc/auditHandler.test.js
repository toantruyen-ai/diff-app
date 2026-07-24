import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockIpcMain, handlers } = vi.hoisted(() => {
  const handlers = {};
  const mockIpcMain = {
    handle: vi.fn((channel, fn) => {
      handlers[channel] = fn;
    }),
  };
  return { mockIpcMain, handlers };
});

vi.mock('electron', () => ({
  ipcMain: mockIpcMain,
}));

vi.mock('../../../../src/main/services/auditService', () => ({
  auditDb: {
    status: vi.fn(() => ({ connected: true })),
    getVersions: vi.fn(async () => []),
    getDeletedResources: vi.fn(async () => []),
    getVersionYaml: vi.fn(async () => null),
  },
  resolveClusterId: vi.fn(() => 'cluster-1'),
  recordAudit: vi.fn(async () => null),
  readManageObject: vi.fn(async () => null),
  createManageObject: vi.fn(async () => null),
}));

vi.mock('../../../../src/main/services/eventsService', () => ({
  eventsDb: {
    getLocalEvents: vi.fn(async () => []),
  },
}));

const { registerAuditHandlers } = require('../../../../src/main/ipc/auditHandler');

describe('auditHandler IPC input validation', () => {
  beforeEach(() => {
    registerAuditHandlers({ ipcMain: mockIpcMain });
  });

  describe('get-resource-versions', () => {
    it('accepts valid identifiers', async () => {
      const res = await handlers['get-resource-versions']({}, 'ref', 'ctx', 'default', 'deployments', 'my-app');
      expect(res).toEqual({ ok: true, rows: [] });
    });

    it('rejects invalid kind or name', async () => {
      const res1 = await handlers['get-resource-versions']({}, 'ref', 'ctx', 'default', 'deployments; DROP', 'my-app');
      expect(res1).toEqual({ ok: false, reason: 'invalid-input' });

      const res2 = await handlers['get-resource-versions']({}, 'ref', 'ctx', 'default', 'deployments', '../invalid');
      expect(res2).toEqual({ ok: false, reason: 'invalid-input' });
    });
  });

  describe('get-deleted-resources', () => {
    it('accepts valid or empty namespace', async () => {
      const res = await handlers['get-deleted-resources']({}, 'ref', 'ctx', '');
      expect(res).toEqual({ ok: true, rows: [] });
    });

    it('rejects invalid namespace', async () => {
      const res = await handlers['get-deleted-resources']({}, 'ref', 'ctx', '$(calc)');
      expect(res).toEqual({ ok: false, reason: 'invalid-input' });
    });
  });

  describe('restore-deleted-resource', () => {
    it('rejects invalid kind or name before checking connection', async () => {
      const res = await handlers['restore-deleted-resource']({}, 'ref', 'ctx', 'ns', 'kind;', 'name', 'id-1');
      expect(res).toEqual({ ok: false, reason: 'invalid-input' });
    });
  });

  describe('get-local-events', () => {
    it('accepts valid params object', async () => {
      const res = await handlers['get-local-events']({}, { namespace: 'default', kind: 'pods', name: 'pod-1' });
      expect(res).toEqual({ ok: true, rows: [] });
    });

    it('rejects non-object or invalid identifiers in params', async () => {
      const res1 = await handlers['get-local-events']({}, null);
      expect(res1).toEqual({ ok: false, reason: 'invalid-input' });

      const res2 = await handlers['get-local-events']({}, { kind: "pods' OR '1'='1" });
      expect(res2).toEqual({ ok: false, reason: 'invalid-input' });
    });
  });
});
