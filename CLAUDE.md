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

### Testing Rules

- Always run `npm test` after modifying or adding any feature.
- Ensure new services or utils have corresponding unit tests under `tests/unit/`.
