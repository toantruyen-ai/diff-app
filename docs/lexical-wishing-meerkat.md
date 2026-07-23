# Plan: Azure SQL audit log + resource versioning + write-gate for K8s Manage

## Context

The "K8s Manage" workspace can edit/apply and delete Deployments, Services, Secrets,
ConfigMaps and CRDs (e.g. Traefik `IngressRoute`), but there is **no audit trail** and
**no version history** — a mistaken edit/delete is unrecoverable and untraceable. Today the
only guard on write actions is server-side RBAC (a 403); the UI never blocks the attempt.

This change makes destructive/mutating actions **auditable and reversible**, and gates them
behind a real "write unlock":

1. Every edit/delete of Deployment/Service/Secret/ConfigMap/IngressRoute is recorded to an
   **Azure SQL database** (who, old YAML, new YAML, time, action type, cluster-id, version #).
2. Each edited object gets an auto-incrementing annotation `k8senvdiff-edit-resource-version`
   to trace the change lineage.
3. The audit DB is **auto-discovered** via Azure resource tag `aks-database-backup=k8s-env-diff`
   (+ `dbname=K8sBackup`). If it connects, write actions unlock; **if no DB is reachable the
   workspace is fully read-only** (no edit/delete). The "Write permission password" popup is
   literally the SQL connection credential.
4. Credentials persist to `localStorage` so the app auto-connects on restart.
5. Each resource gets a **History tab** showing versions, diffs between versions, and restore.

### Decisions locked with the user
- **SQL auth**: user enters **both username + password** in the unlock popup (SQL authentication).
- **`updated_by`**: Azure AD account from `az account show --query user.name`.
- **Password storage**: **plaintext `localStorage`** (as requested — see security note below).
- **Write gate**: **no DB connection = fully read-only**; edit/delete/restore only when connected.

---

## Architecture

Reuse the app's three-layer pattern (renderer → preload → main.js) and the existing
`events-db.js` conventions. Add one new main-process module for Azure SQL.

### New dependency
Add `mssql` (`^11`) to `package.json`. It rides on `tedious` (pure JS, no native build), so
`electron-builder`'s `node_modules/**/*` glob packages it with no rebuild step — same as the
existing pure-JS deps. (`sqlite3` stays as-is for local events; it is unrelated.)

### New module: `audit-db.js` (mirrors `events-db.js`)
A singleton mssql connection pool + audit persistence. Exports:
- `discover()` — shell `az sql server list --query "[?tags.\"aks-database-backup\"=='k8s-env-diff']" --output json` (note the hyphenated tag key needs JMESPath quoting, unlike the bare `tags.diff` used elsewhere), filter by `tags.dbname === 'K8sBackup'`, return `{ ok, server: fullyQualifiedDomainName, database: tags.dbname, resourceGroup }` or `{ ok:false }`. Follows the `execSync`+`JSON.parse` idiom from `main.js:434-453`.
- `connect({ server, database, user, password })` — open an mssql pool (`{ encrypt:true, trustServerCertificate:false }`, port 1433, short login timeout), run `ensureSchema()`, keep the pool in module state. Returns `{ ok }` / `{ ok:false, error }`.
- `ensureSchema()` — `IF OBJECT_ID('k8senvdiff_audit','U') IS NULL CREATE TABLE ...` (idempotent) + an index on `(cluster_id, namespace, kind, name, edit_version)`.
- `insertAudit(row)` — parameterized INSERT (guid id).
- `getVersions({ clusterId, namespace, kind, name })` — `SELECT` metadata rows (no YAML blobs) newest-first for the History list.
- `getVersionYaml(id)` — fetch `old_yaml`/`new_yaml` for one row (lazy, for diff/restore).
- `nextEditVersion({ clusterId, namespace, kind, name })` — `SELECT MAX(edit_version)`.
- `status()` / `close()`.

Table `k8senvdiff_audit`:
```
id NVARCHAR(64) PK, cluster_id NVARCHAR(64), namespace NVARCHAR(256),
kind NVARCHAR(128), name NVARCHAR(256), action NVARCHAR(16),        -- 'edit' | 'delete' | 'restore'
edit_version INT, k8s_resource_version NVARCHAR(64),
old_yaml NVARCHAR(MAX), new_yaml NVARCHAR(MAX),
updated_by NVARCHAR(256), updated_at DATETIME2
```

`cluster_id` reuses `getClusterId(ref, contextName)` — extract/share the existing helper from
`events-db.js:13` (identical hashing) so both modules agree on the id.

---

## main.js changes

**Imports/helpers (top of file):**
- `const auditDb = require('./audit-db');`
- `getAzureIdentity()` — `execSync('az account show --query user.name -o tsv')`, cached in a
  module var (mirrors the `az` one-shot pattern at `main.js:318`); returns `''` on failure.
- Extract the per-kind **read switch** already in `get-resource-yaml` (`main.js:~1230-1263`)
  into `readManageObject(apis, kind, namespace, name)` returning the live object; reuse it both
  in `get-resource-yaml` and in the audit "capture old snapshot" path (avoids a second switch).
- `recordAudit({ ref, contextName, namespace, kind, name, action, oldObj, newObj, editVersion })`
  — dumps old/new via `k8s.dumpYaml` (redact Secrets with existing `redactSecretData`), resolves
  `cluster_id` + `updated_by`, calls `auditDb.insertAudit`. Best-effort: returns a warning string
  on failure rather than throwing.

**New IPC handlers:**
- `audit-db-discover` → `auditDb.discover()`
- `audit-db-connect` (user, password) → discover (if needed) + `auditDb.connect(...)`; returns status.
- `audit-db-status` → `auditDb.status()`
- `get-resource-versions` (ref, ctx, ns, kind, name) → `auditDb.getVersions(...)`
- `get-version-yaml` (id) → `auditDb.getVersionYaml(id)`
- `restore-resource-version` (ref, ctx, ns, kind, name, id, crdMeta?) — GET live object for its
  current `resourceVersion`, load the target version's `new_yaml`, set that live `resourceVersion`
  on it, `replace*` (reusing the apply dispatch), then `recordAudit(action:'restore')` + bump
  annotation. Gated: rejects if `auditDb` not connected.

**Instrument the 4 mutation handlers** (all currently gated read-only client-side, so a DB is
guaranteed connected when they run — but each also re-checks `auditDb.status()` and rejects with
`kind:'forbidden'` if not connected, as defense-in-depth):

- `apply-resource-yaml` (`main.js:1451`): before the `replace*` switch — `readManageObject` to get
  the live `oldObj`; compute `next = max(currentAnnotationValue, nextEditVersion()) + 1`; set
  `parsed.metadata.annotations['k8senvdiff-edit-resource-version'] = String(next)`. After success:
  `recordAudit(action:'edit', oldObj, newObj:res.body, editVersion:next)`. Surface any audit
  failure as `res.auditWarning` (does not fail the edit — k8s write already committed).
- `apply-custom-resource-yaml` (`main.js:1539`): same, via `customApi.getNamespacedCustomObject`
  for the old snapshot and the CRD kind label (`parsed.kind`) as `kind`.
- `resource-action` **delete** branch (`main.js:1375`): before delete, `readManageObject` for
  `oldObj` + its annotation value; after delete, `recordAudit(action:'delete', oldObj, newObj:null,
  editVersion:<last annotation value>)`. (Other actions — restart/scale/cordon — are not audited.)
- `custom-resource-action` delete (`main.js:1669`): same via CRD get.

---

## preload.js changes
Expose (mirroring `preload.js:25-47`): `discoverAuditDb`, `connectAuditDb(user,pw)`,
`getAuditDbStatus`, `getResourceVersions(ref,ctx,ns,kind,name)`, `getVersionYaml(id)`,
`restoreResourceVersion(ref,ctx,ns,kind,name,id,crdMeta)`.

---

## renderer/app.js changes

**State** (`state.manage`, app.js:17-58): add
`auditDb: { discovered:false, connected:false, server:null, database:null, username:null }`,
`writeUnlocked: false`, `history: null`.

**Credential persistence** — new key `MANAGE_AUDIT_CREDS_KEY`, load/save via the same defensive
try/catch idiom as `loadManageSettings`/`saveManageSettings` (app.js:1813-1842). Stores
`{ username, password }` (plaintext).

**Startup / Manage-enter flow** — new `initAuditDb()`:
1. `discoverAuditDb()`. If not discovered → `writeUnlocked=false`, render a read-only lock badge.
2. If discovered and creds saved → `connectAuditDb(saved.user, saved.pw)`; on ok set
   `connected/writeUnlocked=true`. On failure → clear saved creds, stay locked.
3. If discovered and no/failed creds → locked until the user opens the unlock popup.
Call it when entering the Manage view (near where CRDs/namespaces load, e.g. app.js:1815-1818).

**Unlock popup** — a dedicated overlay (clone of `.manage-confirm-overlay`) with **two inputs**
(`username` text, `password` type=password). New `showUnlockModal()` resolving `{user,pw}`; on
submit call `connectAuditDb`, and on success persist creds + set `writeUnlocked` + re-render the
drawer. Trigger: an "Unlock Write" button in the manage toolbar, and lazily when a user clicks a
locked write control.

**Write gating** — gate on `state.manage.writeUnlocked`:
- `renderManageDrawerActions` (app.js:3482): disable/hide mutating actions (delete/scale/restart/
  cordon) when locked; show a small "🔒 Read-only — unlock write" hint.
- `renderManageYamlEditGate` (app.js:3672): Edit button also requires `writeUnlocked` (in addition
  to the existing `yamlEditable` secret guard).
- Bulk-action handler (app.js:2920): same gate before running.

**History tab**:
- `index.html`: add `<button class="manage-tab" data-tab="history">History</button>` to the tab
  strip (index.html:643) and a `<div id="manage-history-pane">` pane; register `el.manageHistoryPane`.
- `switchManageTab` (app.js:3603-3637): add the show/hide line + `if (tab==='history') loadManageHistory();`
- `loadManageHistory()` — follows the stale-guard idiom (`if (data.selected !== row) return;`,
  as at app.js:3655): call `getResourceVersions(...)`, render a newest-first list (version #,
  action, `updated_by`, `updated_at`). Each version has **Compare** (vs current or vs another
  version) and **Restore** buttons.
- **Diff**: reuse the vendored global `Diff.diffLines(oldYaml, newYaml)` and the existing
  `.manifest-diff-line{,-added,-removed,-same}` classes (app.js:749-763 / styles.css:2190-2195),
  plus `stripManifestStatus()` to drop `status:` noise. Fetch YAML lazily via `getVersionYaml(id)`.
- **Restore**: confirm modal (type-the-name, reuse `showManageConfirm`) → `restoreResourceVersion(...)`
  → on ok refresh drawer + history. Gated on `writeUnlocked`.

---

## renderer/index.html + styles.css
- `index.html`: unlock overlay markup (clone of `.manage-confirm-overlay` at index.html:715-726
  with two inputs); History tab button + `#manage-history-pane`; an "Unlock Write" button + lock
  badge in the manage toolbar.
- `styles.css`: reuse `.auth-overlay`/`.manage-confirm-overlay` rules (styles.css:1244-1326) for the
  unlock overlay; add small styles for the history list, version rows, and the read-only lock badge.

---

## CHANGELOG.md
Add an entry under a new version bump per project convention (Vietnamese, matching existing style):
audit-to-Azure-SQL, write-unlock gate, `k8senvdiff-edit-resource-version` annotation, version
history + diff + restore.

---

## Security note (localStorage plaintext)
Per the explicit request, the SQL username+password are stored **unencrypted** in `localStorage`,
readable by anyone with filesystem/DevTools access to the app profile. A drop-in hardening (same
UX) would be Electron's `safeStorage` (OS-keychain encryption) — the code is structured so only
the load/save creds functions would change if you later opt into it.

---

## Verification (end-to-end)

Prereq: an Azure SQL server tagged `aks-database-backup=k8s-env-diff` + `dbname=K8sBackup`, with a
SQL login, and a firewall rule allowing this machine's IP. `az login` active.

1. **Read-only when no DB**: temporarily rename/hide the tag (or block SQL) → `npm run dev`, open
   Manage. Confirm Edit/Delete/Scale/Restart are disabled with the lock badge; bulk delete blocked.
2. **Discover + unlock**: with the tagged DB reachable, confirm auto-discovery; open unlock popup,
   enter a **wrong** password → clear error, still locked; enter correct user/password → unlocks,
   creds saved to localStorage.
3. **Edit + audit + annotation**: edit a ConfigMap `data` key, apply. Confirm the object now has
   annotation `k8senvdiff-edit-resource-version: 1` (then `2` on a second edit). Query
   `SELECT * FROM k8senvdiff_audit` → row with action `edit`, correct `updated_by` (Azure AD),
   old/new YAML, cluster_id, edit_version.
4. **Delete + audit**: delete a test Service → audit row action `delete`, `old_yaml` populated,
   `new_yaml` null.
5. **CRD path (IngressRoute)**: edit and delete a Traefik `IngressRoute` → audit rows via the CRD
   handlers; annotation bump on edit.
6. **History + diff + restore**: open the ConfigMap's History tab → versions listed newest-first;
   Compare two versions renders a red/green line diff; Restore an earlier version → resource
   reverts, a new audit row (action `restore`) appears, annotation increments again.
7. **Persistence**: quit and relaunch → app auto-connects from localStorage, write stays unlocked
   with no popup.
8. **Regression**: with DB connected, confirm restart/scale/cordon still work (unaudited) and the
   409-conflict edit path + Full Manifest diff are unaffected (no `resourceVersion`/annotation noise
   leaking into read-only YAML view or the manifest diff).
