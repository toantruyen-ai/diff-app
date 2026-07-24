# Plan: Thêm "K8s Manage" — quản lý cluster kiểu Lens

## Context

App hiện tại (`k8s-env-diff`, Electron 3-process) chỉ so sánh ENV giữa các deployment. User muốn bổ sung khả năng **quản lý k8s giống Lens**: xem danh sách resource, xem logs, mở shell/exec vào pod, và metrics/biểu đồ. Đây là một tool mới độc lập trong bộ "DevOps Diff Tools", không đụng đến các tính năng diff hiện có.

**Quyết định đã chốt với user:**
- **Chia phase**: Phase 1 = Resource list + Logs → Phase 2 = Exec/shell → Phase 3 = Metrics/charts. Ship dần.
- **Bố cục**: thêm tool-card "K8s Manage" → mở 1 view workspace mới có **sidebar trái** (resource types) + bảng chính + drawer chi tiết. Quản lý MỘT cluster tại một thời điểm.
- **Thư viện**: vendor **xterm.js** (local, Phase 2) cho terminal; metrics **tự vẽ SVG** (Phase 3). App không có bundler → chỉ dùng `<script src>` local.

## Nguyên tắc bám code hiện có

- **Mọi call k8s phải đi qua `buildKubeConfig(ref, contextName)`** (`main.js:507`) — nó xử lý cả file mode, AKS `kubeconfigId` (in-memory `aksKcStore`), và patch ExecAuth timeout 15s. Dùng đúng thứ tự tham số `(ref, ctx, ns, …)` như `loadEnvs`.
- `state.manage.kubeconfig` giữ **file path HOẶC AKS `kubeconfigId`** — giống `state.left/right.kubeconfig`.
- Tái dùng: `showView`/`BACK_TARGETS` (`app.js:541,550`), `showLoading/hideLoading` (104), `escHtml` (529), `populateSelect` (513), `renderClusterList` (613), `envTagClass` (602), `getAksCredentials` IPC, `applySdrFilter` pattern (864).
- CSS tái dùng (đều dùng `:root` tokens ở `styles.css:4`): `.sdr-table` (1114) + scrollbar recipe (1110), `.btn*` (148), `.badge*`/`.status-pill` (626), `.toggle-btn`/`.dep-view-btn` (461/303), `.spinner` (653), `.tool-card` (726), `.cluster-item` (877).
- Push channel duy nhất hiện có là `webContents.send('update-available')` (`main.js:31`) → cần thêm pattern streaming per-session + teardown listener.

---

## PHASE 1 — Resource list + Pod logs (làm đầu tiên, chi tiết)

### 1.1 Entry flow
- Thêm home card `#card-k8s-manage` (clone block `<button class="tool-card">` ở `index.html:46`; wire cạnh `el.cardK8sDiff` ở `app.js:567`).
- Click → `showView('manage-select')` + `loadManageClusterList()`. **Tái dùng picker cluster AKS ở chế độ single-select**: tổng quát hóa `toggleCluster`/`refreshClusterSelectionUI` (638/650) bằng tham số `maxSelect` (2 cho diff, 1 cho manage) thay vì copy. Thêm nút "Use local kubeconfig" ở footer → vào thẳng với `kubeconfig=null`.
- Confirm: AKS → `getAksCredentials(name, rg)` lấy `kubeconfigId`; local → `null`. Lưu vào `state.manage.kubeconfig` → `showView('manage')`.
- Trong workspace, header có select context/namespace: viết `loadManageContexts()`/`loadManageNamespaces()` mirror `loadContexts`/`loadNamespaces` (178/202) nhưng đọc/ghi `state.manage` + header selects (hàm cũ hard-bind vào `el[side]`/`state[side]`).

### 1.2 Layout workspace (`index.html` + `styles.css`)
Thêm `#manage-view.manage-view` (flex row) sau `#servicebus-diff-result-view`:
```
#manage-view                         (add vào showView + BACK_TARGETS)
 ├─ aside#manage-sidebar             → button.manage-nav-item[data-kind] (.active)
 ├─ section.manage-main
 │   ├─ header#manage-header         → select#manage-context, select#manage-namespace,
 │   │                                 input#manage-search, span#manage-refresh-status,
 │   │                                 button#manage-btn-refresh
 │   └─ div#manage-table-wrap.sdr-table-wrap → table.sdr-table > thead#manage-thead / tbody#manage-tbody
 └─ aside#manage-drawer.manage-drawer (.open; ẩn mặc định)
     ├─ header + nav.manage-drawer-tabs (.manage-tab[data-tab="detail"|"logs"]) + button#manage-drawer-close
     ├─ div#manage-detail-pane
     └─ div#manage-logs-pane
         ├─ toolbar: select#manage-log-container, input#manage-log-follow (checkbox),
         │           input#manage-log-tail (mặc định 500), button#manage-log-clear
         └─ pre#manage-log-output.manage-log-output
```
- Resource types Phase 1 (`data-kind`): **Pods, Deployments, StatefulSets, DaemonSets, Services, ConfigMaps, Secrets, Nodes, Events** (ưu tiên Pods + Deployments; còn lại dùng chung code nên rẻ).
- CSS mới (dùng tokens có sẵn): `.manage-view/.manage-sidebar/.manage-nav-item(.active)/.manage-main/.manage-header/.manage-drawer(.open)/.manage-drawer-tabs/.manage-tab/.manage-log-toolbar/.manage-log-output/.manage-empty`. `.manage-log-output` = `font-family:var(--font-mono); font-size:12px; white-space:pre-wrap; overflow:auto` + copy scrollbar recipe từ `.table-wrapper` (510-513). Map màu status: Running=`--green`, Pending=`--missing-*`, CrashLoopBackOff/Error=`--red`.
- Sửa `showView` (550): thêm dòng cho `manage` và `manage-select`; `BACK_TARGETS['manage']='manage-select'`, `['manage-select']='home'`. **Quan trọng:** khi rời `manage` → gọi `stopManagePolling()` + `stopAllManageLogs()` (choke point teardown).

### 1.3 Resource listing IPC — **một handler generic** `list-resource`
Lý do 1 handler thay vì per-kind: signature giống `loadEnvs`, chung `buildKubeConfig`+`withTimeout`, 1 preload method; khác biệt per-kind chỉ là api method + field projection (lookup table).

- **`main.js`**: `ipcMain.handle('list-resource', (e, ref, ctx, ns, kind))`. `buildKubeConfig(ref, ctx)`; switch kind → `coreApi.listNamespacedPod/Service/ConfigMap/Secret/Event(ns)`, `appsApi.listNamespacedDeployment/StatefulSet/DaemonSet(ns)`, `coreApi.listNode()` (cluster-scoped). Bọc `withTimeout(…, 20000, 'Timed out listing <kind>…')` (mirror 172-176). **Project trong main** cho payload nhỏ: pods → `{name, ready:"1/2", status, restarts, node, age:creationTimestamp, containers:[names]}` (ready từ `containerStatuses`, restarts = sum `restartCount`, status ưu tiên `waiting.reason` rồi `status.phase`). Trả `{ok:true, rows}` / `{ok:false, error}` (dùng convention `{ok,…}` để RBAC-deny 1 kind không crash poller). Include `containers` trong pod row (khỏi round-trip cho log picker).
- **`preload.js`**: `listResource: (ref,ctx,ns,kind) => ipcRenderer.invoke('list-resource', ref,ctx,ns,kind)`.
- **`app.js`**: `COLUMN_DEFS` map (pods/deployments/services/nodes/events/configmaps/secrets); `renderManageTable(kind, rows)` build thead/tbody vào `.sdr-table`, status cell dùng `.status-pill`, row click → `openManageDrawer`; `selectManageKind(kind)` set `state.manage.resourceType` + restart poll; `refreshManageResources()` gọi `listResource`, `!ok` render error row (không alert), filter client-side theo `#manage-search`; helper `relAge(ts)`.
- **Auto-refresh = polling 5s** (nodes/events có thể 10s). Lý do: `watch` cần streaming IPC + resourceVersion + reconnect 410 — quá nặng cho model request/response; payload nhỏ, 5s ngang Lens. `state.manage.pollTimer = setInterval(...)` start trong `selectManageKind`, **clear trong `stopManagePolling()`** gọi từ: rời view, đổi kind, đổi context/namespace, `beforeunload`.

### 1.4 Pod logs (phần streaming — khó nhất)
Renderer tự tạo `sessionId` (`crypto.randomUUID()`) và **subscribe trước khi start** (tránh race chunk đầu).

- **Channels**: `start-pod-logs` (invoke, args `(ref,ctx,ns,pod,container,opts,sid)`, opts `{tailLines,follow:true,timestamps}`), `stop-pod-logs` (invoke `(sid)`); push động: `pod-log-data:<sid>`, `pod-log-error:<sid>`, `pod-log-end:<sid>`.
- **`main.js`**: `const logSessions = new Map()`. `start`: `new k8s.Log(kc)`; tạo `stream.Writable` `_write` đẩy chunk vào buffer per-session; `const req = await logApi.log(ns,pod,container,writable,{follow:true,tailLines,timestamps})`; lưu `{req, buffer, flushTimer}`. `stop`: `req.abort()` (handle teardown đã verify) + `clearInterval(flushTimer)` + `delete`. **Cleanup chống leak**: `mainWindow.on('closed', ...)` abort tất cả session; guard `if (!mainWindow || mainWindow.isDestroyed()) return` trước mỗi `send`.
- **Back-pressure**: main KHÔNG send mỗi chunk — coalesce vào buffer, `flushTimer = setInterval(flush, 150)` gửi gộp; nếu buffer > 256KB gửi marker truncate + giữ tail. Renderer: `<pre>` là ring buffer giữ ~5000 dòng cuối; follow-tail → `scrollTop=scrollHeight`; user scroll lên → tự bỏ check follow.
- **`preload.js`** (mỗi `on*` trả **disposer** để gỡ listener — khác `onUpdateAvailable` không gỡ):
  ```
  startPodLogs, stopPodLogs,
  onPodLogData(sid,cb) => { on('pod-log-data:'+sid, h); return ()=>removeListener(...) }
  onPodLogEnd(sid,cb), onPodLogError(sid,cb)   // cùng pattern disposer
  ```
- **`app.js`**: `openManageDrawer(kind,row)` — nếu pods enable tab Logs, populate `#manage-log-container` từ `row.containers`. `startManageLogs()`: `stopManageLogs()` trước, tạo `sid`, subscribe (lưu disposers) rồi mới `startPodLogs`. `appendLogBatch(text)` append + trim ring + follow scroll. `stopManageLogs()`: `stopPodLogs(sid)` + gọi hết disposers + null session — gọi khi đổi container/pod/kind/namespace, đóng drawer, chuyển tab, và trong teardown `showView`.

### State/refs mới (Phase 1)
- `state.manage = { kubeconfig, context, namespace, resourceType:'pods', rows:[], selected:null, pollTimer:null, logSession:null }`.
- `el`: `manageView, manageSidebar, manageHeader, manageContext, manageNamespace, manageSearch, manageRefreshStatus, manageBtnRefresh, manageThead, manageTbody, manageDrawer, manageDrawerClose, manageDetailPane, manageLogsPane, manageLogContainer, manageLogFollow, manageLogTail, manageLogClear, manageLogOutput, cardK8sManage`, `manageNavItems`.

---

## PHASE 2 — Pod exec/shell (outline)
Files: `main.js`, `preload.js`, `index.html`, `app.js`, `styles.css`, `package.json`, + `renderer/vendor/xterm/*`.
- **`k8s.Exec`**: `stream.PassThrough` làm stdin (keystroke renderer push vào), 2 `Writable` stdout/stderr forward về renderer; `exec(ns,pod,container,['/bin/sh','-c','exec /bin/bash || exec /bin/sh'], stdout, stderr, stdin, true, statusCb)` → trả WebSocket.
- **Channels**: `exec-start` (invoke → `{ok,sid}`), `exec-write` (dùng `ipcRenderer.send`, low-latency → `stdin.write`), `exec-resize` (`(sid,cols,rows)` → terminal-size queue), `exec-stop` (`ws.close()`+stdin end); push `exec-data:<sid>` + `exec-exit:<sid>`. `execSessions` Map + teardown ở `mainWindow 'closed'`.
- **preload**: `startExec, execWrite, execResize, stopExec, onExecData(sid,cb)→disposer, onExecExit(sid,cb)→disposer`.
- **Vendor xterm** (no bundler): thêm dep `xterm` + `@xterm/addon-fit`, **copy** file build vào `renderer/vendor/xterm/` (`xterm.js`, `xterm.css`, `addon-fit.js`); reference bằng `<link>`/`<script>` trong `index.html` trước `app.js` → dùng global `window.Terminal`/`FitAddon`. Không có CSP tag nên load sạch.
- **Renderer**: tab drawer `data-tab="exec"` + `#manage-term`; `new Terminal({convertEol:true})`, `term.onData(d=>execWrite(sid,d))`, `onExecData(sid, d=>term.write(d))`, FitAddon + `ResizeObserver` → `execResize`. Theme background = `var(--bg-base)` qua option xterm.
- **electron-builder**: `build.files` đã có `renderer/**/*` nên `renderer/vendor/**` tự ship — **verify** bằng `npx electron-builder --dir`.

## PHASE 3 — Metrics/charts (outline)
Files: `main.js`, `preload.js`, `app.js`, `styles.css`, `index.html`.
- **IPC** `get-metrics` `(ref,ctx,ns,scope)`: `new k8s.Metrics(kc)` → `getPodMetrics(ns)`/`getNodeMetrics()`. **Fail → `{ok:false, reason:'metrics-server-unavailable', error}`** (metrics-server 404/ServiceUnavailable rất phổ biến, không được crash poller).
- **Parse units**: CPU `250m`→250, `1`→1000, `1500000000n`→/1e6; memory `Ki/Mi/Gi`→bytes.
- **Time series client-side**: `state.manage.metricsSeries = Map(key → ring buffer[{t,cpu,mem}])` cap ~60 điểm; poll 10s push sample mới, drop cũ (dựng series từ dữ liệu point-in-time `top`).
- **SVG tự vẽ**: `renderSparkline(container, points, {accessor,color})` → `<path d>` trong `viewBox="0 0 100 30"`, stroke `var(--accent)`, area fill mờ, gridline `--border`. CPU + memory sparkline mỗi pod/node; line chart lớn trong drawer. IDs `#manage-metrics-pane`, class `.manage-spark`, `.manage-chart`.
- **Fail UX**: `reason==='metrics-server-unavailable'` → render `.manage-empty` ("Metrics server not installed") + dừng poll metrics.

---

## Rủi ro cross-cutting (áp dụng mọi phase)
- **Listener leak**: mọi `on*` per-session TRẢ disposer và gọi khi teardown (khác `onUpdateAvailable:21` không gỡ).
- **Request leak**: mọi `Log` request / `Exec` WS track trong Map, abort/close khi stop VÀ khi `mainWindow 'closed'`.
- **Back-pressure**: coalesce+flush ở main, ring-buffer cap ở renderer.
- **Teardown 1 choke point**: `showView` rời `manage` gọi `stopManagePolling()` + `stopAllManageLogs()` (+ exec/metrics phase sau).
- **RBAC/kind fail**: `list-resource`/`get-metrics` dùng `{ok,…}` → render inline khi poll, không alert.
- **electron-builder**: verify `renderer/vendor/**` vào bundle (Phase 2).
- Cập nhật `CHANGELOG.md` sau mỗi phase (theo CLAUDE.md).

## Files sẽ sửa
- `main.js` — IPC `list-resource`, `start/stop-pod-logs` (P1); exec (P2); `get-metrics` (P3); teardown ở `createWindow`.
- `preload.js` — expose các method mới + disposer pattern.
- `renderer/index.html` — `#card-k8s-manage`, `#manage-select-view`, `#manage-view`; xterm `<script>` (P2).
- `renderer/app.js` — `state.manage`, `el` refs, entry flow, `renderManageTable`, polling, log viewer; exec (P2); metrics (P3).
- `renderer/styles.css` — class `.manage-*`.
- `package.json` — dep xterm + verify `build.files` (P2).
- `renderer/vendor/xterm/*` — file vendored (P2).

## Verification (end-to-end)
1. `npm run dev` → home hiện card **K8s Manage**.
2. Click card → chọn 1 cluster AKS (hoặc "Use local kubeconfig") → vào workspace.
3. **Resource list**: sidebar Pods → bảng hiện pods (name/ready/status/restarts/age/node); đổi namespace ở header → bảng cập nhật; quan sát auto-refresh 5s; đổi qua Deployments/Services/Nodes/Events; search lọc đúng; RBAC-deny 1 kind → error row (không crash).
4. **Logs**: click 1 pod → drawer tab Logs → chọn container → log stream chảy; toggle follow-tail; scroll lên tự bỏ follow; pod nhiều container đổi picker → stream reset; đóng drawer / rời view → xác nhận không còn stream chạy ngầm (log main-process, không leak).
5. **Teardown**: Back về home rồi vào lại → không có poll/stream cũ tồn đọng.
6. (P2) exec: mở shell, gõ `ls`, resize cửa sổ terminal reflow, đóng → WS close. Verify `--dir` build có `renderer/vendor/xterm`.
7. (P3) metrics: cluster có metrics-server → sparkline CPU/mem cập nhật theo poll; cluster không có → hiện notice, không crash.
