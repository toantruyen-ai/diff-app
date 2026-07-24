---
name: implement-code-flow
description: Standardized workflow for implementing code in k8s-env-diff. Enforces modular design, TDD, token-efficient file editing, and mandatory test verification.
---

# Code Implementation Standard Operating Procedure (SOP)

This skill governs how features, refactors, and bug fixes must be implemented in the `k8s-env-diff` codebase.

## 1. Architectural Principles & File Mapping

Every new feature or change must strictly adhere to the layered modular architecture:

| Layer | Directory | Purpose & Responsibility | Representative files |
|---|---|---|---|
| **Constants** | `src/main/constants/` | K8s resource kinds, labels, GVRs, watch paths, verbs. | `k8sConstants.js` |
| **Utilities** | `src/main/utils/` | Pure helper functions (formatters, parsers, timeouts, k8s helpers). | `timeout.js` (`withTimeout`), `k8sHelper.js`, `unitParser.js`, `resourceFormatter.js` |
| **Data / DB** | `src/main/db/` | Persistence adapters. | `auditDb.js` (Azure SQL audit trail), `eventsDb.js` (local SQLite) |
| **Services** | `src/main/services/` | Business logic & K8s/Azure/DB API integrations (< 200 lines per file). | `k8sService.js`, `resourceActionService.js`, `watchService.js` |
| **IPC Handlers** | `src/main/ipc/` | Thin routing layer binding `ipcMain.handle` to domain services. | `k8sHandler.js`, `index.js` |
| **App Bootstrapper**| `src/main/index.js` | App lifecycle, window management, cleanup/disposal handlers. | — |
| **Preload Bridge** | `src/preload/index.js` | Safe `contextBridge` exposing `window.k8sApi`. | — |
| **Renderer (modular)** | `src/renderer/` | UI utilities & client API bridge, **imported by** `renderer/app.js`. | `utils/`, `api/` |
| **Renderer (entry)** | `renderer/app.js` | Bundle entry; `require`s `src/renderer/*`, bundled by esbuild → `renderer/dist/app.js`. | — |
| **Unit Tests** | `tests/unit/` | Vitest suites mirroring `src/` structure (`main/services`, `main/utils`, `preload`, `renderer`). | — |

> **Renderer wiring rule**: New modular renderer code lives in `src/renderer/`, but it is **dead code until `renderer/app.js` imports it**. `index.html` loads `dist/app.js` (the esbuild output), never `app.js` directly — so any renderer change requires a rebundle to take effect (see Step 5).

## 1b. Naming Conventions (MANDATORY)

New code must match the conventions **already established** in the codebase. Do not invent a new style —
copy the pattern of the sibling file/channel/symbol you are extending. These are the enforced conventions:

### File names

| Layer | Pattern | Case | Examples |
|---|---|---|---|
| Service | `<domain>Service.js` | camelCase + `Service` | `k8sService.js`, `watchService.js`, `portForwardService.js` |
| IPC handler | `<domain>Handler.js` | camelCase + `Handler` | `k8sHandler.js`, `azureHandler.js`, `logExecHandler.js` |
| Utility | `<noun>.js` / `<noun>Helper.js` | camelCase noun | `unitParser.js`, `resourceFormatter.js`, `k8sHelper.js`, `timeout.js` |
| Constants | `<domain>Constants.js` | camelCase + `Constants` | `k8sConstants.js` |
| DB adapter | `<domain>Db.js` | camelCase + `Db` | `auditDb.js`, `eventsDb.js` |
| Renderer util | `<noun>.js` | camelCase | `htmlUtils.js`, `yamlHighlighter.js`, `envDiffComputer.js` |
| Unit test | `<module>.test.js`, mirroring the `src/` path | — | `tests/unit/main/services/k8sService.test.js` |

### Identifiers (inside files)

| Kind | Convention | Examples |
|---|---|---|
| Exported constants | `UPPER_SNAKE_CASE` | `MANAGE_KINDS`, `ALL_NAMESPACES`, `MANAGE_KIND_GVR`, `WATCH_ENABLED_KINDS` |
| Service / util functions | **verb-first** `camelCase` | `loadContexts`, `getResourceYaml`, `applyResourceYaml`, `resourceAction`, `searchResources` |
| Internal (non-exported) helpers | `camelCase`, still verb-first | `listKindItems`, `runAccessCheck` |

### IPC channels (`ipcMain.handle` / `ipcRenderer.invoke`)

- **`kebab-case`, verb-noun**: `load-contexts`, `get-resource-yaml`, `apply-resource-yaml`, `list-crds`, `check-access`, `search-resources`.
- **Streaming lifecycle** — use the `<domain>-start` / `<domain>-stop` pair (the majority pattern):
  `watch-start`/`watch-stop`, `exec-start`/`exec-stop`, `pf-start`/`pf-stop`. Prefer this over the older
  verb-first `start-pod-logs`/`stop-pod-logs` form for any NEW streaming domain.
- **Domain-grouped families** share a prefix: `audit-db-connect`, `audit-db-disconnect`, `audit-db-status`; `az-login`, `az-logout`.
- **Session-scoped push-event channels** (`webContents.send` → `ipcRenderer.on`): `<event-base>:${sessionId}`,
  base in kebab-case: `pod-log-data:${sid}`, `watch-event:${sid}`, `watch-sync:${sid}`, `exec-data:${sid}`.

### Preload surface (`window.k8sApi.*` in `src/preload/index.js`)

- **Request/action keys**: `camelCase` that **mirrors the IPC verb-noun** 1:1 —
  `load-contexts` → `loadContexts`, `get-resource-yaml` → `getResourceYaml`, `watch-start` → `startWatch`, `pf-start` → `startPortForward`.
- **Push-event subscribers**: `on` + PascalCase event name, returning an unsubscribe function —
  `onWatchEvent`, `onWatchSync`, `onPodLogData`, `onExecExit`, `onUpdateAvailable`, `onPortForwardError`.

> **The 1:1 rule**: for a plain request/response feature the same concept keeps one spelling across three layers —
> IPC `kebab-case` → preload/service `camelCase` verb-noun. If you know one, you can predict the other two.

## 1c. Security Coding Standard (MANDATORY)

This is a desktop **Electron** app that holds cluster credentials, kubeconfigs, Azure tokens, and K8s Secrets,
and shells out to `az` / `kubelogin` / `kubectl`. Treat everything crossing the renderer→main boundary as untrusted.

### Electron process hardening (keep these true — verify in `src/main/index.js`)
- `contextIsolation: true` and `nodeIntegration: false` on **every** `BrowserWindow` — never flip them.
- Expose only a **curated** API via `contextBridge` in `src/preload/index.js`. **Never** expose raw `ipcRenderer`,
  `require`, `process`, or a generic `invoke(channel, …)` passthrough — each channel is named explicitly (see the existing `k8sApi`).
- Prefer `sandbox: true`; if a preload dependency forces `sandbox: false`, that is a documented exception, not a default.
- Do not load remote/http content into a renderer, and do not enable `webviewTag`, `allowRunningInsecureContent`, or `webSecurity: false`.

### Shelling out — command injection (highest-risk surface here)
- **Never interpolate untrusted values into a shell string.** Quoting with `"${x}"` is NOT safe — a `"`, `$()`, or backtick escapes it.
- Use the **arg-array, no-shell** form: `execFile('az', ['aks', 'get-credentials', '--name', name, …])` /
  `spawn(cmd, argsArray, { shell: false })`. Reserve `execSync('… string …')` for **fully static** commands with no interpolation
  (e.g. `az account get-access-token --output json`).
- Validate identifiers before use: cluster/RG/namespace/pod names must match an allow-list pattern (`/^[a-z0-9][a-z0-9._-]*$/i`);
  reject anything else with a structured `{ ok: false, reason: 'invalid-input', … }`.
- Any handler that runs a remote script (e.g. `trigger-update`'s `curl … | bash`) is a **special trust point**: it must be
  hardcoded, never take renderer input, and be called out in review.

### IPC input validation (every handler in `src/main/ipc/*`)
- Renderer args are untrusted. Validate type/shape/range at the top of the handler (or service) before touching shell, filesystem, K8s, or SQL.
- **Kubeconfig / file paths**: only accept a path the user picked via the native `select-kubeconfig` dialog or a stored
  kubeconfig id — never an arbitrary renderer-supplied path (path-traversal / arbitrary file read).
- **SQL (audit DB)**: always use `mssql` parameterized queries (`request.input(...)`) — never string-concatenate values into SQL.

### Secrets & logging
- Route Secret payloads through `redactSecretData` (in `resourceFormatter.js`) before returning to the renderer, persisting to the
  audit/events DB, or logging. **Never** `console.log` a token, kubeconfig, Secret value, or full env dump.
- Do not write credentials to disk unencrypted; temp kubeconfigs (like `azureService`'s) must be created in the OS temp dir and
  `unlink`ed in a `finally` block.
- On error, return `{ ok: false, error }` with a message safe to show — do not leak raw tokens or full command lines into `error`.

### Least privilege & mutations
- Destructive K8s actions stay behind the audit/write-gate path (see §Red Lines) — that gate is a security control, not just bookkeeping.
- Don't broaden RBAC/verbs or add cluster-scoped access beyond what a feature needs; reuse `MANAGE_ACCESS_VERBS` / access-check helpers.

## 2. Standard 5-Step Implementation Flow

### Step 1: Scope & Target File Identification
- Locate the specific domain file in `src/main/services/` or `src/main/utils/`.
- **CRITICAL**: Never read or modify monolithic files. Focus exclusively on the target module to preserve context window and minimize token usage (> 90% savings).

### Step 2: API Contract & Interface Design
- Define input parameters, return structure (`{ ok: true, ... }` or `{ ok: false, error: ... }`).
- For error results the caller must branch on, add a machine-readable `reason` alongside `error`
  (e.g. `metricsService` returns `{ ok: false, reason: 'metrics-server-unavailable', error: e.message }`).
- Ensure no breaking changes to existing IPC channels or renderer callers.
- **Naming**: follow the conventions in **§1b** for every new file, function, constant, IPC channel, and
  preload key. Match the sibling you are extending; do not invent a new style.
- **Security**: apply the **§1c Security Coding Standard** — validate renderer input, no shell injection
  (`execFile`/arg-arrays), redact secrets, parameterize SQL, keep the preload bridge curated.

### Step 3: Write Unit Tests (TDD First / Parallel)
- Create or update test file under `tests/unit/<path>/<module>.test.js`.
- Cover:
  1. Success paths.
  2. Edge cases (null/empty inputs, missing properties).
  3. Error & timeout handling.

### Step 4: Implement Modular Code
- Write clean, single-responsibility code (< 200 lines).
- Use `withTimeout` (from `src/main/utils/timeout.js`) for external/cluster async calls.
- Prefer existing helpers (`k8sHelper.js`, `unitParser.js`, `resourceFormatter.js`) over reinventing them.
- **Mutations must go through the audit/write-gate path** — do not bypass `auditService` for delete/scale/restart/replace actions.
- **Long-lived resources must be disposable**: any watch, log stream, port-forward, exec session, or DB handle
  you open must register a teardown in the cleanup handler in `src/main/index.js` (see how sibling
  streaming services — `watchService`, `portForwardService`, `podExecService`, `podLogService` — dispose sessions).
- If adding a new IPC channel:
  1. Add service method in `src/main/services/`.
  2. Register handler in `src/main/ipc/`.
  3. Expose in `src/preload/index.js`.
  4. Use in renderer via `window.k8sApi`.

### Step 5: Verification & Documentation
- **Inner loop (token-efficient)**: run only the affected suite —
  `npx vitest run tests/unit/<path>/<module>.test.js`.
- **Before declaring done**: run the full `npm test` and verify a 100% pass rate.
- Run `node --check <file>` syntax verification on changed `.js` files.
- **If any renderer code changed** (`renderer/app.js` or `src/renderer/*`), run `npm run build:renderer`
  so `dist/app.js` reflects the change — tests passing does NOT prove the app updated.
- Update `CHANGELOG.md` under `## Unreleased`.

## 3. Rules & Red Lines

- ❌ **No Monoliths**: Never add logic directly to root `main.js` or `preload.js`.
- ❌ **No Unverified Claims**: Never declare completion without running `npm test`.
- ❌ **No Stale Bundles**: Never claim a renderer change works without `npm run build:renderer`; `index.html` loads `dist/app.js`, not `app.js`.
- ❌ **No Orphaned Renderer Code**: Code in `src/renderer/` is inert until `renderer/app.js` imports it.
- ❌ **No Leaked Sessions**: Never open a watch/stream/port-forward/exec/DB handle without a registered disposal path.
- ❌ **No Swallowing Errors**: Always return structured errors `{ ok: false, error: e.message }` (add `reason` when the caller must branch).
- ❌ **No Hardcoded Offsets/Magic Values**: Use constants from `k8sConstants.js`.
- ❌ **No Ungated Mutations**: Never perform destructive K8s actions outside the audit/write-gate path.
- ❌ **No Off-Convention Names**: Never invent a naming style — file, function, constant, IPC channel, and preload key must match §1b and the sibling being extended.
- ❌ **No Shell Injection**: Never interpolate untrusted values into a shell string — use `execFile`/`spawn` arg-arrays (`shell: false`); `execSync` only for fully static commands (§1c).
- ❌ **No Unvalidated IPC Input**: Never pass renderer args into shell/filesystem/K8s/SQL without validating type/shape and, for identifiers, an allow-list pattern (§1c).
- ❌ **No Raw Bridge**: Never expose raw `ipcRenderer`/`require`/`process` or a generic `invoke` passthrough from preload; never disable `contextIsolation` or enable `nodeIntegration` (§1c).
- ❌ **No Leaked Secrets**: Never log or return un-redacted tokens/kubeconfigs/Secret values; route Secret payloads through `redactSecretData` (§1c).
- ❌ **No SQL Concatenation**: Audit-DB queries must be parameterized (`request.input(...)`), never string-built (§1c).
- ❌ **No Undocumented Change**: Never declare a feature/change complete without an entry in `CHANGELOG.md` under `## Unreleased` (Step 5) — this is a completion gate, same as `npm test`, not an optional step.
