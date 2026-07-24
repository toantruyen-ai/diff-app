const { createFilteredLogStore } = require('./filteredLogStore');
const { createPinnedLogStore } = require('./logPinStore');
const { createLogLineMenu } = require('./logLineMenu');
const { createLogLineDetailModal } = require('./logLineDetailModal');
const { escHtml } = require('./htmlUtils');

function createMultiPodLogViewer(containerEl, api = window.k8sApi) {
  let activeSid = null;
  let store = createFilteredLogStore(10000);
  let pinStore = createPinnedLogStore();
  let isFollowMode = true;
  let disposers = [];
  let topology = [];

  containerEl.innerHTML = `
    <div class="multi-pod-log-toolbar" style="display:flex;gap:8px;align-items:center;padding:8px;background:var(--bg-surface,#181b24);border-bottom:1px solid var(--border,#262b38);flex-wrap:wrap;">
      <input type="text" id="mpl-filter-include" placeholder="Grep / Include (regex supported)" style="flex:1;min-width:180px;padding:4px 8px;background:var(--bg-base,#0f1117);border:1px solid var(--border,#262b38);color:var(--text,#e1e4ea);border-radius:4px;font-size:12px;" />
      <input type="text" id="mpl-filter-exclude" placeholder="Exclude" style="width:120px;padding:4px 8px;background:var(--bg-base,#0f1117);border:1px solid var(--border,#262b38);color:var(--text,#e1e4ea);border-radius:4px;font-size:12px;" />
      <select id="mpl-tail-select" style="padding:4px;background:var(--bg-base,#0f1117);border:1px solid var(--border,#262b38);color:var(--text,#e1e4ea);border-radius:4px;font-size:12px;">
        <option value="200">200 lines</option>
        <option value="500" selected>500 lines</option>
        <option value="1000">1000 lines</option>
        <option value="5000">5000 lines</option>
      </select>
      <label style="display:flex;align-items:center;gap:4px;font-size:12px;color:var(--text-subtle,#8b949e);cursor:pointer;">
        <input type="checkbox" id="mpl-follow-chk" checked /> Follow
      </label>
      <button id="mpl-btn-clear" style="padding:4px 8px;background:var(--bg-elevated,#212633);border:1px solid var(--border,#262b38);color:var(--text,#e1e4ea);border-radius:4px;font-size:12px;cursor:pointer;">Clear</button>
    </div>
    <div id="mpl-topology-bar" style="padding:4px 8px;background:var(--bg-surface,#181b24);border-bottom:1px solid var(--border,#262b38);display:flex;gap:6px;overflow-x:auto;font-size:11px;"></div>
    <div id="mpl-pinned-bar" class="mpl-pinned-bar" style="display:none;"></div>
    <div id="mpl-status-bar" style="padding:2px 8px;background:var(--bg-base,#0f1117);color:var(--text-subtle,#8b949e);font-size:11px;border-bottom:1px solid var(--border,#262b38);display:flex;justify-content:space-between;">
      <span id="mpl-status-text">Disconnected</span>
      <span id="mpl-stats-text">0 lines</span>
    </div>
    <div id="mpl-output-viewport" style="flex:1;overflow-y:auto;padding:8px;font-family:var(--font-mono,monospace);font-size:12px;line-height:1.4;background:var(--bg-base,#0f1117);color:var(--text,#e1e4ea);white-space:pre-wrap;"></div>
    <div id="mpl-line-menu" class="mpl-line-menu" style="display:none;"></div>
    <div id="mpl-detail-overlay" class="mpl-detail-overlay" style="display:none;"><div class="mpl-detail-card"></div></div>
  `;

  const includeInput = containerEl.querySelector('#mpl-filter-include');
  const excludeInput = containerEl.querySelector('#mpl-filter-exclude');
  const tailSelect = containerEl.querySelector('#mpl-tail-select');
  const followChk = containerEl.querySelector('#mpl-follow-chk');
  const clearBtn = containerEl.querySelector('#mpl-btn-clear');
  const topologyBar = containerEl.querySelector('#mpl-topology-bar');
  const pinnedBar = containerEl.querySelector('#mpl-pinned-bar');
  const statusText = containerEl.querySelector('#mpl-status-text');
  const statsText = containerEl.querySelector('#mpl-stats-text');
  const viewport = containerEl.querySelector('#mpl-output-viewport');
  const menuEl = containerEl.querySelector('#mpl-line-menu');
  const overlayEl = containerEl.querySelector('#mpl-detail-overlay');

  const lineMenu = createLogLineMenu(menuEl);
  const detailModal = createLogLineDetailModal(overlayEl);

  function renderPinnedBar() {
    const pins = pinStore.getAll();
    if (!pins || pins.length === 0) {
      pinnedBar.style.display = 'none';
      pinnedBar.innerHTML = '';
      return;
    }

    pinnedBar.style.display = 'block';
    pinnedBar.innerHTML = `
      <div class="mpl-pinned-header">📌 Pinned Logs (${pins.length})</div>
      <div class="mpl-pinned-list">
        ${pins.map((p) => `
          <div class="mpl-pinned-item" data-seq="${p.seq}">
            <span class="mpl-pinned-meta">[${escHtml(p.pod)}]</span>
            <span class="mpl-pinned-msg">${escHtml(p.message.slice(0, 120))}${p.message.length > 120 ? '…' : ''}</span>
            <div style="display:flex;gap:4px;">
              <button class="mpl-pinned-btn btn-view-pin" data-seq="${p.seq}">View</button>
              <button class="mpl-pinned-btn btn-unpin-pin" data-seq="${p.seq}">Unpin</button>
            </div>
          </div>
        `).join('')}
      </div>
    `;

    const viewBtns = pinnedBar.querySelectorAll('.btn-view-pin');
    viewBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        const seq = parseInt(btn.getAttribute('data-seq'), 10);
        const pin = pins.find((p) => p.seq === seq);
        if (pin) detailModal.open(pin);
      });
    });

    const unpinBtns = pinnedBar.querySelectorAll('.btn-unpin-pin');
    unpinBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        const seq = parseInt(btn.getAttribute('data-seq'), 10);
        pinStore.unpin(seq);
        renderLogs();
      });
    });
  }

  pinStore.subscribe(renderPinnedBar);

  function renderLogs() {
    const totalCount = store.getTotalCount();
    statsText.textContent = `${totalCount} lines (${store.getRawCount()} total)`;

    const maxDomLines = Math.max(1000, parseInt(tailSelect?.value || '500', 10));
    const renderCount = Math.min(totalCount, maxDomLines);
    const startIndex = isFollowMode ? Math.max(0, totalCount - renderCount) : 0;
    const lines = store.getVisibleSlice(startIndex, renderCount);

    const overflowHeader = (totalCount > renderCount && isFollowMode)
      ? `<div style="text-align:center;padding:4px;color:var(--text-subtle,#8b949e);font-size:11px;border-bottom:1px dashed var(--border,#262b38);margin-bottom:4px;">⋯ Displaying latest ${renderCount} of ${totalCount} lines (scroll up or filter for full history) ⋯</div>`
      : '';

    viewport.innerHTML = overflowHeader + lines.map((l) => {
      const isPinned = pinStore.isPinned(l.seq);
      const podPrefix = `<span style="color:#58a6ff;font-weight:600;">[${escHtml(l.pod)}]</span> `;
      const inlineStyle = l.level === 'ERROR' ? 'color:#f85149;' : l.level === 'WARN' ? 'color:#d29922;' : '';
      const pinClass = isPinned ? 'mpl-pinned' : '';
      const lvlClass = l.level === 'ERROR' ? 'mpl-lvl-error' : l.level === 'WARN' ? 'mpl-lvl-warn' : '';
      const msg = escHtml(l.message);

      return `<div class="mpl-log-line ${lvlClass} ${pinClass}" style="${inlineStyle}position:relative;display:flex;align-items:center;justify-content:space-between;padding:0 4px;margin:0;line-height:1.3;" data-seq="${l.seq}"><div class="mpl-log-content" style="flex:1;min-width:0;text-align:left;overflow:hidden;text-overflow:ellipsis;">${isPinned ? '<span class="mpl-pin-badge">📌 </span>' : ''}${podPrefix}${msg}</div><div class="mpl-line-actions" style="margin-left:auto;" data-seq="${l.seq}"><button class="mpl-line-action-btn mpl-btn-show" data-seq="${l.seq}" title="Show content">👁️</button><button class="mpl-line-action-btn mpl-btn-copy" data-seq="${l.seq}" title="Copy to clipboard">📋</button><button class="mpl-line-action-btn mpl-btn-pin" data-seq="${l.seq}" title="${isPinned ? 'Unpin' : 'Pin'}">${isPinned ? '📌' : '📍'}</button></div></div>`;
    }).join('');

    if (isFollowMode) {
      viewport.scrollTop = viewport.scrollHeight;
    }
  }

  store.subscribe(renderLogs);

  viewport.addEventListener('click', (e) => {
    const btn = e.target.closest ? e.target.closest('.mpl-line-action-btn') : null;
    if (!btn) return;
    e.stopPropagation();

    const seq = parseInt(btn.getAttribute('data-seq'), 10);
    const line = store.getItemBySeq(seq);
    if (!line) return;

    if (btn.classList.contains('mpl-btn-show')) {
      detailModal.open(line);
    } else if (btn.classList.contains('mpl-btn-copy')) {
      if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(line.message || '').catch(() => {});
      }
      const origText = btn.textContent;
      btn.textContent = '✓';
      setTimeout(() => { btn.textContent = origText; }, 1000);
    } else if (btn.classList.contains('mpl-btn-pin')) {
      const isPinned = pinStore.isPinned(seq);
      if (isPinned) {
        pinStore.unpin(seq);
      } else {
        pinStore.pin(line);
      }
      renderLogs();
    }
  });

  followChk.addEventListener('change', () => {
    isFollowMode = followChk.checked;
    if (isFollowMode) viewport.scrollTop = viewport.scrollHeight;
  });

  viewport.addEventListener('scroll', () => {
    if (!viewport.clientHeight) return;
    const isAtBottom = (viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop) <= 15;
    if (!isAtBottom && isFollowMode) {
      isFollowMode = false;
      followChk.checked = false;
    } else if (isAtBottom && !isFollowMode) {
      isFollowMode = true;
      followChk.checked = true;
    }
  });

  clearBtn.addEventListener('click', () => {
    store.clear();
    pinStore.clear();
  });

  let filterDebounce = null;
  function applyFilter() {
    const includeText = includeInput.value.trim().toLowerCase();
    const excludeText = excludeInput.value.trim().toLowerCase();
    const count = store.getRawCount();
    const allLines = store.getVisibleSlice(0, count);
    const matched = [];
    for (const l of allLines) {
      const msg = (l.message || '').toLowerCase();
      if (excludeText && msg.includes(excludeText)) continue;
      if (!includeText || msg.includes(includeText)) matched.push(l.seq);
    }
    store.setMatchedSeqs(matched);
  }

  includeInput.addEventListener('input', () => {
    clearTimeout(filterDebounce);
    filterDebounce = setTimeout(applyFilter, 150);
  });
  excludeInput.addEventListener('input', () => {
    clearTimeout(filterDebounce);
    filterDebounce = setTimeout(applyFilter, 150);
  });

  function startSession(ref, contextName, namespace, workload, opts = {}, sid) {
    stopSession();
    activeSid = sid;
    store.clear();
    pinStore.clear();
    isFollowMode = true;
    followChk.checked = true;
    statusText.textContent = 'Connecting…';

    disposers = [
      api.onMultiPodLogBatch(sid, (batch) => {
        if (batch && Array.isArray(batch.lines)) {
          store.appendBatch(batch.lines);
        }
      }),
      api.onMultiPodLogTopology(sid, (top) => {
        topology = top || [];
        const streamingCount = topology.filter((t) => t.state === 'streaming').length;
        statusText.textContent = `Streaming ${streamingCount}/${topology.length} pods`;
        topologyBar.innerHTML = topology.map((t) => `
          <span style="padding:2px 6px;background:var(--bg-elevated,#212633);border-radius:3px;border:1px solid var(--border,#262b38);">
            ${escHtml(t.pod)} (${escHtml(t.state)})
          </span>
        `).join('');
      }),
      api.onMultiPodLogStatus(sid, (st) => {
        if (st.state === 'error') {
          statusText.textContent = `Error: ${st.error || 'Failed'}`;
        }
      }),
    ];

    api.startMultiPodLogs(ref, contextName, namespace, workload, opts, sid);
  }

  function stopSession() {
    if (activeSid) {
      api.stopMultiPodLogs(activeSid);
      activeSid = null;
    }
    disposers.forEach((d) => d());
    disposers = [];
  }

  return {
    startSession,
    stopSession,
    getStore: () => store,
    getPinStore: () => pinStore,
  };
}

module.exports = {
  createMultiPodLogViewer,
};
