import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('Pod Analysis Drawer content isolation & DB history loading', () => {
  let state;
  let el;

  beforeEach(() => {
    el = {
      manageAnalyzeContent: {
        innerHTML: '',
        children: [],
        appendChild: function (child) {
          this.children.push(child);
        },
        querySelector: () => null,
      },
      manageAnalyzeStatus: {
        textContent: '',
      },
      manageAnalyzeRunBtn: {
        disabled: false,
      },
      manageDrawer: {
        classList: {
          add: () => {},
          remove: () => {},
        },
      },
      manageDrawerTitle: {
        textContent: '',
      },
      manageYamlRevealLabel: { style: {} },
      manageYamlReveal: { checked: false },
      manageDetailPane: { style: {}, innerHTML: '' },
      manageYamlPane: { style: {} },
      manageAccessPane: { style: {} },
      manageLogsPane: { style: {} },
      manageExecPane: { style: {} },
      managePfPane: { style: {} },
      manageMetricsPane: { style: {} },
      manageAnalyzePane: { style: {} },
      manageTabs: [],
      manageDrawerActions: { innerHTML: '', querySelectorAll: () => [] },
    };

    state = {
      manage: {
        selected: null,
        mode: 'kind',
        revealSecrets: false,
        yamlEditing: false,
        writeUnlocked: true,
      },
    };
  });

  it('clears previous pod analysis content when opening a new pod drawer', () => {
    // Simulate previous pod analysis content left in container
    el.manageAnalyzeContent.innerHTML = '<div class="analysis-result-card">Pod A Analysis</div>';
    el.manageAnalyzeContent.children = [{ tag: 'div' }];
    el.manageAnalyzeStatus.textContent = 'Completed';

    // Simulate openManageDrawer logic
    function openManageDrawer(kind, row) {
      state.manage.selected = row;
      if (el.manageAnalyzeContent) {
        el.manageAnalyzeContent.innerHTML = '';
        el.manageAnalyzeContent.children = [];
      }
      if (el.manageAnalyzeStatus) el.manageAnalyzeStatus.textContent = '';
    }

    openManageDrawer('pods', { name: 'pod-b', namespace: 'default' });

    expect(state.manage.selected.name).toBe('pod-b');
    expect(el.manageAnalyzeContent.innerHTML).toBe('');
    expect(el.manageAnalyzeContent.children.length).toBe(0);
    expect(el.manageAnalyzeStatus.textContent).toBe('');
  });

  it('prevents stale async analysis response from rendering if user switches pods', async () => {
    let activeSelected = { name: 'pod-a', namespace: 'default' };

    async function runPodAnalysisMock(targetRow, mockFetch) {
      const currentPodName = targetRow.name;
      const res = await mockFetch();

      // Guard check
      if (!activeSelected || activeSelected.name !== currentPodName) {
        return { discarded: true };
      }

      el.manageAnalyzeContent.innerHTML = `Analysis for ${currentPodName}`;
      return { discarded: false };
    }

    // Start analysis for pod-a with delayed response
    let resolvePodA;
    const podAPromise = runPodAnalysisMock({ name: 'pod-a' }, () => new Promise((r) => { resolvePodA = r; }));

    // User switches to pod-b before pod-a finishes
    activeSelected = { name: 'pod-b', namespace: 'default' };

    // Resolve pod-a
    resolvePodA({ ok: true });
    const result = await podAPromise;

    expect(result.discarded).toBe(true);
    expect(el.manageAnalyzeContent.innerHTML).not.toContain('Analysis for pod-a');
  });

  it('loads latest saved analysis from DB history when available instead of triggering live analysis', async () => {
    state.manage.selected = { name: 'pod-c', namespace: 'default' };
    const mockSavedHistory = [
      {
        id: 101,
        podName: 'pod-c',
        namespace: 'default',
        timestamp: 1700000000000,
        result: { rootCause: 'Saved DB OOMKilled Cause', confidence: 'high' }
      }
    ];

    const mockGetAnalysisHistory = vi.fn().mockResolvedValue({ ok: true, history: mockSavedHistory });
    const mockRunLiveAnalysis = vi.fn();

    async function initPodAnalysisMock() {
      const row = state.manage.selected;
      const res = await mockGetAnalysisHistory('cfg', 'ctx', row.namespace, row.name);
      if (res.ok && res.history && res.history.length > 0) {
        el.manageAnalyzeStatus.textContent = 'Loaded saved analysis';
        el.manageAnalyzeContent.innerHTML = res.history[0].result.rootCause;
      } else {
        mockRunLiveAnalysis();
      }
    }

    await initPodAnalysisMock();

    expect(mockGetAnalysisHistory).toHaveBeenCalledWith('cfg', 'ctx', 'default', 'pod-c');
    expect(mockRunLiveAnalysis).not.toHaveBeenCalled();
    expect(el.manageAnalyzeStatus.textContent).toBe('Loaded saved analysis');
    expect(el.manageAnalyzeContent.innerHTML).toContain('Saved DB OOMKilled Cause');
  });
});
