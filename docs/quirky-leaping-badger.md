# Plan: Restore a deleted Kubernetes resource ("Recycle Bin")

## Context

Today, when a user deletes a resource in K8s Manage (with the Audit DB connected), the full
pre-delete manifest is already saved to `k8senvdiff_audit.old_yaml` — but there is **no way to
bring it back**:

1. **Unreachable** — the History tab that exposes stored versions only opens from a *live* table
   row. Deleting removes the row and closes the drawer (`app.js:4040`), so a deleted resource's
   history can never be opened again. There is no global audit/deleted view.
2. **No CREATE path** — every mutation in `main.js` is a full-object PUT (`replace*` /
   `replaceCustomObject`). There are zero `create*` calls in the codebase. `restore-resource-version`
   (`main.js:1950`) reads the live object first to get a `resourceVersion`, then replaces — this
   404s for a resource that no longer exists.
3. **UI blocks it** — Restore is explicitly `disabled` for `action === 'delete'` entries
   (`app.js:4855`) and its confirm copy says "replace the current live resource".

**Goal:** add a "Recycle Bin" view in K8s Manage that lists deleted resources from the audit trail
and lets the user recreate one from its stored manifest (a POST/`create*`), recording the recreate
as a new `restore` audit entry.

### Decisions (confirmed with user)
- **Discovery UI:** dedicated **"Recycle Bin"** sidebar entry in K8s Manage (global, per current
  cluster/namespace).
- **Kind scope:** curated **top-level kinds + CRDs**; strip `ownerReferences` so recreated objects
  aren't immediately garbage-collected. Restore is **not** offered for owner-managed / infra kinds
  (pods, replicasets, events, nodes, pvs).
- **Secrets:** **blocked** — values are stored `***REDACTED***` at delete time and cannot be
  recovered; show a clear message instead of recreating a broken Secret (the existing apply guard
  rejects redacted placeholders anyway).

---

## Changes

### 1. `audit-db.js` — query deleted resources

Add `getDeletedResources({ clusterId, namespace, limit })` mirroring the existing `getVersions`
style (`audit-db.js:177`). Return the most-recent `delete` audit row **per resource identity**, so
a resource deleted-then-restored-then-deleted shows once:

```sql
WITH latest AS (
  SELECT id, namespace, kind, name, action, edit_version, updated_by, updated_at,
         ROW_NUMBER() OVER (PARTITION BY namespace, kind, name ORDER BY updated_at DESC) rn
  FROM k8senvdiff_audit
  WHERE cluster_id = @cluster_id
    AND (@namespace = '' OR namespace = @namespace)
)
SELECT id, namespace, kind, name, edit_version, updated_by, updated_at
FROM latest
WHERE rn = 1 AND action = 'delete'
ORDER BY updated_at DESC
OFFSET 0 ROWS FETCH NEXT <min(limit,200)> ROWS ONLY
```

(Filtering `action='delete'` only on the *latest* row means a later `restore`/`edit` correctly hides
the entry.) Export it alongside the existing functions (`audit-db.js:251`). No schema change — the
existing `IX_audit_resource` index covers the filter.

### 2. `main.js` — CREATE helper + restore-deleted IPC

**a) `createManageObject(ref, ctx, ns, kind, parsed)`** — new helper mirroring `readManageObject`
(`main.js:1826`), a per-kind switch calling `createNamespaced*` / `create*` (e.g.
`appsApi.createNamespacedDeployment(namespace, parsed)`, `coreApi.createNamespacedConfigMap(...)`,
`rbacApi.createClusterRole(parsed)`, etc.). Only the **curated restorable kinds** get a case;
everything else returns `null` (→ "not supported"). Build the same 7 API clients as the existing
switches.

**b) `RESTORABLE_KINDS`** — a `Set` of the curated built-in kinds (deployments, statefulsets,
daemonsets, services, configmaps, ingresses, cronjobs, jobs, pvcs, hpas, networkpolicies,
serviceaccounts, roles, rolebindings, clusterroles, clusterrolebindings, storageclasses,
resourcequotas, limitranges, namespaces). Excludes pods, replicasets, events, nodes, pvs, secrets.
Secrets are excluded here and messaged in the UI.

**c) `stripForRecreate(parsed)`** — remove server-managed / bound fields before POST:
`metadata.resourceVersion`, `uid`, `creationTimestamp`, `generation`, `managedFields`,
`ownerReferences`, `selfLink`, the whole `status` block, and the internal
`k8senvdiff-edit-resource-version` annotation plus `kubectl.kubernetes.io/last-applied-configuration`.
(Reuse the field list already stripped in `cleanYamlForDiff` at `app.js:4877` as the reference set.)

**d) `restore-deleted-resource` IPC handler** — new, modelled on `restore-resource-version`
(`main.js:1950`) but **create instead of replace**:
- Guard `auditDb.status().connected`.
- `getVersionYaml(id)` → use `old_yaml` (the deleted manifest).
- Reject kind not in `RESTORABLE_KINDS` (and secrets) with a clear message.
- `k8s.loadYaml`, then `stripForRecreate`.
- Recreate via `createManageObject(...)` for built-ins, or
  `customApi.createNamespacedCustomObject` / `createClusterCustomObject` for CRDs (`crdMeta`).
- On `409` (already exists) → `{ ok:false, error:'A resource with this name already exists — delete it first or it was already recreated.', kind:'conflict' }`; reuse the existing 403/parse/error mapping tail (`main.js:2048`).
- On success, `recordAudit({ ..., action:'restore', oldObj:null, newObj:created, editVersion:nextEditVersion })` (reuse `recordAudit` at `main.js:1870`).

**e) `get-deleted-resources` IPC** — thin wrapper over `auditDb.getDeletedResources`, same shape as
`get-resource-versions` (`main.js:1926`): computes `clusterId` via `auditDb.getClusterId`, returns
`{ ok, rows }`.

### 3. `preload.js` — bridge methods

Add next to the existing audit bridges (`preload.js:57-67`):
```js
getDeletedResources: (ref, ctx, ns) => ipcRenderer.invoke('get-deleted-resources', ref, ctx, ns),
restoreDeletedResource: (ref, ctx, ns, kind, name, id, crdMeta) =>
  ipcRenderer.invoke('restore-deleted-resource', ref, ctx, ns, kind, name, id, crdMeta),
```

### 4. `renderer/index.html` — sidebar entry + pane

- Add a nav button in the sidebar header area (near Overview, `index.html:474`):
  `<button class="manage-nav-item" data-kind="recyclebin">♻️ Recycle Bin</button>`.
- Add a pane `#manage-recyclebin-pane` (sibling of `#manage-overview-pane`, `index.html:248`),
  containing a header + `#manage-recyclebin-list` container.

### 5. `renderer/app.js` — Recycle Bin view

Treat `recyclebin` as a **special sidebar item like `overview`** (not a real kind):
- Cache `el.manageRecyclebinPane` / `el.manageRecyclebinList` in the `el` map (near `app.js:248`).
- In `selectManageKind(kind)` (`app.js:2797`), add a `recyclebin` branch mirroring the `overview`
  branch: stop polling, hide overview/table panes, show the recycle-bin pane, mark nav active, and
  call `loadRecycleBin()`. In `resetManageView`/overview redirect logic, keep it excluded from the
  real-kind paths (same guards that already special-case `'overview'`).
- **`loadRecycleBin()`** — new function near the History section (`app.js:4791`):
  - If `!state.manage.auditConnected` → "Enable Audit in Settings to view deleted resources".
  - Call `window.k8sApi.getDeletedResources(kubeconfig, context, namespace)`; render each row:
    `kind · name · namespace · deleted by · when` + **Restore** and **View YAML** buttons.
  - Restore button `disabled` when write is locked (`!writeUnlocked`) or kind is a non-restorable /
    secret kind, with a tooltip explaining why (secrets: "values were redacted at delete time").
- **`handleRestoreDeleted(id, kind, namespace, name)`** — new, modelled on `handleHistoryRestore`
  (`app.js:4947`) but new copy: "Recreate this deleted resource from its saved manifest?" Calls
  `window.k8sApi.restoreDeletedResource(...)`; on success refresh the recycle-bin list (and, if the
  restored kind is the active table kind, `refreshManageResources()`). Resolve CRD `crdMeta` from
  the cached `list-crds` data by matching the row's `kind` (same lookup the search-result jump uses).
- **View YAML** reuses the existing `getVersionYaml(id)` → `cleanYamlForDiff` path (`app.js:4910`)
  to show the stored `old_yaml` read-only (delete entries render as a single removed block, which
  the existing `showHistoryDiff` already handles).
- Also relax the History-tab restore rule so a `delete` entry viewed via History (if ever reachable)
  routes through the same recreate path rather than staying disabled — optional; the Recycle Bin is
  the primary surface.

### 6. `renderer/styles.css`

Minor: style `.manage-recyclebin-list` / rows reusing existing `.manage-history-row` styling
(`styles.css`) — no new design system, just reuse.

### 7. Docs

- `CHANGELOG.md` — new "Unreleased / Added" entry: "K8s Manage — Recycle Bin: restore deleted
  resources from the audit trail".
- `CLAUDE.md` — note the new `create*` path and `restore-deleted-resource` IPC (the delete/restore
  section).

---

## Files touched
- `audit-db.js` — `getDeletedResources()` + export.
- `main.js` — `createManageObject()`, `RESTORABLE_KINDS`, `stripForRecreate()`,
  `restore-deleted-resource` + `get-deleted-resources` IPC handlers.
- `preload.js` — `getDeletedResources`, `restoreDeletedResource`.
- `renderer/index.html` — sidebar button + `#manage-recyclebin-pane`.
- `renderer/app.js` — `el` refs, `selectManageKind` branch, `loadRecycleBin()`,
  `handleRestoreDeleted()`.
- `renderer/styles.css` — reuse history-row styles.
- `CHANGELOG.md`, `CLAUDE.md`.

## Verification (end-to-end)
1. `npm run dev`. Connect the Audit DB in Settings (unlocks writes).
2. Select a namespace, delete a **Deployment** (or ConfigMap) from the table → confirm the row
   disappears and a `delete` audit entry is written.
3. Open **Recycle Bin** in the sidebar → the deleted Deployment appears with deleter + timestamp.
4. Click **View YAML** → the stored manifest renders (as a removed block).
5. Click **Restore** → confirm dialog → success. Switch to Deployments: the resource is back;
   its pods spin up (proving `ownerReferences`/`status` were stripped correctly and it wasn't GC'd).
   A new `restore` audit entry exists.
6. Restore again immediately → expect the `409` "already exists" message.
7. Delete a **Secret**, open Recycle Bin → its Restore button is disabled with the redaction tooltip.
8. With Audit disconnected, Recycle Bin shows the "Enable Audit" message; with write locked, Restore
   buttons are disabled.
