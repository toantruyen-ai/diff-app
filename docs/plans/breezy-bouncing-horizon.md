# Plan: K8s Manage — Phase 4–7 roadmap (YAML/Events, Safe Actions, Port-forward, Breadth)

## Context

`K8s Manage` (added in Phases 1–3) is today a **strictly read-only** Lens-style tool: browse resources, tail pod logs, exec into pods, view CPU/mem metrics. Every k8s call in `main.js` is `list*`/`read*` — there are no mutations, no manifest (YAML) view, no port-forward, and only 9 resource kinds in a single namespace at a time.

The user wants to close the gap toward a real cluster-management tool. Confirmed scope (from clarifying questions): build **all four** areas below, shipped as incremental phases like before, with mutations limited to **safe, bounded actions only** — **no free-form YAML edit/apply**. The intended outcome is that an operator can inspect a manifest, troubleshoot with scoped events, perform the everyday safe operations (restart/scale/delete/cordon), reach a pod locally via port-forward, and browse the resource kinds/namespaces that matter — all without leaving the app for `kubectl`.

## Design principles (bind to existing code)

- **Every k8s call goes through `buildKubeConfig(ref, contextName)` (`main.js:880`)** — handles file / AKS in-memory (`aksKcStore`) / inline content, and patches ExecAuth timeout. Wrap calls in `withTimeout(...)` (`main.js:10`).
- **`{ok:true,...}` / `{ok:false,error}` convention** for all new IPC (mirror `list-resource` `main.js:628`) so an RBAC-403 renders inline, never crashes the poller or throws to the renderer.
- **Generic-handler style**: extend the existing per-kind lookup pattern (`projectRow` `main.js:527`, the `switch` in `list-resource`) rather than adding one handler per kind.
- **Drawer as the action surface**: the drawer already has `state.manage.selected` (`row`), plus `state.manage.{kubeconfig,context,namespace,resourceType}` — everything a mutation needs is already in state. New tabs follow the existing `.manage-tab[data-tab=…]` + `switchManageTab` (`app.js:1733`) pattern; tab visibility is gated per-kind exactly like Logs/Exec/Metrics (`openManageDrawer` `app.js:1692-1699`).
- **Teardown choke point**: any new stream/server (port-forward) must register a disposer and be stopped from the same place logs/exec/metrics are (`closeManageDrawer`, kind/ns switch, leaving `manage`, `mainWindow 'closed'`). Follow the disposer-returning `on*` preload pattern.
- **No bundler / no new deps**: vanilla JS, CSS via `:root` tokens, reuse `.sdr-table`, `.btn*`, `.status-pill`, `.manage-*` classes. Confirm dialogs reuse existing overlay/modal styling (no `window.confirm`).

---

## PHASE 4 — YAML view + scoped Events (read-only, foundational)

Two new drawer tabs, available for **all kinds**. Lowest risk; prerequisite for later work.

- **`main.js`**
  - `get-resource-yaml (ref, ctx, ns, kind, name)`: per-kind `read*` (e.g. `coreApi.readNamespacedPod(name, ns)`, `appsApi.readNamespacedDeployment`, `coreApi.readNode(name)` for cluster-scoped). Strip noise (`metadata.managedFields`, `metadata.resourceVersion`), then `k8s.dumpYaml(obj)` → `{ok, yaml}`. Reuse the same kind→api lookup shape as `list-resource`.
  - `get-resource-events (ref, ctx, ns, kind, name)`: `coreApi.listNamespacedEvent(ns, undefined, …, fieldSelector = 'involvedObject.name=' + name)` → project `{type, reason, message, count, age}` sorted newest-first → `{ok, rows}`.
- **`preload.js`**: expose `getResourceYaml`, `getResourceEvents`.
- **`index.html`**: add `<button class="manage-tab" data-tab="yaml">YAML</button>` and `data-tab="events">Events`; add `#manage-yaml-pane` (a `<pre>` reusing `.manage-log-output` mono styling + a Copy button) and `#manage-events-pane` (a small `.sdr-table`).
- **`app.js`**: in `switchManageTab` add `yaml`/`events` branches that fetch on open (one-shot, not polled). Show these tabs for every kind in `openManageDrawer`. YAML pane: read-only `<pre>` + "Copy" button (no edit — per decision). Events pane: render rows or a `.manage-empty` "No events".
- **CSS**: `.manage-yaml-pane` (mono, scroll, wrap-off), reuse table styles for events.

---

## PHASE 5 — Safe resource actions (mutating, confirm-gated)

A small, fixed set of bounded operations surfaced as buttons in the drawer header (and optionally a row hover menu). **No arbitrary YAML apply.**

- **Actions by kind**
  - Pods → **Delete** (i.e. restart via controller) — `coreApi.deleteNamespacedPod(name, ns)`.
  - Deployments / StatefulSets / DaemonSets → **Rollout restart** — strategic-merge patch adding `spec.template.metadata.annotations['kubectl.kubernetes.io/restartedAt'] = <ISO now>`.
  - Deployments / StatefulSets → **Scale N** — `patchNamespacedDeploymentScale` / `…StatefulSetScale` with `{spec:{replicas:N}}` (small prompt for N).
  - Nodes → **Cordon / Uncordon** — patch `spec.unschedulable`. (**Drain** = cordon + evict pods via the eviction API loop; flag as an optional stretch within this phase, not required for the first cut.)
  - Any kind → **Delete** with a **typed confirmation** (user types the resource name to enable the button).
- **`main.js`**: one guarded `resource-action (ref, ctx, ns, kind, name, action, payload)` handler with an explicit allow-list `switch(action)` → `restart|scale|delete|cordon|uncordon`. **Patch gotcha (client-node 0.21):** pass `{ headers: { 'Content-Type': 'application/strategic-merge-patch+json' } }` as the options argument or the patch 415s. Return `{ok,...}`; RBAC-403 → `{ok:false,error}` shown inline.
- **`preload.js`**: expose `resourceAction`.
- **`app.js`**: a reusable `confirmAction({title, body, danger, requireTyped})` modal (reuse existing overlay markup/classes; **not** `window.confirm`). On success, immediately `refreshManageResources()`. Action buttons rendered per-kind in the drawer header next to the close button.
- **CSS**: `.manage-actions` button group, `.btn-danger` variant, confirm-modal classes (reuse the auth/loading overlay recipe).

---

## PHASE 6 — Port-forward (pods)

Local `localhost:<port>` → pod, with an active-forwards manager. Scope v1 to **pods**; service→endpoint resolution noted as follow-up.

- **`main.js`**: `require('net')` + `k8s.PortForward`. `pf-start (ref,ctx,ns,pod,targetPort,localPort,sid)` → `net.createServer(socket => new k8s.PortForward(kc).portForward(ns, pod, [targetPort], socket, socket, socket))`, `server.listen(localPort, '127.0.0.1')`; track `{server}` in a `pfSessions` Map. `pf-stop (sid)` → `server.close()` + delete. Abort all on `mainWindow 'closed'` (same teardown block as `logSessions`/`execSessions`). Emit `pf-error:<sid>` on listen failure (port in use) → `{ok:false}`.
- **`preload.js`**: `startPortForward`, `stopPortForward`, disposer-returning `onPortForwardError`.
- **`app.js`**: pod drawer gains a **Port-forward** tab/section: target-port + optional local-port inputs → Start; an active list `localhost:8080 → pod:80 [Stop]` kept in `state.manage.portForwards` (Map). Wire stop-all into the teardown choke point.
- **CSS**: `.manage-pf-*` list/row styles.

---

## PHASE 7 — Breadth: more kinds + all-namespaces

Mostly reuses the generic list path; low logic, some new API clients.

- **New kinds** (extend `MANAGE_KINDS` `main.js:508`, the `list-resource` switch, `projectRow`, sidebar buttons `index.html:424`, and `MANAGE_COLUMN_DEFS` `app.js:1378`):
  - Jobs, CronJobs → `k8s.BatchV1Api` (`listNamespacedJob`, `listNamespacedCronJob`).
  - Ingresses → `k8s.NetworkingV1Api` (`listNamespacedIngress`).
  - PVCs → `coreApi.listNamespacedPersistentVolumeClaim`; PVs → `coreApi.listPersistentVolume` (cluster-scoped).
  - ReplicaSets → `appsApi.listNamespacedReplicaSet`; HPAs → `k8s.AutoscalingV2Api`; Namespaces → `coreApi.listNamespace` (cluster-scoped).
- **All-namespaces**: add `(All namespaces)` option to `#manage-namespace`. When selected, call the `list*ForAllNamespaces()` variants (or pass a sentinel and branch in the handler); include a `namespace` field in projected rows and prepend a **Namespace** column via `COLUMN_DEFS`. Metrics/logs/exec/actions that require a namespace read it from the selected row, not the header, in this mode.
- Cluster-scoped kinds (nodes, PVs, namespaces) ignore the namespace selector as nodes already do.

---

## Cross-cutting risks

- **Mutation blast radius**: fixed allow-list of actions server-side; destructive ops require typed confirm client-side; refresh immediately after so the UI reflects reality. No generic apply.
- **Patch content-type** (Phase 5) — the #1 gotcha; strategic-merge header required.
- **Leak discipline** (Phase 6) — every `net.Server` tracked in a Map and closed on stop, drawer close, kind/ns switch, leave-view, and `mainWindow 'closed'`; every per-session `on*` returns a disposer.
- **RBAC / missing CRDs** — `{ok,false}` inline everywhere; a denied kind or missing metrics never crashes a poller (existing convention).
- **Ship incrementally** and update `CHANGELOG.md` after each phase (per `CLAUDE.md`).

## Files touched (all phases)

- `main.js` — new IPC: `get-resource-yaml`, `get-resource-events` (P4); `resource-action` (P5); `pf-start`/`pf-stop` (P6); extend `MANAGE_KINDS`/`projectRow`/`list-resource` + new API clients (P7); extend `mainWindow 'closed'` teardown.
- `preload.js` — expose each new method + disposer for `onPortForwardError`.
- `renderer/index.html` — YAML/Events tabs + panes (P4); action buttons + confirm modal (P5); port-forward section (P6); sidebar kind buttons + all-namespaces option (P7).
- `renderer/app.js` — `switchManageTab` branches, per-kind tab/action gating, confirm modal, `state.manage.portForwards`, `COLUMN_DEFS` entries, all-namespaces handling; teardown wiring.
- `renderer/styles.css` — `.manage-yaml-pane`, `.manage-actions`/`.btn-danger`, confirm-modal, `.manage-pf-*`.
- No `package.json` changes — no new dependencies.

## Verification (end-to-end, per phase)

Run `npm run dev`, enter a cluster (AKS or local kubeconfig), open Manage.
1. **P4**: select a Deployment → **YAML** tab shows clean manifest, Copy works; **Events** tab on a failing pod shows its events; on a healthy resource shows "No events".
2. **P5**: Deployment → **Rollout restart** → pods recreate (watch the Pods list refresh); **Scale** to N → replica count changes; Pod **Delete** → controller respawns it; Node **Cordon** → status flips to `SchedulingDisabled`, **Uncordon** reverts; **Delete** requires typing the name; trigger an RBAC-denied action → inline error, no crash.
3. **P6**: pod Port-forward `8080→80` → `curl localhost:8080` reaches the pod; **Stop** frees the port; leave the workspace → confirm the `net.Server` is closed (no lingering listener); starting on a busy port → inline error.
4. **P7**: sidebar shows Jobs/CronJobs/Ingress/PVC/PV/ReplicaSet/HPA/Namespace and each lists; select **(All namespaces)** → Namespace column appears and rows span namespaces; cluster-scoped kinds ignore the namespace selector.
5. **Teardown regression** (every phase): Back to home and re-enter → no leftover pollers, log/exec streams, or port-forward servers.
