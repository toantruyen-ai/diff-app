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
    selectorGrid:    $('left-selector-grid'),
    aksField:        $('left-aks-field'),
    aksDisplay:      $('left-aks-display'),
    kubeconfigField: $('left-kubeconfig-field'),
    contextField:    $('left-context-field'),
  },
  right: {
    kubeconfig: $('right-kubeconfig'), btnBrowse: $('right-btn-browse'),
    btnDefault: $('right-btn-default'), context: $('right-context'),
    namespace:  $('right-namespace'),  deployment: $('right-deployment'),
    status:     $('right-status'),
    selectorGrid:    $('right-selector-grid'),
    aksField:        $('right-aks-field'),
    aksDisplay:      $('right-aks-display'),
    kubeconfigField: $('right-kubeconfig-field'),
    contextField:    $('right-context-field'),
    btnUseFile:      $('right-btn-use-file'),
  },
  updateBanner:        $('update-banner'),
  updateBannerText:    $('update-banner-text'),
  btnInstallUpdate:    $('btn-install-update'),
  btnDismissUpdate:    $('btn-dismiss-update'),
  btnCompare:          $('btn-compare'),
  btnClear:            $('btn-clear'),
  btnBackHome:         $('btn-back-home'),
  titlebarActions:     $('titlebar-actions'),
  homeView:            $('home-view'),
  clusterSelectView:   $('cluster-select-view'),
  clusterList:         $('cluster-list'),
  csCount:             $('cs-count'),
  btnCompareClusters:     $('btn-compare-clusters'),
  k8sDiffView:            $('k8s-diff-view'),
  cardK8sDiff:            $('card-k8s-diff'),
  cardStorageDiff:           $('card-storage-diff'),
  storageSelectView:         $('storage-select-view'),
  storageAccountList:        $('storage-account-list'),
  saCount:                   $('sa-count'),
  btnCompareStorage:         $('btn-compare-storage'),
  storageDiffResultView:     $('storage-diff-result-view'),
  sdrHead:                   $('sdr-head'),
  sdrBody:                   $('sdr-body'),
  sdrStats:                  $('sdr-stats'),
  sdrSearch:                 $('sdr-search'),
  sdrFilterBtns:             document.querySelectorAll('[data-sdr-filter]'),
  cardServiceBusDiff:        $('card-servicebus-diff'),
  servicebusSelectView:      $('servicebus-select-view'),
  servicebusNamespaceList:   $('servicebus-namespace-list'),
  sbCount:                   $('sb-count'),
  btnCompareServiceBus:      $('btn-compare-servicebus'),
  servicebusResultView:      $('servicebus-diff-result-view'),
  sbdrHead:                  $('sbdr-head'),
  sbdrBody:                  $('sbdr-body'),
  sbdrStats:                 $('sbdr-stats'),
  sbdrSearch:                $('sbdr-search'),
  sbdrFilterBtns:            document.querySelectorAll('[data-sbdr-filter]'),
  tokenExpiry:         $('token-expiry'),
  tokenCountdown:      $('token-countdown'),
  authOverlay:         $('auth-overlay'),
  authMessage:      $('auth-message'),
  authStatus:       $('auth-status'),
  btnAzLogin:       $('btn-az-login'),
  filterBar:        $('filter-bar'),
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

/* ════════════════════════════════════════════════════════════════════════════
   VIEW SWITCHING
   ════════════════════════════════════════════════════════════════════════════ */
let panelsInitialized = false;

const BACK_TARGETS = {
  'cluster-select':          'home',
  'k8s-diff':                'cluster-select',
  'storage-select':          'home',
  'storage-diff-result':     'storage-select',
  'servicebus-select':       'home',
  'servicebus-diff-result':  'servicebus-select',
};

function showView(view) {
  el.homeView.style.display              = view === 'home'                   ? 'flex' : 'none';
  el.clusterSelectView.style.display     = view === 'cluster-select'         ? 'flex' : 'none';
  el.k8sDiffView.style.display           = view === 'k8s-diff'               ? 'flex' : 'none';
  el.storageSelectView.style.display     = view === 'storage-select'         ? 'flex' : 'none';
  el.storageDiffResultView.style.display = view === 'storage-diff-result'    ? 'flex' : 'none';
  el.servicebusSelectView.style.display  = view === 'servicebus-select'      ? 'flex' : 'none';
  el.servicebusResultView.style.display  = view === 'servicebus-diff-result' ? 'flex' : 'none';
  el.btnBackHome.style.display           = view !== 'home'                   ? ''     : 'none';
  el.titlebarActions.style.display       = view === 'k8s-diff'               ? ''     : 'none';
  el.btnBackHome.dataset.target          = BACK_TARGETS[view] || 'home';
}

el.btnBackHome.addEventListener('click', () => {
  showView(el.btnBackHome.dataset.target || 'home');
});

el.cardK8sDiff.addEventListener('click', () => {
  showView('cluster-select');
  loadClusterList();
});

/* ════════════════════════════════════════════════════════════════════════════
   CLUSTER SELECTION
   ════════════════════════════════════════════════════════════════════════════ */
let selectedClusters = [];

async function loadClusterList() {
  selectedClusters = [];
  el.clusterList.innerHTML = '<div class="cs-loading">Loading clusters…</div>';
  el.csCount.textContent = '0 / 2 selected';
  el.btnCompareClusters.disabled = true;

  showLoading('Fetching AKS clusters…');
  const result = await window.k8sApi.listAksClusters();
  hideLoading();

  if (!result.ok) {
    el.clusterList.innerHTML = `<div class="cs-error">Failed to load clusters:<br>${escHtml(result.error)}</div>`;
    return;
  }
  if (result.clusters.length === 0) {
    el.clusterList.innerHTML = '<div class="cs-empty">No clusters found with tag <code>diff=true</code></div>';
    return;
  }
  renderClusterList(result.clusters);
}

function clusterKey(c) {
  return `${c.name}::${c.resourceGroup}`;
}

function envTagClass(env) {
  if (!env) return 'env-unknown';
  const e = env.toLowerCase();
  if (e === 'production' || e === 'prod') return 'env-prod';
  if (e === 'staging' || e === 'stage') return 'env-staging';
  if (e === 'development' || e === 'dev') return 'env-dev';
  if (e === 'sandbox' || e === 'sand') return 'env-sandbox';
  if (e === 'uat') return 'env-uat';
  return 'env-other';
}

function renderClusterList(clusters) {
  el.clusterList.innerHTML = '';
  for (const c of clusters) {
    const item = document.createElement('div');
    item.className = 'cluster-item';
    item.dataset.key = clusterKey(c);
    const envHtml = c.environment
      ? `<span class="ci-env-tag ${envTagClass(c.environment)}">${escHtml(c.environment)}</span>`
      : `<span class="ci-env-tag env-unknown">—</span>`;
    item.innerHTML = `
      <div class="ci-check"></div>
      <div class="ci-body">
        <div class="ci-name-row">
          ${envHtml}
          <span class="ci-name">${escHtml(c.name)}</span>
        </div>
        <div class="ci-meta">${escHtml(c.resourceGroup)} &middot; ${escHtml(c.location)} &middot; k8s ${escHtml(c.kubernetesVersion)}</div>
      </div>
      <div class="ci-badge" style="visibility:hidden">A</div>
    `;
    item.addEventListener('click', () => toggleCluster(item, c));
    el.clusterList.appendChild(item);
  }
}

function toggleCluster(item, cluster) {
  const key = clusterKey(cluster);
  const idx = selectedClusters.findIndex((c) => clusterKey(c) === key);
  if (idx >= 0) {
    selectedClusters.splice(idx, 1);
  } else {
    if (selectedClusters.length >= 2) return;
    selectedClusters.push(cluster);
  }
  refreshClusterSelectionUI();
}

function refreshClusterSelectionUI() {
  const maxReached = selectedClusters.length >= 2;
  el.clusterList.querySelectorAll('.cluster-item').forEach((item) => {
    const idx = selectedClusters.findIndex((c) => clusterKey(c) === item.dataset.key);
    const badge = item.querySelector('.ci-badge');
    item.classList.remove('ci-selected-a', 'ci-selected-b', 'ci-max-reached');
    badge.style.visibility = 'hidden';
    if (idx === 0) {
      item.classList.add('ci-selected-a');
      badge.textContent = 'A';
      badge.style.visibility = '';
    } else if (idx === 1) {
      item.classList.add('ci-selected-b');
      badge.textContent = 'B';
      badge.style.visibility = '';
    } else if (maxReached) {
      item.classList.add('ci-max-reached');
    }
  });
  el.csCount.textContent = `${selectedClusters.length} / 2 selected`;
  el.btnCompareClusters.disabled = selectedClusters.length !== 2;
}

el.btnCompareClusters.addEventListener('click', async () => {
  if (selectedClusters.length !== 2) return;
  el.btnCompareClusters.disabled = true;

  try {
    showLoading(`Getting credentials for ${selectedClusters[0].name}…`);
    const credA = await window.k8sApi.getAksCredentials(selectedClusters[0].name, selectedClusters[0].resourceGroup);
    if (!credA.ok) throw new Error(`Cannot get credentials for ${selectedClusters[0].name}: ${credA.error}`);

    showLoading(`Getting credentials for ${selectedClusters[1].name}…`);
    const credB = await window.k8sApi.getAksCredentials(selectedClusters[1].name, selectedClusters[1].resourceGroup);
    if (!credB.ok) throw new Error(`Cannot get credentials for ${selectedClusters[1].name}: ${credB.error}`);

    hideLoading();
    await initAksPanels(
      { ...selectedClusters[0], kubeconfigId: credA.kubeconfigId },
      { ...selectedClusters[1], kubeconfigId: credB.kubeconfigId }
    );
    showView('k8s-diff');
  } catch (e) {
    hideLoading();
    alert(e.message);
    el.btnCompareClusters.disabled = false;
  }
});

function setAksMode(side, clusterName, environment) {
  const s = el[side];
  s.aksField.style.display        = '';
  s.kubeconfigField.style.display = 'none';
  s.contextField.style.display    = 'none';
  s.selectorGrid.classList.add('col-3');
  const envHtml = environment
    ? `<span class="ci-env-tag ${envTagClass(environment)} env-inline">${escHtml(environment)}</span>`
    : '';
  s.aksDisplay.innerHTML = `${envHtml}<span class="aks-name-text">${escHtml(clusterName)}</span>`;
}

el.right.btnUseFile.addEventListener('click', () => {
  const s = el.right;
  // Switch right panel back to file mode
  s.aksField.style.display        = 'none';
  s.kubeconfigField.style.display = '';
  s.contextField.style.display    = '';
  s.selectorGrid.classList.remove('col-3');
  // Reset state and reload from default kubeconfig
  state.right.kubeconfig   = null;
  state.right.context      = null;
  state.right.namespace    = null;
  state.right.deployment   = null;
  state.right.envs         = null;
  s.kubeconfig.value       = '';
  loadContexts('right');
});

function initPanelsOnce() {
  if (panelsInitialized) return;
  panelsInitialized = true;
  setupPanel('left');
  setupPanel('right');
}

async function initAksPanels(clusterA, clusterB) {
  initPanelsOnce();
  // Reset dropdowns without touching kubeconfig state
  resetBelow('left', 'kubeconfig');
  resetBelow('right', 'kubeconfig');
  // Set kubeconfig references (short IDs stored in main process)
  state.left.kubeconfig  = clusterA.kubeconfigId;
  state.right.kubeconfig = clusterB.kubeconfigId;
  // Switch panels to AKS display mode
  setAksMode('left',  clusterA.name, clusterA.environment);
  setAksMode('right', clusterB.name, clusterB.environment);
  // Load contexts (auto-selects if only 1 context, then cascades to namespaces)
  await Promise.all([loadContexts('left'), loadContexts('right')]);
}

/* ════════════════════════════════════════════════════════════════════════════
   STORAGE DIFF
   ════════════════════════════════════════════════════════════════════════════ */
let selectedAccounts = [];

el.cardStorageDiff.addEventListener('click', () => {
  showView('storage-select');
  loadStorageAccountList();
});

async function loadStorageAccountList() {
  selectedAccounts = [];
  el.storageAccountList.innerHTML = '<div class="cs-loading">Loading storage accounts…</div>';
  el.saCount.textContent = '0 selected';
  el.btnCompareStorage.disabled = true;

  showLoading('Fetching storage accounts…');
  const result = await window.k8sApi.listStorageAccounts();
  hideLoading();

  if (!result.ok) {
    el.storageAccountList.innerHTML = `<div class="cs-error">Failed to load accounts:<br>${escHtml(result.error)}</div>`;
    return;
  }
  if (result.accounts.length === 0) {
    el.storageAccountList.innerHTML = '<div class="cs-empty">No storage accounts found with tag <code>diff=true</code></div>';
    return;
  }
  renderStorageAccountList(result.accounts);
}

function renderStorageAccountList(accounts) {
  el.storageAccountList.innerHTML = '';
  for (const a of accounts) {
    const item = document.createElement('div');
    item.className = 'cluster-item';
    item.dataset.name = a.name;
    const envHtml = a.environment
      ? `<span class="ci-env-tag ${envTagClass(a.environment)}">${escHtml(a.environment)}</span>`
      : `<span class="ci-env-tag env-unknown">—</span>`;
    item.innerHTML = `
      <div class="ci-check"></div>
      <div class="ci-body">
        <div class="ci-name-row">${envHtml}<span class="ci-name">${escHtml(a.name)}</span></div>
        <div class="ci-meta">${escHtml(a.resourceGroup)} &middot; ${escHtml(a.location)}</div>
      </div>
    `;
    item.addEventListener('click', () => toggleStorageAccount(item, a));
    el.storageAccountList.appendChild(item);
  }
}

function toggleStorageAccount(item, account) {
  const idx = selectedAccounts.findIndex((a) => a.name === account.name);
  if (idx >= 0) {
    selectedAccounts.splice(idx, 1);
    item.classList.remove('ci-selected-a', 'ci-selected-b');
    item.querySelector('.ci-check').classList.remove('ci-checked');
  } else {
    selectedAccounts.push(account);
    item.classList.add(selectedAccounts.length === 1 ? 'ci-selected-a' : 'ci-selected-b');
  }
  refreshStorageSelectionUI();
}

function refreshStorageSelectionUI() {
  el.storageAccountList.querySelectorAll('.cluster-item').forEach((item) => {
    const idx = selectedAccounts.findIndex((a) => a.name === item.dataset.name);
    item.classList.remove('ci-selected-a', 'ci-selected-b');
    if (idx >= 0) {
      item.classList.add(idx === 0 ? 'ci-selected-a' : 'ci-selected-b');
    }
  });
  const n = selectedAccounts.length;
  el.saCount.textContent = n === 0 ? '0 selected' : `${n} selected`;
  el.btnCompareStorage.disabled = n < 2;
}

el.btnCompareStorage.addEventListener('click', async () => {
  if (selectedAccounts.length < 2) return;
  el.btnCompareStorage.disabled = true;

  try {
    showLoading(`Listing containers for ${selectedAccounts.length} accounts…`);
    const results = await window.k8sApi.listStorageContainers(selectedAccounts);
    hideLoading();
    renderStorageDiffTable(results);
    showView('storage-diff-result');
  } catch (e) {
    hideLoading();
    alert(`Failed to list containers: ${e.message}`);
    el.btnCompareStorage.disabled = false;
  }
});

// ── Storage diff table ────────────────────────────────────────────────────────
let sdrFilter = 'all';
let sdrSearch = '';
let lastSdrRows = [];

el.sdrFilterBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    el.sdrFilterBtns.forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    sdrFilter = btn.dataset.sdrFilter;
    applySdrFilter();
  });
});

el.sdrSearch.addEventListener('input', () => {
  sdrSearch = el.sdrSearch.value.toLowerCase();
  applySdrFilter();
});

function applySdrFilter() {
  el.sdrBody.querySelectorAll('tr').forEach((row) => {
    const matchFilter = sdrFilter === 'all' || row.dataset.status === sdrFilter;
    const matchSearch = !sdrSearch || row.dataset.container.includes(sdrSearch);
    row.style.display = matchFilter && matchSearch ? '' : 'none';
  });
}

function renderStorageDiffTable(results) {
  // Build unique container set
  const allContainers = new Set();
  for (const r of results) {
    for (const c of r.containers) allContainers.add(c);
  }
  const sorted = Array.from(allContainers).sort();

  // ── Header ────────────────────────────────────────────────────────────────
  el.sdrHead.innerHTML = '';
  const hRow = document.createElement('tr');
  let hHtml = '<th class="sdr-col-container">Container</th>';
  for (const r of results) {
    const envHtml = r.environment
      ? `<span class="ci-env-tag ${envTagClass(r.environment)} env-inline">${escHtml(r.environment)}</span>`
      : '';
    const errHtml = r.ok ? '' : `<div class="sdr-account-error" title="${escHtml(r.error)}">⚠ error</div>`;
    hHtml += `
      <th class="sdr-col-account">
        <div class="sdr-th-account">
          ${envHtml}
          <span class="sdr-th-name">${escHtml(r.name)}</span>
          ${errHtml}
        </div>
      </th>`;
  }
  hHtml += '<th class="sdr-col-status">Status</th>';
  hRow.innerHTML = hHtml;
  el.sdrHead.appendChild(hRow);

  // ── Body ──────────────────────────────────────────────────────────────────
  el.sdrBody.innerHTML = '';
  let totalComplete = 0, totalPartial = 0;

  for (const container of sorted) {
    const presence = results.map((r) => r.containers.includes(container));
    const allHave = presence.every(Boolean);
    const status = allHave ? 'complete' : 'partial';
    if (allHave) totalComplete++; else totalPartial++;

    const row = document.createElement('tr');
    row.className = `sdr-row-${status}`;
    row.dataset.status = status;
    row.dataset.container = container.toLowerCase();

    let cells = `<td class="sdr-cell-name">${escHtml(container)}</td>`;
    results.forEach((r, i) => {
      if (!r.ok) {
        cells += `<td class="sdr-cell-check sdr-unknown" title="${escHtml(r.error)}">?</td>`;
      } else {
        cells += `<td class="sdr-cell-check">${presence[i]
          ? '<span class="sdr-present">✓</span>'
          : '<span class="sdr-missing">✗</span>'
        }</td>`;
      }
    });
    cells += `<td class="sdr-col-status">
      <span class="sdr-pill sdr-pill-${status}">${allHave ? 'ALL' : 'PARTIAL'}</span>
    </td>`;
    row.innerHTML = cells;
    el.sdrBody.appendChild(row);
  }

  const total = sorted.length;
  el.sdrStats.textContent = total === 0
    ? 'No containers found'
    : `${total} containers · ${totalPartial} missing in some · ${totalComplete} in all`;

  // Reset filters
  sdrFilter = 'all';
  sdrSearch = '';
  el.sdrSearch.value = '';
  el.sdrFilterBtns.forEach((b) => b.classList.toggle('active', b.dataset.sdrFilter === 'all'));
}

/* ════════════════════════════════════════════════════════════════════════════
   SERVICEBUS DIFF
   ════════════════════════════════════════════════════════════════════════════ */
let selectedNamespaces = [];

el.cardServiceBusDiff.addEventListener('click', () => {
  showView('servicebus-select');
  loadServiceBusNamespaceList();
});

async function loadServiceBusNamespaceList() {
  selectedNamespaces = [];
  el.servicebusNamespaceList.innerHTML = '<div class="cs-loading">Loading Service Bus namespaces…</div>';
  el.sbCount.textContent = '0 selected';
  el.btnCompareServiceBus.disabled = true;

  showLoading('Fetching Service Bus namespaces…');
  const result = await window.k8sApi.listServiceBusNamespaces();
  hideLoading();

  if (!result.ok) {
    el.servicebusNamespaceList.innerHTML = `<div class="cs-error">Failed to load namespaces:<br>${escHtml(result.error)}</div>`;
    return;
  }
  if (result.namespaces.length === 0) {
    el.servicebusNamespaceList.innerHTML = '<div class="cs-empty">No Service Bus namespaces found with tag <code>diff=true</code></div>';
    return;
  }
  renderServiceBusNamespaceList(result.namespaces);
}

function renderServiceBusNamespaceList(namespaces) {
  el.servicebusNamespaceList.innerHTML = '';
  for (const ns of namespaces) {
    const item = document.createElement('div');
    item.className = 'cluster-item';
    item.dataset.name = ns.name;
    const envHtml = ns.environment
      ? `<span class="ci-env-tag ${envTagClass(ns.environment)}">${escHtml(ns.environment)}</span>`
      : `<span class="ci-env-tag env-unknown">—</span>`;
    item.innerHTML = `
      <div class="ci-check"></div>
      <div class="ci-body">
        <div class="ci-name-row">${envHtml}<span class="ci-name">${escHtml(ns.name)}</span></div>
        <div class="ci-meta">${escHtml(ns.resourceGroup)} &middot; ${escHtml(ns.location)}</div>
      </div>
    `;
    item.addEventListener('click', () => toggleServiceBusNamespace(item, ns));
    el.servicebusNamespaceList.appendChild(item);
  }
}

function toggleServiceBusNamespace(item, ns) {
  const idx = selectedNamespaces.findIndex((n) => n.name === ns.name);
  if (idx >= 0) {
    selectedNamespaces.splice(idx, 1);
    item.classList.remove('ci-selected-a', 'ci-selected-b');
  } else {
    selectedNamespaces.push(ns);
    item.classList.add(selectedNamespaces.length === 1 ? 'ci-selected-a' : 'ci-selected-b');
  }
  refreshServiceBusSelectionUI();
}

function refreshServiceBusSelectionUI() {
  el.servicebusNamespaceList.querySelectorAll('.cluster-item').forEach((item) => {
    const idx = selectedNamespaces.findIndex((n) => n.name === item.dataset.name);
    item.classList.remove('ci-selected-a', 'ci-selected-b');
    if (idx >= 0) item.classList.add(idx === 0 ? 'ci-selected-a' : 'ci-selected-b');
  });
  const n = selectedNamespaces.length;
  el.sbCount.textContent = n === 0 ? '0 selected' : `${n} selected`;
  el.btnCompareServiceBus.disabled = n < 2;
}

el.btnCompareServiceBus.addEventListener('click', async () => {
  if (selectedNamespaces.length < 2) return;
  el.btnCompareServiceBus.disabled = true;

  try {
    showLoading(`Listing queues for ${selectedNamespaces.length} namespaces…`);
    const results = await window.k8sApi.listServiceBusQueues(selectedNamespaces);
    hideLoading();
    renderServiceBusDiffTable(results);
    showView('servicebus-diff-result');
  } catch (e) {
    hideLoading();
    alert(`Failed to list queues: ${e.message}`);
    el.btnCompareServiceBus.disabled = false;
  }
});

// ── ServiceBus diff table ─────────────────────────────────────────────────────
let sbdrFilter = 'all';
let sbdrSearch = '';

el.sbdrFilterBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    el.sbdrFilterBtns.forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    sbdrFilter = btn.dataset.sbdrFilter;
    applySbdrFilter();
  });
});

el.sbdrSearch.addEventListener('input', () => {
  sbdrSearch = el.sbdrSearch.value.toLowerCase();
  applySbdrFilter();
});

function applySbdrFilter() {
  el.sbdrBody.querySelectorAll('tr').forEach((row) => {
    const matchFilter = sbdrFilter === 'all' || row.dataset.status === sbdrFilter;
    const matchSearch = !sbdrSearch || row.dataset.queue.includes(sbdrSearch);
    row.style.display = matchFilter && matchSearch ? '' : 'none';
  });
}

function renderServiceBusDiffTable(results) {
  // Build unique queue set
  const allQueues = new Set();
  for (const r of results) {
    for (const q of r.queues) allQueues.add(q);
  }
  const sorted = Array.from(allQueues).sort();

  // ── Header ────────────────────────────────────────────────────────────────
  el.sbdrHead.innerHTML = '';
  const hRow = document.createElement('tr');
  let hHtml = '<th class="sdr-col-container">Queue</th>';
  for (const r of results) {
    const envHtml = r.environment
      ? `<span class="ci-env-tag ${envTagClass(r.environment)} env-inline">${escHtml(r.environment)}</span>`
      : '';
    const errHtml = r.ok ? '' : `<div class="sdr-account-error" title="${escHtml(r.error)}">⚠ error</div>`;
    hHtml += `
      <th class="sdr-col-account">
        <div class="sdr-th-account">
          ${envHtml}
          <span class="sdr-th-name">${escHtml(r.name)}</span>
          ${errHtml}
        </div>
      </th>`;
  }
  hHtml += '<th class="sdr-col-status">Status</th>';
  hRow.innerHTML = hHtml;
  el.sbdrHead.appendChild(hRow);

  // ── Body ──────────────────────────────────────────────────────────────────
  el.sbdrBody.innerHTML = '';
  let totalComplete = 0, totalPartial = 0;

  for (const queue of sorted) {
    const presence = results.map((r) => r.queues.includes(queue));
    const allHave = presence.every(Boolean);
    const status = allHave ? 'complete' : 'partial';
    if (allHave) totalComplete++; else totalPartial++;

    const row = document.createElement('tr');
    row.className = `sdr-row-${status}`;
    row.dataset.status = status;
    row.dataset.queue = queue.toLowerCase();

    let cells = `<td class="sdr-cell-name">${escHtml(queue)}</td>`;
    results.forEach((r, i) => {
      if (!r.ok) {
        cells += `<td class="sdr-cell-check sdr-unknown" title="${escHtml(r.error)}">?</td>`;
      } else {
        cells += `<td class="sdr-cell-check">${presence[i]
          ? '<span class="sdr-present">✓</span>'
          : '<span class="sdr-missing">✗</span>'
        }</td>`;
      }
    });
    cells += `<td class="sdr-col-status">
      <span class="sdr-pill sdr-pill-${status}">${allHave ? 'ALL' : 'PARTIAL'}</span>
    </td>`;
    row.innerHTML = cells;
    el.sbdrBody.appendChild(row);
  }

  const total = sorted.length;
  el.sbdrStats.textContent = total === 0
    ? 'No queues found'
    : `${total} queues · ${totalPartial} missing in some · ${totalComplete} in all`;

  // Reset filters
  sbdrFilter = 'all';
  sbdrSearch = '';
  el.sbdrSearch.value = '';
  el.sbdrFilterBtns.forEach((b) => b.classList.toggle('active', b.dataset.sbdrFilter === 'all'));
}

/* ════════════════════════════════════════════════════════════════════════════
   TOKEN EXPIRY COUNTDOWN
   ════════════════════════════════════════════════════════════════════════════ */
let _countdownInterval = null;

async function startTokenCountdown() {
  if (_countdownInterval) {
    clearInterval(_countdownInterval);
    _countdownInterval = null;
  }

  const result = await window.k8sApi.getTokenExpiry();
  if (!result.ok) return;

  const expiresAt = result.expiresAt;
  el.tokenExpiry.style.display = '';

  function tick() {
    const remaining = Math.floor((expiresAt - Date.now()) / 1000);

    if (remaining <= 0) {
      clearInterval(_countdownInterval);
      _countdownInterval = null;
      el.tokenCountdown.textContent = 'Expired';
      el.tokenExpiry.className = 'token-expiry token-expired';
      setTimeout(() => {
        showAuthModal('Azure token has expired. Please login to continue.');
      }, 800);
      return;
    }

    let display;
    if (remaining > 3600) {
      const h = Math.floor(remaining / 3600);
      const m = Math.floor((remaining % 3600) / 60);
      display = `${h}h ${m}m`;
    } else {
      const m = Math.floor(remaining / 60);
      const s = remaining % 60;
      display = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }
    el.tokenCountdown.textContent = display;

    if (remaining <= 60) {
      el.tokenExpiry.className = 'token-expiry token-danger';
    } else if (remaining <= 300) {
      el.tokenExpiry.className = 'token-expiry token-warning';
    } else {
      el.tokenExpiry.className = 'token-expiry';
    }
  }

  tick();
  _countdownInterval = setInterval(tick, 1000);
}

/* ════════════════════════════════════════════════════════════════════════════
   AUTH CHECK
   ════════════════════════════════════════════════════════════════════════════ */
async function checkAuth() {
  showLoading('Checking authentication…');
  try {
    const [azResult, kubeResult] = await Promise.all([
      window.k8sApi.checkAzureAuth(),
      window.k8sApi.checkKubeloginAuth(),
    ]);

    if (!azResult.ok) {
      hideLoading();
      showAuthModal('Azure CLI session has expired. Please login to continue.');
      return false;
    }

    if (!kubeResult.ok) {
      hideLoading();
      showAuthModal('Kubelogin token has expired. Please login again to refresh.');
      return false;
    }
  } catch {
    // If check fails (e.g. az not installed), proceed silently
  }
  hideLoading();
  return true;
}

function showAuthModal(msg) {
  el.authMessage.textContent = msg;
  el.authStatus.textContent = '';
  el.btnAzLogin.disabled = false;
  el.btnAzLogin.textContent = 'Login with Azure';
  el.authOverlay.style.display = 'flex';
}

function hideAuthModal() {
  el.authOverlay.style.display = 'none';
}

el.btnAzLogin.addEventListener('click', async () => {
  el.btnAzLogin.disabled = true;
  el.btnAzLogin.textContent = 'Opening browser…';
  el.authStatus.textContent = 'Waiting for browser authentication…';

  const loginResult = await window.k8sApi.azLogin();
  if (!loginResult.ok) {
    el.authStatus.textContent = 'Login failed. Please try again.';
    el.btnAzLogin.disabled = false;
    el.btnAzLogin.textContent = 'Login with Azure';
    return;
  }

  el.authStatus.textContent = 'Refreshing kubelogin…';
  await window.k8sApi.kubeloginRefresh();

  hideAuthModal();
  showView('home');
  startTokenCountdown();
});

/* ── Auto-update ─────────────────────────────────────────────────────────── */
if (window.k8sApi.onUpdateAvailable) {
  window.k8sApi.onUpdateAvailable((version) => {
    el.updateBannerText.textContent = `Update v${version} is downloading…`;
    el.btnInstallUpdate.style.display = 'none';
    el.updateBanner.style.display = 'flex';
  });

  window.k8sApi.onUpdateDownloaded((version) => {
    el.updateBannerText.textContent = `v${version} is ready to install`;
    el.btnInstallUpdate.style.display = '';
    el.updateBanner.style.display = 'flex';
  });

  el.btnInstallUpdate.addEventListener('click', () => window.k8sApi.installUpdate());
  el.btnDismissUpdate.addEventListener('click', () => { el.updateBanner.style.display = 'none'; });
}

/* ── Init ────────────────────────────────────────────────────────────────── */
checkAuth().then((ok) => {
  if (ok) {
    showView('home');
    startTokenCountdown();
  }
});
