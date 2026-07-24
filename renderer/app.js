/* ── Shared renderer utils (bundled by esbuild from src/renderer) ──────────── */
const { escHtml, csvEscape, rowsToCsv, downloadTextFile } = require('../src/renderer/utils/htmlUtils');
const { highlightYaml } = require('../src/renderer/utils/yamlHighlighter');
const { getSourceClass, computeEnvDiffRows } = require('../src/renderer/utils/envDiffComputer');

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
  diffTab: 'env',         // 'env' | 'manifest' — which pane is active in the k8s-diff view
  compareTarget: null,    // { left:{kubeconfig,context,namespace,deployment}, right:{...}|null } — the identity actually being compared (select-mode or list-mode)
  manifest: { leftYaml: null, rightYaml: null, hideStatus: true, key: null, kind: 'deployments', leftName: null, rightName: null }, // Full Manifest tab cache — derived per-comparison, not connection identity
  storageDiffResults: null,     // last Storage diff `results` array, kept for CSV/JSON export
  serviceBusDiffResults: null,  // last ServiceBus diff `results` array, kept for CSV/JSON export
  manage: {
    kubeconfig: null,     // file path, AKS kubeconfigId, or null (default kubeconfig)
    context: null,
    namespace: null,
    resourceType: 'overview',
    rows: [],
    selected: null,       // row shown in the drawer
    pollTimer: null,
    watchSession: null,   // { sid, kind, namespace, disposers: [] } — active real-time watch, if any
    logSession: null,     // { sid, disposers: [] }
    execSession: null,    // { sid, term, fitAddon, resizeObserver, dataDisposable, disposers }
    metricsSeries: new Map(),  // "namespace/name" -> ring buffer [{t,cpu(millicores),mem(bytes)}], point-in-time samples
    metricsPollTimer: null,
    metricsAvailable: true,    // false once metrics-server proves unreachable — stops polling until kind/ns/context changes
    portForwards: new Map(),  // sid -> { sid, pod, targetPort, localPort, disposer } — persist across tabs/rows until stopped or view left
    revealSecrets: false,      // Secret YAML reveal toggle — reset on every drawer open/close, never carries across rows
    yamlEditing: false,        // YAML tab is in edit (textarea) mode vs. read-only view
    yamlEditable: true,        // from the last fetch's `editable` flag (false = redacted Secret)
    selection: new Set(),     // bulk-select: keys of `${namespace}::${name}` for the currently checked rows
    mode: 'kind',              // 'kind' (built-in MANAGE_KINDS) | 'crd' (dynamic custom resources)
    crds: [],                  // [{name, group, version, plural, kind, namespaced}] — populated per-context
    activeCrd: null,           // the CRD currently being browsed, when mode === 'crd'
    enableMetrics: false,      // toggle CPU/Memory column display and polling
    enableAutoRefresh: false,  // toggle auto-refresh polling
    enableEventCapture: false, // toggle auto-capturing events to SQLite
    eventRetention: 0,         // retention policy in days (0 = forever)
    menuVisibility: {
      // Workloads — default ON for essentials
      pods: true, deployments: true, statefulsets: false, daemonsets: false,
      replicasets: false, jobs: false, cronjobs: false,
      services: true, ingresses: false, configmaps: true, secrets: true,
      hpas: false, nodes: true, pvs: false, namespaces: false, events: true,
      // RBAC — default OFF
      serviceaccounts: false, roles: false, rolebindings: false,
      clusterroles: false, clusterrolebindings: false,
      // Policy & Storage — default OFF
      networkpolicies: false, storageclasses: false, resourcequotas: false,
      limitranges: false, pvcs: false,
      // Custom Resources — default OFF
      _crd: false,
    },
    overviewPollTimer: null,
    // Audit
    auditEnabled: false,
    auditConnected: false,
    auditServer: null,
    auditDatabase: null,
    writeUnlocked: false,
    history: null,
  },
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
    btnUseFile:      $('left-btn-use-file'),
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
  authCheckBanner:     $('auth-check-banner'),
  authCheckBannerText: $('auth-check-banner-text'),
  btnDismissAuthCheck: $('btn-dismiss-auth-check'),
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
  sdrExportCsv:              $('sdr-export-csv'),
  sdrExportJson:             $('sdr-export-json'),
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
  sbdrExportCsv:             $('sbdr-export-csv'),
  sbdrExportJson:            $('sbdr-export-json'),
  tokenExpiry:         $('token-expiry'),
  tokenCountdown:      $('token-countdown'),
  authOverlay:         $('auth-overlay'),
  authMessage:      $('auth-message'),
  authStatus:       $('auth-status'),
  btnAzLogin:       $('btn-az-login'),
  btnTokenReauth:   $('btn-token-reauth'),
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
  envDiffExportCsv:  $('env-diff-export-csv'),
  envDiffExportJson: $('env-diff-export-json'),

  cardK8sManage:        $('card-k8s-manage'),
  manageSelectView:     $('manage-select-view'),
  manageClusterList:    $('manage-cluster-list'),
  manageCsCount:        $('manage-cs-count'),
  btnManageUseLocal:    $('btn-manage-use-local'),
  btnManageContinue:    $('btn-manage-continue'),

  manageView:           $('manage-view'),
  manageSidebar:        $('manage-sidebar'),
  manageHeader:         $('manage-header'),
  manageContext:        $('manage-context'),
  manageNamespace:      $('manage-namespace'),
  manageSearch:         $('manage-search'),
  manageRefreshStatus:  $('manage-refresh-status'),
  manageBtnRefresh:     $('manage-btn-refresh'),
  manageSettingsBtn:    $('manage-settings-btn'),
  manageSettingsPopover: $('manage-settings-popover'),
  manageSettingMetrics: $('manage-setting-metrics'),
  manageSettingAutoRefresh: $('manage-setting-autorefresh'),
  manageSettingEventCapture: $('manage-setting-event-capture'),
  manageSettingEventRetention: $('manage-setting-event-retention'),
  manageSettingEventClear: $('manage-setting-event-clear'),
  manageTableWrap:      $('manage-table-wrap'),
  manageThead:          $('manage-thead'),
  manageTbody:          $('manage-tbody'),
  manageDrawer:         $('manage-drawer'),
  manageDrawerTitle:    $('manage-drawer-title'),
  manageDrawerActions:  $('manage-drawer-actions'),
  manageDrawerClose:    $('manage-drawer-close'),
  manageTabs:           document.querySelectorAll('.manage-tab'),
  manageDetailPane:     $('manage-detail-pane'),
  manageYamlPane:       $('manage-yaml-pane'),
  manageYamlGutter:     $('manage-yaml-gutter'),
  manageYamlOutput:     $('manage-yaml-output'),
  manageYamlCopy:       $('manage-yaml-copy'),
  manageYamlRevealLabel: $('manage-yaml-reveal-label'),
  manageYamlReveal:     $('manage-yaml-reveal'),
  manageYamlTextarea:   $('manage-yaml-textarea'),
  manageYamlError:      $('manage-yaml-error'),
  manageYamlEdit:       $('manage-yaml-edit'),
  manageYamlSave:       $('manage-yaml-save'),
  manageYamlCancel:     $('manage-yaml-cancel'),
  manageYamlReload:     $('manage-yaml-reload'),
  manageEventsPane:     $('manage-events-pane'),
  manageEventsThead:    $('manage-events-thead'),
  manageEventsTbody:    $('manage-events-tbody'),
  manageAccessPane:     $('manage-access-pane'),
  manageAccessTbody:    $('manage-access-tbody'),
  manageLogsPane:       $('manage-logs-pane'),
  manageLogContainer:   $('manage-log-container'),
  manageLogFollow:      $('manage-log-follow'),
  manageLogTail:        $('manage-log-tail'),
  manageLogClear:       $('manage-log-clear'),
  manageLogOutput:      $('manage-log-output'),
  manageExecPane:       $('manage-exec-pane'),
  manageExecContainer:  $('manage-exec-container'),
  manageExecStatus:     $('manage-exec-status'),
  manageTerm:           $('manage-term'),
  managePfPane:         $('manage-pf-pane'),
  managePfTargetPort:   $('manage-pf-target-port'),
  managePfLocalPort:    $('manage-pf-local-port'),
  managePfStart:        $('manage-pf-start'),
  managePfList:         $('manage-pf-list'),
  manageMetricsPane:    $('manage-metrics-pane'),
  manageConfirmOverlay: $('manage-confirm-overlay'),
  manageConfirmTitle:   $('manage-confirm-title'),
  manageConfirmBody:    $('manage-confirm-body'),
  manageConfirmInput:   $('manage-confirm-input'),
  manageConfirmCancel:  $('manage-confirm-cancel'),
  manageConfirmOk:      $('manage-confirm-ok'),

  manageKindTitle:      $('manage-kind-title'),
  manageBulkBar:        $('manage-bulk-bar'),
  manageBulkCount:      $('manage-bulk-count'),
  manageBulkResult:     $('manage-bulk-result'),
  manageSearchAllBtn:   $('manage-search-all-btn'),
  manageSearchResults:      $('manage-search-results'),
  manageSearchResultsTitle: $('manage-search-results-title'),
  manageSearchResultsBody:  $('manage-search-results-body'),
  manageSearchResultsClose: $('manage-search-results-close'),
  manageOverviewPane:   $('manage-overview-pane'),
  manageCrdFilter:      $('manage-crd-filter'),
  manageCrdList:        $('manage-crd-list'),
  manageRecyclebinPane:       $('manage-recyclebin-pane'),
  manageRecyclebinList:       $('manage-recyclebin-list'),
  manageRecyclebinYaml:       $('manage-recyclebin-yaml'),
  manageRecyclebinYamlClose:  $('manage-recyclebin-yaml-close'),
  manageRecyclebinYamlOutput: $('manage-recyclebin-yaml-output'),

  // Audit
  manageWriteBadge:     $('manage-write-badge'),
  manageSettingAudit:   $('manage-setting-audit'),
  manageAuditStatus:    $('manage-audit-status'),
  manageAuditOverlay:   $('manage-audit-overlay'),
  manageAuditUsername:  $('manage-audit-username'),
  manageAuditPassword:  $('manage-audit-password'),
  manageAuditError:     $('manage-audit-error'),
  manageAuditCancel:    $('manage-audit-cancel'),
  manageAuditConnect:   $('manage-audit-connect'),
  manageHistoryPane:    $('manage-history-pane'),
  manageHistoryList:    $('manage-history-list'),
  manageHistoryDiff:    $('manage-history-diff'),
  manageHistoryDiffClose: $('manage-history-diff-close'),
  manageHistoryDiffOutput: $('manage-history-diff-output'),

  diffViewTabs:         $('diff-view-tabs'),
  envDiffPane:          $('env-diff-pane'),
  manifestDiffPane:     $('manifest-diff-pane'),
  manifestDiffHideStatus: $('manifest-diff-hide-status'),
  manifestDiffOutput:   $('manifest-diff-output'),
  manifestDiffKind:       $('manifest-diff-kind'),
  manifestDiffLeftNameField:  $('manifest-diff-left-name-field'),
  manifestDiffLeftName:       $('manifest-diff-left-name'),
  manifestDiffRightNameField: $('manifest-diff-right-name-field'),
  manifestDiffRightName:      $('manifest-diff-right-name'),
  manifestDiffExport:         $('manifest-diff-export'),
};

// Kinds offered for Full Manifest diff — namespaced built-in kinds only. Events excluded (a
// single event's manifest isn't meaningful to diff); cluster-scoped kinds excluded because the
// name pickers below are wired to the per-side (context, namespace) already selected for Env Vars.
const MANIFEST_DIFF_KINDS = ['deployments', 'pods', 'statefulsets', 'daemonsets', 'replicasets',
  'services', 'ingresses', 'configmaps', 'secrets', 'jobs', 'cronjobs', 'pvcs', 'hpas',
  'serviceaccounts', 'roles', 'rolebindings', 'networkpolicies', 'resourcequotas', 'limitranges'];

// Self-contained (not MANAGE_KIND_LABEL_PLURAL, which is declared later in this file and would be
// in its temporal dead zone at this point — this runs at top-level script eval, not inside a function).
const MANIFEST_DIFF_KIND_LABELS = {
  deployments: 'Deployment', pods: 'Pod', statefulsets: 'StatefulSet', daemonsets: 'DaemonSet',
  replicasets: 'ReplicaSet', services: 'Service', ingresses: 'Ingress', configmaps: 'ConfigMap',
  secrets: 'Secret', jobs: 'Job', cronjobs: 'CronJob', pvcs: 'PVC', hpas: 'HPA',
  serviceaccounts: 'ServiceAccount', roles: 'Role', rolebindings: 'RoleBinding',
  networkpolicies: 'NetworkPolicy', resourcequotas: 'ResourceQuota', limitranges: 'LimitRange',
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

  if (s.btnUseFile) {
    s.btnUseFile.addEventListener('click', () => {
      // Switch this panel back to file mode
      s.aksField.style.display        = 'none';
      s.kubeconfigField.style.display = '';
      s.contextField.style.display    = '';
      s.selectorGrid.classList.remove('col-3');
      // Reset state and reload from default kubeconfig
      data.kubeconfig = null;
      data.context    = null;
      data.namespace  = null;
      data.deployment = null;
      data.envs       = null;
      s.kubeconfig.value = '';
      loadContexts(side);
    });
  }

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
    setCompareTarget(
      { kubeconfig: l.kubeconfig, context: l.context, namespace: l.namespace, deployment: name },
      inB ? { kubeconfig: r.kubeconfig, context: r.context, namespace: r.namespace, deployment: name } : null
    );
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
    setCompareTarget(
      { kubeconfig: state.left.kubeconfig, context: state.left.context, namespace: state.left.namespace, deployment: state.left.deployment },
      { kubeconfig: state.right.kubeconfig, context: state.right.context, namespace: state.right.namespace, deployment: state.right.deployment }
    );
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
  state.compareTarget = null;
  state.manifest = { leftYaml: null, rightYaml: null, hideStatus: el.manifestDiffHideStatus.checked, key: null, kind: 'deployments', leftName: null, rightName: null };
  resetManifestKindPicker();
  switchDiffTab('env');
});

/* ════════════════════════════════════════════════════════════════════════════
   FULL MANIFEST DIFF TAB (Phase 11) — reuses get-resource-yaml, no new IPC.
   Phase 15 generalizes it beyond Deployments via a kind picker + two name pickers.
   ════════════════════════════════════════════════════════════════════════════ */
MANIFEST_DIFF_KINDS.forEach((k) => {
  const opt = document.createElement('option');
  opt.value = k;
  opt.textContent = MANIFEST_DIFF_KIND_LABELS[k] || k;
  el.manifestDiffKind.appendChild(opt);
});

function resetManifestKindPicker() {
  el.manifestDiffKind.value = 'deployments';
  el.manifestDiffLeftNameField.style.display = 'none';
  el.manifestDiffRightNameField.style.display = 'none';
  el.manifestDiffLeftName.innerHTML = '';
  el.manifestDiffRightName.innerHTML = '';
}

async function populateManifestNamePickers() {
  const target = state.compareTarget;
  const kind = state.manifest.kind;
  if (!target) return;
  const { left, right } = target;

  const [leftResult, rightResult] = await Promise.all([
    window.k8sApi.listResource(left.kubeconfig, left.context, left.namespace, kind),
    right ? window.k8sApi.listResource(right.kubeconfig, right.context, right.namespace, kind) : Promise.resolve({ ok: true, rows: [] }),
  ]);
  if (state.manifest.kind !== kind) return; // kind changed again while this was in flight

  const fill = (selectEl, result, currentName) => {
    selectEl.innerHTML = '';
    const names = result.ok ? result.rows.map((r) => r.name) : [];
    names.forEach((n) => {
      const opt = document.createElement('option');
      opt.value = n;
      opt.textContent = n;
      selectEl.appendChild(opt);
    });
    if (currentName && names.includes(currentName)) selectEl.value = currentName;
    return selectEl.value || null;
  };

  state.manifest.leftName = fill(el.manifestDiffLeftName, leftResult, left.deployment);
  state.manifest.rightName = right ? fill(el.manifestDiffRightName, rightResult, right.deployment) : null;
  el.manifestDiffLeftNameField.style.display = '';
  el.manifestDiffRightNameField.style.display = right ? '' : 'none';
}

el.manifestDiffKind.addEventListener('change', async () => {
  const kind = el.manifestDiffKind.value;
  state.manifest.kind = kind;
  state.manifest.leftName = null;
  state.manifest.rightName = null;
  state.manifest.key = null;
  if (kind === 'deployments') {
    el.manifestDiffLeftNameField.style.display = 'none';
    el.manifestDiffRightNameField.style.display = 'none';
    loadManifestDiff();
    return;
  }
  el.manifestDiffOutput.innerHTML = '<div class="manage-empty">Loading names…</div>';
  await populateManifestNamePickers();
  loadManifestDiff();
});

el.manifestDiffLeftName.addEventListener('change', () => {
  state.manifest.leftName = el.manifestDiffLeftName.value || null;
  state.manifest.key = null;
  loadManifestDiff();
});
el.manifestDiffRightName.addEventListener('change', () => {
  state.manifest.rightName = el.manifestDiffRightName.value || null;
  state.manifest.key = null;
  loadManifestDiff();
});

function setCompareTarget(left, right) {
  state.compareTarget = { left, right };
  state.manifest.leftYaml = null;
  state.manifest.rightYaml = null;
  state.manifest.key = null;
  state.manifest.kind = 'deployments';
  state.manifest.leftName = null;
  state.manifest.rightName = null;
  resetManifestKindPicker();
  if (state.diffTab === 'manifest') loadManifestDiff();
}

el.diffViewTabs.addEventListener('click', (e) => {
  const btn = e.target.closest('.manage-tab');
  if (!btn) return;
  switchDiffTab(btn.dataset.difftab);
});

function switchDiffTab(tab) {
  state.diffTab = tab;
  el.diffViewTabs.querySelectorAll('.manage-tab').forEach((b) => b.classList.toggle('active', b.dataset.difftab === tab));
  el.envDiffPane.style.display = tab === 'env' ? '' : 'none';
  el.manifestDiffPane.style.display = tab === 'manifest' ? 'flex' : 'none';
  if (tab === 'manifest') loadManifestDiff();
}

function compareTargetKey(target) {
  if (!target) return null;
  const { left, right } = target;
  const kind = state.manifest.kind;
  const leftName = kind === 'deployments' ? left?.deployment : state.manifest.leftName;
  const rightName = kind === 'deployments' ? right?.deployment : state.manifest.rightName;
  const side = (s, name) => s ? `${s.kubeconfig || ''}/${s.context}/${s.namespace}/${kind}/${name}` : 'none';
  return `${side(left, leftName)}::${side(right, rightName)}`;
}

async function loadManifestDiff() {
  const target = state.compareTarget;
  if (!target) {
    el.manifestDiffOutput.innerHTML = '<div class="manage-empty">Select deployments and click Compare first.</div>';
    return;
  }
  const kind = state.manifest.kind;
  const { left, right } = target;
  const leftName = kind === 'deployments' ? left.deployment : state.manifest.leftName;
  const rightName = kind === 'deployments' ? (right && right.deployment) : state.manifest.rightName;
  if (kind !== 'deployments' && !leftName) {
    el.manifestDiffOutput.innerHTML = '<div class="manage-empty">Select a name for side A.</div>';
    return;
  }
  const key = compareTargetKey(target);
  if (state.manifest.key === key && state.manifest.leftYaml != null) {
    renderManifestDiff();
    return;
  }
  el.manifestDiffOutput.innerHTML = '<div class="manage-empty">Loading manifests…</div>';
  const leftResult = await window.k8sApi.getResourceYaml(left.kubeconfig, left.context, left.namespace, kind, leftName);
  if (compareTargetKey(state.compareTarget) !== key) return; // comparison changed while in flight
  let rightResult = null;
  if (right && rightName) {
    rightResult = await window.k8sApi.getResourceYaml(right.kubeconfig, right.context, right.namespace, kind, rightName);
    if (compareTargetKey(state.compareTarget) !== key) return;
  }
  state.manifest.key = key;
  state.manifest.leftYaml = leftResult.ok ? leftResult.yaml : `Error: ${leftResult.error}`;
  state.manifest.rightYaml = (right && rightName) ? (rightResult.ok ? rightResult.yaml : `Error: ${rightResult.error}`) : null;
  renderManifestDiff();
}

// Pure text strip of the top-level `status:` block — replica counts/conditions differ constantly
// between clusters and aren't spec drift, so they're noise for a manifest diff by default.
function stripManifestStatus(yaml) {
  return (yaml || '').replace(/\nstatus:\n(?:[ \t].*\n?)*/, '\n');
}

function renderManifestDiff() {
  if (state.manifest.leftYaml == null) return;
  if (state.manifest.rightYaml == null) {
    el.manifestDiffOutput.innerHTML = `<div class="manage-empty">— not present in B —</div><pre class="manifest-diff-single">${highlightYaml(state.manifest.leftYaml)}</pre>`;
    return;
  }
  const hideStatus = el.manifestDiffHideStatus.checked;
  const left = hideStatus ? stripManifestStatus(state.manifest.leftYaml) : state.manifest.leftYaml;
  const right = hideStatus ? stripManifestStatus(state.manifest.rightYaml) : state.manifest.rightYaml;
  const chunks = Diff.diffLines(left, right);
  el.manifestDiffOutput.innerHTML = chunks.map((part) => {
    const cls = part.added ? 'manifest-diff-line-added' : part.removed ? 'manifest-diff-line-removed' : 'manifest-diff-line-same';
    const html = cls === 'manifest-diff-line-same' ? highlightYaml(part.value) : escHtml(part.value);
    return `<div class="manifest-diff-line ${cls}">${html.replace(/\n/g, '<br>')}</div>`;
  }).join('');
}

el.manifestDiffHideStatus.addEventListener('change', () => {
  if (state.manifest.leftYaml != null) renderManifestDiff();
});

el.manifestDiffExport.addEventListener('click', () => {
  if (state.manifest.leftYaml == null) return;
  if (state.manifest.rightYaml == null) {
    downloadTextFile('manifest-diff.diff', state.manifest.leftYaml, 'text/plain');
    return;
  }
  const hideStatus = el.manifestDiffHideStatus.checked;
  const left = hideStatus ? stripManifestStatus(state.manifest.leftYaml) : state.manifest.leftYaml;
  const right = hideStatus ? stripManifestStatus(state.manifest.rightYaml) : state.manifest.rightYaml;
  const chunks = Diff.diffLines(left, right);
  const text = chunks.map((part) => {
    const prefix = part.added ? '+' : part.removed ? '-' : ' ';
    return part.value.replace(/\n$/, '').split('\n').map((line) => `${prefix}${line}`).join('\n');
  }).join('\n');
  downloadTextFile('manifest-diff.diff', text, 'text/plain');
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
  const { rows, totalDiff, totalSame, totalMissing } = computeEnvDiffRows(leftEnvs, rightEnvs, {
    filter: state.filter, search: state.search, maskSecrets: state.maskSecrets,
  });

  el.diffBody.innerHTML = '';
  for (const row of rows) {
    const sourceClass = getSourceClass(row.source);
    const tr = document.createElement('tr');
    tr.className = `row-${row.rowType}`;
    tr.innerHTML = `
      <td class="col-key"><span class="cell-key">${escHtml(row.key)}</span></td>
      <td class="col-source"><span class="source-tag ${sourceClass}">${escHtml(row.sourceLabel)}</span></td>
      <td class="col-a col-value">
        ${row.leftPresent ? `<span class="cell-value">${escHtml(row.leftValue)}</span>` : `<span class="cell-value-missing">— not present —</span>`}
      </td>
      <td class="col-b col-value">
        ${row.rightPresent ? `<span class="cell-value">${escHtml(row.rightValue)}</span>` : `<span class="cell-value-missing">— not present —</span>`}
      </td>
      <td class="col-status">
        <span class="status-pill pill-${row.rowType}">
          ${row.rowType === 'diff' ? 'DIFF' : row.rowType === 'same' ? 'SAME' : 'MISSING'}
        </span>
      </td>
    `;
    el.diffBody.appendChild(tr);
  }

  el.statsEl.textContent = `${rows.length} shown · ${totalDiff} diff · ${totalSame} same · ${totalMissing} missing`;
  el.emptyState.style.display = 'none';
  el.diffTable.style.display  = 'table';
}

el.envDiffExportCsv.addEventListener('click', () => {
  if (!lastEnvs) return;
  const { rows } = computeEnvDiffRows(lastEnvs.left, lastEnvs.right, {
    filter: state.filter, search: state.search, maskSecrets: state.maskSecrets,
  });
  const csv = rowsToCsv(
    ['Key', 'Source', 'A', 'B', 'Status'],
    rows.map((r) => [r.key, r.sourceLabel, r.leftPresent ? r.leftValue : '', r.rightPresent ? r.rightValue : '', r.rowType])
  );
  downloadTextFile('env-diff.csv', csv, 'text/csv');
});

el.envDiffExportJson.addEventListener('click', () => {
  if (!lastEnvs) return;
  const { rows } = computeEnvDiffRows(lastEnvs.left, lastEnvs.right, {
    filter: state.filter, search: state.search, maskSecrets: state.maskSecrets,
  });
  downloadTextFile('env-diff.json', JSON.stringify(rows, null, 2), 'application/json');
});

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

function setStatus(side, msg, type) {
  const s = el[side].status;
  s.textContent = msg;
  s.className   = 'panel-status' + (type ? ` ${type}` : '');
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
  'manage-select':           'home',
  'manage':                  'manage-select',
};

function showView(view) {
  // Sole teardown choke point: leaving the manage workspace always stops its
  // poller and any open log/exec/port-forward stream, so nothing keeps running in the background.
  if (view !== 'manage') {
    stopManagePolling();
    stopManageWatch();
    stopManageMetricsPolling();
    stopManageOverviewPolling();
    stopManageLogs();
    stopManageExec();
    stopAllManagePortForwards();
    clearManageSelection();
    closeManageSearchResults();
  }

  el.homeView.style.display              = view === 'home'                   ? 'flex' : 'none';
  el.clusterSelectView.style.display     = view === 'cluster-select'         ? 'flex' : 'none';
  el.k8sDiffView.style.display           = view === 'k8s-diff'               ? 'flex' : 'none';
  el.storageSelectView.style.display     = view === 'storage-select'         ? 'flex' : 'none';
  el.storageDiffResultView.style.display = view === 'storage-diff-result'    ? 'flex' : 'none';
  el.servicebusSelectView.style.display  = view === 'servicebus-select'      ? 'flex' : 'none';
  el.servicebusResultView.style.display  = view === 'servicebus-diff-result' ? 'flex' : 'none';
  el.manageSelectView.style.display      = view === 'manage-select'          ? 'flex' : 'none';
  el.manageView.style.display            = view === 'manage'                ? 'flex' : 'none';
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

el.cardK8sManage.addEventListener('click', () => {
  showView('manage-select');
  loadManageClusterList();
});

window.addEventListener('beforeunload', () => {
  stopManagePolling();
  stopManageWatch();
  stopManageMetricsPolling();
  stopManageLogs();
  stopManageExec();
  stopAllManagePortForwards();
});

/* ════════════════════════════════════════════════════════════════════════════
   CLUSTER SELECTION — shared picker (K8s Diff picks 2, K8s Manage picks 1)
   ════════════════════════════════════════════════════════════════════════════ */
const clusterDiffPicker = {
  listEl: el.clusterList,
  selected: [],
  maxSelect: 2,
  countEl: el.csCount,
  actionBtn: el.btnCompareClusters,
  countLabel: (n) => `${n} / 2 selected`,
};

const manageClusterPicker = {
  listEl: el.manageClusterList,
  selected: [],
  maxSelect: 1,
  countEl: el.manageCsCount,
  actionBtn: el.btnManageContinue,
  countLabel: (n) => `${n} / 1 selected`,
};

async function loadClusterList() {
  clusterDiffPicker.selected.length = 0;
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
  renderClusterList(result.clusters, clusterDiffPicker);
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

// `picker` carries its own listEl/selected/maxSelect/countEl/actionBtn so the
// same render/toggle/refresh trio serves both the 2-cluster diff picker and the
// 1-cluster manage picker instead of duplicating this UI.
function renderClusterList(clusters, picker) {
  picker.listEl.innerHTML = '';
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
    item.addEventListener('click', () => toggleCluster(item, c, picker));
    picker.listEl.appendChild(item);
  }
}

function toggleCluster(item, cluster, picker) {
  const key = clusterKey(cluster);
  const idx = picker.selected.findIndex((c) => clusterKey(c) === key);
  if (idx >= 0) {
    picker.selected.splice(idx, 1);
  } else {
    if (picker.selected.length >= picker.maxSelect) {
      if (picker.maxSelect !== 1) return;
      picker.selected.length = 0; // single-select: picking a new item replaces the old one
    }
    picker.selected.push(cluster);
  }
  refreshClusterSelectionUI(picker);
}

function refreshClusterSelectionUI(picker) {
  const maxReached = picker.selected.length >= picker.maxSelect;
  picker.listEl.querySelectorAll('.cluster-item').forEach((item) => {
    const idx = picker.selected.findIndex((c) => clusterKey(c) === item.dataset.key);
    const badge = item.querySelector('.ci-badge');
    item.classList.remove('ci-selected-a', 'ci-selected-b', 'ci-max-reached');
    badge.style.visibility = 'hidden';
    if (idx === 0) {
      item.classList.add('ci-selected-a');
      if (picker.maxSelect > 1) {
        badge.textContent = 'A';
        badge.style.visibility = '';
      }
    } else if (idx === 1) {
      item.classList.add('ci-selected-b');
      badge.textContent = 'B';
      badge.style.visibility = '';
    } else if (maxReached && picker.maxSelect > 1) {
      item.classList.add('ci-max-reached');
    }
  });
  picker.countEl.textContent = picker.countLabel(picker.selected.length);
  picker.actionBtn.disabled = picker.selected.length !== picker.maxSelect;
}

el.btnCompareClusters.addEventListener('click', async () => {
  const [a, b] = clusterDiffPicker.selected;
  if (clusterDiffPicker.selected.length !== 2) return;
  el.btnCompareClusters.disabled = true;

  try {
    showLoading(`Getting credentials for ${a.name}…`);
    const credA = await window.k8sApi.getAksCredentials(a.name, a.resourceGroup);
    if (!credA.ok) throw new Error(`Cannot get credentials for ${a.name}: ${credA.error}`);

    showLoading(`Getting credentials for ${b.name}…`);
    const credB = await window.k8sApi.getAksCredentials(b.name, b.resourceGroup);
    if (!credB.ok) throw new Error(`Cannot get credentials for ${b.name}: ${credB.error}`);

    hideLoading();
    await initAksPanels(
      { ...a, kubeconfigId: credA.kubeconfigId },
      { ...b, kubeconfigId: credB.kubeconfigId }
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
// Shared by Storage and ServiceBus diff: union of item names across all accounts/namespaces,
// each with a per-account/namespace presence boolean. Used by both the on-screen table render
// and CSV/JSON export, so the two can never drift apart.
function buildPresenceMatrix(results, itemsKey) {
  const allItems = new Set();
  for (const r of results) {
    for (const item of r[itemsKey]) allItems.add(item);
  }
  return Array.from(allItems).sort().map((item) => ({
    item,
    presence: results.map((r) => r[itemsKey].includes(item)),
  }));
}

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
  state.storageDiffResults = results;
  const matrix = buildPresenceMatrix(results, 'containers');
  const sorted = matrix.map((m) => m.item);

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

  for (const { item: container, presence } of matrix) {
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

el.sdrExportCsv.addEventListener('click', () => {
  const results = state.storageDiffResults;
  if (!results) return;
  const matrix = buildPresenceMatrix(results, 'containers');
  const headers = ['Container', ...results.map((r) => r.name), 'Status'];
  const rows = matrix.map(({ item, presence }) => [
    item,
    ...presence.map((p, i) => (results[i].ok ? (p ? 'yes' : 'no') : 'ERROR')),
    presence.every(Boolean) ? 'ALL' : 'PARTIAL',
  ]);
  downloadTextFile('storage-diff.csv', rowsToCsv(headers, rows), 'text/csv');
});

el.sdrExportJson.addEventListener('click', () => {
  const results = state.storageDiffResults;
  if (!results) return;
  const matrix = buildPresenceMatrix(results, 'containers');
  const out = matrix.map(({ item, presence }) => ({
    container: item,
    presence: Object.fromEntries(results.map((r, i) => [r.name, r.ok ? presence[i] : null])),
    status: presence.every(Boolean) ? 'ALL' : 'PARTIAL',
  }));
  downloadTextFile('storage-diff.json', JSON.stringify(out, null, 2), 'application/json');
});

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
  state.serviceBusDiffResults = results;
  const matrix = buildPresenceMatrix(results, 'queues');
  const sorted = matrix.map((m) => m.item);

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

  for (const { item: queue, presence } of matrix) {
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

el.sbdrExportCsv.addEventListener('click', () => {
  const results = state.serviceBusDiffResults;
  if (!results) return;
  const matrix = buildPresenceMatrix(results, 'queues');
  const headers = ['Queue', ...results.map((r) => r.name), 'Status'];
  const rows = matrix.map(({ item, presence }) => [
    item,
    ...presence.map((p, i) => (results[i].ok ? (p ? 'yes' : 'no') : 'ERROR')),
    presence.every(Boolean) ? 'ALL' : 'PARTIAL',
  ]);
  downloadTextFile('servicebus-diff.csv', rowsToCsv(headers, rows), 'text/csv');
});

el.sbdrExportJson.addEventListener('click', () => {
  const results = state.serviceBusDiffResults;
  if (!results) return;
  const matrix = buildPresenceMatrix(results, 'queues');
  const out = matrix.map(({ item, presence }) => ({
    queue: item,
    presence: Object.fromEntries(results.map((r, i) => [r.name, r.ok ? presence[i] : null])),
    status: presence.every(Boolean) ? 'ALL' : 'PARTIAL',
  }));
  downloadTextFile('servicebus-diff.json', JSON.stringify(out, null, 2), 'application/json');
});

/* ════════════════════════════════════════════════════════════════════════════
   K8S MANAGE — entry flow (cluster picker → context/namespace)
   ════════════════════════════════════════════════════════════════════════════ */
async function loadManageClusterList() {
  manageClusterPicker.selected.length = 0;
  el.manageClusterList.innerHTML = '<div class="cs-loading">Loading clusters…</div>';
  el.manageCsCount.textContent = '0 / 1 selected';
  el.btnManageContinue.disabled = true;

  showLoading('Fetching AKS clusters…');
  const result = await window.k8sApi.listAksClusters();
  hideLoading();

  if (!result.ok) {
    el.manageClusterList.innerHTML = `<div class="cs-error">Failed to load clusters:<br>${escHtml(result.error)}</div>`;
    return;
  }
  if (result.clusters.length === 0) {
    el.manageClusterList.innerHTML = '<div class="cs-empty">No clusters found with tag <code>diff=true</code></div>';
    return;
  }
  renderClusterList(result.clusters, manageClusterPicker);
}

el.btnManageUseLocal.addEventListener('click', () => enterManageWorkspace(null));

el.btnManageContinue.addEventListener('click', async () => {
  if (manageClusterPicker.selected.length !== 1) return;
  const cluster = manageClusterPicker.selected[0];
  el.btnManageContinue.disabled = true;

  try {
    showLoading(`Getting credentials for ${cluster.name}…`);
    const cred = await window.k8sApi.getAksCredentials(cluster.name, cluster.resourceGroup);
    if (!cred.ok) throw new Error(`Cannot get credentials for ${cluster.name}: ${cred.error}`);
    hideLoading();
    await enterManageWorkspace(cred.kubeconfigId);
  } catch (e) {
    hideLoading();
    alert(e.message);
    el.btnManageContinue.disabled = false;
  }
});

async function enterManageWorkspace(kubeconfigRef) {
  const data = state.manage;
  data.kubeconfig = kubeconfigRef;
  data.context = null;
  data.namespace = null;
  data.resourceType = 'overview';
  data.mode = 'kind';
  data.crds = [];
  data.activeCrd = null;
  data.rows = [];
  data.selected = null;
  clearManageSelection();

  el.manageSidebar.querySelectorAll('.manage-nav-item').forEach((b) => b.classList.toggle('active', b.dataset.kind === 'overview'));
  el.manageCrdList.innerHTML = '';
  el.manageContext.innerHTML = '<option value="">— select context —</option>';
  el.manageNamespace.innerHTML = '<option value="">— select namespace —</option>';
  el.manageNamespace.disabled = true;
  el.manageSearch.value = '';
  el.manageOverviewPane.style.display = 'flex';
  el.manageTableWrap.style.display = 'none';
  el.manageKindTitle.style.display = 'none';
  closeManageDrawer();
  closeManageSearchResults();

  showView('manage');
  el.btnManageContinue.disabled = false;
  initAuditOnStartup(); // async — doesn't block context loading
  await loadManageContexts();
}

async function loadManageContexts() {
  const data = state.manage;
  try {
    showLoading('Loading contexts…');
    const contexts = await window.k8sApi.loadContexts(data.kubeconfig);
    populateSelect(el.manageContext, contexts, '— select context —');
    el.manageContext.disabled = contexts.length === 0;
    if (contexts.length === 1) {
      el.manageContext.value = contexts[0];
      data.context = contexts[0];
      loadManageCrds();
      if (data.resourceType === 'overview') startManageOverviewPolling();
      else if (data.resourceType === 'recyclebin') loadRecycleBin();
      await loadManageNamespaces();
    }
  } catch (e) {
    alert(`Failed to load contexts: ${e.message}`);
  } finally {
    hideLoading();
  }
}

async function loadManageNamespaces() {
  const data = state.manage;
  try {
    showLoading('Loading namespaces…');
    const ns = await window.k8sApi.loadNamespaces(data.kubeconfig, data.context);
    populateSelect(el.manageNamespace, ns, '— select namespace —');
    const allOpt = document.createElement('option');
    allOpt.value = MANAGE_ALL_NAMESPACES;
    allOpt.textContent = '(All namespaces)';
    el.manageNamespace.firstElementChild.after(allOpt);
    el.manageNamespace.disabled = false;

    const defaultNs = ns.includes('brand') ? 'brand' : (ns.length === 1 ? ns[0] : null);
    if (defaultNs) {
      el.manageNamespace.value = defaultNs;
      data.namespace = defaultNs;
      if (data.resourceType === 'recyclebin') {
        loadRecycleBin();
      } else if (data.resourceType !== 'overview') {
        startManageLiveUpdates(data.resourceType, data.namespace);
        startManageMetricsPolling();
      }
    }
  } catch (e) {
    alert(`Failed to load namespaces: ${e.message}`);
  } finally {
    hideLoading();
  }
}

el.manageContext.addEventListener('change', async () => {
  const data = state.manage;
  data.context = el.manageContext.value || null;
  data.namespace = null;
  el.manageNamespace.innerHTML = '<option value="">— select namespace —</option>';
  el.manageNamespace.disabled = true;
  stopManagePolling();
  stopManageWatch();
  stopManageMetricsPolling();
  stopManageOverviewPolling();
  _clearManageRowsCache();
  closeManageDrawer();
  closeManageSearchResults();
  data.crds = [];
  data.activeCrd = null;
  el.manageCrdList.innerHTML = '';
  if (data.resourceType === 'overview') {
    el.manageOverviewPane.innerHTML = '';
  } else if (data.resourceType === 'recyclebin') {
    el.manageRecyclebinList.innerHTML = '';
  } else {
    renderManageTable(data.resourceType, []);
  }
  if (data.context) {
    loadManageCrds();
    if (data.resourceType === 'overview') startManageOverviewPolling();
    else if (data.resourceType === 'recyclebin') loadRecycleBin();
    await loadManageNamespaces();
  }
  syncEventCaptureToBackend();
});

el.manageNamespace.addEventListener('change', () => {
  const data = state.manage;
  data.namespace = el.manageNamespace.value || null;
  stopManagePolling();
  stopManageWatch();
  stopManageMetricsPolling();
  _clearManageRowsCache();
  closeManageDrawer();
  if (data.resourceType === 'recyclebin') {
    loadRecycleBin();
  } else if (data.namespace) {
    startManageLiveUpdates(data.resourceType, data.namespace);
    startManageMetricsPolling();
  } else {
    renderManageTable(data.resourceType, []);
  }
  syncEventCaptureToBackend();
});

let _manageSearchTimer;
el.manageSearch.addEventListener('input', () => {
  clearTimeout(_manageSearchTimer);
  _manageSearchTimer = setTimeout(() => {
    if (!isManageSpecialView(state.manage.resourceType)) renderManageTable(state.manage.resourceType, state.manage.rows);
  }, 150);
});
el.manageBtnRefresh.addEventListener('click', () => refreshManageResources());

/* ════════════════════════════════════════════════════════════════════════════
   K8S MANAGE — Settings (gear popover, menu visibility, localStorage)
   ════════════════════════════════════════════════════════════════════════════ */

const MANAGE_SETTINGS_KEY = 'k8s-manage-settings';

// Group definitions: maps group name → array of kind keys
const MANAGE_SETTINGS_GROUPS = {
  workloads: ['pods','deployments','statefulsets','daemonsets','replicasets','jobs','cronjobs',
              'services','ingresses','configmaps','secrets','hpas','nodes','pvs','namespaces','events'],
  rbac: ['serviceaccounts','roles','rolebindings','clusterroles','clusterrolebindings'],
  policy: ['networkpolicies','storageclasses','resourcequotas','limitranges','pvcs'],
  crd: ['_crd'],
};

// ── localStorage persistence ──────────────────────────────────────────────────

function loadManageSettings() {
  try {
    const raw = localStorage.getItem(MANAGE_SETTINGS_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (saved.menuVisibility) {
      // Merge with defaults so newly added kinds get their default value
      Object.assign(state.manage.menuVisibility, saved.menuVisibility);
    }
    if (typeof saved.enableMetrics === 'boolean') state.manage.enableMetrics = saved.enableMetrics;
    if (typeof saved.enableAutoRefresh === 'boolean') state.manage.enableAutoRefresh = saved.enableAutoRefresh;
    if (typeof saved.enableEventCapture === 'boolean') state.manage.enableEventCapture = saved.enableEventCapture;
    if (typeof saved.eventRetention === 'number') state.manage.eventRetention = saved.eventRetention;
    if (typeof saved.auditEnabled === 'boolean') state.manage.auditEnabled = saved.auditEnabled;
  } catch { /* corrupted localStorage — use defaults */ }
}

function saveManageSettings() {
  try {
    localStorage.setItem(MANAGE_SETTINGS_KEY, JSON.stringify({
      menuVisibility: state.manage.menuVisibility,
      enableMetrics: state.manage.enableMetrics,
      enableAutoRefresh: state.manage.enableAutoRefresh,
      enableEventCapture: state.manage.enableEventCapture,
      eventRetention: state.manage.eventRetention,
      auditEnabled: state.manage.auditEnabled,
    }));
  } catch { /* quota exceeded — silently ignore */ }
}

// ── Audit credential persistence (plaintext localStorage) ────────────────────
const MANAGE_AUDIT_CREDS_KEY = 'k8s-manage-audit-creds';

function loadAuditCreds() {
  try {
    const raw = localStorage.getItem(MANAGE_AUDIT_CREDS_KEY);
    if (!raw) return null;
    const creds = JSON.parse(raw);
    if (creds.username && creds.password) return creds;
  } catch { /* ignore */ }
  return null;
}

function saveAuditCreds(username, password) {
  try {
    localStorage.setItem(MANAGE_AUDIT_CREDS_KEY, JSON.stringify({ username, password }));
  } catch { /* ignore */ }
}

function clearAuditCreds() {
  try { localStorage.removeItem(MANAGE_AUDIT_CREDS_KEY); } catch { /* ignore */ }
}

// Load settings immediately on startup
loadManageSettings();

// ── Sync checkboxes in popover to match state ─────────────────────────────────

function syncSettingsPopoverToState() {
  // Performance checkboxes
  el.manageSettingMetrics.checked = state.manage.enableMetrics;
  el.manageSettingAutoRefresh.checked = state.manage.enableAutoRefresh;
  el.manageSettingEventCapture.checked = state.manage.enableEventCapture;
  el.manageSettingEventRetention.value = state.manage.eventRetention;

  // Menu item checkboxes
  const vis = state.manage.menuVisibility;
  el.manageSettingsPopover.querySelectorAll('[data-settings-menu]').forEach((cb) => {
    cb.checked = !!vis[cb.dataset.settingsMenu];
  });

  // Group checkboxes (tri-state)
  for (const [group, kinds] of Object.entries(MANAGE_SETTINGS_GROUPS)) {
    const groupCb = el.manageSettingsPopover.querySelector(`[data-settings-group="${group}"]`);
    if (!groupCb) continue;
    const onCount = kinds.filter((k) => vis[k]).length;
    groupCb.checked = onCount === kinds.length;
    groupCb.indeterminate = onCount > 0 && onCount < kinds.length;
  }
}

// ── Apply menu visibility to sidebar DOM ──────────────────────────────────────

// Map each divider text to the group key for show/hide logic
const MANAGE_DIVIDER_GROUP = {
  'Workloads': 'workloads',
  'RBAC': 'rbac',
  'Policy & Storage': 'policy',
  'Custom Resources': 'crd',
};

function applyMenuVisibility() {
  const vis = state.manage.menuVisibility;

  // Show/hide individual nav items
  el.manageSidebar.querySelectorAll('.manage-nav-item[data-kind]').forEach((btn) => {
    const kind = btn.dataset.kind;
    if (isManageSpecialView(kind)) return; // Overview / Recycle Bin are always visible
    btn.style.display = vis[kind] ? '' : 'none';
  });

  // Show/hide group dividers — hide if ALL items in the group are hidden
  el.manageSidebar.querySelectorAll('.manage-nav-divider').forEach((div) => {
    const groupKey = MANAGE_DIVIDER_GROUP[div.textContent.trim()];
    if (!groupKey) return;
    const kinds = MANAGE_SETTINGS_GROUPS[groupKey] || [];
    const anyVisible = kinds.some((k) => k === '_crd' ? vis._crd : vis[k]);
    div.style.display = anyVisible ? '' : 'none';
  });

  // Show/hide Custom Resources CRD filter + list
  const crdVisible = vis._crd;
  const crdFilter = el.manageSidebar.querySelector('#manage-crd-filter');
  const crdList = el.manageSidebar.querySelector('#manage-crd-list');
  if (crdFilter) crdFilter.style.display = crdVisible ? '' : 'none';
  if (crdList) crdList.style.display = crdVisible ? '' : 'none';

  // If the currently active kind was just hidden → redirect to overview
  const data = state.manage;
  if (data.mode === 'kind' && !isManageSpecialView(data.resourceType)) {
    if (!vis[data.resourceType]) {
      selectManageKind('overview');
    }
  } else if (data.mode === 'crd' && !vis._crd) {
    selectManageKind('overview');
  }
}

// ── Popover toggle ────────────────────────────────────────────────────────────

el.manageSettingsBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  const popover = el.manageSettingsPopover;
  const isOpen = popover.style.display !== 'none';
  if (isOpen) {
    popover.style.display = 'none';
  } else {
    syncSettingsPopoverToState();
    popover.style.display = '';
  }
});

// Close popover on click outside
document.addEventListener('click', (e) => {
  if (el.manageSettingsPopover.style.display === 'none') return;
  if (el.manageSettingsPopover.contains(e.target) || el.manageSettingsBtn.contains(e.target)) return;
  el.manageSettingsPopover.style.display = 'none';
});

// Prevent popover clicks from bubbling to sidebar nav delegation
el.manageSettingsPopover.addEventListener('click', (e) => e.stopPropagation());

// ── Menu item checkbox handlers ───────────────────────────────────────────────

el.manageSettingsPopover.addEventListener('change', (e) => {
  const target = e.target;

  // Individual item checkbox
  if (target.dataset.settingsMenu) {
    const kind = target.dataset.settingsMenu;
    state.manage.menuVisibility[kind] = target.checked;
    // Update parent group checkbox state
    for (const [group, kinds] of Object.entries(MANAGE_SETTINGS_GROUPS)) {
      if (kinds.includes(kind)) {
        const groupCb = el.manageSettingsPopover.querySelector(`[data-settings-group="${group}"]`);
        if (groupCb) {
          const onCount = kinds.filter((k) => state.manage.menuVisibility[k]).length;
          groupCb.checked = onCount === kinds.length;
          groupCb.indeterminate = onCount > 0 && onCount < kinds.length;
        }
        break;
      }
    }
    applyMenuVisibility();
    saveManageSettings();
    return;
  }

  // Group checkbox
  if (target.dataset.settingsGroup) {
    const group = target.dataset.settingsGroup;
    const kinds = MANAGE_SETTINGS_GROUPS[group] || [];
    const checked = target.checked;
    target.indeterminate = false;
    for (const kind of kinds) {
      state.manage.menuVisibility[kind] = checked;
      const itemCb = el.manageSettingsPopover.querySelector(`[data-settings-menu="${kind}"]`);
      if (itemCb) itemCb.checked = checked;
    }
    applyMenuVisibility();
    saveManageSettings();
    return;
  }
});

// ── Performance setting handlers ──────────────────────────────────────────────

el.manageSettingMetrics.addEventListener('change', () => {
  const enabled = el.manageSettingMetrics.checked;
  state.manage.enableMetrics = enabled;
  if (!enabled) {
    stopManageMetricsPolling();
    const activeTab = el.manageDrawer.querySelector('.manage-tab.active');
    if (activeTab && activeTab.dataset.tab === 'metrics') {
      switchManageTab('detail');
    }
  } else {
    if (state.manage.enableAutoRefresh && state.manage.context && state.manage.namespace) {
      startManageMetricsPolling();
    }
  }
  const drawerOpen = el.manageDrawer.classList.contains('open');
  if (drawerOpen && state.manage.selected) {
    const metricsTabBtn = el.manageDrawer.querySelector('.manage-tab[data-tab="metrics"]');
    if (metricsTabBtn) {
      const isMetricsKind = state.manage.mode === 'kind' && MANAGE_METRICS_KINDS.includes(state.manage.resourceType) && enabled;
      metricsTabBtn.style.display = isMetricsKind ? '' : 'none';
    }
  }
  if (!isManageSpecialView(state.manage.resourceType)) {
    renderManageTable(state.manage.resourceType, state.manage.rows);
  }
  saveManageSettings();
});

el.manageSettingAutoRefresh.addEventListener('change', () => {
  const enabled = el.manageSettingAutoRefresh.checked;
  state.manage.enableAutoRefresh = enabled;
  if (!enabled) {
    stopManagePolling();
    stopManageMetricsPolling();
    stopManageOverviewPolling();
  } else {
    if (state.manage.context && state.manage.namespace) {
      if (state.manage.resourceType === 'overview') {
        startManageOverviewPolling();
      } else if (state.manage.resourceType === 'recyclebin') {
        loadRecycleBin();
      } else {
        startManagePolling();
        startManageMetricsPolling();
      }
    }
  }
  saveManageSettings();
});

// Sync event capture settings to backend
async function syncEventCaptureToBackend() {
  const data = state.manage;
  if (!data.context) return;
  
  try {
    await window.k8sApi.toggleEventCapture({
      enabled: data.enableEventCapture,
      ref: data.kubeconfig,
      contextName: data.context,
      namespace: data.namespace || '',
      retentionDays: data.eventRetention
    });
  } catch (err) {
    console.error('Failed to sync event capture settings to backend:', err);
  }
}

el.manageSettingEventCapture.addEventListener('change', async () => {
  state.manage.enableEventCapture = el.manageSettingEventCapture.checked;
  saveManageSettings();
  await syncEventCaptureToBackend();
});

el.manageSettingEventRetention.addEventListener('change', async () => {
  state.manage.eventRetention = Number(el.manageSettingEventRetention.value) || 0;
  saveManageSettings();
  if (state.manage.enableEventCapture) {
    await window.k8sApi.setEventRetention({ retentionDays: state.manage.eventRetention });
  }
});

el.manageSettingEventClear.addEventListener('click', async () => {
  const confirmClear = confirm("Are you sure you want to clear the local events database for the current cluster?");
  if (confirmClear) {
    try {
      const result = await window.k8sApi.clearEventDb();
      if (result.ok) {
        alert(`Successfully cleared event database.`);
        // Reload events if drawer is open on events tab
        const activeTab = el.manageDrawer.querySelector('.manage-tab.active');
        if (activeTab && activeTab.dataset.tab === 'events') {
          loadManageEvents();
        }
      } else {
        alert(`Error clearing database: ${result.error}`);
      }
    } catch (err) {
      alert(`Error: ${err.message}`);
    }
  }
});

// Apply visibility on startup
applyMenuVisibility();

// ── Audit toggle + credential overlay + write-gate ────────────────────────────

function updateWriteGate() {
  const data = state.manage;
  data.writeUnlocked = data.auditEnabled && data.auditConnected;
  // Badge
  if (data.writeUnlocked) {
    el.manageWriteBadge.textContent = '🔓 Write enabled';
    el.manageWriteBadge.className = 'manage-write-badge connected';
  } else {
    el.manageWriteBadge.textContent = '🔒 Read-only';
    el.manageWriteBadge.className = 'manage-write-badge';
  }
  // Re-render drawer actions/YAML edit gate if drawer is open
  if (data.selected) {
    const kind = data.mode === 'crd' ? (data.activeCrd?.name || '') : data.resourceType;
    renderManageDrawerActions(kind, data.selected);
    renderManageYamlEditGate();
  }
  // Refresh Recycle Bin if it's the active view — its "Enable Audit…" empty state and
  // Restore-button disabled state both depend on this gate.
  if (data.resourceType === 'recyclebin') loadRecycleBin();
}

function showAuditStatus(text, type) {
  el.manageAuditStatus.textContent = text;
  el.manageAuditStatus.className = `manage-audit-status ${type || ''}`;
  el.manageAuditStatus.style.display = text ? '' : 'none';
}

function showAuditOverlay() {
  return new Promise((resolve) => {
    el.manageAuditOverlay.style.display = 'flex';
    el.manageAuditError.style.display = 'none';
    el.manageAuditUsername.value = '';
    el.manageAuditPassword.value = '';
    const creds = loadAuditCreds();
    if (creds) {
      el.manageAuditUsername.value = creds.username;
      el.manageAuditPassword.value = creds.password;
    }
    el.manageAuditUsername.focus();

    const cleanup = (result) => {
      el.manageAuditOverlay.style.display = 'none';
      el.manageAuditConnect.onclick = null;
      el.manageAuditCancel.onclick = null;
      resolve(result);
    };

    el.manageAuditCancel.onclick = () => cleanup(null);
    el.manageAuditConnect.onclick = async () => {
      const user = el.manageAuditUsername.value.trim();
      const pw = el.manageAuditPassword.value;
      if (!user || !pw) {
        el.manageAuditError.textContent = 'Username and password are required';
        el.manageAuditError.style.display = '';
        return;
      }
      el.manageAuditConnect.disabled = true;
      el.manageAuditConnect.textContent = 'Connecting…';
      el.manageAuditError.style.display = 'none';
      try {
        const result = await window.k8sApi.connectAuditDb(user, pw);
        if (result.ok) {
          saveAuditCreds(user, pw);
          cleanup(result);
        } else {
          el.manageAuditError.textContent = result.error || 'Connection failed';
          el.manageAuditError.style.display = '';
        }
      } catch (e) {
        el.manageAuditError.textContent = e.message;
        el.manageAuditError.style.display = '';
      } finally {
        el.manageAuditConnect.disabled = false;
        el.manageAuditConnect.textContent = 'Connect';
      }
    };
  });
}

async function connectAuditWithSavedCreds() {
  const creds = loadAuditCreds();
  if (!creds) return false;
  try {
    const result = await window.k8sApi.connectAuditDb(creds.username, creds.password);
    if (result.ok) {
      state.manage.auditConnected = true;
      state.manage.auditServer = result.server;
      state.manage.auditDatabase = result.database;
      showAuditStatus(`✓ Connected to ${result.server}`, 'connected');
      updateWriteGate();
      return true;
    }
  } catch { /* ignore */ }
  clearAuditCreds();
  showAuditStatus('Auto-connect failed — click to reconfigure', 'error');
  return false;
}

async function handleAuditToggle(enabled) {
  state.manage.auditEnabled = enabled;
  saveManageSettings();

  if (!enabled) {
    // Disconnect
    state.manage.auditConnected = false;
    state.manage.auditServer = null;
    state.manage.auditDatabase = null;
    showAuditStatus('', '');
    updateWriteGate();
    try { await window.k8sApi.disconnectAuditDb(); } catch { /* ignore */ }
    return;
  }

  // Try auto-connect with saved creds
  const ok = await connectAuditWithSavedCreds();
  if (ok) return;

  // Show credential overlay
  const result = await showAuditOverlay();
  if (!result) {
    // User cancelled — uncheck
    state.manage.auditEnabled = false;
    el.manageSettingAudit.checked = false;
    saveManageSettings();
    updateWriteGate();
    return;
  }

  state.manage.auditConnected = true;
  state.manage.auditServer = result.server;
  state.manage.auditDatabase = result.database;
  showAuditStatus(`✓ Connected to ${result.server}`, 'connected');
  updateWriteGate();
}

el.manageSettingAudit.addEventListener('change', () => {
  handleAuditToggle(el.manageSettingAudit.checked);
});

// Auto-init audit on app startup if previously enabled
async function initAuditOnStartup() {
  if (!state.manage.auditEnabled) {
    updateWriteGate();
    return;
  }
  el.manageSettingAudit.checked = true;
  showAuditStatus('Connecting…', '');
  const ok = await connectAuditWithSavedCreds();
  if (!ok) {
    showAuditStatus('Saved credentials expired — open Settings to reconnect', 'error');
  }
}
// Defer to after app init — called in the manage-enter flow

/* ════════════════════════════════════════════════════════════════════════════
   K8S MANAGE — Resizable columns (sidebar ↔ main ↔ drawer)
   ════════════════════════════════════════════════════════════════════════════ */

(function initManageResize() {
  const sidebarHandle = $('manage-resize-sidebar');
  const drawerHandle = $('manage-resize-drawer');
  const sidebar = el.manageSidebar;
  const drawer = el.manageDrawer;

  const SIDEBAR_MIN = 120, SIDEBAR_MAX = 350;
  const DRAWER_MIN = 250, DRAWER_MAX = 700;

  function startDrag(handle, onMove) {
    handle.classList.add('active');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const moveHandler = (e) => {
      e.preventDefault();
      onMove(e);
    };
    const upHandler = () => {
      handle.classList.remove('active');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', moveHandler);
      document.removeEventListener('mouseup', upHandler);
    };
    document.addEventListener('mousemove', moveHandler);
    document.addEventListener('mouseup', upHandler);
  }

  // Sidebar resize
  sidebarHandle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const viewRect = el.manageView.getBoundingClientRect();
    startDrag(sidebarHandle, (moveEvt) => {
      const newWidth = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, moveEvt.clientX - viewRect.left));
      sidebar.style.width = newWidth + 'px';
    });
  });

  // Drawer resize (drag left to widen, right to narrow)
  drawerHandle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const viewRect = el.manageView.getBoundingClientRect();
    startDrag(drawerHandle, (moveEvt) => {
      const newWidth = Math.min(DRAWER_MAX, Math.max(DRAWER_MIN, viewRect.right - moveEvt.clientX));
      drawer.style.width = newWidth + 'px';
    });
  });
})();

/* ════════════════════════════════════════════════════════════════════════════
   K8S MANAGE — resource table + polling
   ════════════════════════════════════════════════════════════════════════════ */

// Sentinel sent to main.js as the `namespace` arg to browse a kind across every namespace.
// Must match ALL_NAMESPACES in main.js exactly — the two processes don't share a module.
const MANAGE_ALL_NAMESPACES = '__all__';

// Ignore whatever namespace is selected — always listed cluster-wide (mirrors main.js).
const MANAGE_CLUSTER_SCOPED_KINDS = ['nodes', 'pvs', 'namespaces', 'clusterroles', 'clusterrolebindings', 'storageclasses'];

// Per-row operations (YAML, events, logs, exec, actions, port-forward) must target the row's own
// namespace when browsing all-namespaces, since the header namespace is just the sentinel there.
function manageRowNamespace(row) {
  return state.manage.namespace === MANAGE_ALL_NAMESPACES ? (row.namespace || '') : state.manage.namespace;
}

function isSameResource(r1, r2) {
  if (!r1 || !r2) return false;
  return r1.name === r2.name && (r1.namespace || '') === (r2.namespace || '');
}

const MANAGE_COLUMN_DEFS = {
  pods: [
    { key: 'name', label: 'Name' },
    { key: 'ready', label: 'Ready' },
    { key: 'status', label: 'Status', status: true },
    { key: 'restarts', label: 'Restarts' },
    { key: 'node', label: 'Node' },
    { key: 'cpu', label: 'CPU', spark: 'cpu' },
    { key: 'mem', label: 'Memory', spark: 'mem' },
    { key: 'age', label: 'Age', age: true },
  ],
  deployments: [
    { key: 'name', label: 'Name' },
    { key: 'ready', label: 'Ready' },
    { key: 'upToDate', label: 'Up-to-date' },
    { key: 'available', label: 'Available' },
    { key: 'age', label: 'Age', age: true },
  ],
  statefulsets: [
    { key: 'name', label: 'Name' },
    { key: 'ready', label: 'Ready' },
    { key: 'age', label: 'Age', age: true },
  ],
  daemonsets: [
    { key: 'name', label: 'Name' },
    { key: 'desired', label: 'Desired' },
    { key: 'current', label: 'Current' },
    { key: 'ready', label: 'Ready' },
    { key: 'age', label: 'Age', age: true },
  ],
  replicasets: [
    { key: 'name', label: 'Name' },
    { key: 'desired', label: 'Desired' },
    { key: 'current', label: 'Current' },
    { key: 'ready', label: 'Ready' },
    { key: 'age', label: 'Age', age: true },
  ],
  services: [
    { key: 'name', label: 'Name' },
    { key: 'type', label: 'Type' },
    { key: 'clusterIp', label: 'Cluster IP' },
    { key: 'externalIp', label: 'External IP' },
    { key: 'ports', label: 'Ports' },
    { key: 'age', label: 'Age', age: true },
  ],
  ingresses: [
    { key: 'name', label: 'Name' },
    { key: 'class', label: 'Class' },
    { key: 'hosts', label: 'Hosts' },
    { key: 'address', label: 'Address' },
    { key: 'age', label: 'Age', age: true },
  ],
  configmaps: [
    { key: 'name', label: 'Name' },
    { key: 'keys', label: 'Keys' },
    { key: 'age', label: 'Age', age: true },
  ],
  secrets: [
    { key: 'name', label: 'Name' },
    { key: 'type', label: 'Type' },
    { key: 'keys', label: 'Keys' },
    { key: 'age', label: 'Age', age: true },
  ],
  jobs: [
    { key: 'name', label: 'Name' },
    { key: 'completions', label: 'Completions' },
    { key: 'age', label: 'Age', age: true },
  ],
  cronjobs: [
    { key: 'name', label: 'Name' },
    { key: 'schedule', label: 'Schedule' },
    { key: 'suspend', label: 'Suspend' },
    { key: 'active', label: 'Active' },
    { key: 'lastSchedule', label: 'Last Schedule', age: true },
    { key: 'age', label: 'Age', age: true },
  ],
  pvcs: [
    { key: 'name', label: 'Name' },
    { key: 'status', label: 'Status', status: true },
    { key: 'volume', label: 'Volume' },
    { key: 'capacity', label: 'Capacity' },
    { key: 'storageClass', label: 'Storage Class' },
    { key: 'age', label: 'Age', age: true },
  ],
  hpas: [
    { key: 'name', label: 'Name' },
    { key: 'reference', label: 'Reference' },
    { key: 'minPods', label: 'Min Pods' },
    { key: 'maxPods', label: 'Max Pods' },
    { key: 'replicas', label: 'Replicas' },
    { key: 'age', label: 'Age', age: true },
  ],
  nodes: [
    { key: 'name', label: 'Name' },
    { key: 'status', label: 'Status', status: true },
    { key: 'roles', label: 'Roles' },
    { key: 'version', label: 'Version' },
    { key: 'cpu', label: 'CPU', spark: 'cpu' },
    { key: 'mem', label: 'Memory', spark: 'mem' },
    { key: 'age', label: 'Age', age: true },
  ],
  pvs: [
    { key: 'name', label: 'Name' },
    { key: 'capacity', label: 'Capacity' },
    { key: 'status', label: 'Status', status: true },
    { key: 'claim', label: 'Claim' },
    { key: 'storageClass', label: 'Storage Class' },
    { key: 'age', label: 'Age', age: true },
  ],
  namespaces: [
    { key: 'name', label: 'Name' },
    { key: 'status', label: 'Status', status: true },
    { key: 'age', label: 'Age', age: true },
  ],
  events: [
    { key: 'type', label: 'Type' },
    { key: 'reason', label: 'Reason' },
    { key: 'object', label: 'Object' },
    { key: 'message', label: 'Message' },
    { key: 'age', label: 'Age', age: true },
  ],
  serviceaccounts: [
    { key: 'name', label: 'Name' },
    { key: 'secrets', label: 'Secrets' },
    { key: 'age', label: 'Age', age: true },
  ],
  roles: [
    { key: 'name', label: 'Name' },
    { key: 'rules', label: 'Rules' },
    { key: 'age', label: 'Age', age: true },
  ],
  rolebindings: [
    { key: 'name', label: 'Name' },
    { key: 'role', label: 'Role' },
    { key: 'subjects', label: 'Subjects' },
    { key: 'age', label: 'Age', age: true },
  ],
  clusterroles: [
    { key: 'name', label: 'Name' },
    { key: 'rules', label: 'Rules' },
    { key: 'age', label: 'Age', age: true },
  ],
  clusterrolebindings: [
    { key: 'name', label: 'Name' },
    { key: 'role', label: 'Role' },
    { key: 'subjects', label: 'Subjects' },
    { key: 'age', label: 'Age', age: true },
  ],
  networkpolicies: [
    { key: 'name', label: 'Name' },
    { key: 'podSelector', label: 'Pod Selector' },
    { key: 'policyTypes', label: 'Types' },
    { key: 'ingressRules', label: 'Ingress Rules' },
    { key: 'egressRules', label: 'Egress Rules' },
    { key: 'age', label: 'Age', age: true },
  ],
  storageclasses: [
    { key: 'name', label: 'Name' },
    { key: 'provisioner', label: 'Provisioner' },
    { key: 'reclaimPolicy', label: 'Reclaim Policy' },
    { key: 'volumeBindingMode', label: 'Binding Mode' },
    { key: 'age', label: 'Age', age: true },
  ],
  resourcequotas: [
    { key: 'name', label: 'Name' },
    { key: 'summary', label: 'Usage' },
    { key: 'age', label: 'Age', age: true },
  ],
  limitranges: [
    { key: 'name', label: 'Name' },
    { key: 'limits', label: 'Limit Types' },
    { key: 'age', label: 'Age', age: true },
  ],
};

// Returns the effective columns for a kind, injecting a Namespace column right after Name when
// browsing all-namespaces (cluster-scoped kinds skip it — their `namespace` field is always empty).
function getManageColumns(kind) {
  if (state.manage.mode === 'crd') {
    const crd = state.manage.activeCrd;
    const cols = [{ key: 'name', label: 'Name' }, { key: 'age', label: 'Age', age: true }];
    if (crd && crd.namespaced) cols.splice(1, 0, { key: 'namespace', label: 'Namespace' });
    return cols;
  }
  let cols = MANAGE_COLUMN_DEFS[kind] || MANAGE_COLUMN_DEFS.pods;
  if (!state.manage.enableMetrics) {
    cols = cols.filter((c) => !c.spark);
  }
  if (state.manage.namespace !== MANAGE_ALL_NAMESPACES || MANAGE_CLUSTER_SCOPED_KINDS.includes(kind)) return cols;
  const nameIdx = cols.findIndex((c) => c.key === 'name');
  const withNamespace = cols.slice();
  withNamespace.splice(nameIdx + 1, 0, { key: 'namespace', label: 'Namespace' });
  return withNamespace;
}

// Nodes/Events change slowly and are usually shared across many namespaces —
// polling them as often as pods just adds load for no benefit.
const MANAGE_POLL_INTERVAL = { nodes: 10000, events: 10000 };

// Columns for the drawer's scoped-Events pane — no "Object" column since it's always the selected resource.
const MANAGE_EVENTS_PANE_COLUMNS = [
  { key: 'type', label: 'Type' },
  { key: 'reason', label: 'Reason' },
  { key: 'message', label: 'Message' },
  { key: 'count', label: 'Count' },
  { key: 'age', label: 'Age', age: true },
];

const MANAGE_METRICS_KINDS = ['pods', 'nodes'];
const MANAGE_METRICS_POLL_INTERVAL = 10000;
const MANAGE_METRICS_MAX_POINTS = 60;

function relAge(ts) {
  if (!ts) return '';
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(ts).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

// Pod/node names alone aren't unique when browsing all-namespaces (same name can exist in
// multiple namespaces) — key metrics series by namespace+name so their sparklines don't collide.
function metricsKey(row) {
  return `${row.namespace || ''}/${row.name}`;
}

function manageStatusClass(status) {
  const s = (status || '').toLowerCase();
  if (['running', 'ready', 'completed', 'succeeded', 'active', 'bound', 'available'].includes(s)) return 'manage-status-running';
  if (['pending', 'containercreating', 'terminating', 'released'].includes(s)) return 'manage-status-pending';
  return 'manage-status-error'; // CrashLoopBackOff, Error, ImagePullBackOff, NotReady, Failed, Lost, …
}

el.manageSidebar.addEventListener('click', (e) => {
  const btn = e.target.closest('.manage-nav-item');
  if (!btn) return;
  selectManageKind(btn.dataset.kind);
});

// Selection is scoped by namespace+name so bulk-select stays correct in all-namespaces mode,
// where `name` alone isn't unique.
function manageSelectionKey(row) {
  return `${row.namespace || ''}::${row.name}`;
}

function clearManageSelection() {
  state.manage.selection.clear();
  renderManageBulkBar();
}

// ── Resource cache: instant display when switching kinds ──────────────────────
// Keyed by `namespace::kind`, stores the last successfully fetched rows array.
// Cleared on context/namespace change so stale cross-namespace data never shows.
const _manageRowsCache = new Map();

function _manageRowsCacheKey(ns, kind) {
  return `${ns || ''}::${kind}`;
}

function _clearManageRowsCache() {
  _manageRowsCache.clear();
}

// Shows a small "you are here" label above the table — without it, once you're inside a CRD
// with a name that also exists under a different API group (e.g. Traefik's Middleware under both
// traefik.io and traefik.containo.us), nothing on screen says which one you're actually browsing.
function updateManageKindTitle() {
  const data = state.manage;
  if (data.mode === 'crd' && data.activeCrd) {
    el.manageKindTitle.textContent = `${data.activeCrd.kind} · ${data.activeCrd.group || '(core)'}`;
    el.manageKindTitle.style.display = '';
  } else if (data.resourceType && !isManageSpecialView(data.resourceType)) {
    const activeBtn = el.manageSidebar.querySelector('.manage-nav-item.active');
    el.manageKindTitle.textContent = activeBtn ? activeBtn.textContent.trim() : (MANAGE_KIND_LABEL_PLURAL[data.resourceType] || data.resourceType);
    el.manageKindTitle.style.display = '';
  } else {
    el.manageKindTitle.style.display = 'none';
  }
}

// "Special" sidebar views (Overview, Recycle Bin) aren't a real resource kind — they don't poll
// the resource-listing endpoints, have no table, and are exempt from the per-kind menu-visibility
// toggle (always shown).
function isManageSpecialView(resourceType) {
  return resourceType === 'overview' || resourceType === 'recyclebin';
}

function selectManageKind(kind) {
  const data = state.manage;

  if (kind === 'recyclebin') {
    if (data.mode === 'kind' && data.resourceType === 'recyclebin') return;
    data.mode = 'kind';
    data.activeCrd = null;
    data.resourceType = 'recyclebin';
    data.rows = [];
    clearManageSelection();
    el.manageSidebar.querySelectorAll('.manage-nav-item').forEach((b) => b.classList.toggle('active', b.dataset.kind === 'recyclebin'));
    el.manageCrdList.querySelectorAll('.manage-crd-item').forEach((b) => b.classList.remove('active'));
    closeManageDrawer();
    stopManageOverviewPolling();
    stopManagePolling();
    stopManageWatch();
    stopManageMetricsPolling();
    el.manageOverviewPane.style.display = 'none';
    el.manageTableWrap.style.display = 'none';
    el.manageRecyclebinPane.style.display = 'flex';
    el.manageRecyclebinYaml.style.display = 'none';
    el.manageRecyclebinList.style.display = '';
    updateManageKindTitle();
    loadRecycleBin();
    return;
  }

  if (kind === 'overview') {
    if (data.mode === 'kind' && data.resourceType === 'overview') return;
    data.mode = 'kind';
    data.activeCrd = null;
    data.resourceType = 'overview';
    data.rows = [];
    clearManageSelection();
    el.manageSidebar.querySelectorAll('.manage-nav-item').forEach((b) => b.classList.toggle('active', b.dataset.kind === 'overview'));
    el.manageCrdList.querySelectorAll('.manage-crd-item').forEach((b) => b.classList.remove('active'));
    closeManageDrawer();
    stopManagePolling();
    stopManageWatch();
    stopManageMetricsPolling();
    el.manageTableWrap.style.display = 'none';
    el.manageRecyclebinPane.style.display = 'none';
    el.manageOverviewPane.style.display = 'flex';
    updateManageKindTitle();
    startManageOverviewPolling();
    return;
  }

  if (kind === data.resourceType && data.mode === 'kind') return;
  data.mode = 'kind';
  data.activeCrd = null;
  data.resourceType = kind;
  clearManageSelection();
  el.manageSidebar.querySelectorAll('.manage-nav-item').forEach((b) => b.classList.toggle('active', b.dataset.kind === kind));
  el.manageCrdList.querySelectorAll('.manage-crd-item').forEach((b) => b.classList.remove('active'));
  el.manageOverviewPane.style.display = 'none';
  el.manageRecyclebinPane.style.display = 'none';
  el.manageTableWrap.style.display = '';
  updateManageKindTitle();
  closeManageDrawer();
  stopManageOverviewPolling();
  stopManagePolling();
  stopManageWatch();
  stopManageMetricsPolling();

  // Restore cached rows instantly (avoids blank table while HTTP request is in-flight).
  const cached = _manageRowsCache.get(_manageRowsCacheKey(data.namespace, kind));
  data.rows = cached || [];
  renderManageTable(kind, data.rows);
  if (cached) {
    el.manageRefreshStatus.textContent = 'Refreshing…';
  }

  // Debounce: if user clicks multiple kinds within 100ms, only fire IPC for the last one.
  // Cached data above is rendered immediately — only the HTTP request is delayed.
  clearTimeout(selectManageKind._debounce);
  selectManageKind._debounce = setTimeout(() => {
    if (data.context && data.namespace) {
      startManageLiveUpdates(kind, data.namespace);
      startManageMetricsPolling();
    }
  }, 100);
}

// ── Diff-update renderer ─────────────────────────────────────────────────────
// On initial render (kind/namespace switch) we do a full DOM build.
// On polling refresh the table structure already exists, so we diff: match rows
// by key, update only changed cells in-place, append new rows, remove stale ones.
// This cuts DOM mutations by ~95% during steady-state polling.

// Builds the inner HTML for a row's data cells (everything after the checkbox).
function _manageCellsHtml(cols, row) {
  return cols.map((c) => {
    const val = row[c.key];
    if (c.spark) return `<td><span class="manage-spark" data-row="${escHtml(metricsKey(row))}" data-metric="${c.spark}"></span></td>`;
    if (c.age) return `<td>${escHtml(relAge(val))}</td>`;
    if (c.status) return `<td><span class="status-pill ${manageStatusClass(val)}">${escHtml(val || '')}</span></td>`;
    return `<td>${escHtml(val ?? '')}</td>`;
  }).join('');
}

// Creates a full <tr> for `row`, including checkbox cell, click handler, and data attribute.
function _manageCreateTr(kind, cols, row) {
  const tr = document.createElement('tr');
  tr.style.cursor = 'pointer';
  tr.dataset.rowKey = manageSelectionKey(row);

  const checkboxCell = document.createElement('td');
  checkboxCell.className = 'manage-select-col';
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = state.manage.selection.has(tr.dataset.rowKey);
  checkbox.addEventListener('click', (e) => {
    e.stopPropagation();
    if (checkbox.checked) state.manage.selection.add(tr.dataset.rowKey);
    else state.manage.selection.delete(tr.dataset.rowKey);
    renderManageBulkBar();
    updateManageSelectAllState(state.manage._lastFiltered || []);
  });
  checkboxCell.appendChild(checkbox);
  tr.appendChild(checkboxCell);

  tr.insertAdjacentHTML('beforeend', _manageCellsHtml(cols, row));
  tr._rowData = row;
  tr.addEventListener('click', () => openManageDrawer(kind, tr._rowData));
  return tr;
}

// Patches an existing <tr>'s data cells in-place (skips checkbox, skips sparklines).
function _manageUpdateTr(tr, cols, row) {
  // Cells: [0]=checkbox, [1..N]=data columns
  const cells = tr.children;
  for (let i = 0; i < cols.length; i++) {
    const c = cols[i];
    const td = cells[i + 1]; // +1 for checkbox cell
    if (!td || c.spark) continue; // sparklines are handled separately

    let newText;
    const val = row[c.key];
    if (c.age) {
      newText = relAge(val);
    } else if (c.status) {
      // Status pill: update both text and class
      const pill = td.querySelector('.status-pill');
      if (pill) {
        const txt = val || '';
        if (pill.textContent !== txt) pill.textContent = txt;
        const cls = `status-pill ${manageStatusClass(val)}`;
        if (pill.className !== cls) pill.className = cls;
      }
      continue;
    } else {
      newText = String(val ?? '');
    }
    if (td.textContent !== newText) td.textContent = newText;
  }
  // Update checkbox state
  const checkbox = cells[0]?.querySelector('input');
  if (checkbox) {
    const key = tr.dataset.rowKey;
    const shouldBeChecked = state.manage.selection.has(key);
    if (checkbox.checked !== shouldBeChecked) checkbox.checked = shouldBeChecked;
  }
}

// Column sorting: kind (or CRD name, which renderManageTable is also called with) -> {key, dir}.
// Sparkline columns (no scalar value) are deliberately excluded from sorting.
const manageSortState = new Map();

function applyManageSort(kind, rows) {
  const sort = manageSortState.get(kind);
  if (!sort) return rows;
  const { key, dir } = sort;
  return rows.slice().sort((a, b) => {
    const av = a[key], bv = b[key];
    const an = Number(av), bn = Number(bv);
    const bothNumeric = av !== '' && bv !== '' && av != null && bv != null && !Number.isNaN(an) && !Number.isNaN(bn);
    const cmp = bothNumeric ? (an - bn) : String(av ?? '').localeCompare(String(bv ?? ''));
    return cmp * dir;
  });
}

function renderManageTable(kind, rows) {
  const cols = getManageColumns(kind);
  const query = (el.manageSearch.value || '').toLowerCase();
  let filtered = query ? rows.filter((r) => (r.name || '').toLowerCase().includes(query)) : rows;
  filtered = applyManageSort(kind, filtered);
  state.manage._lastFiltered = filtered;

  // Always rebuild <thead> (cheap, one row)
  const sort = manageSortState.get(kind);
  el.manageThead.innerHTML = `<tr><th class="manage-select-col"><input type="checkbox" id="manage-select-all" /></th>${cols.map((c) => {
    if (c.spark) return `<th>${escHtml(c.label)}</th>`; // no scalar value to sort by
    const arrow = sort && sort.key === c.key ? (sort.dir === 1 ? ' ▲' : ' ▼') : '';
    return `<th class="manage-sortable-th" data-sort-key="${escHtml(c.key)}">${escHtml(c.label)}${arrow}</th>`;
  }).join('')}</tr>`;
  const selectAllBox = $('manage-select-all');

  if (filtered.length === 0) {
    _vsCleanup();
    el.manageTbody.innerHTML = `<tr><td colspan="${cols.length + 1}" class="manage-empty">${query ? 'No match' : 'No resources found'}</td></tr>`;
    if (selectAllBox) selectAllBox.disabled = true;
    return;
  }

  if (filtered.length > _VS_THRESHOLD) {
    // ── Virtual scroll path ────────────────────────────────────────────────
    _vsRender(kind, cols, filtered);
  } else {
    // ── Standard diff-update path (<= threshold) ──────────────────────────
    _vsCleanup();
    _renderManageTableStandard(kind, cols, filtered);
  }

  updateManageSelectAllState(filtered);
  if (selectAllBox) {
    selectAllBox.addEventListener('change', () => {
      for (const row of filtered) {
        const key = manageSelectionKey(row);
        if (selectAllBox.checked) state.manage.selection.add(key);
        else state.manage.selection.delete(key);
      }
      renderManageTable(kind, rows);
      renderManageBulkBar();
    });
  }
  renderManageMetricsSparklines();
}

// Delegated on the persistent <thead> element itself (its innerHTML is rebuilt every render,
// but the element reference stays the same, so a listener attached once still sees new clicks).
el.manageThead.addEventListener('click', (e) => {
  const th = e.target.closest('[data-sort-key]');
  if (!th) return;
  const key = th.dataset.sortKey;
  const kind = state.manage.mode === 'crd' ? state.manage.activeCrd.name : state.manage.resourceType;
  const current = manageSortState.get(kind);
  manageSortState.set(kind, current && current.key === key ? { key, dir: -current.dir } : { key, dir: 1 });
  renderManageTable(kind, state.manage.rows);
});

// ── Standard diff-update table renderer (existing logic, extracted) ──────────

function _renderManageTableStandard(kind, cols, filtered) {
  // ── Diff-update: build a map of existing rows by key ────────────────────
  const existingMap = new Map();
  for (const tr of Array.from(el.manageTbody.children)) {
    if (tr.dataset.rowKey) existingMap.set(tr.dataset.rowKey, tr);
  }

  // If the existing tbody has no keyed rows (first render, kind switch, etc.) → full build.
  const canDiff = existingMap.size > 0;

  if (!canDiff) {
    // Full build — same as before but rows get data-row-key for future diffs.
    el.manageTbody.innerHTML = '';
    const frag = document.createDocumentFragment();
    for (const row of filtered) {
      frag.appendChild(_manageCreateTr(kind, cols, row));
    }
    el.manageTbody.appendChild(frag);
  } else {
    // Diff update
    const newKeys = new Set(filtered.map(manageSelectionKey));

    // 1. Remove rows that no longer exist
    for (const [key, tr] of existingMap) {
      if (!newKeys.has(key)) {
        tr.remove();
        existingMap.delete(key);
      }
    }

    // 2. Update existing rows in-place, append new ones, maintain order
    let prevTr = null;
    for (const row of filtered) {
      const key = manageSelectionKey(row);
      let tr = existingMap.get(key);
      if (tr) {
        // Update cells that changed
        _manageUpdateTr(tr, cols, row);
      } else {
        // New row — create and insert in order
        tr = _manageCreateTr(kind, cols, row);
      }
      // Ensure correct order: tr should come after prevTr
      if (prevTr) {
        if (tr.previousElementSibling !== prevTr) {
          prevTr.after(tr);
        }
      } else {
        if (tr !== el.manageTbody.firstElementChild) {
          el.manageTbody.prepend(tr);
        }
      }
      // Update the stored row reference so drawer click opens fresh data
      tr._rowData = row;
      prevTr = tr;
    }
  }
}

// ── Virtual scroll renderer (>200 rows) ─────────────────────────────────────
// Renders only the rows visible in the viewport + a buffer above/below.
// Uses two spacer <tr> elements to maintain correct scrollbar/total height.

const _VS_THRESHOLD = 200;
const _VS_ROW_HEIGHT = 34;   // must match CSS row height (px)
const _VS_BUFFER = 10;       // extra rows above/below viewport

let _vsState = null;          // { kind, cols, filtered, onScroll }

function _vsCleanup() {
  if (_vsState) {
    el.manageTableWrap.removeEventListener('scroll', _vsState.onScroll);
    _vsState = null;
  }
}

function _vsRender(kind, cols, filtered) {
  const total = filtered.length;
  const totalHeight = total * _VS_ROW_HEIGHT;
  const wrapEl = el.manageTableWrap;
  const viewportH = wrapEl.clientHeight;
  const colCount = cols.length + 1; // +1 for checkbox

  // Create or update scroll handler
  if (_vsState) {
    wrapEl.removeEventListener('scroll', _vsState.onScroll);
  }

  _vsState = { kind, cols, filtered, onScroll: null, rafId: 0, lastStart: -1, lastEnd: -1 };

  function renderWindow() {
    const scrollTop = wrapEl.scrollTop;
    const start = Math.max(0, Math.floor(scrollTop / _VS_ROW_HEIGHT) - _VS_BUFFER);
    const visibleCount = Math.ceil(viewportH / _VS_ROW_HEIGHT);
    const end = Math.min(total, start + visibleCount + _VS_BUFFER * 2);

    // Skip if window hasn't changed
    if (start === _vsState.lastStart && end === _vsState.lastEnd) return;
    _vsState.lastStart = start;
    _vsState.lastEnd = end;

    const topH = start * _VS_ROW_HEIGHT;
    const bottomH = Math.max(0, (total - end) * _VS_ROW_HEIGHT);

    el.manageTbody.innerHTML = '';
    const frag = document.createDocumentFragment();

    // Top spacer
    if (topH > 0) {
      const spacer = document.createElement('tr');
      spacer.className = 'manage-vs-spacer';
      const td = document.createElement('td');
      td.colSpan = colCount;
      td.style.height = topH + 'px';
      td.style.padding = '0';
      td.style.border = 'none';
      spacer.appendChild(td);
      frag.appendChild(spacer);
    }

    // Visible rows
    for (let i = start; i < end; i++) {
      frag.appendChild(_manageCreateTr(kind, cols, filtered[i]));
    }

    // Bottom spacer
    if (bottomH > 0) {
      const spacer = document.createElement('tr');
      spacer.className = 'manage-vs-spacer';
      const td = document.createElement('td');
      td.colSpan = colCount;
      td.style.height = bottomH + 'px';
      td.style.padding = '0';
      td.style.border = 'none';
      spacer.appendChild(td);
      frag.appendChild(spacer);
    }

    el.manageTbody.appendChild(frag);
    renderManageMetricsSparklines();
  }

  // Initial render
  renderWindow();

  // Scroll handler with requestAnimationFrame
  _vsState.onScroll = () => {
    if (_vsState.rafId) return;
    _vsState.rafId = requestAnimationFrame(() => {
      _vsState.rafId = 0;
      renderWindow();
    });
  };
  wrapEl.addEventListener('scroll', _vsState.onScroll, { passive: true });
}

function updateManageSelectAllState(filteredRows) {
  const selectAllBox = $('manage-select-all');
  if (!selectAllBox) return;
  const keys = filteredRows.map(manageSelectionKey);
  const selectedCount = keys.filter((k) => state.manage.selection.has(k)).length;
  selectAllBox.disabled = false;
  selectAllBox.checked = selectedCount > 0 && selectedCount === keys.length;
  selectAllBox.indeterminate = selectedCount > 0 && selectedCount < keys.length;
}

function renderManageErrorRow(kind, error) {
  const cols = getManageColumns(kind);
  el.manageThead.innerHTML = `<tr>${cols.map((c) => `<th>${escHtml(c.label)}</th>`).join('')}</tr>`;
  el.manageTbody.innerHTML = `<tr><td colspan="${cols.length}" class="manage-empty">${escHtml(error)}</td></tr>`;
}

let _manageResourceGen = 0;

async function refreshManageResources() {
  const data = state.manage;
  if (data.mode === 'crd' && data.activeCrd) return refreshManageCustomResources();
  if (data.resourceType === 'recyclebin') return loadRecycleBin();
  if (!data.context || !data.namespace) return;
  const gen = ++_manageResourceGen;
  const kindAtStart = data.resourceType;
  const nsAtStart = data.namespace;
  el.manageRefreshStatus.textContent = 'Refreshing…';

  try {
    const result = await window.k8sApi.listResource(data.kubeconfig, data.context, nsAtStart, kindAtStart);
    // Generation counter: drop stale responses from superseded requests.
    if (gen !== _manageResourceGen) return;
    if (data.resourceType !== kindAtStart || data.namespace !== nsAtStart) return;

    if (!result.ok) {
      data.rows = [];
      renderManageErrorRow(kindAtStart, result.error);
      el.manageRefreshStatus.textContent = `Error at ${new Date().toLocaleTimeString()}`;
      return;
    }
    data.rows = result.rows;
    _manageRowsCache.set(_manageRowsCacheKey(nsAtStart, kindAtStart), result.rows);
    renderManageTable(kindAtStart, data.rows);
    el.manageRefreshStatus.textContent = `Updated ${new Date().toLocaleTimeString()}`;
    if (data.enableMetrics && MANAGE_METRICS_KINDS.includes(kindAtStart)) {
      refreshManageMetrics();
    }
  } catch (e) {
    el.manageRefreshStatus.textContent = `Error: ${e.message}`;
  }
}

function startManagePolling() {
  stopManagePolling();
  if (!state.manage.enableAutoRefresh) return;
  const interval = MANAGE_POLL_INTERVAL[state.manage.resourceType] || 5000;
  state.manage.pollTimer = setInterval(refreshManageResources, interval);
}

function stopManagePolling() {
  if (state.manage.pollTimer) {
    clearInterval(state.manage.pollTimer);
    state.manage.pollTimer = null;
  }
}

/* ── K8s Manage: real-time watch (Phase 16) ─────────────────────────────────
   High-churn kinds get a live k8s watch stream instead of a poll timer. Kept in sync by hand
   with WATCH_ENABLED_KINDS in main.js (no shared module between the two processes). */
const WATCH_ENABLED_KINDS = ['pods', 'deployments', 'replicasets', 'statefulsets', 'daemonsets', 'jobs', 'events'];

function startManageWatch(kind, namespace) {
  stopManageWatch();
  const data = state.manage;
  const sid = crypto.randomUUID();

  // Subscribe before starting the stream so the first sync/event can't race past us.
  const disposers = [
    window.k8sApi.onWatchSync(sid, ({ rows }) => {
      data.rows = rows;
      _manageRowsCache.set(_manageRowsCacheKey(namespace, kind), rows);
      renderManageTable(kind, rows);
      el.manageRefreshStatus.textContent = `Live · ${new Date().toLocaleTimeString()}`;
      if (data.enableMetrics && MANAGE_METRICS_KINDS.includes(kind)) refreshManageMetrics();
    }),
    window.k8sApi.onWatchEvent(sid, ({ type, row }) => {
      applyManageWatchDelta(kind, type, row);
      el.manageRefreshStatus.textContent = `Live · ${new Date().toLocaleTimeString()}`;
    }),
    window.k8sApi.onWatchError(sid, ({ message, permanent }) => {
      if (permanent) {
        // Most likely the `watch` verb is RBAC-denied even though list/get are allowed —
        // fall back silently to the pre-existing poll timer for this kind.
        stopManageWatch();
        el.manageRefreshStatus.textContent = 'Live updates unavailable — polling';
        refreshManageResources();
        startManagePolling();
      } else {
        el.manageRefreshStatus.textContent = message || 'Reconnecting live updates…';
      }
    }),
  ];
  data.watchSession = { sid, kind, namespace, disposers };
  window.k8sApi.startWatch(data.kubeconfig, data.context, namespace, kind, sid);
}

function stopManageWatch() {
  const session = state.manage.watchSession;
  if (!session) return;
  window.k8sApi.stopWatch(session.sid);
  session.disposers.forEach((dispose) => dispose());
  state.manage.watchSession = null;
}

// Applies one ADDED/MODIFIED/DELETED delta directly onto state.manage.rows, then re-renders
// through the existing diff-by-key table patching — no new rendering logic needed, watch deltas
// and poll refreshes both funnel through the same renderManageTable().
function applyManageWatchDelta(kind, type, row) {
  const data = state.manage;
  if (data.mode !== 'kind' || data.resourceType !== kind) return; // stale event from a superseded view
  const key = manageSelectionKey(row);
  const idx = data.rows.findIndex((r) => manageSelectionKey(r) === key);
  if (type === 'DELETED') {
    if (idx !== -1) data.rows.splice(idx, 1);
  } else {
    if (idx !== -1) data.rows[idx] = row;
    else data.rows.push(row);
  }
  _manageRowsCache.set(_manageRowsCacheKey(data.namespace, kind), data.rows);
  renderManageTable(kind, data.rows);
}

// Shared by every call site that used to do `refreshManageResources(); startManagePolling();` —
// watch-enabled kinds get a live stream instead when Auto-Poll is on; when Auto-Poll is off, a
// watch-enabled kind gets the same one-shot-only behavior Tier-2 kinds already had (no timer,
// no watch — matches the existing "Auto-Poll off" convention rather than overriding it).
function startManageLiveUpdates(kind, namespace) {
  if (WATCH_ENABLED_KINDS.includes(kind) && state.manage.enableAutoRefresh) {
    startManageWatch(kind, namespace);
  } else {
    refreshManageResources();
    if (!WATCH_ENABLED_KINDS.includes(kind)) startManagePolling();
  }
}

/* ── K8s Manage: bulk actions ────────────────────────────────────────────── */

function renderManageBulkBar() {
  const n = state.manage.selection.size;
  el.manageBulkBar.style.display = n > 0 ? 'flex' : 'none';
  el.manageBulkCount.textContent = `${n} selected`;
  const kind = state.manage.mode === 'crd' ? null : state.manage.resourceType;
  const restartBtn = el.manageBulkBar.querySelector('[data-bulk-action="restart"]');
  const scaleBtn = el.manageBulkBar.querySelector('[data-bulk-action="scale"]');
  const cordonBtn = el.manageBulkBar.querySelector('[data-bulk-action="cordon"]');
  const uncordonBtn = el.manageBulkBar.querySelector('[data-bulk-action="uncordon"]');
  restartBtn.style.display = ['deployments', 'statefulsets', 'daemonsets'].includes(kind) ? '' : 'none';
  scaleBtn.style.display = ['deployments', 'statefulsets'].includes(kind) ? '' : 'none';
  cordonBtn.style.display = kind === 'nodes' ? '' : 'none';
  uncordonBtn.style.display = kind === 'nodes' ? '' : 'none';
  // Write gate: disable all bulk action buttons when audit not connected
  const locked = !state.manage.writeUnlocked;
  el.manageBulkBar.querySelectorAll('[data-bulk-action]').forEach((b) => {
    b.disabled = locked;
    b.title = locked ? 'Enable Audit in Settings to unlock' : '';
  });
}

el.manageBulkBar.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-bulk-action]');
  if (!btn) return;
  runManageBulkAction(btn.dataset.bulkAction);
});

// Small bounded-concurrency map — avoids opening dozens of simultaneous connections
// against the API server when a large selection is bulk-actioned.
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function runManageBulkAction(action) {
  if (!state.manage.writeUnlocked) return;
  const data = state.manage;
  const kind = data.mode === 'crd' ? data.activeCrd.name : data.resourceType;
  const kindLabel = data.mode === 'crd' ? data.activeCrd.kind : (MANAGE_KIND_SINGULAR[kind] || kind);
  const rows = data.rows.filter((r) => data.selection.has(manageSelectionKey(r)));
  if (rows.length === 0) return;

  let payload;
  if (action === 'delete') {
    const { ok } = await showManageConfirm({
      title: `Delete ${rows.length} ${kindLabel}(s)?`,
      body: `This permanently deletes ${rows.length} selected resources. Type the count to confirm.`,
      danger: true,
      confirmLabel: 'Delete',
      typedValue: String(rows.length),
    });
    if (!ok) return;
  } else if (action === 'restart') {
    const { ok } = await showManageConfirm({
      title: `Restart rollout for ${rows.length} resources?`,
      body: 'This restarts every pod managed by each selected resource, one at a time.',
      confirmLabel: 'Restart',
    });
    if (!ok) return;
  } else if (action === 'scale') {
    const current = rows[0]?.ready ? Number(String(rows[0].ready).split('/')[1]) || 0 : 0;
    const { ok, value } = await showManageConfirm({
      title: `Scale ${rows.length} resources?`,
      body: 'Every selected resource is scaled to the same replica count.',
      confirmLabel: 'Scale',
      numberInput: { current },
    });
    if (!ok) return;
    payload = { replicas: value };
  } else if (action === 'cordon' || action === 'uncordon') {
    const { ok } = await showManageConfirm({
      title: `${action === 'cordon' ? 'Cordon' : 'Uncordon'} ${rows.length} nodes?`,
      body: action === 'cordon'
        ? 'Marks every selected node unschedulable — existing pods keep running, no new pods are scheduled onto them.'
        : 'Marks every selected node schedulable again.',
      confirmLabel: action === 'cordon' ? 'Cordon' : 'Uncordon',
    });
    if (!ok) return;
  } else {
    return;
  }

  const results = await mapLimit(rows, 5, async (row) => {
    const result = data.mode === 'crd'
      ? await window.k8sApi.customResourceAction(
          data.kubeconfig, data.context, manageRowNamespace(row),
          data.activeCrd.group, data.activeCrd.version, data.activeCrd.plural, row.name, data.activeCrd.namespaced, action
        )
      : await window.k8sApi.resourceAction(data.kubeconfig, data.context, manageRowNamespace(row), kind, row.name, action, payload);
    return { row, result };
  });

  const failed = results.filter((r) => !r.result.ok);
  const succeeded = results.length - failed.length;
  el.manageBulkResult.style.display = 'block';
  el.manageBulkResult.className = `manage-bulk-result${failed.length ? ' manage-bulk-result-partial' : ' manage-bulk-result-ok'}`;
  el.manageBulkResult.textContent = failed.length === 0
    ? `${succeeded}/${results.length} succeeded`
    : `${succeeded}/${results.length} succeeded, ${failed.length} failed: ${failed.map((f) => `${f.row.name} (${f.result.error})`).join(', ')}`;

  clearManageSelection();
  refreshManageResources();
}

/* ── K8s Manage: cluster overview / health-summary landing page ──────────── */

const MANAGE_OVERVIEW_POLL_INTERVAL = 30000;

function startManageOverviewPolling() {
  stopManageOverviewPolling();
  refreshManageOverview();
  if (!state.manage.enableAutoRefresh) return;
  state.manage.overviewPollTimer = setInterval(refreshManageOverview, MANAGE_OVERVIEW_POLL_INTERVAL);
}

function stopManageOverviewPolling() {
  if (state.manage.overviewPollTimer) {
    clearInterval(state.manage.overviewPollTimer);
    state.manage.overviewPollTimer = null;
  }
}

async function refreshManageOverview() {
  const data = state.manage;
  if (data.resourceType !== 'overview' || !data.context) return;
  const contextAtStart = data.context;
  const result = await window.k8sApi.getManageOverview(data.kubeconfig, data.context);
  if (data.resourceType !== 'overview' || data.context !== contextAtStart) return;
  if (!result.ok) {
    el.manageOverviewPane.innerHTML = `<div class="manage-empty">${escHtml(result.error)}</div>`;
    return;
  }
  renderManageOverview(result.digest);
}

const MANAGE_OVERVIEW_TILES = [
  { key: 'podsNotReady', title: 'Pods not Ready', jumpKind: 'pods' },
  { key: 'deploymentsUnhealthy', title: 'Deployments unhealthy', jumpKind: 'deployments' },
  { key: 'nodesNotReady', title: 'Nodes NotReady', jumpKind: 'nodes' },
  { key: 'warningEvents', title: 'Warning events', jumpKind: 'events' },
];

function renderManageOverview(digest) {
  el.manageOverviewPane.innerHTML = MANAGE_OVERVIEW_TILES.map((t) => {
    const d = digest[t.key] || { count: 0, items: [] };
    const itemsHtml = d.items.length === 0
      ? '<div class="manage-overview-tile-empty">None</div>'
      : d.items.map((item) => {
          const label = item.object || item.name || '';
          const sub = item.status || item.ready || item.reason || '';
          return `<div class="manage-overview-tile-row" data-kind="${escHtml(t.jumpKind)}" data-namespace="${escHtml(item.namespace || '')}" data-name="${escHtml(item.name || '')}">
            <span class="manage-overview-tile-row-name">${escHtml(item.namespace ? `${item.namespace}/${label || item.name}` : (label || item.name || ''))}</span>
            <span class="manage-overview-tile-row-sub">${escHtml(sub)}</span>
          </div>`;
        }).join('');
    return `
      <div class="manage-overview-tile">
        <div class="manage-overview-tile-header">
          <span class="manage-overview-tile-title">${escHtml(t.title)}</span>
          <span class="manage-overview-tile-count ${d.count > 0 ? 'manage-overview-tile-count-bad' : ''}">${d.count}</span>
        </div>
        <div class="manage-overview-tile-list">${itemsHtml}</div>
      </div>`;
  }).join('');

  el.manageOverviewPane.querySelectorAll('.manage-overview-tile-row[data-name]').forEach((row) => {
    row.addEventListener('click', () => {
      const kind = row.dataset.kind;
      const namespace = row.dataset.namespace;
      const name = row.dataset.name;
      selectManageKind(kind);
      if (namespace && el.manageNamespace.querySelector(`option[value="${CSS.escape(namespace)}"]`)) {
        el.manageNamespace.value = namespace;
        state.manage.namespace = namespace;
      } else {
        el.manageNamespace.value = MANAGE_ALL_NAMESPACES;
        state.manage.namespace = MANAGE_ALL_NAMESPACES;
      }
      // selectManageKind(kind) above already schedules the right live-update mechanism
      // (poll or watch) via its own debounce — this fetch is just to open the drawer now.
      refreshManageResources().then(() => {
        const found = state.manage.rows.find((r) => r.name === name && (r.namespace || '') === namespace);
        if (found) openManageDrawer(kind, found);
      });
    });
  });
}

/* ── K8s Manage: CRD / custom-resource browsing ───────────────────────────── */

async function loadManageCrds() {
  const data = state.manage;
  const result = await window.k8sApi.listCrds(data.kubeconfig, data.context);
  data.crds = result.ok ? result.crds : [];
  renderManageCrdList(el.manageCrdFilter.value);
}

// Several CRDs can share the same `kind` across different API groups (e.g. Traefik ships
// duplicate Kinds under both `traefik.io` and the legacy `traefik.containo.us` for migration) —
// grouping by group (the CRD's actual "parent") disambiguates them instead of showing bare,
// indistinguishable Kind names side by side.
// Groups collapsed by the user (by group name) — remembered across re-renders within the
// session; a group containing the active CRD, or matching an active filter, always shows
// expanded regardless of its remembered state, so selecting/searching never hides the result.
const _manageCrdCollapsedGroups = new Set();

function renderManageCrdList(filter = '') {
  const q = filter.trim().toLowerCase();
  const items = state.manage.crds.filter((c) => !q || c.name.toLowerCase().includes(q) || c.kind.toLowerCase().includes(q));
  if (items.length === 0) {
    el.manageCrdList.innerHTML = state.manage.crds.length === 0
      ? '<div class="manage-empty-hint">No CRDs found</div>'
      : '<div class="manage-empty-hint">No match</div>';
    return;
  }

  const byGroup = new Map();
  for (const c of items) {
    const group = c.group || '(core)';
    if (!byGroup.has(group)) byGroup.set(group, []);
    byGroup.get(group).push(c);
  }
  const groups = Array.from(byGroup.keys()).sort((a, b) => a.localeCompare(b));
  const activeGroup = state.manage.activeCrd ? (state.manage.activeCrd.group || '(core)') : null;

  el.manageCrdList.innerHTML = groups.map((group) => {
    const crds = byGroup.get(group).sort((a, b) => a.kind.localeCompare(b.kind));
    const forceOpen = !!q || group === activeGroup;
    const collapsed = !forceOpen && _manageCrdCollapsedGroups.has(group);
    const header = `
      <button class="manage-crd-group-header${collapsed ? ' collapsed' : ''}" data-crd-group="${escHtml(group)}">
        <svg class="manage-crd-group-caret" width="8" height="8" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
        <span class="manage-crd-group-name">${escHtml(group)}</span>
        <span class="manage-crd-group-count">${crds.length}</span>
      </button>`;
    if (collapsed) return header;
    const rows = crds.map((c) => `<button class="manage-nav-item manage-crd-item${state.manage.activeCrd && state.manage.activeCrd.name === c.name ? ' active' : ''}" data-crd="${escHtml(c.name)}" title="${escHtml(c.name)}">${escHtml(c.kind)}</button>`).join('');
    return header + rows;
  }).join('');
}

el.manageCrdFilter.addEventListener('input', () => renderManageCrdList(el.manageCrdFilter.value));

el.manageCrdList.addEventListener('click', (e) => {
  const groupHeader = e.target.closest('.manage-crd-group-header');
  if (groupHeader) {
    const group = groupHeader.dataset.crdGroup;
    if (_manageCrdCollapsedGroups.has(group)) _manageCrdCollapsedGroups.delete(group);
    else _manageCrdCollapsedGroups.add(group);
    renderManageCrdList(el.manageCrdFilter.value);
    return;
  }
  const btn = e.target.closest('.manage-crd-item');
  if (!btn) return;
  // CRD buttons also carry `.manage-nav-item` for shared styling — without this, the click would
  // keep bubbling into #manage-sidebar's own delegated listener and get double-handled as a
  // (bogus, kind=undefined) built-in-kind selection, clobbering the CRD selection we just made.
  e.stopPropagation();
  const crd = state.manage.crds.find((c) => c.name === btn.dataset.crd);
  if (crd) selectManageCrd(crd);
});

function selectManageCrd(crd) {
  const data = state.manage;
  data.mode = 'crd';
  data.activeCrd = crd;
  data.resourceType = null;
  data.rows = [];
  clearManageSelection();
  el.manageSidebar.querySelectorAll('.manage-nav-item').forEach((b) => b.classList.remove('active'));
  renderManageCrdList(el.manageCrdFilter.value); // re-render so the CRD's group is force-expanded and highlighted
  el.manageOverviewPane.style.display = 'none';
  el.manageRecyclebinPane.style.display = 'none';
  el.manageTableWrap.style.display = '';
  updateManageKindTitle();
  closeManageDrawer();
  stopManageOverviewPolling();
  stopManagePolling();
  stopManageWatch();
  stopManageMetricsPolling();
  if (data.context && (data.namespace || !crd.namespaced)) {
    refreshManageResources();
    startManagePolling();
  } else {
    renderManageTable(crd.name, []);
  }
}

async function refreshManageCustomResources() {
  const data = state.manage;
  const crd = data.activeCrd;
  if (!data.context || (crd.namespaced && !data.namespace)) return;
  const crdAtStart = crd;
  const nsAtStart = data.namespace;
  el.manageRefreshStatus.textContent = 'Refreshing…';
  const result = await window.k8sApi.listCustomResource(data.kubeconfig, data.context, nsAtStart, crd.group, crd.version, crd.plural, crd.namespaced);
  if (data.activeCrd !== crdAtStart || data.namespace !== nsAtStart) return;
  if (!result.ok) {
    data.rows = [];
    renderManageErrorRow(crd.name, result.error);
    el.manageRefreshStatus.textContent = `Error at ${new Date().toLocaleTimeString()}`;
    return;
  }
  data.rows = result.rows;
  renderManageTable(crd.name, data.rows);
  el.manageRefreshStatus.textContent = `Updated ${new Date().toLocaleTimeString()}`;
}

/* ── K8s Manage: global search across kinds ───────────────────────────────── */

function runGlobalManageSearch() {
  const data = state.manage;
  const query = (el.manageSearch.value || '').trim();
  if (!data.context || !query) return;
  el.manageSearchResults.style.display = 'flex';
  el.manageSearchResultsTitle.textContent = `Searching for "${query}"…`;
  el.manageSearchResultsBody.innerHTML = '';
  window.k8sApi.searchResources(data.kubeconfig, data.context, data.namespace || '', query, state.manage.crds).then((result) => {
    if (!result.ok) {
      el.manageSearchResultsTitle.textContent = `Search failed`;
      el.manageSearchResultsBody.innerHTML = `<div class="manage-empty">${escHtml(result.error)}</div>`;
      return;
    }
    el.manageSearchResultsTitle.textContent = `${result.results.length} result(s) for "${query}"`;
    if (result.results.length === 0) {
      el.manageSearchResultsBody.innerHTML = '<div class="manage-empty">No matches</div>';
      return;
    }
    el.manageSearchResultsBody.innerHTML = result.results.map((r, i) => `
      <div class="manage-search-result-row" data-index="${i}" data-namespace="${escHtml(r.namespace || '')}" data-name="${escHtml(r.name)}">
        <span class="manage-search-result-kind">${escHtml(r.crd ? r.kind : (MANAGE_KIND_LABEL_PLURAL[r.kind] || r.kind))}</span>
        <span class="manage-search-result-name">${escHtml(r.namespace ? `${r.namespace}/${r.name}` : r.name)}</span>
      </div>`).join('')
      + (result.errors.length ? `<div class="manage-search-errors">Couldn't search: ${result.errors.map((e) => `${e.kind} (${e.error})`).join(', ')}</div>` : '');

    el.manageSearchResultsBody.querySelectorAll('.manage-search-result-row').forEach((rowEl) => {
      rowEl.addEventListener('click', () => {
        const r = result.results[Number(rowEl.dataset.index)];
        const namespace = rowEl.dataset.namespace;
        const name = rowEl.dataset.name;
        closeManageSearchResults();

        if (r.crd) {
          const crd = state.manage.crds.find((c) => c.group === r.group && c.version === r.version && c.plural === r.plural);
          if (!crd) return;
          selectManageCrd(crd);
          const applyRow = () => {
            const row = state.manage.rows.find((row2) => row2.name === name && (row2.namespace || '') === namespace);
            if (row) openManageDrawer(crd.name, row);
          };
          if (namespace && el.manageNamespace.querySelector(`option[value="${CSS.escape(namespace)}"]`)) {
            el.manageNamespace.value = namespace;
            state.manage.namespace = namespace;
          } else if (crd.namespaced) {
            el.manageNamespace.value = MANAGE_ALL_NAMESPACES;
            state.manage.namespace = MANAGE_ALL_NAMESPACES;
          }
          refreshManageCustomResources().then(applyRow);
          return;
        }

        const kind = r.kind;
        selectManageKind(kind);
        const applyRow = () => {
          const row = state.manage.rows.find((row2) => row2.name === name && (row2.namespace || '') === namespace);
          if (row) openManageDrawer(kind, row);
        };
        if (namespace && el.manageNamespace.querySelector(`option[value="${CSS.escape(namespace)}"]`)) {
          el.manageNamespace.value = namespace;
          state.manage.namespace = namespace;
        } else if (!MANAGE_CLUSTER_SCOPED_KINDS.includes(kind)) {
          el.manageNamespace.value = MANAGE_ALL_NAMESPACES;
          state.manage.namespace = MANAGE_ALL_NAMESPACES;
        }
        // selectManageKind(kind) above already schedules the right live-update mechanism
        // (poll or watch) via its own debounce — this fetch is just to open the drawer now.
        refreshManageResources().then(applyRow);
      });
    });
  });
}

function closeManageSearchResults() {
  el.manageSearchResults.style.display = 'none';
}

el.manageSearchAllBtn.addEventListener('click', runGlobalManageSearch);
el.manageSearch.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') runGlobalManageSearch();
});
el.manageSearchResultsClose.addEventListener('click', closeManageSearchResults);

const MANAGE_KIND_LABEL_PLURAL = {
  pods: 'Pod', deployments: 'Deployment', statefulsets: 'StatefulSet', daemonsets: 'DaemonSet',
  replicasets: 'ReplicaSet', services: 'Service', ingresses: 'Ingress', configmaps: 'ConfigMap',
  secrets: 'Secret', jobs: 'Job', cronjobs: 'CronJob', pvcs: 'PVC', hpas: 'HPA', nodes: 'Node',
  pvs: 'PV', namespaces: 'Namespace', serviceaccounts: 'ServiceAccount', roles: 'Role',
  rolebindings: 'RoleBinding', clusterroles: 'ClusterRole', clusterrolebindings: 'ClusterRoleBinding',
  networkpolicies: 'NetworkPolicy', storageclasses: 'StorageClass', resourcequotas: 'ResourceQuota',
  limitranges: 'LimitRange',
};


function startManageMetricsPolling() {
  stopManageMetricsPolling();
  if (!state.manage.enableAutoRefresh || !state.manage.enableMetrics) return;
  if (!MANAGE_METRICS_KINDS.includes(state.manage.resourceType)) return;
  refreshManageMetrics();
  state.manage.metricsPollTimer = setInterval(refreshManageMetrics, MANAGE_METRICS_POLL_INTERVAL);
}

function stopManageMetricsPolling() {
  if (state.manage.metricsPollTimer) {
    clearInterval(state.manage.metricsPollTimer);
    state.manage.metricsPollTimer = null;
  }
  state.manage.metricsSeries.clear();
  state.manage.metricsAvailable = true;
}

async function refreshManageMetrics() {
  const data = state.manage;
  if (!data.enableMetrics) return;
  const kindAtStart = data.resourceType;
  const nsAtStart = data.namespace;
  if (!MANAGE_METRICS_KINDS.includes(kindAtStart) || !data.context || !nsAtStart) return;

  const result = await window.k8sApi.getMetrics(data.kubeconfig, data.context, nsAtStart, kindAtStart);
  // Kind/namespace may have changed while this request was in flight — drop stale responses.
  if (data.resourceType !== kindAtStart || data.namespace !== nsAtStart) return;

  if (!result.ok) {
    data.metricsAvailable = false;
    if (data.metricsPollTimer) {
      clearInterval(data.metricsPollTimer);
      data.metricsPollTimer = null;
    }
    renderManageMetricsPane();
    return;
  }

  data.metricsAvailable = true;
  const now = Date.now();
  for (const row of result.rows) {
    const key = metricsKey(row);
    let series = data.metricsSeries.get(key);
    if (!series) { series = []; data.metricsSeries.set(key, series); }
    series.push({ t: now, cpu: row.cpu, mem: row.memory });
    if (series.length > MANAGE_METRICS_MAX_POINTS) series.shift();
  }
  renderManageMetricsSparklines();
  if (el.manageMetricsPane.style.display === 'flex') renderManageMetricsPane();
}

// Draws a filled line chart into `container` from `points` (each mapped through opts.accessor).
// Reused for both the compact table sparklines (.manage-spark) and the bigger drawer charts (.manage-chart).
function renderSparkline(container, points, opts) {
  const { accessor, color } = opts || {};
  const values = points.map((p) => (accessor ? accessor(p) : p));
  if (values.length < 2) {
    container.innerHTML = '';
    return;
  }
  const w = 100, h = 30;
  const max = Math.max(...values, 1);
  const stepX = w / (values.length - 1);
  const coords = values.map((v, i) => [i * stepX, h - (v / max) * h]);
  const linePath = coords.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const areaPath = `${linePath} L${w},${h} L0,${h} Z`;
  const stroke = color || 'var(--accent)';
  container.innerHTML = `
    <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
      <line x1="0" y1="${h - 0.5}" x2="${w}" y2="${h - 0.5}" stroke="var(--border)" stroke-width="1" />
      <path d="${areaPath}" fill="${stroke}" fill-opacity="0.15" stroke="none" />
      <path d="${linePath}" fill="none" stroke="${stroke}" stroke-width="1.5" />
    </svg>`;
}

function renderManageMetricsSparklines() {
  const data = state.manage;
  el.manageTbody.querySelectorAll('.manage-spark').forEach((node) => {
    const series = data.metricsSeries.get(node.dataset.row);
    if (!series || !series.length) return;
    // Skip re-render if the series hasn't grown since the last render.
    const len = series.length;
    if (node._lastSeriesLen === len) return;
    node._lastSeriesLen = len;
    const metric = node.dataset.metric;
    renderSparkline(node, series, { accessor: (p) => (metric === 'cpu' ? p.cpu : p.mem) });
  });
}

function renderManageMetricsPane() {
  const data = state.manage;
  if (!data.metricsAvailable) {
    el.manageMetricsPane.innerHTML = '<div class="manage-empty">Metrics server not installed or unreachable.</div>';
    return;
  }
  const row = data.selected;
  if (!row) return;
  const series = data.metricsSeries.get(metricsKey(row)) || [];
  const latest = series[series.length - 1];
  el.manageMetricsPane.innerHTML = `
    <div class="manage-chart-block">
      <div class="manage-chart-header">
        <span class="manage-chart-title">CPU</span>
        <span class="manage-chart-value">${latest ? `${Math.round(latest.cpu)}m` : '—'}</span>
      </div>
      <div id="manage-chart-cpu" class="manage-chart"></div>
    </div>
    <div class="manage-chart-block">
      <div class="manage-chart-header">
        <span class="manage-chart-title">Memory</span>
        <span class="manage-chart-value">${latest ? `${(latest.mem / (1024 ** 2)).toFixed(0)} MiB` : '—'}</span>
      </div>
      <div id="manage-chart-mem" class="manage-chart"></div>
    </div>`;
  renderSparkline($('manage-chart-cpu'), series, { accessor: (p) => p.cpu });
  renderSparkline($('manage-chart-mem'), series, { accessor: (p) => p.mem });
}

/* ════════════════════════════════════════════════════════════════════════════
   K8S MANAGE — drawer (detail + pod logs)
   ════════════════════════════════════════════════════════════════════════════ */
function openManageDrawer(kind, row) {
  stopManageLogs();
  stopManageExec();
  state.manage.selected = row;
  state.manage.revealSecrets = false;
  state.manage.yamlEditing = false;
  el.manageYamlReveal.checked = false;
  el.manageDrawer.classList.add('open');
  // In CRD mode, append the Kind+group so two same-named resources under different API groups
  // (e.g. Traefik's Middleware in both traefik.io and traefik.containo.us) aren't ambiguous here.
  el.manageDrawerTitle.textContent = (state.manage.mode === 'crd' && state.manage.activeCrd)
    ? `${row.name || '—'}  ·  ${state.manage.activeCrd.kind} (${state.manage.activeCrd.group || '(core)'})`
    : (row.name || '—');
  renderManageDetail(kind, row);
  renderManageDrawerActions(kind, row);

  const isPod = kind === 'pods' && state.manage.mode === 'kind';
  const isMetricsKind = state.manage.mode === 'kind' && MANAGE_METRICS_KINDS.includes(kind) && state.manage.enableMetrics;
  const logsTabBtn = el.manageDrawer.querySelector('.manage-tab[data-tab="logs"]');
  const execTabBtn = el.manageDrawer.querySelector('.manage-tab[data-tab="exec"]');
  const pfTabBtn = el.manageDrawer.querySelector('.manage-tab[data-tab="portforward"]');
  const metricsTabBtn = el.manageDrawer.querySelector('.manage-tab[data-tab="metrics"]');
  logsTabBtn.style.display = isPod ? '' : 'none';
  execTabBtn.style.display = isPod ? '' : 'none';
  pfTabBtn.style.display = isPod ? '' : 'none';
  metricsTabBtn.style.display = isMetricsKind ? '' : 'none';
  el.manageYamlRevealLabel.style.display = (state.manage.mode === 'kind' && kind === 'secrets') ? '' : 'none';
  if (isPod) {
    populateManageLogContainerPicker(row.containers || []);
    populateManageExecContainerPicker(row.containers || []);
  }

  switchManageTab('detail');
}

function closeManageDrawer() {
  stopManageLogs();
  stopManageExec();
  state.manage.selected = null;
  state.manage.revealSecrets = false;
  state.manage.yamlEditing = false;
  el.manageDrawer.classList.remove('open');
}

el.manageDrawerClose.addEventListener('click', closeManageDrawer);

function renderManageDetail(kind, row) {
  const cols = getManageColumns(kind).filter((c) => !c.spark);
  el.manageDetailPane.innerHTML = cols.map((c) => {
    const val = c.age ? relAge(row[c.key]) : row[c.key];
    return `
      <div class="manage-detail-row">
        <span class="manage-detail-key">${escHtml(c.label)}</span>
        <span class="manage-detail-value">${escHtml(val ?? '')}</span>
      </div>`;
  }).join('');
}

/* ── K8s Manage: safe resource actions ────────────────────────────────────── */

// Fixed, per-kind action set — mirrors the allow-list enforced server-side in main.js.
function getManageActionsFor(kind, row) {
  const actions = [];
  if (['deployments', 'statefulsets', 'daemonsets'].includes(kind)) {
    actions.push({ action: 'restart', label: 'Restart' });
  }
  if (['deployments', 'statefulsets'].includes(kind)) {
    actions.push({ action: 'scale', label: 'Scale' });
  }
  if (kind === 'nodes') {
    actions.push(row.unschedulable
      ? { action: 'uncordon', label: 'Uncordon' }
      : { action: 'cordon', label: 'Cordon' });
  }
  actions.push({ action: 'delete', label: 'Delete', danger: true });
  return actions;
}

function renderManageDrawerActions(kind, row) {
  const actions = getManageActionsFor(kind, row);
  const locked = !state.manage.writeUnlocked;
  el.manageDrawerActions.innerHTML = actions
    .map((a) => {
      const disabled = locked ? ' disabled' : '';
      const title = locked ? ' title="Enable Audit in Settings to unlock"' : '';
      return `<button class="btn btn-xs ${a.danger ? 'btn-danger' : 'btn-ghost'}" data-action="${a.action}"${disabled}${title}>${escHtml(a.label)}</button>`;
    })
    .join('');
  el.manageDrawerActions.querySelectorAll('button[data-action]').forEach((btn) => {
    if (!btn.disabled) btn.addEventListener('click', () => runManageAction(kind, row, btn.dataset.action));
  });
}

// Reusable confirm modal — supports a plain yes/no confirm, a type-the-name gate (delete), or a
// numeric-input gate (scale). Resolves { ok:false } on cancel, { ok:true, value? } on confirm.
function showManageConfirm({ title, body, danger, confirmLabel = 'Confirm', typedValue, numberInput }) {
  return new Promise((resolve) => {
    el.manageConfirmTitle.textContent = title;
    el.manageConfirmBody.textContent = body;
    el.manageConfirmOk.textContent = confirmLabel;
    el.manageConfirmOk.classList.toggle('btn-danger', !!danger);
    el.manageConfirmOk.classList.toggle('btn-primary', !danger);

    const useNumber = !!numberInput;
    el.manageConfirmInput.style.display = (typedValue || useNumber) ? '' : 'none';
    el.manageConfirmInput.type = useNumber ? 'number' : 'text';
    el.manageConfirmInput.min = useNumber ? '0' : '';
    el.manageConfirmInput.placeholder = typedValue ? `Type "${typedValue}" to confirm` : (useNumber ? 'New replica count' : '');
    el.manageConfirmInput.value = useNumber ? String(numberInput.current ?? 0) : '';

    const updateOkState = () => {
      if (typedValue) el.manageConfirmOk.disabled = el.manageConfirmInput.value !== typedValue;
      else if (useNumber) {
        const n = Number(el.manageConfirmInput.value);
        el.manageConfirmOk.disabled = !Number.isInteger(n) || n < 0;
      } else el.manageConfirmOk.disabled = false;
    };
    updateOkState();
    el.manageConfirmInput.oninput = updateOkState;

    el.manageConfirmOverlay.style.display = 'flex';
    if (typedValue || useNumber) el.manageConfirmInput.focus();

    const cleanup = (result) => {
      el.manageConfirmOverlay.style.display = 'none';
      el.manageConfirmOk.onclick = null;
      el.manageConfirmCancel.onclick = null;
      el.manageConfirmInput.oninput = null;
      resolve(result);
    };
    el.manageConfirmCancel.onclick = () => cleanup({ ok: false });
    el.manageConfirmOk.onclick = () => cleanup({ ok: true, value: useNumber ? Number(el.manageConfirmInput.value) : undefined });
  });
}

const MANAGE_KIND_SINGULAR = {
  pods: 'pod', deployments: 'deployment', statefulsets: 'statefulset', daemonsets: 'daemonset',
  replicasets: 'replicaset', services: 'service', ingresses: 'ingress', configmaps: 'configmap',
  secrets: 'secret', jobs: 'job', cronjobs: 'cronjob', pvcs: 'persistent volume claim',
  hpas: 'horizontal pod autoscaler', nodes: 'node', pvs: 'persistent volume', namespaces: 'namespace', events: 'event',
  serviceaccounts: 'service account', roles: 'role', rolebindings: 'role binding',
  clusterroles: 'cluster role', clusterrolebindings: 'cluster role binding',
  networkpolicies: 'network policy', storageclasses: 'storage class',
  resourcequotas: 'resource quota', limitranges: 'limit range',
};

async function runManageAction(kind, row, action) {
  let payload;
  if (action === 'delete') {
    const { ok } = await showManageConfirm({
      title: `Delete ${row.name}?`,
      body: `This permanently deletes this ${MANAGE_KIND_SINGULAR[kind] || kind}. Type its name to confirm.`,
      danger: true,
      confirmLabel: 'Delete',
      typedValue: row.name,
    });
    if (!ok) return;
  } else if (action === 'restart') {
    const { ok } = await showManageConfirm({
      title: `Restart rollout for ${row.name}?`,
      body: 'This restarts every pod managed by this resource, one at a time.',
      confirmLabel: 'Restart',
    });
    if (!ok) return;
  } else if (action === 'scale') {
    const current = row.ready ? Number(String(row.ready).split('/')[1]) || 0 : 0;
    const { ok, value } = await showManageConfirm({
      title: `Scale ${row.name}`,
      body: 'Enter the new replica count.',
      confirmLabel: 'Scale',
      numberInput: { current },
    });
    if (!ok) return;
    payload = { replicas: value };
  } else if (action === 'cordon' || action === 'uncordon') {
    const { ok } = await showManageConfirm({
      title: `${action === 'cordon' ? 'Cordon' : 'Uncordon'} ${row.name}?`,
      body: action === 'cordon'
        ? 'Marks the node unschedulable — no new pods will be scheduled here.'
        : 'Marks the node schedulable again.',
      confirmLabel: action === 'cordon' ? 'Cordon' : 'Uncordon',
    });
    if (!ok) return;
  }

  const data = state.manage;
  const result = data.mode === 'crd'
    ? await window.k8sApi.customResourceAction(
        data.kubeconfig, data.context, manageRowNamespace(row),
        data.activeCrd.group, data.activeCrd.version, data.activeCrd.plural, row.name, data.activeCrd.namespaced, action
      )
    : await window.k8sApi.resourceAction(data.kubeconfig, data.context, manageRowNamespace(row), kind, row.name, action, payload);
  if (!result.ok) {
    alert(`Action failed: ${result.error}`);
    return;
  }
  if (action === 'delete') closeManageDrawer();
  refreshManageResources();
}

el.manageTabs.forEach((btn) => {
  btn.addEventListener('click', () => switchManageTab(btn.dataset.tab));
});

function switchManageTab(tab) {
  el.manageTabs.forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  el.manageDetailPane.style.display = tab === 'detail' ? '' : 'none';
  el.manageYamlPane.style.display = tab === 'yaml' ? 'flex' : 'none';
  el.manageEventsPane.style.display = tab === 'events' ? 'flex' : 'none';
  el.manageAccessPane.style.display = tab === 'access' ? 'flex' : 'none';
  el.manageLogsPane.style.display = tab === 'logs' ? 'flex' : 'none';
  el.manageExecPane.style.display = tab === 'exec' ? 'flex' : 'none';
  el.managePfPane.style.display = tab === 'portforward' ? 'flex' : 'none';
  el.manageMetricsPane.style.display = tab === 'metrics' ? 'flex' : 'none';
  el.manageHistoryPane.style.display = tab === 'history' ? 'flex' : 'none';
  if (tab === 'yaml') loadManageYaml();
  if (tab === 'events') loadManageEvents();
  if (tab === 'access') loadManageAccess();
  if (tab === 'logs') {
    if (el.manageLogContainer.value) startManageLogs();
  } else {
    stopManageLogs();
  }
  if (tab === 'exec') {
    if (el.manageExecContainer.value) startManageExec();
  } else {
    stopManageExec();
  }
  // Port-forwards are independent background proxies, not tied to this pod/tab —
  // switching away must NOT stop them, only refresh the list when switching in.
  if (tab === 'portforward') {
    renderManagePortForwardList();
  }
  if (tab === 'metrics') {
    renderManageMetricsPane();
  }
  if (tab === 'history') {
    loadManageHistory();
  }
}

// Line-number gutter, shared by the read-only <pre> and the edit <textarea> so both views
// share identical layout. Gutter scrolls in lockstep with whichever element is visible.
function updateManageYamlGutter(text) {
  const count = Math.max(1, (text || '').split('\n').length);
  const numbers = [];
  for (let i = 1; i <= count; i++) numbers.push(i);
  el.manageYamlGutter.textContent = numbers.join('\n');
  el.manageYamlGutter.scrollTop = 0;
}

// In view mode the <pre> is the scroller (syncs the gutter). In edit mode the transparent
// <textarea> sits on top and is the real scroller, so it must mirror both axes to the <pre>
// behind it plus the gutter's vertical offset.
function syncManageYamlScroll() {
  el.manageYamlOutput.scrollTop  = el.manageYamlTextarea.scrollTop;
  el.manageYamlOutput.scrollLeft = el.manageYamlTextarea.scrollLeft;
  el.manageYamlGutter.scrollTop  = el.manageYamlTextarea.scrollTop;
}

// Re-highlight the <pre> layer + gutter from the current textarea value, then re-sync scroll.
// Call after any programmatic change to textarea.value (assignment does not fire 'input').
function refreshManageYamlEditLayer() {
  el.manageYamlOutput.innerHTML = highlightYaml(el.manageYamlTextarea.value);
  updateManageYamlGutter(el.manageYamlTextarea.value);
  syncManageYamlScroll();
}

el.manageYamlOutput.addEventListener('scroll', () => {
  el.manageYamlGutter.scrollTop = el.manageYamlOutput.scrollTop;
});
el.manageYamlTextarea.addEventListener('scroll', syncManageYamlScroll);
el.manageYamlTextarea.addEventListener('input', refreshManageYamlEditLayer);

// Tab / Shift+Tab indent by 2 spaces (YAML uses spaces, never literal tabs).
el.manageYamlTextarea.addEventListener('keydown', (e) => {
  if (e.key !== 'Tab') return;
  e.preventDefault();
  const ta = el.manageYamlTextarea;
  const INDENT = '  ';
  const val = ta.value;
  const selStart = ta.selectionStart;
  const selEnd = ta.selectionEnd;

  // Multi-line selection (or Shift+Tab): operate on whole affected lines.
  if (e.shiftKey || val.slice(selStart, selEnd).includes('\n')) {
    const lineStart = val.lastIndexOf('\n', selStart - 1) + 1;
    const block = val.slice(lineStart, selEnd);
    let newBlock, delta, firstLineDelta;
    if (e.shiftKey) {
      let removedFirst = 0, removedTotal = 0, seenFirst = false;
      newBlock = block.split('\n').map((line) => {
        const strip = line.startsWith('  ') ? 2 : line.startsWith(' ') ? 1 : 0;
        if (!seenFirst) { removedFirst = strip; seenFirst = true; }
        removedTotal += strip;
        return line.slice(strip);
      }).join('\n');
      firstLineDelta = -removedFirst;
      delta = -removedTotal;
    } else {
      const lines = block.split('\n');
      newBlock = lines.map((line) => INDENT + line).join('\n');
      firstLineDelta = INDENT.length;
      delta = INDENT.length * lines.length;
    }
    ta.value = val.slice(0, lineStart) + newBlock + val.slice(selEnd);
    ta.selectionStart = Math.max(lineStart, selStart + firstLineDelta);
    ta.selectionEnd = selEnd + delta;
  } else {
    // Collapsed caret (or single-line selection): insert 2 spaces at the caret.
    ta.value = val.slice(0, selStart) + INDENT + val.slice(selEnd);
    ta.selectionStart = ta.selectionEnd = selStart + INDENT.length;
  }
  refreshManageYamlEditLayer();
});

// Fetches are one-shot (not polled); each captures the resource identity at request time and
// drops the response if the user has since selected a different row/kind/namespace.
async function loadManageYaml() {
  const data = state.manage;
  const row = data.selected;
  if (!row) return;
  data.yamlEditing = false;
  switchManageYamlView();
  el.manageYamlOutput.textContent = 'Loading…';
  updateManageYamlGutter('Loading…');

  if (data.mode === 'crd') {
    const crd = data.activeCrd;
    const result = await window.k8sApi.getCustomResourceYaml(
      data.kubeconfig, data.context, manageRowNamespace(row), crd.group, crd.version, crd.plural, row.name, crd.namespaced
    );
    if (!isSameResource(data.selected, row)) return;
    if (result.ok) el.manageYamlOutput.innerHTML = highlightYaml(result.yaml);
    else el.manageYamlOutput.textContent = `Error: ${result.error}`;
    updateManageYamlGutter(result.ok ? result.yaml : result.error);
    data.yamlEditable = result.ok ? result.editable !== false : false;
    renderManageYamlEditGate();
    return;
  }

  const kind = data.resourceType;
  const result = await window.k8sApi.getResourceYaml(
    data.kubeconfig, data.context, manageRowNamespace(row), kind, row.name, { reveal: data.revealSecrets }
  );
  if (!isSameResource(data.selected, row) || data.resourceType !== kind) return;
  if (result.ok) el.manageYamlOutput.innerHTML = highlightYaml(result.yaml);
  else el.manageYamlOutput.textContent = `Error: ${result.error}`;
  updateManageYamlGutter(result.ok ? result.yaml : result.error);
  data.yamlEditable = result.ok ? result.editable !== false : false;
  renderManageYamlEditGate();
}

function renderManageYamlEditGate() {
  const data = state.manage;
  const canEdit = data.yamlEditable && data.writeUnlocked;
  el.manageYamlEdit.disabled = !canEdit;
  if (!data.writeUnlocked) {
    el.manageYamlEdit.title = 'Enable Audit in Settings to unlock editing';
  } else if (!data.yamlEditable) {
    el.manageYamlEdit.title = 'Enable "Reveal secret values" to edit this Secret';
  } else {
    el.manageYamlEdit.title = '';
  }
}

function switchManageYamlView() {
  const editing = state.manage.yamlEditing;
  // The highlighted <pre> is always the visible layer; in edit mode the transparent
  // <textarea> overlays it to capture input while the <pre> shows live-highlighted text.
  el.manageYamlOutput.style.display = '';
  el.manageYamlTextarea.style.display = editing ? '' : 'none';
  el.manageYamlEdit.style.display = editing ? 'none' : '';
  el.manageYamlSave.style.display = editing ? '' : 'none';
  el.manageYamlCancel.style.display = editing ? '' : 'none';
  el.manageYamlReload.style.display = 'none';
  el.manageYamlCopy.style.display = editing ? 'none' : '';
  el.manageYamlError.style.display = 'none';
}

async function enterManageYamlEdit() {
  const data = state.manage;
  const row = data.selected;
  if (!row || !data.yamlEditable || !data.writeUnlocked) return;
  el.manageYamlError.style.display = 'none';
  el.manageYamlOutput.textContent = 'Loading…';
  updateManageYamlGutter('Loading…');

  let result;
  if (data.mode === 'crd') {
    const crd = data.activeCrd;
    result = await window.k8sApi.getCustomResourceYaml(
      data.kubeconfig, data.context, manageRowNamespace(row), crd.group, crd.version, crd.plural, row.name, crd.namespaced, { forEdit: true }
    );
  } else {
    result = await window.k8sApi.getResourceYaml(
      data.kubeconfig, data.context, manageRowNamespace(row), data.resourceType, row.name, { reveal: data.revealSecrets, forEdit: true }
    );
  }
  if (!isSameResource(data.selected, row)) return; // stale guard — user switched rows while this was in flight
  if (!result.ok) {
    el.manageYamlOutput.textContent = `Error: ${result.error}`;
    updateManageYamlGutter(result.error);
    return;
  }
  data.yamlEditing = true;
  el.manageYamlTextarea.value = result.yaml;
  el.manageYamlOutput.innerHTML = highlightYaml(result.yaml); // highlight layer matches from the first frame
  updateManageYamlGutter(result.yaml);
  switchManageYamlView();
}

function cancelManageYamlEdit() {
  state.manage.yamlEditing = false;
  loadManageYaml(); // back to the plain read-only view with a fresh fetch
}

async function saveManageYamlEdit() {
  const data = state.manage;
  const row = data.selected;
  if (!row) return;
  const { ok } = await showManageConfirm({
    title: `Apply changes to ${row.name}?`,
    body: 'This overwrites the resource on the cluster with your edited YAML.',
    confirmLabel: 'Apply',
  });
  if (!ok) return;

  const yamlText = el.manageYamlTextarea.value;
  let result;
  if (data.mode === 'crd') {
    const crd = data.activeCrd;
    result = await window.k8sApi.applyCustomResourceYaml(
      data.kubeconfig, data.context, manageRowNamespace(row), crd.group, crd.version, crd.plural, row.name, crd.namespaced, yamlText,
      row.metadata?.resourceVersion
    );
  } else {
    result = await window.k8sApi.applyResourceYaml(
      data.kubeconfig, data.context, manageRowNamespace(row), data.resourceType, row.name, yamlText,
      row.metadata?.resourceVersion
    );
  }
  if (!isSameResource(data.selected, row)) return; // stale guard

  if (!result.ok) {
    el.manageYamlError.style.display = '';
    el.manageYamlError.textContent = result.error;
    el.manageYamlReload.style.display = result.kind === 'conflict' ? '' : 'none';
    return;
  }
  el.manageYamlError.style.display = 'none';
  el.manageYamlReload.style.display = 'none';
  data.yamlEditing = false;
  el.manageYamlOutput.innerHTML = highlightYaml(result.yaml); // the visible <pre> — was left stuck on "Loading…" otherwise
  el.manageYamlTextarea.value = result.yaml;
  updateManageYamlGutter(result.yaml);
  switchManageYamlView();
  refreshManageResources(); // row list may reflect the change (e.g. labels, replicas)
}

el.manageYamlCopy.addEventListener('click', () => {
  navigator.clipboard.writeText(el.manageYamlOutput.textContent || '');
});

el.manageYamlReveal.addEventListener('change', () => {
  state.manage.revealSecrets = el.manageYamlReveal.checked;
  // The resourceVersion snapshot and redaction state are now stale — bail out of edit mode.
  if (state.manage.yamlEditing) state.manage.yamlEditing = false;
  loadManageYaml();
});

el.manageYamlEdit.addEventListener('click', enterManageYamlEdit);
el.manageYamlCancel.addEventListener('click', cancelManageYamlEdit);
el.manageYamlSave.addEventListener('click', saveManageYamlEdit);
el.manageYamlReload.addEventListener('click', enterManageYamlEdit);

async function loadManageEvents() {
  const data = state.manage;
  const row = data.selected;
  if (!row) return;
  el.manageEventsThead.innerHTML = `<tr>${MANAGE_EVENTS_PANE_COLUMNS.map((c) => `<th>${escHtml(c.label)}</th>`).join('')}</tr>`;
  el.manageEventsTbody.innerHTML = `<tr><td colspan="${MANAGE_EVENTS_PANE_COLUMNS.length}" class="manage-empty">Loading…</td></tr>`;

  const namespace = manageRowNamespace(row);
  const kindLabel = data.mode === 'crd' ? data.activeCrd.kind : MANAGE_KIND_LABEL[data.resourceType];

  // Fetch song song live events và local events
  const [liveRes, localRes] = await Promise.all([
    data.mode === 'crd'
      ? window.k8sApi.getCustomResourceEvents(data.kubeconfig, data.context, namespace, data.activeCrd.kind, row.name, data.activeCrd.namespaced)
      : window.k8sApi.getResourceEvents(data.kubeconfig, data.context, namespace, data.resourceType, row.name),
    window.k8sApi.getLocalEvents({ namespace, kind: kindLabel, name: row.name })
  ]);

  if (!isSameResource(data.selected, row)) return;

  const liveRows = liveRes.ok ? liveRes.rows : [];
  const localRows = localRes.ok ? localRes.rows : [];

  if (!liveRes.ok && !localRes.ok) {
    el.manageEventsTbody.innerHTML = `<tr><td colspan="${MANAGE_EVENTS_PANE_COLUMNS.length}" class="manage-empty">Failed to load events: ${escHtml(liveRes.error || localRes.error)}</td></tr>`;
    return;
  }

  // Merge events theo UID
  const mergedMap = new Map();

  // Local events trước
  for (const r of localRows) {
    if (r.uid) {
      mergedMap.set(r.uid, r);
    }
  }

  // Live events ghi đè lên local events nếu cùng UID
  for (const r of liveRows) {
    const key = r.uid || `${r.reason}-${r.message}-${r._ts}`;
    mergedMap.set(key, r);
  }

  const mergedRows = Array.from(mergedMap.values());

  if (mergedRows.length === 0) {
    el.manageEventsTbody.innerHTML = `<tr><td colspan="${MANAGE_EVENTS_PANE_COLUMNS.length}" class="manage-empty">No events</td></tr>`;
    return;
  }

  // Sắp xếp theo timestamp giảm dần
  const getEventTs = (e) => e._ts || e.lastTimestamp || e.lastSeen || 0;
  mergedRows.sort((a, b) => new Date(getEventTs(b)) - new Date(getEventTs(a)));

  el.manageEventsTbody.innerHTML = mergedRows.map((r) => {
    const eventAge = r.age ? r.age : relAge(r.lastTimestamp);
    return `
      <tr>${MANAGE_EVENTS_PANE_COLUMNS.map((c) => {
        let val = r[c.key];
        if (c.age) {
          val = eventAge;
        }
        
        if (c.key === 'type' && r.isLocalDb) {
          return `<td><span class="status-pill manage-status-local" title="Loaded from local SQLite DB">💾 ${escHtml(val)}</span></td>`;
        }
        return `<td>${escHtml(val ?? '')}</td>`;
      }).join('')}</tr>`;
  }).join('');
}

async function loadManageAccess() {
  const data = state.manage;
  const row = data.selected;
  if (!row) return;
  el.manageAccessTbody.innerHTML = `<tr><td colspan="3" class="manage-empty">Checking…</td></tr>`;

  let result;
  if (data.mode === 'crd') {
    const crd = data.activeCrd;
    const crdAtStart = crd;
    result = await window.k8sApi.checkCustomResourceAccess(
      data.kubeconfig, data.context, manageRowNamespace(row), crd.group, crd.plural, crd.namespaced, row.name
    );
    if (!isSameResource(data.selected, row) || data.activeCrd !== crdAtStart) return;
  } else {
    const kind = data.resourceType;
    result = await window.k8sApi.checkAccess(data.kubeconfig, data.context, manageRowNamespace(row), kind, row.name);
    if (!isSameResource(data.selected, row) || data.resourceType !== kind) return;
  }

  if (!result.ok) {
    el.manageAccessTbody.innerHTML = `<tr><td colspan="3" class="manage-empty">${escHtml(result.error)}</td></tr>`;
    return;
  }
  el.manageAccessTbody.innerHTML = result.rows.map((r) => `
    <tr>
      <td>${escHtml(r.verb)}</td>
      <td><span class="status-pill ${r.allowed ? 'manage-status-running' : 'manage-status-error'}">${r.allowed ? 'Allowed' : 'Denied'}</span></td>
      <td>${escHtml(r.reason)}</td>
    </tr>`).join('');
}

function populateManageLogContainerPicker(containers) {
  el.manageLogContainer.innerHTML = '';
  containers.forEach((name) => {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    el.manageLogContainer.appendChild(opt);
  });
  el.manageLogContainer.disabled = containers.length === 0;
}


function populateManageExecContainerPicker(containers) {
  el.manageExecContainer.innerHTML = '';
  containers.forEach((name) => {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    el.manageExecContainer.appendChild(opt);
  });
  el.manageExecContainer.disabled = containers.length === 0;
}

el.manageLogContainer.addEventListener('change', () => {
  if (el.manageLogsPane.style.display === 'flex') startManageLogs();
});
el.manageExecContainer.addEventListener('change', () => {
  if (el.manageExecPane.style.display === 'flex') startManageExec();
});

el.manageLogFollow.addEventListener('change', () => {
  if (el.manageLogFollow.checked) el.manageLogOutput.scrollTop = el.manageLogOutput.scrollHeight;
});

el.manageLogClear.addEventListener('click', () => { el.manageLogOutput.textContent = ''; _logLineCount = 0; });

// User scrolling away from the bottom while following turns follow-tail off —
// scrolling back down does not turn it back on, matching Lens/kubectl-like UX.
el.manageLogOutput.addEventListener('scroll', () => {
  if (!el.manageLogFollow.checked) return;
  const nearBottom = el.manageLogOutput.scrollHeight - el.manageLogOutput.scrollTop - el.manageLogOutput.clientHeight < 30;
  if (!nearBottom) el.manageLogFollow.checked = false;
});

const MANAGE_LOG_MAX_LINES = 5000;

function startManageLogs() {
  stopManageLogs();
  const data = state.manage;
  const row = data.selected;
  const container = el.manageLogContainer.value;
  if (!row || !container) return;

  const sid = crypto.randomUUID();
  el.manageLogOutput.textContent = '';
  _logLineCount = 0;

  // Subscribe before starting the stream so the first chunks can't race past us.
  const disposers = [
    window.k8sApi.onPodLogData(sid, (chunk) => appendLogBatch(chunk)),
    window.k8sApi.onPodLogEnd(sid, () => appendLogBatch('\n[stream ended]\n')),
    window.k8sApi.onPodLogError(sid, (msg) => appendLogBatch(`\n[error: ${msg}]\n`)),
  ];
  data.logSession = { sid, disposers };

  const tailLines = parseInt(el.manageLogTail.value, 10) || 500;
  window.k8sApi.startPodLogs(
    data.kubeconfig, data.context, manageRowNamespace(row), row.name, container,
    { follow: true, tailLines, timestamps: false },
    sid
  );
}

function stopManageLogs() {
  const session = state.manage.logSession;
  if (!session) return;
  window.k8sApi.stopPodLogs(session.sid);
  session.disposers.forEach((dispose) => dispose());
  state.manage.logSession = null;
}

let _logLineCount = 0;

function appendLogBatch(text) {
  const shouldFollow = el.manageLogFollow.checked;
  _logLineCount += (text.match(/\n/g) || []).length;
  el.manageLogOutput.textContent += text;
  // Only do the expensive split/join when we've accumulated 20% over the limit —
  // avoids re-parsing the entire log buffer on every single chunk.
  if (_logLineCount > MANAGE_LOG_MAX_LINES * 1.2) {
    const lines = el.manageLogOutput.textContent.split('\n');
    el.manageLogOutput.textContent = lines.slice(-MANAGE_LOG_MAX_LINES).join('\n');
    _logLineCount = MANAGE_LOG_MAX_LINES;
  }
  if (shouldFollow) el.manageLogOutput.scrollTop = el.manageLogOutput.scrollHeight;
}


function startManageExec() {
  stopManageExec();
  const data = state.manage;
  const row = data.selected;
  const container = el.manageExecContainer.value;
  if (!row || !container) return;

  const sid = crypto.randomUUID();
  el.manageExecStatus.textContent = 'Connecting…';

  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg-base').trim();
  const fg = getComputedStyle(document.documentElement).getPropertyValue('--text').trim();
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
  const term = new Terminal({
    convertEol: true,
    fontSize: 12,
    fontFamily: 'var(--font-mono)',
    theme: { background: bg, foreground: fg, cursor: accent },
  });
  const fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  el.manageTerm.innerHTML = '';
  term.open(el.manageTerm);
  fitAddon.fit();

  const dataDisposable = term.onData((d) => window.k8sApi.execWrite(sid, d));
  const resizeObserver = new ResizeObserver(() => {
    fitAddon.fit();
    window.k8sApi.execResize(sid, term.cols, term.rows);
  });
  resizeObserver.observe(el.manageTerm);

  // Subscribe before starting the session so the first bytes can't race past us.
  const disposers = [
    window.k8sApi.onExecData(sid, (chunk) => term.write(chunk)),
    window.k8sApi.onExecExit(sid, (status) => {
      const msg = (status && (status.message || status.status)) || 'session closed';
      term.write(`\r\n\x1b[2m[${msg}]\x1b[0m\r\n`);
      el.manageExecStatus.textContent = 'Closed';
    }),
  ];

  data.execSession = { sid, term, fitAddon, resizeObserver, dataDisposable, disposers };

  window.k8sApi.startExec(data.kubeconfig, data.context, manageRowNamespace(row), row.name, container, sid)
    .then((res) => {
      if (!data.execSession || data.execSession.sid !== sid) return; // superseded/stopped while connecting
      if (res && res.ok) {
        el.manageExecStatus.textContent = '';
        window.k8sApi.execResize(sid, term.cols, term.rows);
      } else {
        el.manageExecStatus.textContent = (res && res.error) || 'Failed to start shell';
      }
    });
}

function stopManageExec() {
  const session = state.manage.execSession;
  if (!session) return;
  window.k8sApi.stopExec(session.sid);
  session.disposers.forEach((dispose) => dispose());
  session.dataDisposable.dispose();
  session.resizeObserver.disconnect();
  session.term.dispose();
  state.manage.execSession = null;
}

/* ════════════════════════════════════════════════════════════════════════════
   K8S MANAGE — port-forward
   Forwards are independent background proxies, keyed by sid in state.manage.portForwards.
   Unlike logs/exec they are NOT tied to the drawer/tab/selected pod — they keep running
   while browsing other resources and are only stopped explicitly or at the teardown choke point.
   ════════════════════════════════════════════════════════════════════════════ */
async function startManagePortForward() {
  const data = state.manage;
  const row = data.selected;
  if (!row) return;
  const targetPort = Number(el.managePfTargetPort.value);
  if (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) {
    alert('Enter a valid pod port (1-65535).');
    return;
  }
  const localPort = el.managePfLocalPort.value ? Number(el.managePfLocalPort.value) : 0;

  const sid = crypto.randomUUID();
  const disposer = window.k8sApi.onPortForwardError(sid, (msg) => {
    alert(`Port-forward error: ${msg}`);
    stopManagePortForward(sid);
  });

  const result = await window.k8sApi.startPortForward(data.kubeconfig, data.context, manageRowNamespace(row), row.name, targetPort, localPort, sid);
  if (!result.ok) {
    disposer();
    alert(`Failed to start port-forward: ${result.error}`);
    return;
  }
  data.portForwards.set(sid, { sid, pod: row.name, targetPort, localPort: result.localPort, disposer });
  el.managePfTargetPort.value = '';
  el.managePfLocalPort.value = '';
  renderManagePortForwardList();
}

function stopManagePortForward(sid) {
  const session = state.manage.portForwards.get(sid);
  if (!session) return;
  window.k8sApi.stopPortForward(sid);
  session.disposer();
  state.manage.portForwards.delete(sid);
  renderManagePortForwardList();
}

function stopAllManagePortForwards() {
  for (const sid of Array.from(state.manage.portForwards.keys())) stopManagePortForward(sid);
}

function renderManagePortForwardList() {
  const forwards = Array.from(state.manage.portForwards.values());
  if (forwards.length === 0) {
    el.managePfList.innerHTML = '<div class="manage-empty">No active port-forwards</div>';
    return;
  }
  el.managePfList.innerHTML = forwards.map((f) => `
    <div class="manage-pf-row">
      <span class="manage-pf-desc">localhost:${escHtml(f.localPort)} → ${escHtml(f.pod)}:${escHtml(f.targetPort)}</span>
      <button class="btn btn-xs btn-ghost" data-sid="${escHtml(f.sid)}">Stop</button>
    </div>`).join('');
  el.managePfList.querySelectorAll('button[data-sid]').forEach((btn) => {
    btn.addEventListener('click', () => stopManagePortForward(btn.dataset.sid));
  });
}

el.managePfStart.addEventListener('click', startManagePortForward);

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
  } catch (e) {
    // The two IPC calls above already catch internally and resolve {ok:false} for the common
    // "az CLI / kubelogin not set up" case — this outer catch only fires for something else
    // going wrong (e.g. a broken preload bridge). Surface it visibly instead of proceeding
    // silently, but keep the same "proceed anyway" control flow either way.
    el.authCheckBannerText.textContent = `Couldn't verify authentication status: ${e.message}`;
    el.authCheckBanner.style.display = 'flex';
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

el.btnTokenReauth.addEventListener('click', async () => {
  const confirmReauth = confirm("Would you like to log out of Azure CLI and log in again?");
  if (!confirmReauth) return;
  showLoading('Logging out of Azure CLI…');
  try {
    await window.k8sApi.azLogout();
  } catch (e) {
    console.error('Logout error:', e);
  }
  hideLoading();
  showAuthModal('Sign in to Azure to continue.');
});

/* ── K8s Manage: History tab ──────────────────────────────────────────────── */

async function loadManageHistory() {
  console.log('[audit-ui] loadManageHistory triggered');
  const data = state.manage;
  const row = data.selected;
  if (!row) {
    console.log('[audit-ui] loadManageHistory aborted: no row selected');
    el.manageHistoryList.innerHTML = '<div class="manage-empty">Select a resource to view history</div>';
    return;
  }
  if (!data.auditConnected) {
    console.log('[audit-ui] loadManageHistory aborted: audit not connected');
    el.manageHistoryList.innerHTML = '<div class="manage-empty">Enable Audit in Settings to view history</div>';
    return;
  }

  el.manageHistoryList.innerHTML = '<div class="manage-empty">Loading…</div>';
  el.manageHistoryList.style.display = '';
  el.manageHistoryDiff.style.display = 'none';

  const kind = data.mode === 'crd' ? (data.activeCrd?.kind || data.activeCrd?.name || '') : data.resourceType;
  const namespace = manageRowNamespace(row);

  console.log('[audit-ui] Fetching versions for:', {
    kubeconfig: data.kubeconfig,
    context: data.context,
    namespace,
    kind,
    name: row.name
  });

  const result = await window.k8sApi.getResourceVersions(
    data.kubeconfig, data.context, namespace, kind, row.name
  );

  console.log('[audit-ui] Fetch versions result:', result);

  if (!isSameResource(data.selected, row)) {
    console.log('[audit-ui] Fetch versions stale check failed (user switched resources)');
    return; // stale
  }
  if (!result.ok) {
    console.error('[audit-ui] Fetch versions failed with error:', result.error);
    el.manageHistoryList.innerHTML = `<div class="manage-empty">Error: ${escHtml(result.error)}</div>`;
    return;
  }
  if (result.rows.length === 0) {
    console.log('[audit-ui] Fetch versions completed: 0 rows found');
    el.manageHistoryList.innerHTML = '<div class="manage-empty">No audit history for this resource</div>';
    return;
  }

  console.log(`[audit-ui] Fetch versions completed: rendering ${result.rows.length} rows`);
  state.manage.history = result.rows;
  renderHistoryList(result.rows, kind, namespace, row.name);
}

function renderHistoryList(rows, kind, namespace, name) {
  const data = state.manage;
  const crdMeta = data.mode === 'crd' ? data.activeCrd : null;

  el.manageHistoryList.innerHTML = rows.map((r) => {
    const ts = new Date(r.updated_at).toLocaleString();
    const restoreDisabled = (!data.writeUnlocked || r.action === 'delete') ? ' disabled' : '';
    return `<div class="manage-history-row" data-id="${r.id}">
      <span class="manage-history-version">v${r.edit_version}</span>
      <span class="manage-history-action ${r.action}">${r.action}</span>
      <span class="manage-history-meta">${escHtml(r.updated_by || 'unknown')} · ${ts}</span>
      <div class="manage-history-actions">
        <button class="btn btn-xs btn-ghost" data-history-diff="${r.id}">Diff</button>
        <button class="btn btn-xs btn-ghost" data-history-restore="${r.id}"${restoreDisabled}>Restore</button>
      </div>
    </div>`;
  }).join('');

  el.manageHistoryList.querySelectorAll('[data-history-diff]').forEach((btn) => {
    btn.addEventListener('click', () => showHistoryDiff(btn.dataset.historyDiff));
  });
  el.manageHistoryList.querySelectorAll('[data-history-restore]').forEach((btn) => {
    if (!btn.disabled) {
      btn.addEventListener('click', () => handleHistoryRestore(btn.dataset.historyRestore, kind, namespace, name, crdMeta));
    }
  });
}

function cleanYamlForDiff(yaml) {
  if (!yaml) return '';
  
  // 1. Strip managedFields and last-applied-configuration blocks
  const lines = yaml.split(/\r?\n/);
  const noClutter = [];
  let skipIndent = -1;
  for (const line of lines) {
    const match = line.match(/^([ \t]*)"?(managedFields|kubectl\.kubernetes\.io\/last-applied-configuration)"?:/);
    if (match) {
      skipIndent = match[1].length;
      continue;
    }
    if (skipIndent !== -1) {
      const indent = line.match(/^([ \t]*)/)[0].length;
      if (line.trim() === '' || indent > skipIndent) {
        continue;
      }
      skipIndent = -1;
    }
    noClutter.push(line);
  }
  let cleaned = noClutter.join('\n');

  // 2. Strip system metadata fields (uid, resourceVersion, generation, creationTimestamp)
  cleaned = cleaned.replace(/^[ \t]*(uid|resourceVersion|generation|creationTimestamp):.*\r?\n/gm, '');

  // 3. Strip status section at the bottom (similar to stripManifestStatus)
  cleaned = cleaned.replace(/\nstatus:\n(?:[ \t].*\n?)*/g, '\n');

  return cleaned;
}

async function showHistoryDiff(id) {
  const result = await window.k8sApi.getVersionYaml(id);
  if (!result.ok) {
    el.manageHistoryDiffOutput.textContent = `Error: ${result.error}`;
    el.manageHistoryDiff.style.display = 'flex';
    el.manageHistoryList.style.display = 'none';
    return;
  }

  const row = result.row;
  const oldYaml = cleanYamlForDiff(row.old_yaml || '');
  const newYaml = cleanYamlForDiff(row.new_yaml || '');

  let html = '';
  if (row.action === 'delete') {
    html = `<div class="manifest-diff-line manifest-diff-line-removed">${escHtml(oldYaml)}</div>`;
  } else if (!oldYaml) {
    html = `<div class="manifest-diff-line manifest-diff-line-added">${escHtml(newYaml)}</div>`;
  } else {
    const chunks = Diff.diffLines(oldYaml, newYaml);
    html = chunks.map((part) => {
      const cls = part.added ? 'manifest-diff-line-added' : part.removed ? 'manifest-diff-line-removed' : 'manifest-diff-line-same';
      const partHtml = cls === 'manifest-diff-line-same' ? highlightYaml(part.value) : escHtml(part.value);
      return `<div class="manifest-diff-line ${cls}">${partHtml.replace(/\n/g, '<br>')}</div>`;
    }).join('');
  }

  el.manageHistoryDiffOutput.innerHTML = html;
  el.manageHistoryDiff.style.display = 'flex';
  el.manageHistoryList.style.display = 'none';
}

el.manageHistoryDiffClose.addEventListener('click', () => {
  el.manageHistoryDiff.style.display = 'none';
  el.manageHistoryList.style.display = '';
});

async function handleHistoryRestore(id, kind, namespace, name, crdMeta) {
  const { ok } = await showManageConfirm({
    title: `Restore this version?`,
    body: `This will replace the current live resource with the selected version's YAML. The current state will be saved as a new audit entry.`,
    confirmLabel: 'Restore',
  });
  if (!ok) return;

  const data = state.manage;
  const result = await window.k8sApi.restoreResourceVersion(
    data.kubeconfig, data.context, namespace, kind, name, id,
    crdMeta ? { group: crdMeta.group, version: crdMeta.version, plural: crdMeta.plural, namespaced: crdMeta.namespaced } : null
  );

  if (!result.ok) {
    alert(`Restore failed: ${result.error}`);
    return;
  }

  if (result.auditWarning) {
    console.warn('[audit] Restore audit warning:', result.auditWarning);
  }

  refreshManageResources();
  loadManageHistory(); // reload history to show new entry
}

/* ── K8s Manage: Recycle Bin (restore deleted resources) ──────────────────── */

// Kinds recreated via a CREATE call in main.js — mirrors main.js's RESTORABLE_KINDS. Anything
// not in this set (pods, replicasets, events, nodes, pvs — owner-managed/infra kinds where
// recreating is meaningless) never gets a Restore button. Secrets are excluded separately below
// since their values are redacted at delete time and can't be recovered.
const RECYCLEBIN_RESTORABLE_KINDS = new Set([
  'deployments', 'statefulsets', 'daemonsets', 'services', 'ingresses', 'configmaps',
  'jobs', 'cronjobs', 'pvcs', 'hpas', 'namespaces',
  'serviceaccounts', 'roles', 'rolebindings', 'clusterroles', 'clusterrolebindings',
  'networkpolicies', 'storageclasses', 'resourcequotas', 'limitranges',
]);

// A deleted resource's `kind` column is either one of our internal keys (built-ins, e.g.
// "configmaps") or the CRD's actual Kubernetes Kind string (e.g. "Middleware") — this is how
// `recordAudit` stores it in both cases (main.js). Distinguish by checking our known key set.
function isBuiltinManageKind(kind) {
  return Object.prototype.hasOwnProperty.call(MANAGE_KIND_LABEL_PLURAL, kind);
}

// Best-effort CRD lookup by Kind label alone (no group/version to disambiguate) — the same
// limitation already exists in the History tab's getResourceVersions call, since the audit trail
// only ever stored the plain kind string for CRDs.
function findCrdMetaByKind(kind) {
  return state.manage.crds.find((c) => c.kind === kind) || null;
}

async function loadRecycleBin() {
  const data = state.manage;
  if (!data.auditConnected) {
    el.manageRecyclebinList.innerHTML = '<div class="manage-empty">Enable Audit in Settings to view deleted resources</div>';
    return;
  }
  if (!data.context) {
    el.manageRecyclebinList.innerHTML = '<div class="manage-empty">Select a context to view deleted resources</div>';
    return;
  }

  el.manageRecyclebinList.innerHTML = '<div class="manage-empty">Loading…</div>';
  const contextAtStart = data.context;
  const rawNamespaceAtStart = data.namespace;
  const namespaceAtStart = rawNamespaceAtStart && rawNamespaceAtStart !== MANAGE_ALL_NAMESPACES ? rawNamespaceAtStart : '';

  const result = await window.k8sApi.getDeletedResources(data.kubeconfig, contextAtStart, namespaceAtStart);
  if (data.context !== contextAtStart || data.namespace !== rawNamespaceAtStart || data.resourceType !== 'recyclebin') return; // stale

  if (!result.ok) {
    el.manageRecyclebinList.innerHTML = `<div class="manage-empty">Error: ${escHtml(result.error)}</div>`;
    return;
  }
  if (result.rows.length === 0) {
    el.manageRecyclebinList.innerHTML = '<div class="manage-empty">No deleted resources found</div>';
    return;
  }
  renderRecycleBinList(result.rows);
}

function renderRecycleBinList(rows) {
  const data = state.manage;
  el.manageRecyclebinList.innerHTML = rows.map((r) => {
    const ts = new Date(r.updated_at).toLocaleString();
    const isSecret = r.kind === 'secrets';
    const isBuiltin = isBuiltinManageKind(r.kind);
    const restorable = isSecret ? false : (isBuiltin ? RECYCLEBIN_RESTORABLE_KINDS.has(r.kind) : true);
    let restoreTitle = '';
    if (isSecret) restoreTitle = 'Secret values were redacted at delete time and cannot be recovered';
    else if (!restorable) restoreTitle = `Restore not supported for kind: ${r.kind}`;
    else if (!data.writeUnlocked) restoreTitle = 'Enable Audit in Settings to unlock write actions';
    const restoreDisabled = (!data.writeUnlocked || !restorable) ? ' disabled' : '';
    const kindLabel = isBuiltin ? (MANAGE_KIND_LABEL_PLURAL[r.kind] || r.kind) : r.kind;
    return `<div class="manage-history-row" data-id="${r.id}">
      <span class="manage-recyclebin-kind">${escHtml(kindLabel)}</span>
      <span class="manage-recyclebin-name">${escHtml(r.namespace ? `${r.namespace}/${r.name}` : r.name)}</span>
      <span class="manage-history-meta">deleted by ${escHtml(r.updated_by || 'unknown')} · ${ts}</span>
      <div class="manage-history-actions">
        <button class="btn btn-xs btn-ghost" data-recyclebin-view="${r.id}">View YAML</button>
        <button class="btn btn-xs btn-ghost" data-recyclebin-restore="${r.id}" title="${escHtml(restoreTitle)}"${restoreDisabled}>Restore</button>
      </div>
    </div>`;
  }).join('');

  el.manageRecyclebinList.querySelectorAll('[data-recyclebin-view]').forEach((btn) => {
    const row = rows.find((r) => r.id === btn.dataset.recyclebinView);
    btn.addEventListener('click', () => showRecycleBinYaml(row));
  });
  el.manageRecyclebinList.querySelectorAll('[data-recyclebin-restore]').forEach((btn) => {
    if (btn.disabled) return;
    const row = rows.find((r) => r.id === btn.dataset.recyclebinRestore);
    btn.addEventListener('click', () => handleRestoreDeleted(row));
  });
}

async function showRecycleBinYaml(row) {
  const result = await window.k8sApi.getVersionYaml(row.id);
  el.manageRecyclebinList.style.display = 'none';
  el.manageRecyclebinYaml.style.display = 'flex';
  if (!result.ok) {
    el.manageRecyclebinYamlOutput.textContent = `Error: ${result.error}`;
    return;
  }
  const yaml = cleanYamlForDiff(result.row.old_yaml || '');
  el.manageRecyclebinYamlOutput.innerHTML = highlightYaml(yaml);
}

el.manageRecyclebinYamlClose.addEventListener('click', () => {
  el.manageRecyclebinYaml.style.display = 'none';
  el.manageRecyclebinList.style.display = '';
});

async function handleRestoreDeleted(row) {
  const isBuiltin = isBuiltinManageKind(row.kind);
  const crdMeta = isBuiltin ? null : findCrdMetaByKind(row.kind);
  if (!isBuiltin && !crdMeta) {
    alert(`Can't restore: CRD "${row.kind}" is not currently installed/discovered on this cluster.`);
    return;
  }

  const { ok } = await showManageConfirm({
    title: 'Restore this deleted resource?',
    body: `This recreates "${row.name}" from its last saved manifest before deletion. If a resource with this name already exists, restore will fail.`,
    confirmLabel: 'Restore',
  });
  if (!ok) return;

  const data = state.manage;
  const result = await window.k8sApi.restoreDeletedResource(
    data.kubeconfig, data.context, row.namespace, row.kind, row.name, row.id,
    crdMeta ? { group: crdMeta.group, version: crdMeta.version, plural: crdMeta.plural, namespaced: crdMeta.namespaced } : null
  );

  if (!result.ok) {
    alert(`Restore failed: ${result.error}`);
    return;
  }
  if (result.auditWarning) {
    console.warn('[audit] Restore audit warning:', result.auditWarning);
  }

  loadRecycleBin();
  if (data.resourceType === row.kind || (data.mode === 'crd' && data.activeCrd?.kind === row.kind)) {
    refreshManageResources();
  }
}

/* ── Auto-update ─────────────────────────────────────────────────────────── */
if (window.k8sApi.onUpdateAvailable) {
  window.k8sApi.onUpdateAvailable((version) => {
    el.updateBannerText.textContent = `v${version} is available`;
    el.updateBanner.style.display = 'flex';
  });

  el.btnInstallUpdate.addEventListener('click', () => window.k8sApi.triggerUpdate());
  el.btnDismissUpdate.addEventListener('click', () => { el.updateBanner.style.display = 'none'; });
}

el.btnDismissAuthCheck.addEventListener('click', () => { el.authCheckBanner.style.display = 'none'; });

/* ── Init ────────────────────────────────────────────────────────────────── */
checkAuth().then((ok) => {
  if (ok) {
    showView('home');
    startTokenCountdown();
  }
});
