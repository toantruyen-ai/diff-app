# Plan: K8s Manage — Phase 8-11 (RBAC hardening, breadth+CRDs, bulk/UX, env-diff bridge)

## Context

Phases 1-7 of "K8s Manage" (Lens-style cluster browser) are fully implemented in the current uncommitted working tree: 17 resource kinds via a generic per-kind switch, read-only YAML + resource-scoped Events tabs, safe confirm-gated actions (restart/scale/cordon/delete), local port-forward, and all-namespaces browsing. `docs/breezy-bouncing-horizon.md` documents that work and needs no further action.

The user was asked what to build next and chose **all four** of: security/RBAC hardening, broader resource-kind coverage (incl. CRDs), bulk actions + cluster-overview UX, and bridging the older **env-diff** feature with Manage. This plan sequences those as four phases (8-11), each independently shippable, following the same conventions as before: every k8s call via `buildKubeConfig`+`withTimeout`, `{ok,...}`/`{ok:false,error}` IPC convention, generic per-kind switch pattern, drawer-as-action-surface, and the existing teardown choke points (`closeManageDrawer`, kind/ns switch, `showView` leaving `manage`, `mainWindow 'closed'`).

Two independent Plan agents designed these against the actual codebase (file:line verified); this document synthesizes their output into an executable sequence. **No new architecture is needed for Phases 8-9**; Phase 9's CRD work and Phase 11 introduce the only genuinely new patterns (dynamic GVR dispatch; a small vendored diff library).

---

## PHASE 8 — Security/RBAC hardening

### 8.1 Redact Secret data in the YAML pane (quick, high-value fix)

Currently `get-resource-yaml` (`main.js:897-937`) does a bare `readNamespacedSecret` → `k8s.dumpYaml(obj)` with **no redaction** — a Secret's base64 `data` renders in full, unlike env-diff's `state.maskSecrets` toggle.

- `main.js`: add `redactSecretData(obj)` (replaces each `data` key's value with a fixed placeholder, not length-derived, to avoid leaking byte-length). Extend `get-resource-yaml`'s signature with an `opts` arg (`{reveal}`); when `kind === 'secrets' && !opts.reveal`, redact before `dumpYaml`; return `{ok, yaml, redacted}`.
- `preload.js`: thread `opts` through `getResourceYaml`.
- `index.html`/`app.js`: a "Reveal secret values" checkbox in the YAML toolbar, shown only for `kind === 'secrets'`; `state.manage.revealSecrets` resets to `false` on drawer open/close (never carries across rows); toggling re-fetches via the same handler with `{reveal:true}`.
- No new RBAC surface — revealing just re-invokes the same read the initial fetch already required.

### 8.2 RBAC visibility: new kinds + "can-i" access check

- Extend `MANAGE_KINDS` with `serviceaccounts, roles, rolebindings, clusterroles, clusterrolebindings` (cluster-scoped: last two) — pure mechanical additions to `projectRow`, `list-resource` (new `RbacAuthorizationV1Api` client), `get-resource-yaml`, `resource-action` delete switch, `MANAGE_COLUMN_DEFS`, sidebar. Exact API calls: `listNamespacedRole/RoleBinding` + `ForAllNamespaces` variants, `listClusterRole(Binding)`, matching read/delete calls.
- **"can-i" check**: new `MANAGE_KIND_GVR` lookup table (`{group, resource}` per kind — needed for every existing + future kind) and a new `check-access` IPC handler that fires `AuthorizationV1Api.createSelfSubjectAccessReview` in parallel for `get/list/watch/create/update/patch/delete`, returning allowed/denied+reason per verb. Surfaced as a new, always-visible **"Access"** drawer tab (kind-agnostic — works for every kind, including CRDs later) rendering a small table with `status-pill` Allowed/Denied.

**Verification**: new RBAC kinds list/YAML/delete correctly and respect cluster scope; Access tab on any resource matches `kubectl auth can-i <verb> <resource> -n <ns>`; a restricted context correctly shows Denied for mutating verbs only.

---

## PHASE 9 — Broader resource coverage + CRDs

### 9.1 Mechanical additions (no architecture change)

NetworkPolicies (`NetworkingV1Api`), StorageClasses (`StorageV1Api`, cluster-scoped), ResourceQuotas, LimitRanges (`CoreV1Api`) — each gets a `projectRow` case, list/read/delete API calls (namespaced + `ForAllNamespaces` variants where applicable), column defs, sidebar entry, and a `MANAGE_KIND_GVR` entry (so Phase 8's Access tab covers them for free).

### 9.2 CRD / arbitrary custom-resource browsing (genuinely new path)

`MANAGE_KINDS` is a fixed hardcoded array — doesn't scale to arbitrary CRDs. Build a **parallel, kind-agnostic path** keyed by `{group, version, plural}` instead of a kind string, gated by a new `state.manage.mode: 'kind' | 'crd'`:

- `main.js` — 5 new handlers, entirely separate from `MANAGE_KINDS`/`projectRow`:
  - `list-crds`: `ApiextensionsV1Api.listCustomResourceDefinition()` → project `{name, group, version (served+storage), plural, kind, namespaced}`.
  - `list-custom-resource(group,version,plural,namespaced)`: `CustomObjectsApi.listNamespacedCustomObject`/`listClusterCustomObject` — note `listClusterCustomObject` (no namespace segment) also serves as the natural "all namespaces" fetch for namespaced CRDs, so the existing `ALL_NAMESPACES` sentinel needs zero fan-out logic here.
  - `get-custom-resource-yaml`, `get-custom-resource-events` (mirrors existing YAML/Events handlers, `involvedObject.kind` from the CRD's `kind` field), `custom-resource-action` (delete-only in v1).
  - All one-shot fetches — no session/Map/teardown needed (unlike logs/exec/pf).
- `app.js` — new sidebar section "Custom Resources" with its own filter box and scrollable list (a cluster can have 100+ CRDs), populated per-context (not per-namespace) via `loadManageCrds()`. Selecting a CRD sets `mode='crd'`, clears the built-in kind selection, and branches `refreshManageResources`/`loadManageYaml`/`loadManageEvents`/`runManageAction` at the top to call the CRD-specific handlers instead — the existing bodies for built-in kinds are untouched (additive branch, not a rewrite). Logs/Exec/Port-forward/Metrics tabs naturally stay hidden for CRD rows since their existing gating checks (`isPod`, `MANAGE_METRICS_KINDS.includes(kind)`) evaluate false against a CRD's synthetic kind. Access tab (Phase 8) deliberately **not** wired for CRDs in v1 — flag as a fast-follow.
- Clicking any built-in kind exits CRD mode (`selectManageKind` resets `mode='kind'`).

**Verification**: sidebar CRD list populates per-context; a CRD with no `list customresourcedefinitions` RBAC shows "No CRDs found" without breaking built-in kinds; CR instances list/YAML/events/delete correctly; all-namespaces toggle works for namespaced CRDs; switching to a built-in kind cleanly exits CRD mode.

---

## PHASE 10 — Bulk actions & cluster-overview UX

### 10.1 Multi-select + bulk actions

- Selection key: `${row.namespace||''}::${row.name}` (every projected row already carries `namespace`, so this works identically in single-namespace and all-namespaces modes) — `state.manage.selection = new Set()`.
- `renderManageTable`: checkbox column + header "select all *filtered*" checkbox (scoped to what's visible after the existing name filter, not the full row set).
- New bulk bar (`#manage-bulk-bar`) appears when `selection.size > 0`. Bulk-safe action subset only: **restart** (deployments/statefulsets/daemonsets) and **delete** (any kind) — explicitly excludes `scale` (needs a per-row target number, doesn't generalize) and `cordon/uncordon` (ambiguous when selected nodes have mixed current state); those stay single-row-only via the drawer.
- Execution: bounded-concurrency loop (e.g. 5 at a time) over the existing single-row `resource-action` IPC call — **no new IPC handler needed**. Aggregate into a dismissible inline banner ("7/9 succeeded, 2 failed: podA (403), podB (timeout)") rather than `alert()`, matching the app's existing modal/banner conventions for multi-step operations.
- Selection clears at every existing state-reset point that already clears `data.selected`/`rows` (kind switch, namespace/context change, `enterManageWorkspace`, and the `showView` Manage-teardown branch) — same discipline as every other piece of Manage state.

### 10.2 Global search across kinds

Recommendation: **explicit user-triggered fan-out search** (Enter/button, not live-as-you-type) rather than a lighter "recently viewed kinds" shortcut — the latter doesn't solve "I don't know which of the 17 kinds this resource lives in," which is the actual gap. Gating on an explicit trigger keeps worst-case load to one 17-kind fan-out per search, not per keystroke.

- `main.js`: extract the existing `list-resource` kind-dispatch switch into a shared `listKindItems(apis, kind, namespace, allNs)` helper (avoids duplicating the 17 cases). New `search-resources(namespace, query)` handler runs it across all kinds except `events` (excluded as high-volume/low-signal for name search) via `Promise.allSettled`, filtering by name substring, capping at 20 results per kind, tagging each with its `kind` (already `projectRow`-shaped, so a click can open the drawer with no extra round trip). Per-kind failures (RBAC/timeout) are collected as non-fatal `errors`, not aborts.
- `app.js`: a "search all kinds" affordance next to the existing per-kind filter box; results render in a panel grouped by kind; clicking a result switches kind/namespace as needed and opens the drawer directly using the tagged row data.

### 10.3 Cluster overview / health-summary landing page

- Cluster-wide digest (ignores the namespace selector by design — a namespace-scoped "health summary" defeats the purpose of a landing page): pods not Ready (excluding `Succeeded`/`Completed`), Deployments/StatefulSets with `readyReplicas < desired`, Nodes NotReady, recent `type=Warning` events (deduped by object+reason, top 10 by recency). Explicitly deferred from v1 as noise: PV/PVC thresholds, full event stream, HPA/CronJob health.
- `main.js`: one `get-manage-overview` handler doing 4 targeted list calls (`listPodForAllNamespaces`, `listDeploymentForAllNamespaces`, `listNode`, `listEventForAllNamespaces`) — not all 17 kinds.
- `app.js`: new sidebar entry "Overview" (becomes the default landing kind on entering Manage, before/without picking a namespace); 4 stat tiles, each expandable to its top-10 list; clicking an item jumps to that resource's kind+drawer. Polled at a coarser 30s interval via the same start/stop registration pattern as other pollers.

**Verification**: bulk-select across a filtered view only selects visible rows; a mixed-success bulk action shows a proper banner, not `alert()`; selection clears on every navigation; global search returns tagged, clickable cross-kind results and tolerates per-kind RBAC failures; Overview renders immediately on context selection (no namespace required) and updates within ~30s of a real cluster change.

---

## PHASE 11 — Bridge env-diff ↔ Manage

**Decision: extend env-diff itself with a full-manifest diff tab (option i), not a "diff from Manage drawer" entry point (option ii) — deferred.**

Why: `state.left`/`state.right` already hold the exact identity (`kubeconfig, context, namespace, deployment`) needed to call the existing, already-generic `get-resource-yaml` (main.js:897, works for any of the 17 kinds, already strips `managedFields`/`resourceVersion`) — this is a same-view, zero-backend-change feature. Option (ii) would require generalizing `load-envs` beyond Deployments, a new nested cluster-picker inside the Manage drawer, a new state fork with its own teardown obligations, and refactoring the env-diff table renderer (currently written directly against `state.left/right`) to take explicit args — real new surface for less reuse. Revisit (ii) only if generalized env resolution across kinds becomes independently valuable.

- **`main.js`/`preload.js`: no changes** — `get-resource-yaml` is called twice as-is with `kind:'deployments'` and each side's existing `deployment` name.
- **New small vendored dependency**: add `diff` (jsdiff) to `package.json`, copy its prebuilt UMD build into `renderer/vendor/diff/diff.min.js`, load via a plain `<script>` tag — mirrors exactly how `@xterm/xterm`/`@xterm/addon-fit` are already vendored and loaded (no bundler introduced).
- `app.js`: new `state.manifest = {leftYaml, rightYaml, hideStatus: true, loading}` (top-level, not nested under `left`/`right` — a derived artifact, not connection identity, keeping this phase free of cross-state pointers). New tab strip in the diff view ("Env Vars" default / "Full Manifest"), reusing `.manage-tab` classes for visual consistency only (no shared state machine with Manage). `loadManifestDiff()` follows the existing stale-response-drop pattern (compare captured identity before applying results, same as `refreshManageResources`); handles the "not present on one side" case the same way the existing list-mode diff does. Optional "Hide status differences" checkbox strips each side's top-level `status:` block via a simple regex before diffing (status fields — replica counts, conditions — differ constantly between clusters and aren't spec drift). Renders via `Diff.diffLines(...)` into added/removed/same line rows reusing the existing red/green `status-pill` color tokens.
- Reset: clearing the comparison (existing "Clear" button) also resets `state.manifest`/`state.diffTab`; picking a new comparison target invalidates the cached YAML so a stale diff can't leak into a new pair.

**Verification**: "Full Manifest" tab loads and diffs both sides' Deployment YAML; "not present in B" case renders correctly in list-mode; "Hide status differences" toggle recomputes live; Clear resets both tabs; confirm this phase touches only `renderer/*` + `package.json`/vendored file (no `main.js`/`preload.js` diff).

---

## Cross-cutting notes

- **Sequencing**: Phase 8.1 (Secret redaction) is the smallest, highest-value fix — do it first regardless of overall ordering. Phase 9.2 (CRDs) and Phase 11 (vendored diff lib) are the only pieces introducing genuinely new patterns; the rest are mechanical extensions of existing conventions.
- **RBAC-403 discipline**: every new handler follows `{ok:false,error}` on failure — a denied kind, CRD list, or access-review call must never crash a poller (verified pattern throughout).
- **No bundler**: the only new dependency across all four phases is `diff` (Phase 11), vendored exactly like `@xterm/xterm`.
- **Update `CHANGELOG.md`** after each phase, per `CLAUDE.md`.

## Critical files

- `main.js` — new IPC handlers per phase (see above); extends `MANAGE_KINDS`/`projectRow`/`list-resource`/`get-resource-yaml`/`resource-action` switches; new `MANAGE_KIND_GVR` table; new `RbacAuthorizationV1Api`/`StorageV1Api`/`NetworkingV1Api`/`ApiextensionsV1Api`/`CustomObjectsApi`/`AuthorizationV1Api` clients.
- `preload.js` — expose each new handler.
- `renderer/index.html` — new sidebar sections (RBAC, Policy & Storage, Custom Resources, Overview), new drawer tabs (Access), bulk bar, search-results panel, env-diff tab strip + manifest pane, vendored `diff.min.js` script tag.
- `renderer/app.js` — new state (`revealSecrets`, `mode`/`crds`/`activeCrd`, `selection`, `globalSearch`, overview polling, `manifest`/`diffTab`); new render/handler functions per phase; teardown wiring extended at every existing choke point.
- `renderer/styles.css` — new classes per phase (reveal-toggle label, nav dividers, CRD filter/list, bulk bar/result banner, search-results panel, overview tiles, manifest-diff lines).
- `package.json` — add `diff` dependency (Phase 11 only); `renderer/vendor/diff/diff.min.js` — new vendored file.

## Verification (end-to-end)

Run `npm run dev`, enter a cluster. Per-phase checklists are listed above; additionally re-run the Phase 1-7 regression checklist from `docs/breezy-bouncing-horizon.md` (teardown on view-leave, RBAC-403 inline rendering) since these phases touch the same choke points.
