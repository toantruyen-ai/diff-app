/* ── State ───────────────────────────────────────────────────────────────── */
const state = {
  left:  { kubeconfig: null, context: null, namespace: null, deployment: null, envs: null },
  right: { kubeconfig: null, context: null, namespace: null, deployment: null, envs: null },
  filter: 'all',
  search: '',
  maskSecrets: true,
};

/* ── DOM refs ────────────────────────────────────────────────────────────── */
const $ = (id) => document.getElementById(id);

const el = {
  left: {
    kubeconfig: $('left-kubeconfig'),
    btnBrowse:  $('left-btn-browse'),
    btnDefault: $('left-btn-default'),
    context:    $('left-context'),
    namespace:  $('left-namespace'),
    deployment: $('left-deployment'),
    status:     $('left-status'),
  },
  right: {
    kubeconfig: $('right-kubeconfig'),
    btnBrowse:  $('right-btn-browse'),
    btnDefault: $('right-btn-default'),
    context:    $('right-context'),
    namespace:  $('right-namespace'),
    deployment: $('right-deployment'),
    status:     $('right-status'),
  },
  btnCompare:    $('btn-compare'),
  btnClear:      $('btn-clear'),
  filterBar:     $('filter-bar'),
  searchInput:   $('search-input'),
  filterBtns:    document.querySelectorAll('.toggle-btn[data-filter]'),
  diffTable:     $('diff-table'),
  diffBody:      $('diff-body'),
  emptyState:    $('empty-state'),
  loadingOverlay: $('loading-overlay'),
  loadingText:   $('loading-text'),
  statsEl:       $('stats'),
  thLeftLabel:   $('th-left-label'),
  thRightLabel:  $('th-right-label'),
  toggleMask:    $('toggle-mask'),
};

/* ── Loading helpers ─────────────────────────────────────────────────────── */
function showLoading(msg) {
  el.loadingText.textContent = msg || 'Loading…';
  el.loadingOverlay.style.display = 'flex';
}
function hideLoading() {
  el.loadingOverlay.style.display = 'none';
}

/* ── Panel setup helper ──────────────────────────────────────────────────── */
function setupPanel(side) {
  const s = el[side];
  const data = state[side];

  // Browse kubeconfig
  s.btnBrowse.addEventListener('click', async () => {
    const p = await window.k8sApi.selectKubeconfig();
    if (!p) return;
    data.kubeconfig = p;
    s.kubeconfig.value = p;
    await loadContexts(side);
  });

  // Reset to default kubeconfig
  s.btnDefault.addEventListener('click', async () => {
    data.kubeconfig = null;
    s.kubeconfig.value = '';
    await loadContexts(side);
  });

  // Context changed
  s.context.addEventListener('change', async () => {
    data.context = s.context.value || null;
    resetBelow(side, 'context');
    if (data.context) await loadNamespaces(side);
  });

  // Namespace changed
  s.namespace.addEventListener('change', async () => {
    data.namespace = s.namespace.value || null;
    resetBelow(side, 'namespace');
    if (data.namespace) await loadDeployments(side);
  });

  // Deployment changed
  s.deployment.addEventListener('change', () => {
    data.deployment = s.deployment.value || null;
    data.envs = null;
    updateCompareButton();
  });

  // Load contexts on startup with default kubeconfig
  loadContexts(side);
}

/* ── Cascade loaders ─────────────────────────────────────────────────────── */
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
    const namespaces = await window.k8sApi.loadNamespaces(data.kubeconfig, data.context);
    populateSelect(s.namespace, namespaces, '— select namespace —');
    s.namespace.disabled = false;
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
    populateSelect(s.deployment, deps, '— select deployment —');
    s.deployment.disabled = false;
  } catch (e) {
    setStatus(side, `Error: ${e.message}`, 'error');
  } finally {
    hideLoading();
  }
}

/* ── Compare ─────────────────────────────────────────────────────────────── */
el.btnCompare.addEventListener('click', async () => {
  try {
    showLoading('Fetching ENV variables…');
    const [leftEnvs, rightEnvs] = await Promise.all([
      window.k8sApi.loadEnvs(
        state.left.kubeconfig, state.left.context,
        state.left.namespace,  state.left.deployment
      ),
      window.k8sApi.loadEnvs(
        state.right.kubeconfig, state.right.context,
        state.right.namespace,  state.right.deployment
      ),
    ]);
    state.left.envs  = leftEnvs;
    state.right.envs = rightEnvs;

    el.thLeftLabel.textContent  = `${state.left.deployment} (${state.left.namespace})`;
    el.thRightLabel.textContent = `${state.right.deployment} (${state.right.namespace})`;

    renderTable();
    el.filterBar.style.display = 'flex';
  } catch (e) {
    alert(`Compare failed: ${e.message}`);
  } finally {
    hideLoading();
  }
});

/* ── Clear ───────────────────────────────────────────────────────────────── */
el.btnClear.addEventListener('click', () => {
  state.left.envs  = null;
  state.right.envs = null;
  el.diffTable.style.display = 'none';
  el.emptyState.style.display = 'flex';
  el.filterBar.style.display  = 'none';
  el.diffBody.innerHTML = '';
});

/* ── Filters ─────────────────────────────────────────────────────────────── */
el.filterBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    el.filterBtns.forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    state.filter = btn.dataset.filter;
    renderTable();
  });
});

el.searchInput.addEventListener('input', () => {
  state.search = el.searchInput.value.toLowerCase();
  renderTable();
});

el.toggleMask.addEventListener('change', () => {
  state.maskSecrets = el.toggleMask.checked;
  renderTable();
});

/* ── Table render ────────────────────────────────────────────────────────── */
function renderTable() {
  if (!state.left.envs || !state.right.envs) return;

  const allKeys = Array.from(
    new Set([...Object.keys(state.left.envs), ...Object.keys(state.right.envs)])
  ).sort();

  el.diffBody.innerHTML = '';
  let totalDiff = 0, totalSame = 0, totalMissing = 0;
  let shown = 0;

  for (const key of allKeys) {
    const lEntry = state.left.envs[key];
    const rEntry = state.right.envs[key];

    const lVal = lEntry?.value;
    const rVal = rEntry?.value;

    let rowType;
    if (lEntry && rEntry) {
      rowType = lVal === rVal ? 'same' : 'diff';
    } else {
      rowType = 'missing';
    }

    if (rowType === 'diff')    totalDiff++;
    else if (rowType === 'same')  totalSame++;
    else                          totalMissing++;

    // Apply filter
    if (state.filter !== 'all' && state.filter !== rowType) continue;
    if (state.search && !key.toLowerCase().includes(state.search)) continue;

    shown++;

    const source = lEntry?.source || rEntry?.source || 'Unknown';
    const sourceClass = getSourceClass(source);
    const sourceLabel = formatSourceLabel(source);

    const tr = document.createElement('tr');
    tr.className = `row-${rowType}`;

    const maskedL = maskValue(lVal, source);
    const maskedR = maskValue(rVal, source);

    tr.innerHTML = `
      <td class="col-key"><span class="cell-key">${escHtml(key)}</span></td>
      <td class="col-source"><span class="source-tag ${sourceClass}">${escHtml(sourceLabel)}</span></td>
      <td class="col-a col-value">
        ${lEntry
          ? `<span class="cell-value">${escHtml(maskedL)}</span>`
          : `<span class="cell-value-missing">— not present —</span>`}
      </td>
      <td class="col-b col-value">
        ${rEntry
          ? `<span class="cell-value">${escHtml(maskedR)}</span>`
          : `<span class="cell-value-missing">— not present —</span>`}
      </td>
      <td class="col-status">
        <span class="status-pill pill-${rowType}">
          ${rowType === 'diff' ? 'DIFF' : rowType === 'same' ? 'SAME' : 'MISSING'}
        </span>
      </td>
    `;

    el.diffBody.appendChild(tr);
  }

  el.statsEl.textContent =
    `${shown} shown · ${totalDiff} diff · ${totalSame} same · ${totalMissing} missing`;

  el.emptyState.style.display = 'none';
  el.diffTable.style.display  = 'table';
}

/* ── Value masking ───────────────────────────────────────────────────────── */
function maskValue(val, source) {
  if (!state.maskSecrets) return val ?? '';
  if (source && source.toLowerCase().includes('secret')) {
    return val ? '••••••••' : '';
  }
  return val ?? '';
}

/* ── Source formatting ───────────────────────────────────────────────────── */
function getSourceClass(source) {
  if (!source) return 'source-missing';
  const s = source.toLowerCase();
  if (s === 'direct') return 'source-direct';
  if (s.startsWith('configmap')) return 'source-configmap';
  if (s.startsWith('secret')) return 'source-secret';
  if (s.startsWith('fieldref') || s.startsWith('resourcefield')) return 'source-fieldref';
  return 'source-missing';
}

function formatSourceLabel(source) {
  if (!source) return '?';
  if (source === 'Direct') return 'Direct';
  if (source.startsWith('ConfigMap:')) {
    const name = source.replace('ConfigMap:', '').split('[')[0];
    return `CM: ${name}`;
  }
  if (source.startsWith('Secret:')) {
    const name = source.replace('Secret:', '').split('[')[0];
    return `Sec: ${name}`;
  }
  if (source === 'FieldRef') return 'FieldRef';
  return source;
}

/* ── Helpers ─────────────────────────────────────────────────────────────── */
function populateSelect(selectEl, items, placeholder) {
  selectEl.innerHTML = `<option value="">${escHtml(placeholder)}</option>`;
  items.forEach((item) => {
    const opt = document.createElement('option');
    opt.value = item;
    opt.textContent = item;
    selectEl.appendChild(opt);
  });
}

function resetBelow(side, level) {
  const s = el[side];
  const data = state[side];
  const levels = ['context', 'namespace', 'deployment'];
  const idx = levels.indexOf(level);
  // idx+1 so that the changed level itself is NOT reset, only those below it.
  // 'kubeconfig' not in list → idx=-1 → -1+1=0 → reset all three. ✓
  // 'context'    → idx=0  →  0+1=1 → reset namespace + deployment only. ✓
  // 'namespace'  → idx=1  →  1+1=2 → reset deployment only. ✓
  for (let i = idx + 1; i < levels.length; i++) {
    const lvl = levels[i];
    data[lvl] = null;
    s[lvl].innerHTML = `<option value="">— select ${lvl} —</option>`;
    s[lvl].disabled = true;
  }
  data.envs = null;
  updateCompareButton();
}

function setStatus(side, msg, type) {
  const el2 = el[side].status;
  el2.textContent = msg;
  el2.className = 'panel-status' + (type ? ` ${type}` : '');
}

function updateCompareButton() {
  const canCompare =
    state.left.deployment && state.left.namespace && state.left.context &&
    state.right.deployment && state.right.namespace && state.right.context;
  el.btnCompare.disabled = !canCompare;
}

function escHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ── Init ────────────────────────────────────────────────────────────────── */
setupPanel('left');
setupPanel('right');
