// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { createMultiPodLogViewer } from '../../../src/renderer/utils/multiPodLogViewer.js';

describe('multiPodLogViewer UI component', () => {
  it('initializes viewer DOM elements and starts log session', () => {
    const queryMap = new Map();
    const dummyContainer = {
      innerHTML: '',
      querySelector: vi.fn((sel) => {
        if (!queryMap.has(sel)) {
          queryMap.set(sel, {
            addEventListener: vi.fn(),
            value: '',
            scrollTop: 0,
            scrollHeight: 100,
            clientHeight: 50,
            appendChild: vi.fn(),
          });
        }
        return queryMap.get(sel);
      }),
      querySelectorAll: vi.fn(() => []),
    };

    const mockApi = {
      startMultiPodLogs: vi.fn(),
      stopMultiPodLogs: vi.fn(),
      onMultiPodLogBatch: vi.fn(() => () => {}),
      onMultiPodLogTopology: vi.fn(() => () => {}),
      onMultiPodLogStatus: vi.fn(() => () => {}),
    };

    const viewer = createMultiPodLogViewer(dummyContainer, mockApi);
    expect(dummyContainer.querySelector('#mpl-filter-include')).not.toBeNull();
    expect(dummyContainer.querySelector('#mpl-output-viewport')).not.toBeNull();
    expect(dummyContainer.querySelector('#mpl-pinned-bar')).not.toBeNull();
    expect(dummyContainer.querySelector('#mpl-line-menu')).not.toBeNull();
    expect(dummyContainer.querySelector('#mpl-detail-overlay')).not.toBeNull();

    viewer.startSession('ref', 'ctx', 'default', { kind: 'Deployment', name: 'app' }, {}, 'sid-test');
    expect(mockApi.startMultiPodLogs).toHaveBeenCalledWith('ref', 'ctx', 'default', { kind: 'Deployment', name: 'app' }, {}, 'sid-test');

    viewer.stopSession();
    expect(mockApi.stopMultiPodLogs).toHaveBeenCalledWith('sid-test');
  });

  it('automatically unchecks follow checkbox when scrolling up in viewport', () => {
    const listeners = {};
    const queryMap = new Map();

    const followChkMock = {
      checked: true,
      addEventListener: vi.fn(),
    };

    const viewportMock = {
      scrollTop: 50,
      scrollHeight: 100,
      clientHeight: 50,
      addEventListener: vi.fn((event, handler) => {
        listeners[event] = handler;
      }),
    };

    const dummyContainer = {
      innerHTML: '',
      querySelector: vi.fn((sel) => {
        if (sel === '#mpl-follow-chk') return followChkMock;
        if (sel === '#mpl-output-viewport') return viewportMock;
        if (!queryMap.has(sel)) {
          queryMap.set(sel, {
            addEventListener: vi.fn(),
            value: '',
            scrollTop: 0,
            scrollHeight: 100,
            clientHeight: 50,
          });
        }
        return queryMap.get(sel);
      }),
      querySelectorAll: vi.fn(() => []),
    };

    const mockApi = {
      startMultiPodLogs: vi.fn(),
      stopMultiPodLogs: vi.fn(),
      onMultiPodLogBatch: vi.fn(() => () => {}),
      onMultiPodLogTopology: vi.fn(() => () => {}),
      onMultiPodLogStatus: vi.fn(() => () => {}),
    };

    createMultiPodLogViewer(dummyContainer, mockApi);

    expect(viewportMock.addEventListener).toHaveBeenCalledWith('scroll', expect.any(Function));

    viewportMock.scrollTop = 0;
    listeners['scroll']();

    expect(followChkMock.checked).toBe(false);

    viewportMock.scrollTop = 50;
    listeners['scroll']();

    expect(followChkMock.checked).toBe(true);
  });

  it('clears pinStore on Clear button click and on startSession', () => {
    const queryMap = new Map();
    let clearHandler = null;

    const clearBtnMock = {
      addEventListener: vi.fn((evt, handler) => {
        if (evt === 'click') clearHandler = handler;
      }),
    };

    const dummyContainer = {
      innerHTML: '',
      querySelector: vi.fn((sel) => {
        if (sel === '#mpl-btn-clear') return clearBtnMock;
        if (!queryMap.has(sel)) {
          queryMap.set(sel, {
            addEventListener: vi.fn(),
            value: '',
            scrollTop: 0,
            scrollHeight: 100,
            clientHeight: 50,
            style: {},
          });
        }
        return queryMap.get(sel);
      }),
      querySelectorAll: vi.fn(() => []),
    };

    const mockApi = {
      startMultiPodLogs: vi.fn(),
      stopMultiPodLogs: vi.fn(),
      onMultiPodLogBatch: vi.fn(() => () => {}),
      onMultiPodLogTopology: vi.fn(() => () => {}),
      onMultiPodLogStatus: vi.fn(() => () => {}),
    };

    const viewer = createMultiPodLogViewer(dummyContainer, mockApi);
    const pinStore = viewer.getPinStore();

    pinStore.pin({ seq: 10, pod: 'p1', message: 'msg1' });
    expect(pinStore.getAll()).toHaveLength(1);

    clearHandler();
    expect(pinStore.getAll()).toHaveLength(0);

    pinStore.pin({ seq: 20, pod: 'p2', message: 'msg2' });
    expect(pinStore.getAll()).toHaveLength(1);

    viewer.startSession('ref', 'ctx', 'default', { kind: 'Deployment', name: 'app' }, {}, 'sid-test');
    expect(pinStore.getAll()).toHaveLength(0);
  });

  it('renders log lines without leading indentation spaces or newlines inside log-content', () => {
    const queryMap = new Map();
    let batchCallback = null;

    const viewportMock = {
      innerHTML: '',
      addEventListener: vi.fn(),
    };

    const dummyContainer = {
      innerHTML: '',
      querySelector: vi.fn((sel) => {
        if (sel === '#mpl-output-viewport') return viewportMock;
        if (!queryMap.has(sel)) {
          queryMap.set(sel, {
            addEventListener: vi.fn(),
            value: '',
            scrollTop: 0,
            scrollHeight: 100,
            clientHeight: 50,
            style: {},
          });
        }
        return queryMap.get(sel);
      }),
      querySelectorAll: vi.fn(() => []),
    };

    const mockApi = {
      startMultiPodLogs: vi.fn(),
      stopMultiPodLogs: vi.fn(),
      onMultiPodLogBatch: vi.fn((sid, cb) => {
        batchCallback = cb;
        return () => {};
      }),
      onMultiPodLogTopology: vi.fn(() => () => {}),
      onMultiPodLogStatus: vi.fn(() => () => {}),
    };

    const viewer = createMultiPodLogViewer(dummyContainer, mockApi);
    viewer.startSession('ref', 'ctx', 'default', { kind: 'Deployment', name: 'app' }, {}, 'sid-test');

    batchCallback({
      lines: [{ seq: 1, pod: 'my-pod-1', message: 'Hello World', level: 'INFO' }],
    });

    expect(viewportMock.innerHTML).toContain('<div class="mpl-log-content" style="flex:1;min-width:0;text-align:left;overflow:hidden;text-overflow:ellipsis;"><span style="color:#58a6ff;font-weight:600;">[my-pod-1]</span> Hello World</div>');
  });

  it('caps rendered DOM lines to prevent memory explosion when store has 5000 lines', () => {
    const queryMap = new Map();
    let batchCallback = null;

    const viewportMock = {
      innerHTML: '',
      addEventListener: vi.fn(),
    };

    const dummyContainer = {
      innerHTML: '',
      querySelector: vi.fn((sel) => {
        if (sel === '#mpl-output-viewport') return viewportMock;
        if (!queryMap.has(sel)) {
          queryMap.set(sel, {
            addEventListener: vi.fn(),
            value: '',
            scrollTop: 0,
            scrollHeight: 100,
            clientHeight: 50,
            style: {},
          });
        }
        return queryMap.get(sel);
      }),
      querySelectorAll: vi.fn(() => []),
    };

    const mockApi = {
      startMultiPodLogs: vi.fn(),
      stopMultiPodLogs: vi.fn(),
      onMultiPodLogBatch: vi.fn((sid, cb) => {
        batchCallback = cb;
        return () => {};
      }),
      onMultiPodLogTopology: vi.fn(() => () => {}),
      onMultiPodLogStatus: vi.fn(() => () => {}),
    };

    const viewer = createMultiPodLogViewer(dummyContainer, mockApi);
    viewer.startSession('ref', 'ctx', 'default', { kind: 'Deployment', name: 'app' }, {}, 'sid-test');

    const bigBatch = Array.from({ length: 5000 }, (_, i) => ({
      seq: i + 1,
      pod: 'my-pod-1',
      message: `Log line ${i + 1}`,
      level: 'INFO',
    }));

    batchCallback({ lines: bigBatch });

    const renderedLineMatches = viewportMock.innerHTML.match(/mpl-log-line/g) || [];
    expect(renderedLineMatches.length).toBeLessThanOrEqual(1000);
  });
});
