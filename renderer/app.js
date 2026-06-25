/* ── State ───────────────────────────────────────────────────────────────── */
const state = {
  left:  { kubeconfig: null, context: null, namespace: null, deployment: null, envs: null },
  right: { kubeconfig: null, context: null, namespace: null, deployment: null, envs: null },
  filter: 'all',
  search: '',
  maskSecrets: true,
  depView: 'select',      // 'select' | 'list'
  activeDepName: null,    // highlighted item in list view
  leftDeps: [],           // deployment names cached for list view
  rightDeps: new Set(),   // deployment names in B (for ✓/✗ badge)
};

/* ── DOM refs ────────────────────────────────────────────────────────────── */
const $ = (id) => document.getElementById(id);

const el = {
  left: {
    kubeconfig: $('left-kubeconfig'), btnBrowse: $('left-btn-browse'),
    btnDefault: $('left-btn-default'), context: $('left-context'),
    namespace:  $('left-namespace'),  deployment: $('left-deployment'),
    status:     $('left-status'),
    depViewBtns: $('left-dep-view-btns'),
    depListWrap: $('left-dep-list-wrap'),
    depSearch:   $('left-dep-search'),
    depList:     $('left-dep-list'),
    depCount:    $('left-dep-count'),
  },
  right: {
    kubeconfig: $('right-kubeconfig'), btnBrowse: $('right-btn-browse'),
    btnDefault: $('right-btn-default'), context: $('right-context'),
    namespace:  $('right-namespace'),  deployment: $('right-deployment'),
    status:     $('right-status'),
  },
  btnCompare:     $('btn-compare'),
  btnClear:       $('btn-clear'),
  filterBar:      $('filter-bar'),
  searchInput:    $('search-input'),
  filterBtns:     document.querySelectorAll('.toggle-btn[data-filter]'),
  diffTable:      $('diff-table'),
  diffBody:       $('diff-body'),
  emptyState:     $('empty-state'),
  loadingOverlay: $('loading-overlay'),
  loadingText:    $('loading-text'),
  statsEl:        $('stats'),
  thLeftLabel:    $('th-left-label'),
  thRightLabel:   $('th-right-label'),
  toggleMask:     $('toggle-mask'),
};

/* ── Loading helpers ─────────────────────────────────────────────────────── */
function showLoading(msg) { el.loadingText.textContent = msg || 'Loading…'; el.loadingOverlay.style.display = 'flex'; }
function hideLoading()    { el.loadingOverlay.style.display = 'none'; }

/* ════════════════════════════════════════════════════════════════════════════
   PANEL SETUP (both sides)
   ════════════════════════════════════════════════════════════════════════════ */
function setupPanel(side) {
  const s  = el[side];
  const data = state[side];

  s.btnBrowse.addEventListener('click', async () => {
    const p = await window.k8sApi.selectKubeconfig();
    if (!p) return;
    data.kubeconfig = p;
    s.kubeconfig.value = p;
    await loadContexts(side);
  });

  s.btnDefault.addEventListener('click', async () => {
    data.kubeconfig = null;
    s.kubeconfig.value = '';
    await loadContexts(side);
  });

  s.context.addEventListener('change', async () => {
    data.context = s.context.value || null;
    resetBelow(side, 'context');
    if (data.context) await loadNamespaces(side);
  });

  s.namespace.addEventListener('change', async () => {
    data.namespace = s.namespace.value || null;
    resetBelow(side, 'namespace');
    if (data.namespace) await loadDeployments(side);
  });

  s.deployment.addEventListener('change', () => {
    data.deployment = s.deployment.value || null;
    data.envs = null;
    updateCompareButton();
  });

  loadContexts(side);
}

/* ── Deployment view toggle (left side only) ─────────────────────────────── */
el.left.depViewBtns.addEventListener('click', (e) => {
  const btn = e.target.closest('.dep-view-btn');
  if (!btn) return;
  const view = btn.dataset.depview;
  if (view === state.depView) return;

  state.depView = view;
  el.left.depViewBtns.querySelectorAll('.dep-view-btn').forEach((b) =>
    b.classList.toggle('active', b.dataset.depview === view)
  );

  if (view === 'list') {
    el.left.deployment.style.display = 'none';
    el.left.depListWrap.style.display = 'flex';
    if (state.leftDeps.length > 0) renderDepList();
    updateCompareButton(); // list mode disables Compare button
  } else {
    el.left.deployment.style.display = '';
    el.left.depListWrap.style.display = 'none';
    updateCompareButton();
  }
});

el.left.depSearch.addEventListener('input', () => renderDepList());

/* ════════════════════════════════════════════════════════════════════════════
   CASCADE LOADERS
   ════════════════════════════════════════════════════════════════════════════ */
async function loadContexts(side) {
  const s = el[side];
  const data = state[side];
  setStatus(side, '');
  try {
    resetBelow(side, 'kubeconfig');
    showLoading('Loading contexts…');
    const contexts = await window.k8sApi.loadContexts(data.kubeconfig);
    populateSelect(s.context, contexts, '— select context —');
    s.context.disabled = contexts.length === 0;
    setStatus(side, `${contexts.length} context${contexts.length !== 1 ? 's' : ''} loaded`, 'success');

    if (contexts.length === 1) {
      s.context.value = contexts[0];
      data.context = contexts[0];
      await loadNamespaces(side);
    }
  } catch (e) {
    setStatus(side, `Error: ${e.message}`, 'error');
  } finally {
    hideLoading();
  }
}

async function loadNamespaces(side) {
  const s = el[side];
  const data = state[side];
  try {
    showLoading('Loading namespaces…');
    const ns = await window.k8sApi.loadNamespaces(data.kubeconfig, data.context);
    populateSelect(s.namespace, ns, '— select namespace —');
    s.namespace.disabled = false;

    const defaultNs = ns.includes('brand') ? 'brand' : null;
    if (defaultNs) {
      s.namespace.value = defaultNs;
      data.namespace = defaultNs;
      await loadDeployments(side);
    }
  } catch (e) {
    setStatus(side, `Error: ${e.message}`, 'error');
  } finally {
    hideLoading();
  }
}

async function loadDeployments(side) {
  const s = el[side];
  const data = state[side];
  try {
    showLoading('Loading deployments…');
    const deps = await window.k8sApi.loadDeployments(data.kubeconfig, data.context, data.namespace);

    if (side === 'left') {
      populateSelect(s.deployment, deps, '— select deployment —');
      s.deployment.disabled = false;
      // Show view toggle once we have namespace
      s.depViewBtns.style.display = 'flex';
      // Cache for list view
      state.leftDeps = deps;
      if (state.depView === 'list') renderDepList();
    } else {
      populateSelect(s.deployment, deps, '— select deployment —');
      s.deployment.disabled = false;
      // Cache right-side deps for ✓/✗ badge
      state.rightDeps = new Set(deps);
      if (state.depView === 'list' && state.leftDeps.length > 0) renderDepList();
    }
  } catch (e) {
    setStatus(side, `Error: ${e.message}`, 'error');
  } finally {
    hideLoading();
  }
}

function resetBelow(side, level) {
  const s = el[side];
  const data = state[side];
  const levels = ['context', 'namespace', 'deployment'];
  const idx = levels.indexOf(level);
  for (let i = idx + 1; i < levels.length; i++) {
    const lvl = levels[i];
    data[lvl] = null;
    s[lvl].innerHTML = `<option value="">— select ${lvl} —</option>`;
    s[lvl].disabled = true;
  }
  data.envs = null;
  if (side === 'left') {
    // If we went above namespace level, hide toggle and clear list
    if (idx < levels.indexOf('namespace')) {
      s.depViewBtns.style.display = 'none';
      s.depListWrap.style.display = 'none';
      el.left.deployment.style.display = '';
      state.depView = 'select';
      state.leftDeps = [];
      clearDepList();
    }
  }
  updateCompareButton();
}

/* ════════════════════════════════════════════════════════════════════════════
   LIST VIEW — render & click
   ════════════════════════════════════════════════════════════════════════════ */
function renderDepList() {
  const query    = (el.left.depSearch.value || '').toLowerCase();
  const filtered = query
    ? state.leftDeps.filter((d) => d.toLowerCase().includes(query))
    : state.leftDeps;

  el.left.depCount.textContent = `${filtered.length} / ${state.leftDeps.length}`;
  el.left.depList.innerHTML = '';

  if (filtered.length === 0) {
    el.left.depList.innerHTML = `<div class="dep-list-empty-msg">${query ? 'No match' : 'No deployments'}</div>`;
    return;
  }

  for (const name of filtered) {
    const inB  = state.rightDeps.has(name);
    const item = document.createElement('div');
    item.className = 'dep-item' + (name === state.activeDepName ? ' dep-active' : '');
    item.dataset.name = name;
    item.innerHTML = `
      <span class="dep-name">${escHtml(name)}</span>
      <span class="dep-b-badge ${inB ? 'dep-b-ok' : 'dep-b-missing'}">${inB ? '✓ B' : '✗ B'}</span>
      <span class="dep-arrow">→</span>
    `;
    item.addEventListener('click', () => listItemCompare(name, inB));
    el.left.depList.appendChild(item);
  }
}

function clearDepList() {
  state.activeDepName = null;
  state.leftDeps = [];
  state.rightDeps = new Set();
  el.left.depList.innerHTML = '';
  el.left.depCount.textContent = '';
}

/* ── Auto-compare when list item clicked ─────────────────────────────────── */
async function listItemCompare(name, inB) {
  const l = state.left;
  const r = state.right;

  if (!r.namespace || !r.context) {
    alert('Please select Namespace on side B first.');
    return;
  }

  state.activeDepName = name;
  el.left.depList.querySelectorAll('.dep-item').forEach((item) =>
    item.classList.toggle('dep-active', item.dataset.name === name)
  );

  try {
    showLoading(`Comparing ${name}…`);
    const [leftEnvs, rightEnvs] = await Promise.all([
      window.k8sApi.loadEnvs(l.kubeconfig, l.context, l.namespace, name),
      inB
        ? window.k8sApi.loadEnvs(r.kubeconfig, r.context, r.namespace, name)
        : Promise.resolve({}),
    ]);

    el.thLeftLabel.textContent  = `${name} (${l.namespace})`;
    el.thRightLabel.textContent = inB
      ? `${name} (${r.namespace})`
      : `${name} — not in B`;

    renderTable(leftEnvs, rightEnvs);
    el.filterBar.style.display = 'flex';
  } catch (e) {
    alert(`Compare failed: ${e.message}`);
  } finally {
    hideLoading();
  }
}

/* ════════════════════════════════════════════════════════════════════════════
   COMPARE BUTTON (Select mode)
   ════════════════════════════════════════════════════════════════════════════ */
el.btnCompare.addEventListener('click', async () => {
  try {
    showLoading('Fetching ENV variables…');
    const [leftEnvs, rightEnvs] = await Promise.all([
      window.k8sApi.loadEnvs(state.left.kubeconfig,  state.left.context,  state.left.namespace,  state.left.deployment),
      window.k8sApi.loadEnvs(state.right.kubeconfig, state.right.context, state.right.namespace, state.right.deployment),
    ]);
    state.left.envs  = leftEnvs;
    state.right.envs = rightEnvs;
    el.thLeftLabel.textContent  = `${state.left.deployment} (${state.left.namespace})`;
    el.thRightLabel.textContent = `${state.right.deployment} (${state.right.namespace})`;
    renderTable(leftEnvs, rightEnvs);
    el.filterBar.style.display = 'flex';
  } catch (e) {
    alert(`Compare failed: ${e.message}`);
  } finally {
    hideLoading();
  }
});

function updateCompareButton() {
  // Disabled in list view (click on list item to compare)
  if (state.depView === 'list') { el.btnCompare.disabled = true; return; }
  const l = state.left;
  const r = state.right;
  el.btnCompare.disabled = !(l.deployment && l.namespace && l.context && r.deployment && r.namespace && r.context);
}

/* ── Clear ───────────────────────────────────────────────────────────────── */
el.btnClear.addEventListener('click', () => {
  state.left.envs  = null;
  state.right.envs = null;
  lastEnvs = null;
  state.activeDepName = null;
  el.left.depList.querySelectorAll('.dep-item').forEach((i) => i.classList.remove('dep-active'));
  el.diffTable.style.display  = 'none';
  el.emptyState.style.display = 'flex';
  el.filterBar.style.display  = 'none';
  el.diffBody.innerHTML = '';
});

/* ════════════════════════════════════════════════════════════════════════════
   FILTER BAR
   ════════════════════════════════════════════════════════════════════════════ */
el.filterBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    el.filterBtns.forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    state.filter = btn.dataset.filter;
    if (lastEnvs) renderTable(lastEnvs.left, lastEnvs.right);
  });
});

el.searchInput.addEventListener('input', () => {
  state.search = el.searchInput.value.toLowerCase();
  if (lastEnvs) renderTable(lastEnvs.left, lastEnvs.right);
});

el.toggleMask.addEventListener('change', () => {
  state.maskSecrets = el.toggleMask.checked;
  if (lastEnvs) renderTable(lastEnvs.left, lastEnvs.right);
});

/* ════════════════════════════════════════════════════════════════════════════
   TABLE RENDER
   ════════════════════════════════════════════════════════════════════════════ */
let lastEnvs = null;

function renderTable(leftEnvs, rightEnvs) {
  lastEnvs = { left: leftEnvs, right: rightEnvs };

  const allKeys = Array.from(
    new Set([...Object.keys(leftEnvs), ...Object.keys(rightEnvs)])
  ).sort();

  el.diffBody.innerHTML = '';
  let totalDiff = 0, totalSame = 0, totalMissing = 0, shown = 0;

  for (const key of allKeys) {
    const lEntry = leftEnvs[key];
    const rEntry = rightEnvs[key];
    const lVal   = lEntry?.value;
    const rVal   = rEntry?.value;

    let rowType;
    if (lEntry && rEntry) rowType = lVal === rVal ? 'same' : 'diff';
    else                   rowType = 'missing';

    if (rowType === 'diff')    totalDiff++;
    else if (rowType === 'same') totalSame++;
    else                         totalMissing++;

    if (state.filter !== 'all' && state.filter !== rowType) continue;
    if (state.search && !key.toLowerCase().includes(state.search)) continue;

    shown++;
    const source      = lEntry?.source || rEntry?.source || 'Unknown';
    const sourceClass = getSourceClass(source);
    const sourceLabel = formatSourceLabel(source);
    const maskedL     = maskValue(lVal, source);
    const maskedR     = maskValue(rVal, source);

    const tr = document.createElement('tr');
    tr.className = `row-${rowType}`;
    tr.innerHTML = `
      <td class="col-key"><span class="cell-key">${escHtml(key)}</span></td>
      <td class="col-source"><span class="source-tag ${sourceClass}">${escHtml(sourceLabel)}</span></td>
      <td class="col-a col-value">
        ${lEntry ? `<span class="cell-value">${escHtml(maskedL)}</span>` : `<span class="cell-value-missing">— not present —</span>`}
      </td>
      <td class="col-b col-value">
        ${rEntry ? `<span class="cell-value">${escHtml(maskedR)}</span>` : `<span class="cell-value-missing">— not present —</span>`}
      </td>
      <td class="col-status">
        <span class="status-pill pill-${rowType}">
          ${rowType === 'diff' ? 'DIFF' : rowType === 'same' ? 'SAME' : 'MISSING'}
        </span>
      </td>
    `;
    el.diffBody.appendChild(tr);
  }

  el.statsEl.textContent = `${shown} shown · ${totalDiff} diff · ${totalSame} same · ${totalMissing} missing`;
  el.emptyState.style.display = 'none';
  el.diffTable.style.display  = 'table';
}

/* ── Helpers ─────────────────────────────────────────────────────────────── */
function maskValue(val, source) {
  if (!state.maskSecrets) return val ?? '';
  if (source && source.toLowerCase().includes('secret')) return val ? '••••••••' : '';
  return val ?? '';
}

function getSourceClass(source) {
  if (!source) return 'source-missing';
  const s = source.toLowerCase();
  if (s === 'direct')    return 'source-direct';
  if (s.startsWith('configmap')) return 'source-configmap';
  if (s.startsWith('secret'))    return 'source-secret';
  if (s.startsWith('fieldref') || s.startsWith('resourcefield')) return 'source-fieldref';
  return 'source-missing';
}

function formatSourceLabel(source) {
  if (!source) return '?';
  if (source === 'Direct') return 'Direct';
  if (source.startsWith('ConfigMap:')) return `CM: ${source.replace('ConfigMap:', '').split('[')[0]}`;
  if (source.startsWith('Secret:'))    return `Sec: ${source.replace('Secret:', '').split('[')[0]}`;
  if (source === 'FieldRef') return 'FieldRef';
  return source;
}

function populateSelect(selectEl, items, placeholder) {
  selectEl.innerHTML = `<option value="">${escHtml(placeholder)}</option>`;
  items.forEach((item) => {
    const opt = document.createElement('option');
    opt.value = item;
    opt.textContent = item;
    selectEl.appendChild(opt);
  });
}

function setStatus(side, msg, type) {
  const s = el[side].status;
  s.textContent = msg;
  s.className   = 'panel-status' + (type ? ` ${type}` : '');
}

function escHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* ── Init ────────────────────────────────────────────────────────────────── */
setupPanel('left');
setupPanel('right');
