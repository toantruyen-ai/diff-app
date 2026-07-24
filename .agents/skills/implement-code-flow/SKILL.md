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

## 2. Standard 5-Step Implementation Flow

### Step 1: Scope & Target File Identification
- Locate the specific domain file in `src/main/services/` or `src/main/utils/`.
- **CRITICAL**: Never read or modify monolithic files. Focus exclusively on the target module to preserve context window and minimize token usage (> 90% savings).

### Step 2: API Contract & Interface Design
- Define input parameters, return structure (`{ ok: true, ... }` or `{ ok: false, error: ... }`).
- For error results the caller must branch on, add a machine-readable `reason` alongside `error`
  (e.g. `metricsService` returns `{ ok: false, reason: 'metrics-server-unavailable', error: e.message }`).
- Ensure no breaking changes to existing IPC channels or renderer callers.
- **IPC channel naming**: keep the domain-prefixed convention already used by sibling handlers
  (inspect the target handler in `src/main/ipc/` and match its channel string style — do not invent a new one).

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
