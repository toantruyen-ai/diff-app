# Debug tooling cho ứng dụng quản lý Kubernetes (Electron)

Tài liệu thiết kế kiến trúc — mục tiêu tạo khác biệt so với Lens ở mảng debug: ephemeral container, exec terminal, và port-forward manager. Tài liệu này mô tả **kiến trúc và đặc tả**, không kèm code.

Stack giả định: Electron + TypeScript, dùng `@kubernetes/client-node`, `xterm.js`.

---

## 1. Nguyên tắc nền tảng

Mọi kết nối sống lâu — exec WebSocket, port-forward server, pod watch — nằm ở **main process**. Renderer chỉ giữ UI và một `xterm.js` instance, tham chiếu session qua `sessionId`, nói chuyện với main qua IPC.

Hệ quả then chốt: **lifecycle của session tách rời khỏi lifecycle của cửa sổ renderer**. Reload hay đóng/mở cửa sổ không giết session. Khi cửa sổ mở lại, renderer chỉ cần `session:list` rồi re-attach vào các session còn sống. Đây là điểm Lens làm mất session mỗi khi cửa sổ reload hoặc mạng chớp tắt.

---

## 2. Mô hình tiến trình

```
Renderer (React + xterm.js)            Main process (Node)
  │                                      │
  │  control plane: IPC invoke/event     │  @kubernetes/client-node
  │  ── exec:start / pf:start ─────────► │  KubeConfig, CoreV1Api
  │  ◄─ session:event (status) ───────── │  Exec, PortForward, Watch
  │                                      │
  │  data plane: MessageChannel          │  SessionManager
  │  ══ stdin ═════════════════════════► │   ├─ ExecSession
  │  ◄═ stdout / stderr ════════════════ │   └─ PortForwardSession
  │                                      │
                              (WS exec / port-forward / watch)
                                         │
                                   kube-apiserver
```

Hai mặt phẳng truyền thông tách bạch có chủ đích:

- **Control plane** (IPC `invoke`/`handle` + event): mang lệnh điều khiển và trạng thái. Lưu lượng thấp.
- **Data plane** (`MessageChannel`, transferable `ArrayBuffer`): mang byte stream của terminal (stdin/stdout/stderr). Lưu lượng cao, zero-copy, không đi qua IPC string để tránh nghẽn UI.

---

## 3. SessionManager

Singleton ở main process — "sổ cái" của mọi kết nối sống lâu.

Trách nhiệm:

- Registry `Map<sessionId, Session>`: thêm, lấy, xóa, liệt kê.
- EventEmitter trung tâm: session con emit event lên manager, manager relay xuống tất cả cửa sổ renderer đang mở (`webContents.send`).
- Vòng đời: tạo session, dispose từng cái, `disposeAll()` khi app quit.
- Không chứa logic k8s cụ thể — chỉ quản lý các object tuân theo interface `Session` chung.

### Interface `Session` (chung cho mọi loại)

- Nhận dạng: `id`, `kind` (`exec` | `port-forward`), `status`, metadata mô tả (context, namespace, pod, container/port).
- `dispose()`: đóng sạch tài nguyên (ws.close, server.close, watch.abort).
- `describe()`: trả snapshot tuần tự hóa được (`SessionInfo`) để gửi renderer — không chứa handle sống.
- Là EventEmitter: bắn `status` change và (với exec) sự kiện dữ liệu.

Nhờ abstraction này, panel "tất cả session đang chạy" và logic dispose/restore dùng chung một đường, không phân biệt loại.

---

## 4. IPC contract

Đặt trong một module **shared** import được từ cả main và preload/renderer — nguồn sự thật duy nhất.

### 4.1 Control plane — RPC (renderer → main, `invoke`/`handle`)

Đồng bộ, có request/response rõ ràng. Mọi message mang `context` (kubeconfig context) để định tuyến cluster.

| Channel | Request (fields) | Response |
|---|---|---|
| `exec:start` | context, namespace, pod, container, shell?, cols, rows | sessionId, shell (thực dùng), portId |
| `exec:resize` | sessionId, cols, rows | ack |
| `exec:stop` | sessionId | ack |
| `pf:start` | context, target descriptor (mục 7), localPort?, name? | sessionId, localPort |
| `pf:stop` | sessionId | ack |
| `pf:list` / `session:list` | — | SessionInfo[] |
| `debug:inject-ephemeral` | context, namespace, pod, targetContainer, image? | containerName |
| `debug:copy-to` | context, namespace, pod, containerToOverride | newPodName |

Nguyên tắc: **control plane không bao giờ mang byte payload của terminal**. `exec:write` (stdin) cố tình không nằm ở đây — nó đi data plane. `exec:resize` thì ngược lại, là lệnh điều khiển nên nằm control plane để không chen vào luồng byte.

### 4.2 Control plane — events (main → renderer, một kênh `session:event`)

Discriminated union phân biệt bằng `kind` + `type`. Renderer đăng ký một listener, dispatch theo `sessionId`.

| kind | type | fields kèm theo | ý nghĩa |
|---|---|---|---|
| exec | status | sessionId, status, message? | connecting → active → reconnecting → closed/error |
| exec | exit | sessionId, exitCode, reason? | container thoát, kèm exit code |
| port-forward | status | sessionId, status, message? | active / reconnecting / error / pending |
| port-forward | traffic | sessionId, activeConns | (tùy chọn) số kết nối đang mở |
| session | removed | sessionId | manager đã dispose, UI gỡ khỏi panel |

`SessionInfo` (list + describe): sessionId, kind, status, context, namespace, target/pod, container/localPort+remotePort, name?, createdAt. Snapshot tuần tự hóa được, không handle sống.

### 4.3 Data plane — `MessageChannel` (chỉ exec)

Một port riêng mỗi exec session, cấp lúc `exec:start`. Đường byte tối giản, không JSON:

- **stdin** (renderer → main): frame `{ t: 0, data }`.
- **stdout** (main → renderer): frame `{ t: 1, data }`.
- **stderr** (main → renderer): frame `{ t: 2, data }`.

Byte đầu làm tag, phần còn lại là payload thô (transferable `ArrayBuffer`, zero-copy). Backpressure: nếu WS phía k8s đầy, `ExecSession` ngừng đọc từ port; `MessagePort` tự buffer, không mất dữ liệu.

Vì sao tách plane: stdout của `kubectl logs -f` hay cat file lớn có thể vài MB/s. Đẩy qua IPC string sẽ serialize/copy liên tục và khựng UI. `MessageChannel` + transferable giữ terminal mượt kể cả output dày.

### 4.4 Preload bridge

`contextBridge.exposeInMainWorld` một object API gọn (vd `window.k8s`) map 1-1 với contract: các hàm RPC (trả Promise) và một hàm đăng ký nhận `session:event`. Preload là ranh giới bảo mật — chỉ expose đúng channel trong contract, không expose `ipcRenderer` thô.

---

## 5. ExecSession — vòng đời và reconnect

Trạng thái: `connecting → active → reconnecting → closed` (và `error`).

- **Auto-detect shell**: thử `bash`, fallback `sh`; nhớ shell đã dùng theo container.
- **Reconnect**: WS đứt → chuyển `reconnecting`, **giữ ring buffer scrollback**, exec lại (session mới ở main). xterm re-attach, không mất nội dung. Đây là điểm Lens làm mất sạch terminal khi WS đứt.
- **Resize**: `xterm.onResize` → `exec:resize` (control plane) → cập nhật TTY channel.
- **Distroless detection**: nếu exec `/bin/sh` trả "executable not found" → UI đề xuất chuyển sang ephemeral container.

Điểm quan trọng: exec là stream tương tác, **không restore được** sau khi restart app — chỉ hiện lịch sử, không tự mở lại.

---

## 6. Port-forward — panel và auto-reconnect

- **Panel trung tâm**: liệt kê mọi forward across clusters từ `session:list`. State thật ở main.
- **Free-port picker**: cổng trống qua listen(0); xung đột `EADDRINUSE` fallback tự động.
- **Named profiles**: metadata `name` để bật lại nhanh.
- **Auto-reconnect**: xem mục 7 — dựa trên watch pod theo selector, không watch pod đơn lẻ.

---

## 7. Lưu port-forward theo selector (resolve pod động)

Điểm khác biệt lớn nhất so với Lens: thay vì ghim vào một pod name (ephemeral), lưu **mục tiêu logic** rồi resolve ra pod sống mỗi lần cần.

### 7.1 Target descriptor (thứ được persist)

Entry trong `forwards.json` (`userData`) không lưu pod cụ thể:

- `kind`: `service` | `deployment` | `statefulset` | `replicaset` | `pod`
- `namespace`, `name` (tên Service/Deployment/…)
- `remotePort`: với workload là số port; với service có thể là **tên port** (vd `http`)
- `localPort`, `displayName`, `context`

Pod name không xuất hiện ở tầng persist — nó chỉ là kết quả runtime.

### 7.2 Pipeline resolve target → pod + port

Khi `pf:start` (kể cả lúc restore), resolver chạy theo `kind`:

- **Deployment/StatefulSet/ReplicaSet**: đọc object → `spec.selector.matchLabels` → list pod theo label selector → lọc và chọn pod. `remotePort` giữ nguyên là container port.
- **Service**: đọc Service → `spec.selector` → list pod. Phải map `service.port` (hoặc tên port) → `targetPort`; nếu `targetPort` là **tên**, đọc `containerPort` tương ứng trong pod spec để ra số thật. Port-forward luôn forward tới **pod**, không tới service (API không hỗ trợ forward thẳng service).
- **pod**: dùng trực tiếp.

### 7.3 Chọn pod (ranking)

Thứ tự ưu tiên: pod `Running` và **Ready** (`Ready=True` trong `status.conditions`) trước tuyệt đối — không forward vào pod chưa ready. Trong nhóm ready, chọn pod ổn định/mới nhất theo `startTime`. Bỏ pod đang `Terminating` (có `deletionTimestamp`). Không có pod ready → session `pending`, chờ watch báo ready thì tự nối.

**Sticky**: đã chọn pod A và A còn ready thì giữ nguyên qua các lần re-check — chỉ đổi khi A chết. Tránh forward nhảy pod khi có nhiều replica.

### 7.4 Watch + re-resolve (auto-reconnect thông minh)

`PortForwardSession` mở **watch trên pod theo label selector** của target (không watch một pod đơn lẻ):

Khi pod đang forward chuyển `Terminating`/`NotReady`/biến mất (rollout, scale, crash) → session vào `reconnecting`, chạy lại resolver chọn pod ready khác trong cùng workload, dựng port-forward stream mới. `net.Server` local giữ nguyên nên **local port không đổi** — client của user (browser, psql…) không biết pod đã đổi. Workload scale về 0 → `pending`, chờ pod mới ready thì tự nối.

Kết quả: `kubectl rollout restart` không làm đứt port-forward; nó tự trượt sang pod mới. Lens sẽ chết forward và bắt user mở lại.

### 7.5 Edge cases

- Service không selector (headless/ExternalName): fallback đọc `Endpoints`/`EndpointSlice`, hoặc báo không hỗ trợ.
- Tên port không khớp container nào: error mô tả rõ.
- Nhiều container cùng mở port: cần chỉ định container, hoặc chọn container đầu khớp.
- Selector khớp pod thuộc nhiều workload (label trùng): cảnh báo, ưu tiên theo owner reference nếu target là workload cụ thể.

---

## 8. Restore sau khi restart app

Chỉ port-forward restore được (exec là stream tương tác, không tái tạo).

**Ghi lúc chạy**: `pf:start` thành công → append target descriptor vào `forwards.json`; `pf:stop` → xóa entry. Chỉ ghi thứ tái tạo được, không ghi handle hay trạng thái kết nối.

**Khôi phục lúc khởi động**: sau khi dựng kubeconfig, đọc `forwards.json`, với mỗi entry thử `pf:start` lại (chạy resolver mục 7). Vì target là logic nên restore được miễn workload còn tồn tại — không phụ thuộc pod name.

Xử lý khi restore:

- **Local port bị chiếm**: thử `localPort` cũ trước; `EADDRINUSE` → `freePort()` cấp cổng mới, cập nhật entry, báo UI cổng đã đổi.
- **Workload không còn**: session `error` với message rõ, giữ entry để retry, hiện nút khởi động lại thủ công.
- **Cluster/context không truy cập được**: session `error`, giữ entry, retry sau.

Mỗi kết quả restore bắn `port-forward status` event → panel dựng lại đúng ngay khi app mở (active xanh, error đỏ kèm retry). Manager giữ watch pod cho các forward active để auto-reconnect tiếp tục hoạt động như phiên trước.

---

## 9. Thứ tự triển khai đề xuất

1. **Watch layer** (reconnect + `resourceVersion` resume) — cả ba tính năng đều dựa vào.
2. **SessionManager + Session interface** — nền cho mọi thứ.
3. **ExecSession** (reconnect + ring buffer) — giá trị "giữ chân" cao, gặp hàng ngày.
4. **PortForwardSession** cơ bản (pod trực tiếp) → nâng lên **resolve theo selector** + restore.
5. **Ephemeral container / copy-to** cho crashloop debug — điểm nhấn khác biệt.