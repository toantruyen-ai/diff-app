import { describe, it, expect, vi } from 'vitest';
import { initYamlEditor } from '../../../src/renderer/utils/yamlEditor.js';

describe('yamlEditor client controller', () => {
  it('initializes editor and triggers dry-run and apply flows', async () => {
    const mockContainer = {
      querySelector: vi.fn((sel) => {
        if (sel === '#manage-yaml-textarea') {
          return { value: 'apiVersion: v1\nkind: Pod\nmetadata:\n  name: app', addEventListener: vi.fn() };
        }
        return { addEventListener: vi.fn(), style: {} };
      }),
      querySelectorAll: vi.fn(() => []),
    };

    const mockApi = {
      lintYaml: vi.fn().mockResolvedValue({ ok: true, issues: [] }),
      dryRunYaml: vi.fn().mockResolvedValue({ ok: true, diffs: [] }),
      applySsaYaml: vi.fn().mockResolvedValue({ ok: true }),
      mapYamlPos: vi.fn().mockResolvedValue({ ok: true, pos: { line: 1, column: 1 } }),
    };

    const editor = initYamlEditor(mockContainer, mockApi);
    editor.setContext('ref1', 'ctx1');

    const dryRes = await editor.runDryRun();
    expect(dryRes.ok).toBe(true);
    expect(mockApi.dryRunYaml).toHaveBeenCalledWith('ref1', 'ctx1', expect.any(String));

    const applyRes = await editor.performApply(false);
    expect(applyRes.ok).toBe(true);
    expect(mockApi.applySsaYaml).toHaveBeenCalledWith('ref1', 'ctx1', expect.any(String), false);
  });

  it('updates diffPane with success UI feedback when performApply succeeds with force=true', async () => {
    const diffPaneMock = { style: {}, innerHTML: 'old 409 conflict html' };
    const conflictBarMock = { style: { display: 'block' }, innerHTML: '', querySelector: vi.fn() };
    const applyBtnMock = { addEventListener: vi.fn() };

    const mockContainer = {
      querySelector: vi.fn((sel) => {
        if (sel === '#manage-yaml-textarea') return { value: 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: cfg', addEventListener: vi.fn() };
        if (sel === '#manage-yaml-diff-panel') return diffPaneMock;
        if (sel === '#manage-yaml-conflict-bar') return conflictBarMock;
        if (sel === '#manage-yaml-save') return applyBtnMock;
        return { addEventListener: vi.fn(), style: {} };
      }),
      querySelectorAll: vi.fn(() => []),
    };

    const mockApi = {
      applySsaYaml: vi.fn().mockResolvedValue({ ok: true }),
    };

    const editor = initYamlEditor(mockContainer, mockApi);
    editor.setContext('ref1', 'ctx1');

    const res = await editor.performApply(true);
    expect(res.ok).toBe(true);
    expect(mockApi.applySsaYaml).toHaveBeenCalledWith('ref1', 'ctx1', expect.any(String), true);
    expect(conflictBarMock.style.display).toBe('none');
    expect(diffPaneMock.innerHTML).toContain('Applied Successfully');
    expect(applyBtnMock.addEventListener).toHaveBeenCalledWith('click', expect.any(Function));
  });

  it('handles click on #manage-yaml-force-apply via conflictBar event delegation after dry-run conflict', async () => {
    let conflictBarClickListener = null;
    const conflictBarMock = {
      style: { display: 'block' },
      innerHTML: '',
      addEventListener: vi.fn((event, handler) => {
        if (event === 'click') conflictBarClickListener = handler;
      }),
    };

    const mockContainer = {
      querySelector: vi.fn((sel) => {
        if (sel === '#manage-yaml-textarea') return { value: 'apiVersion: v1\nkind: Pod\nmetadata:\n  name: app', addEventListener: vi.fn() };
        if (sel === '#manage-yaml-conflict-bar') return conflictBarMock;
        return { addEventListener: vi.fn(), style: {} };
      }),
      querySelectorAll: vi.fn(() => []),
    };

    const mockApi = {
      dryRunYaml: vi.fn().mockResolvedValue({
        ok: false,
        kind: 'conflict',
        conflicts: [{ field: 'spec.containers', manager: 'kubectl' }],
      }),
      applySsaYaml: vi.fn().mockResolvedValue({ ok: true }),
    };

    const editor = initYamlEditor(mockContainer, mockApi);
    editor.setContext('ref1', 'ctx1');

    await editor.runDryRun();
    expect(conflictBarClickListener).toBeTypeOf('function');

    const fakeTarget = {
      closest: vi.fn((sel) => (sel === '#manage-yaml-force-apply' ? { textContent: 'Force Overwrite' } : null)),
    };
    await conflictBarClickListener({ preventDefault: vi.fn(), stopPropagation: vi.fn(), target: fakeTarget });

    expect(mockApi.applySsaYaml).toHaveBeenCalledWith('ref1', 'ctx1', expect.any(String), true);
  });
});
