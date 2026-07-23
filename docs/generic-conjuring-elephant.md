# K8s Manage — Next Phases (12–16)

## Context

`k8s-env-diff`'s "K8s Manage" workspace is already through Phase 11 (RBAC/Access, CRD browsing, bulk restart/delete, cluster overview, port-forward, exec, metrics, and a manifest-diff bridge from the older env-diff tool). The user asked what to build next; after a full read of `main.js` (1760 lines) and `renderer/app.js` (3623 lines), the genuine remaining gaps — confirmed against the actual code, not assumed — are:

1. YAML is read-only — no edit-and-apply workflow (biggest capability gap vs. tools like Lens/k9s).
2. CRDs are a second-class citizen: no Access/RBAC tab, excluded from global search, delete-only actions.
3. Everything is poll-based (5s/10s timers) — no real-time push updates via the k8s watch API.
4. "Full Manifest" diff only works for Deployments; no export of any diff result to a file.
5. A handful of small, independent rough edges: bulk actions missing Scale/Cordon, no column sorting, an unbounded in-memory kubeconfig cache, an asymmetric UI control (left panel missing a button the right panel has), and a silently-swallowed auth-check exception.

The user selected all four feature directions plus all three polish items. Given the scope, this is organized as five sequential phases (12–16), ordered from lowest-risk/mechanical to highest-risk/architectural, continuing the project's existing "Phase N" CHANGELOG convention. Each phase is independently shippable and testable — do not attempt all five in one sitting.

---

## Phase 12 — CRD parity + global search + small bug fixes

Lowest risk: closes existing inconsistencies using patterns that already exist, touches no core mutation logic.

**CRD Access-tab parity**
- `main.js`: extract the verb-fan-out body of `check-access` (main.js:1257) into a shared helper `runAccessCheck(authApi, {namespace, namespaced, group, resource, name})` reusing `MANAGE_ACCESS_VERBS` (main.js:1162). Add a new handler `check-custom-resource-access` calling it with the CRD's own group/plural (already known to the renderer from `list-crds`, main.js:1377).
- `preload.js`: expose `checkCustomResourceAccess`.
- `renderer/app.js`: `loadManageAccess()` (app.js:3234) — replace the CRD short-circuit with a call to the new IPC when `data.mode === 'crd'`, using `crd.plural` (not `crd.kind`) as the SelfSubjectAccessReview resource.
- **Explicitly descoped**: CRD scale/restart. Too many CRDs have no restart concept and inconsistent `/scale` subresource support to generalize safely — `custom-resource-action` (main.js:1466) stays delete-only.

**CRDs in global search**
- `main.js`: `search-resources` (main.js:982) gains a `crds` param (the already-client-cached CRD list) and fans out `listNamespacedCustomObject`/`listClusterCustomObject` per CRD, same 20-result cap, tagged `{crd:true, group, version, plural, kind, namespaced}`.
- `preload.js`/`renderer/app.js`: `runGlobalManageSearch()` (app.js:2746) passes `state.manage.crds`; result click handler branches to the existing `selectManageCrd()` (app.js:2700) for CRD hits.

**Bug fixes**
1. **`aksKcStore` unbounded** (main.js:119, populated at main.js:403, read at main.js:1721-1723) — add `AKS_KC_STORE_MAX = 20`; wrap the `set` in a `storeAksKc()` helper that evicts the oldest entry past the cap (Map preserves insertion order); wrap the `get` in `buildKubeConfig` with a `touchAksKc()` that delete-then-re-sets on hit for real LRU behavior. Self-contained in `main.js`, no renderer call-site changes needed.
2. **Left ENV-diff panel missing "Use file" button** — right panel has one (`index.html:208-219`, handler `app.js:982-997`), left doesn't. Add the matching HTML for `#left-aks-field`, and move the handler out of its right-only special case into `setupPanel(side)` (app.js:231), guarded by `if (s.btnUseFile)`, so both sides share one code path (fixes the root cause, not just the symptom).
3. **`checkAuth()` swallows exceptions** (app.js:3547-3571, empty catch) — add a dismissible banner (reuse `#update-banner`'s visual language) shown when the catch fires, with the existing "proceed anyway" control flow left untouched. Note in a code comment that `check-azure-auth`/`check-kubelogin-auth` already catch internally, so this only covers the narrower "something else broke" case, not "az CLI missing" (that's a separate, pre-existing UX issue — not part of this fix).

**Test**: Access tab shows real verb results for a CRD instance (not "Not available"). Search box finds a CRD instance by name substring and jumps to it. Repeatedly cycle the AKS cluster picker 25+ times and confirm `aksKcStore.size` never exceeds 20. Left panel's new "Use file" button flips it back to manual kubeconfig mode. Stub a rejected `checkAzureAuth` in DevTools and confirm the app still loads with a visible (not silent) banner.

---

## Phase 13 — Bulk Scale/Cordon + column sorting

Renderer-only, no `main.js` changes (the underlying `resource-action` cases already exist).

- **Bulk Scale/Cordon**: `renderManageBulkBar()` (app.js:2463) — show a Scale button for `deployments`/`statefulsets`, and separate Cordon + Uncordon buttons for `nodes` (two buttons, not one toggle, since a mixed selection can contain both states). `runManageBulkAction()` (app.js:2493) currently only handles `delete`/`restart` — add `scale` (reuse the existing numeric-input confirm modal) and `cordon`/`uncordon` (plain confirm), feeding into the existing bounded-concurrency `mapLimit` call.
- **Column sorting**: new `state.manage.sortState` (Map keyed per kind/CRD). `applyManageSort()` — stable sort, numeric-aware with string fallback, ISO8601 age strings sort correctly as-is. Sparkline columns are explicitly not sortable (no scalar value). Wire clickable `<th>` headers with a sort-direction indicator into `renderManageTable()` (app.js:2308) — sorting only reorders the array before the existing diff-by-key/reorder DOM patching, so no changes needed to the patching logic itself.

**Test**: Select 2+ Deployments, bulk-scale to N, confirm all reach N replicas. Select mixed cordoned/uncordoned Nodes, confirm each bulk button works regardless of starting state. Click "Age" column header, confirm sort + reversed sort on second click, confirm a poll refresh mid-sort doesn't rebuild the table or lose a checked selection.

---

## Phase 14 — YAML edit & apply

The biggest new capability. Key design decisions:
- Preserve `resourceVersion` transparently via a new `opts.forEdit` flag on `get-resource-yaml`/`get-custom-resource-yaml` (main.js:1173, 1423) — default (no flag) behavior is byte-for-byte unchanged, so Phase 11's manifest-diff feature (which calls this without `opts`) is unaffected.
- Apply via full-object `replace*` (PUT), not patch — every `MANAGE_KINDS` entry has a matching `replaceNamespaced*` method, and PUT naturally uses `resourceVersion` for optimistic concurrency (409 on conflict), which a merge-patch would not give for free.
- New `main.js` handler `apply-resource-yaml`: validates the parsed YAML's `kind`/`metadata.name`/`metadata.namespace` match what the tab was opened for (reject on mismatch, no cross-resource or create-new writes), requires `resourceVersion` present, then dispatches through a per-kind switch mirroring `get-resource-yaml`'s existing style. Returns distinct error `kind`s (`parse`/`validation`/`conflict`/`forbidden`/`invalid`/`error`) so the renderer can show the right message (409 → "resource changed, reload and retry", not a generic failure).
- New `apply-custom-resource-yaml` mirrors this for CRDs via `replaceNamespacedCustomObject`/`replaceClusterCustomObject`.
- **Secrets**: block Edit client-side unless "Reveal secret values" is on; server-side safety net rejects if any submitted `data` value is still the literal `***REDACTED***` placeholder.
- `renderer/index.html`/`app.js`: YAML pane (index.html:605-613) gains Edit/Save/Cancel/Reload buttons and a `<textarea>` (no code-editor library — plain textarea is an explicit scope decision, not an oversight). New functions `enterManageYamlEdit`/`saveManageYamlEdit`/`cancelManageYamlEdit`, gated through the existing `showManageConfirm()` modal, with the same stale-row guard pattern (`data.selected !== row`) already used by `loadManageYaml`.
- **Explicitly not building**: arbitrary "paste any YAML" apply, create-new-resource flow, a vendored code editor, further generalizing the per-kind switch dispatch (leave a comment noting it as a possible future cleanup).

**Test**: Edit a ConfigMap's data key, apply, restart the consuming Deployment (existing action), exec in (existing tab) and confirm the new value via `printenv`. Trigger a real 409 (edit via `kubectl` in another terminal while the app has it open) and confirm the conflict message + working Reload button. Mangle the YAML and confirm a parse error; change `metadata.name` and confirm a distinct validation error. Attempt against an under-privileged context and confirm a clear RBAC message with no partial write. Verify Secret edit is blocked without Reveal, works with it, and the redacted-placeholder guard rejects a stale submission. Repeat the conflict test against a CRD instance. Re-run the Phase 11 Full Manifest diff afterward to confirm no `resourceVersion` noise leaked into it (regression check).

---

## Phase 15 — Extended manifest diff + export-to-file

- **Generalize Full Manifest diff beyond Deployments**: add a kind `<select>` next to the existing manifest-diff toolbar (index.html:319-324), defaulting to `deployments` (preserves current behavior exactly when untouched). When changed, populate two name pickers via the already-generic `list-resource` IPC (no `main.js` change — reuse the same generic listing every Manage table already uses, not the Deployment-specific `load-deployments`). `loadManifestDiff()` (app.js:565) swaps its hardcoded `'deployments'` literals for `state.manifest.kind` and the resolved names. Fold kind/names into `compareTargetKey()` so switching invalidates the cached diff correctly, and reset to `deployments` on every fresh Compare so state doesn't leak across comparisons.
- **Export-to-file**, all three diff tools (Env Vars, Full Manifest, Storage/ServiceBus presence diffs): pure-renderer `Blob` + `<a download>`, no new IPC (consistent with the existing renderer-side clipboard-copy trust level; a native Save-As dialog is a documented deferred alternative, not built now).
  - Env Vars: extract the per-key diff computation out of `renderTable()` (app.js:644) into a pure `computeEnvDiffRows()` reused by CSV/JSON export — **exported values must respect the current mask-secrets/filter state**, not bypass it.
  - Full Manifest: export raw unified-diff text reconstructed from the same `Diff.diffLines` chunks already computed.
  - Storage/ServiceBus: persist the last diff `results` into state (currently only a local param) so export can reach it; extract the shared "union of item names → per-account presence matrix" logic already duplicated between `renderStorageDiffTable`/`renderServiceBusDiffTable` into one helper used by both render and export.

**Test**: Full Manifest tab still defaults to and behaves identically for Deployments (regression). Switch kind to ConfigMaps, pick a name present on both sides, confirm the diff renders correctly; pick a name only on one side, confirm the existing "not present" path still works. Export CSV/JSON from Env Vars with a non-default filter/mask state and confirm the export matches what's on screen, not the unfiltered/unmasked full set. Export `.diff` from Full Manifest and confirm +/- prefixes match the rendered colors. Export CSV/JSON from a Storage or ServiceBus diff that includes a deliberately erroring account and confirm it's represented distinctly in the export.

---

## Phase 16 — Real-time watch (replace polling for high-churn kinds)

Highest risk/complexity — do last, once the above are stable, since it changes the core Manage data-flow that every other feature reads from.

- **Scope**: watch-enable only high-churn kinds — `pods, deployments, replicasets, statefulsets, daemonsets, jobs, events`. Everything else (Services, ConfigMaps, Secrets, RBAC kinds, StorageClasses, PVs/PVCs, HPAs, CronJobs, Namespaces, Nodes, and all CRDs) stays on the existing poll timer — genuinely low-churn or not worth the added complexity in this phase. Metrics (`get-metrics`) is unaffected — metrics-server has no watch API.
- **main.js**: a `KIND_WATCH_META` table (REST path builder + namespaced flag per watchable kind), a `watchSessions` Map following the exact same session idiom as existing `logSessions`/`execSessions`/`pfSessions` (Map-keyed by session id, `webContents.send` per-session channels, explicit stop, teardown on window close). New `watch-start`/`watch-stop` handlers: `watch-start` does an initial LIST (via a small refactor to `listKindItems` to also return `metadata.resourceVersion`, not just `.items`) to seed a full snapshot, then opens a `k8s.Watch` stream from that resourceVersion, forwarding ADDED/MODIFIED/DELETED events. On disconnect: reconnect with exponential backoff (capped ~30s), **always re-seeding with a fresh LIST on reconnect** rather than attempting resourceVersion-resume (avoids fragile 410-Gone detection, at the cost of one extra LIST call per reconnect — a rare event). If the very first connection attempt fails (never received even one event/bookmark), treat as permanent (most likely `watch` verb RBAC-denied) and tell the renderer to fall back to the existing poll timer for that kind — no retry loop against a resource that can't be watched at all.
- **preload.js**: expose `startWatch`/`stopWatch` plus disposer-returning `onWatchSync`/`onWatchEvent`/`onWatchError`, mirroring the existing pod-log subscribe-before-start pattern.
- **renderer/app.js**: `startManageWatch`/`stopManageWatch`, wired into every place that currently starts/stops the poll timer for a watch-enabled kind (kind switch, namespace/context change, and critically the `showView` teardown choke point and `beforeunload`, alongside the existing five stop calls there). Watch deltas apply directly to `data.rows` by row key and re-render through the *existing* `renderManageTable()` diff-by-key patching — no new rendering logic needed. The existing generation-counter staleness guard stays in place for Tier-2 (still-polled) kinds and the polling-fallback path; for watch-enabled kinds, session-id-scoped IPC channels (disposed before a new session starts) serve the same purpose.
- **Explicitly deferred**: the cluster Overview digest (`get-manage-overview`) stays a one-shot fetch, not converted to incremental watch-driven recompute — a materially harder problem (merging multiple watch streams into one derived digest), left as a candidate follow-up once this phase is proven.

**Test**: Watch a Deployment's table row, `kubectl scale` it from a terminal, confirm sub-second UI update (no 5s wait). Delete/recreate a Pod, confirm the row disappears/reappears without a full-table rebuild (verify via DevTools that unrelated row DOM nodes are untouched). Test all-namespaces mode still streams correctly. Switch away from a watched kind and confirm (via a temporary log) the watch session is torn down with no leak; same when leaving the Manage workspace entirely and on app close (no hanging connections). Simulate a network blip (toggle Wi-Fi, or firewall-block the API server port briefly) and confirm reconnect-with-backoff and that a change made during the outage is correctly picked up afterward. Using a deliberately watch-denied (but list/get-allowed) RBAC context, confirm silent fallback to polling with no user-facing error spam. Confirm Tier-2 kinds and metrics polling are completely unaffected.

---

## Critical files (all phases)
- `/Users/toantruyen/data/devops/k8s-env-diff/main.js`
- `/Users/toantruyen/data/devops/k8s-env-diff/preload.js`
- `/Users/toantruyen/data/devops/k8s-env-diff/renderer/app.js`
- `/Users/toantruyen/data/devops/k8s-env-diff/renderer/index.html`
- `/Users/toantruyen/data/devops/k8s-env-diff/renderer/styles.css`
- `/Users/toantruyen/data/devops/k8s-env-diff/CHANGELOG.md` (update after each phase, per project convention)

No build step, no test suite — verification throughout is manual, against a real (or kind/minikube) cluster with `kubectl` available side-by-side for cross-checking every mutation.
