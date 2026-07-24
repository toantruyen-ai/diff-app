# CLAUDE.md

This file provides guidance to AI coding assistants when working with code in this repository.

- Lịch sử thay đổi → `CHANGELOG.md` (cập nhật sau mỗi session)

## Commands

```bash
npm start           # Run the app (auto-bundles renderer via prestart hook)
npm run dev         # Run the app (dev mode, --dev flag available for devTools)
npm test            # Run Vitest unit test suite
npm run build:renderer  # Bundle renderer/app.js → renderer/dist/app.js (esbuild)
```

The renderer is bundled by **esbuild** (`renderer/app.js` → `renderer/dist/app.js`, git-ignored). `prestart`/`predev` and the `build:*` targets run `build:renderer` automatically, so the bundle is always fresh. `index.html` loads `dist/app.js`, never `app.js` directly.

## Architecture

Modular, enterprise-grade Electron architecture designed for high scalability and token-efficient AI editing:

```
main.js                  # Entry point delegating to src/main/index.js
preload.js               # Entry point delegating to src/preload/index.js
src/
  main/
    index.js             # Main app bootstrapper (lifecycle, window, cleanup)
    constants/           # K8s constants, GVR mappings, watch paths
    db/                  # auditDb.js (Azure SQL audit trail), eventsDb.js (local SQLite)
    utils/               # Unit parsers, resource formatters, k8s helpers, timeouts
    services/            # Core business logic & K8s/Azure API integrations
      k8sService.js              # K8s context, namespace, deployment & CRD queries
      envResolverService.js      # ENV resolution (ConfigMap, Secret, FieldRef, direct)
      azureService.js            # Azure CLI, AKS clusters, storage, servicebus
      resourceActionService.js   # Resource actions (delete, restart, scale, yaml replace)
      watchService.js            # Real-time resource watch stream sessions
      podLogService.js           # Pod streaming logs
      podExecService.js          # Interactive pod shell terminal (PTY / xterm)
      portForwardService.js      # Local TCP port-forwarding
      metricsService.js          # Cluster overview & pod/node metrics
      auditService.js            # Resource versioning & audit DB integration
      eventsService.js           # Local SQLite event capture
      kubeconfigStoreService.js  # LRU-capped in-memory kubeconfig store
    ipc/                 # IPC handlers registering endpoints with ipcMain
      index.js, appHandler.js, k8sHandler.js, azureHandler.js, resourceHandler.js, watchHandler.js, logExecHandler.js, auditHandler.js
  preload/
    index.js             # Type-safe contextBridge exposing window.k8sApi
  renderer/
    utils/               # htmlUtils, yamlHighlighter, envDiffComputer — imported by renderer/app.js, bundled
    api/                 # Client-side API bridge
renderer/
  app.js                 # Renderer entry; requires src/renderer/utils, bundled to dist/app.js
  dist/app.js            # esbuild output (git-ignored, loaded by index.html)
tests/
  unit/                  # Comprehensive Vitest unit tests (36+ tests)
```

### IPC Flow & AI Vibe Code Efficiency

Renderer calls `window.k8sApi.*` → preload forwards via `ipcRenderer.invoke` → IPC handlers in `src/main/ipc/*` call domain services in `src/main/services/*`.

AI coding assistants can edit specific features by inspecting small, single-responsibility files (< 200 lines) in `src/main/services/` or `src/main/ipc/` without reading massive monolithic files, saving over 90% of token context.

### Naming Conventions (MANDATORY)

New code must match the conventions already in the codebase — copy the sibling you extend, never invent a new style.
The authoritative reference is **§1b of the `implement-code-flow` skill** (`.agents/skills/implement-code-flow/SKILL.md`).

| Thành phần | Quy tắc | Ví dụ |
|---|---|---|
| File service | `<domain>Service.js` | `k8sService.js`, `watchService.js`, `portForwardService.js` |
| File IPC handler | `<domain>Handler.js` | `k8sHandler.js`, `azureHandler.js`, `logExecHandler.js` |
| File util | camelCase noun / `<x>Helper.js` | `unitParser.js`, `resourceFormatter.js`, `k8sHelper.js` |
| File constants | `<domain>Constants.js` | `k8sConstants.js` |
| File DB | `<domain>Db.js` | `auditDb.js`, `eventsDb.js` |
| File test | `<module>.test.js` mirror `src/` path | `tests/unit/main/services/k8sService.test.js` |
| Hằng số export | `UPPER_SNAKE_CASE` | `MANAGE_KINDS`, `ALL_NAMESPACES`, `MANAGE_KIND_GVR` |
| Hàm | verb-first `camelCase` | `loadContexts`, `getResourceYaml`, `applyResourceYaml`, `resourceAction` |
| Kênh IPC invoke | `kebab-case` verb-noun | `load-contexts`, `get-resource-yaml`, `list-crds`, `search-resources` |
| Streaming lifecycle | `<domain>-start` / `<domain>-stop` | `watch-start`/`watch-stop`, `exec-start`, `pf-start` |
| Family cùng domain | prefix chung | `audit-db-connect`, `audit-db-status`, `az-login` |
| Push-event theo session | `<base>:${sid}` (kebab) | `pod-log-data:${sid}`, `watch-event:${sid}`, `exec-data:${sid}` |
| Preload request key | `camelCase` mirror IPC 1:1 | `watch-start`→`startWatch`, `get-resource-yaml`→`getResourceYaml` |
| Preload push subscriber | `on` + PascalCase, trả về hàm unsubscribe | `onWatchEvent`, `onPodLogData`, `onExecExit` |

**Quy tắc 1:1**: một request/response giữ 1 khái niệm qua 3 tầng — IPC `kebab-case` ↔ preload/service `camelCase` verb-noun.
Biết 1 tầng suy ra được 2 tầng còn lại. Streaming domain **mới** dùng `<domain>-start`/`-stop` (không dùng dạng cũ `start-pod-logs`).

### Security Coding Standard (MANDATORY)

Electron app holding cluster credentials, kubeconfigs, Azure tokens, and K8s Secrets; shells out to `az`/`kubelogin`/`kubectl`.
Treat everything crossing renderer→main as untrusted. Full rules in **§1c of `implement-code-flow`**.

- **Electron hardening**: keep `contextIsolation: true` + `nodeIntegration: false`; prefer `sandbox: true`. Preload exposes only the curated `k8sApi` — never raw `ipcRenderer`/`require`/`process` or a generic `invoke` passthrough.
- **No shell injection**: never interpolate untrusted values into a shell string (quoting is not safe). Use `execFile`/`spawn` arg-arrays with `shell: false`; `execSync('static string')` only when there is no interpolation.
- **Validate IPC input**: check type/shape at each handler; identifiers (cluster/RG/namespace/pod) must match an allow-list (`/^[a-z0-9][a-z0-9._-]*$/i`) → else `{ ok: false, reason: 'invalid-input' }`.
- **File paths**: accept only a native-dialog-picked path or a stored kubeconfig id — never an arbitrary renderer path (traversal).
- **Secrets**: route Secret payloads through `redactSecretData` before returning/persisting/logging; never log tokens/kubeconfigs/Secret values; `unlink` temp credential files in `finally`.
- **SQL (audit DB)**: parameterized `mssql` queries (`request.input(...)`) only — never string-concatenate.
- **Mutations**: destructive K8s actions stay on the audit/write-gate path (it is a security control). Don't broaden RBAC/verbs beyond need.

### Testing Rules

- Always run `npm test` after modifying or adding any feature.
- Ensure new services or utils have corresponding unit tests under `tests/unit/`.
