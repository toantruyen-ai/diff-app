# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

- Lịch sử thay đổi → `CHANGELOG.md` (cập nhật sau mỗi session)

## Commands

```bash
npm start       # Run the app (production mode)
npm run dev     # Run the app (dev mode, --dev flag available for devTools)
```

No build step — vanilla JS, loaded directly by Electron. No linter or test suite configured.

## Architecture

Three-process Electron app with strict context isolation:

```
main.js          Electron main process — all Node.js & k8s API calls happen here
preload.js       contextBridge — exposes window.k8sApi to the renderer (no direct Node access)
renderer/
  index.html     Shell + DOM structure
  styles.css     Dark-theme CSS (CSS variables, no framework)
  app.js         All renderer logic — state machine, DOM manipulation, IPC calls
```

### IPC flow

Renderer calls `window.k8sApi.*` → preload forwards via `ipcRenderer.invoke` → main.js `ipcMain.handle` executes k8s API → result serialized back to renderer.

Available IPC channels: `select-kubeconfig`, `load-contexts`, `load-namespaces`, `load-deployments`, `load-envs`.

### ENV resolution in `load-envs` (main.js)

For each container in the deployment spec, envs are resolved in this order:
1. `envFrom[].configMapRef` — bulk import all keys from a ConfigMap
2. `envFrom[].secretRef` — bulk import all keys from a Secret (base64-decoded)
3. `env[].value` — direct literal value
4. `env[].valueFrom.configMapKeyRef` — single key from a ConfigMap
5. `env[].valueFrom.secretKeyRef` — single key from a Secret (base64-decoded)
6. `env[].valueFrom.fieldRef` / `resourceFieldRef` — represented as a string, not resolved

Later entries in `env[]` overwrite earlier `envFrom` keys (matches Kubernetes behaviour).

### `resetBelow(side, level)` invariant (renderer/app.js)

The cascade selectors (context → namespace → deployment) reset downstream dropdowns when an upstream value changes. The function starts at `levels.indexOf(level) + 1` — meaning it resets everything **below** `level`, never the level itself. Passing `'kubeconfig'` (not in the levels array, gives index `-1`) resolves to start index `0`, resetting all three.

### Namespace fallback

`load-namespaces` first tries a cluster-wide `listNamespace()` call. If that fails (e.g. RBAC 403), it falls back to extracting unique `context.namespace` values from the kubeconfig contexts.

## MCP & context

- Ưu tiên `serena` MCP để tìm symbol/định nghĩa thay vì đọc nhiều file thô; chỉ đọc full file
  khi summary không đủ.
