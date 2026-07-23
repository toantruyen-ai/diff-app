# Changelog

## Unreleased

### Added
- **K8s Manage (Phase 1)** — new home-screen tool for browsing a single cluster, Lens-style:
  - Resource list for Pods, Deployments, StatefulSets, DaemonSets, Services, ConfigMaps, Secrets, Nodes, and Events, with a sidebar switcher, client-side name filter, and auto-refresh polling (5s; 10s for Nodes/Events).
  - Detail drawer with a live pod log viewer: container picker, follow-tail toggle (auto-disables on manual scroll-up), configurable tail-line count, and a bounded ring buffer to cap memory use.
  - Cluster entry point reuses the existing AKS cluster picker, generalized with a `maxSelect` parameter (2 for K8s ENV Diff, 1 for K8s Manage) instead of duplicating the picker UI; also supports "Use local kubeconfig".
  - `main.js`: one generic `list-resource` IPC handler projects each resource kind down to the fields the table needs and returns `{ok, rows}` / `{ok:false, error}` so an RBAC-denied kind renders an inline error instead of crashing the poller; `start-pod-logs`/`stop-pod-logs` stream logs via `k8s.Log`, coalescing chunks into a single flush every 150ms and truncating past a 256KB buffer, with sessions aborted on window close.
  - `preload.js`: exposes `listResource`, `startPodLogs`/`stopPodLogs`, and disposer-returning `onPodLogData`/`onPodLogEnd`/`onPodLogError` listeners.
  - Leaving the Manage workspace (or closing the app) is a single teardown choke point that stops the poll timer and any open log stream, so nothing keeps running in the background.
- **K8s Manage (Phase 2)** — pod exec/shell in the detail drawer, via vendored `xterm.js` (no bundler, loaded as plain `<script>`):
  - New "Exec" tab opens an interactive shell in the selected pod (tries `/bin/bash`, falls back to `/bin/sh`), with a container picker for multi-container pods.
  - `main.js`: `exec-start`/`exec-write`/`exec-resize`/`exec-stop` IPC channels drive `k8s.Exec`; stdin is a `PassThrough`, stdout/stderr share one `Writable` so output interleaves like a real terminal, and that same stream exposes `rows`/`columns` so the client-node resize channel activates. Sessions are tracked in an `execSessions` Map and aborted on window close, alongside existing log sessions.
  - `preload.js`: exposes `startExec`/`execWrite`/`execResize`/`stopExec` plus disposer-returning `onExecData`/`onExecExit`, following the same subscribe-before-start pattern as pod logs to avoid dropping the first bytes.
  - `renderer/app.js`: `startManageExec`/`stopManageExec` wire an `xterm.js` `Terminal` + `FitAddon` to the session, with a `ResizeObserver` keeping the PTY size in sync; wired into the same teardown choke point as log streams (tab switch, drawer close, leaving the workspace, app quit).
  - `renderer/vendor/xterm/` — vendored `@xterm/xterm` + `@xterm/addon-fit` browser builds (no bundler in this app); verified via `electron-builder --dir` that they ship inside `app.asar`.

### Planned
- Phase 3: CPU/memory metrics with hand-drawn SVG sparklines/charts.
