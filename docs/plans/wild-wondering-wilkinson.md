# Plan: Loki-style hover menu on log lines (Show content / Copy / Pin)

## Context

The multi-pod log viewer (`src/renderer/utils/multiPodLogViewer.js`) currently just streams raw log lines into a plain scrollable list. The user wants a Grafana Loki-style interaction: hovering a log line reveals a small menu with:
- **Show content** — opens a popup that auto-detects whether the line is JSON or `key=value` (logfmt) formatted and pretty-prints it for readability; plain text otherwise.
- **Copy to clipboard** — copies the raw line.
- **Pin** — pins the line to a persistent list so it doesn't get lost while new logs keep streaming in.

This is a renderer-only feature (no IPC/main-process changes) built on top of the existing `filteredLogStore`/`logRingBuffer` (seq-keyed) and the `escHtml` / `yamlHighlighter.js`-style tokenizer conventions already in the codebase.

**Decisions confirmed with the user:**
- Clicking **Clear** wipes both the log buffer *and* any pinned lines (no persistence across Clear — simplest behavior).
- Pinned lines are shown in a **collapsible bar at the top** of the log viewer panel, not inline-only highlighting.

## Key architectural constraint (why the design looks the way it does)

`renderLogs()` in `multiPodLogViewer.js` replaces `viewport.innerHTML` wholesale on every store update (~every 80-100ms while actively streaming — the design doc's TanStack virtualization is not implemented yet). Anything stateful triggered from a log line (the dropdown menu, the detail popup) **must live outside that regenerated subtree**, or it gets wiped mid-interaction.

Also important: this file never calls `document.createElement` anywhere — it only ever grabs refs via `containerEl.querySelector(...)` against one static template string built once at construction (lines 11-32). There is no safe/mockable way to fabricate new DOM nodes at runtime given the test harness's hand-mocked DOM (`@vitest-environment node`, no real `document`). So the menu/modal markup must be added as **additional siblings in that same one-time template**, not created imperatively later — exactly like `#mpl-topology-bar`/`#mpl-status-bar` already are.

Positioning: use `position:fixed` for both the floating menu and the detail overlay (mirroring `.manage-confirm-overlay` at `renderer/styles.css:1319`, which already uses `position:fixed; inset:0`). No `position:relative` needed on the container — checked the ancestor chain (`.manage-view`, `.manage-logs-pane`) and nothing creates a new containing block for `fixed` descendants.

`createMultiPodLogViewer` is instantiated twice in `renderer/app.js` (once for `clusterLogsViewer`, once for `multiPodViewer`). Each instance's menu/modal elements are scoped inside its own `containerEl`, so "only one menu/modal open at a time" only needs to hold per-instance — no app-wide registry.

## New files (`src/renderer/utils/`)

1. **`logContentParser.js`** — `parseLogContent(message)` returns one of:
   - `{ type: 'json', prefix, suffix, value }` (`value` = `JSON.stringify(parsed, null, 2)`)
   - `{ type: 'kv', pairs: [[key, value], ...] }`
   - `{ type: 'text', value: message }`

   JSON detection: cap input at ~20000 chars (skip detection on pathological lines). Find the first `{`/`[`, then do a quote-aware balanced-bracket scan (same technique as `findYamlCommentStart` in `yamlHighlighter.js:9-20` — track `inString`/escape state, depth counter) to find the matching close. `JSON.parse` only that balanced substring (never a naive `lastIndexOf`); reject if the parsed value isn't an object/array; fall through to kv/text on any failure. On success, `prefix`/`suffix` are the text before/after the matched span.

   Logfmt/kv detection (only if JSON failed): regex `/([A-Za-z_][\w.-]*)=("(?:[^"\\]|\\.)*"|\S+)/g`; require **both** ≥2 matches **and** matched-span coverage ≥ ~60% of the trimmed message, to reject false positives like `"result = 42 and that's fine"`. Strip quotes from quoted values.

2. **`jsonHighlighter.js`** — `highlightJson(prettyJsonText)`, structured exactly like `yamlHighlighter.js`: tokenizes each line into `.json-key`/`.json-string`/`.json-number`/`.json-bool`/`.json-null`/`.json-punct` spans, all passed through `escHtml`. (JSON gets an explicit `null` class, unlike YAML's conflated bool/null regex.)

3. **`logPinStore.js`** — `createPinnedLogStore()` with `pin(line)` (stores a shallow snapshot `{seq,pod,container,ts,message,level}`), `unpin(seq)`, `isPinned(seq)`, `getAll()`, `clear()`, `subscribe(listener)` — same `subscribe`/`notify` shape as `filteredLogStore.js`. Storing a snapshot (not just the seq) is required because the ring buffer evicts old seqs (capacity-capped); pinned display must never depend on `store.getItemBySeq()` still returning the line.

4. **`logLineMenu.js`** — `createLogLineMenu(menuEl)` → `{ open(anchorRect, actions), close() }`. `menuEl` is the pre-existing `#mpl-line-menu` element (grabbed via `querySelector`, never created). Renders `escHtml`'d action items; closes on outside click, `Escape`, or after an item click; re-opening replaces whatever was previously shown (no extra registry needed, since it's scoped to one element).

5. **`logLineDetailModal.js`** — `createLogLineDetailModal(overlayEl)` → `{ open(line), close() }`. `overlayEl` is the pre-existing `#mpl-detail-overlay`/`.mpl-detail-card`. Header shows pod/container/timestamp (`escHtml`'d). Body dispatches on `parseLogContent(line.message)`: JSON → `highlightJson`, kv → a simple two-column `escHtml`'d key:value list, text → `escHtml`'d `<pre>`. Footer has a **Copy** button (copies the *pretty/formatted* text, using the same `navigator.clipboard.writeText(...)` pattern already used in `renderer/app.js:4273-4275`) and a **Close** button. Escape / backdrop click closes; clicking inside the card does not.

## Modified: `src/renderer/utils/multiPodLogViewer.js`

- Template string (lines 11-32): add `#mpl-pinned-bar` (collapsible, `display:none` until the first pin) before the toolbar/viewport, and `#mpl-line-menu` + `#mpl-detail-overlay` (containing `.mpl-detail-card`) as siblings after `#mpl-output-viewport`.
- Grab the new refs via `querySelector` alongside the existing ones (lines 34-42).
- Instantiate `pinStore = createPinnedLogStore()`, `lineMenu = createLogLineMenu(menuEl)`, `detailModal = createLogLineDetailModal(overlayEl)`.
- `renderLogs()`: convert the row from an inline-styled `<div>` to `<div class="mpl-log-line ${lvlClass} ${pinStore.isPinned(seq) ? 'mpl-pinned' : ''}" data-seq="${seq}">` plus a trailing `<button class="mpl-line-menu-trigger" data-seq="${seq}">⋮</button>` (revealed purely via CSS `:hover`/`:focus-visible` — no per-row JS listeners, keeping the hot render path cheap).
- **One** delegated `click` listener added on `viewport` (registered once), using `event.target.closest('.mpl-line-menu-trigger')` → resolve `seq` → `store.getItemBySeq(seq)` (null-check: a batch may have evicted it between paint and click — no-op if null) → `lineMenu.open(...)` with 3 actions:
  - **Show content** → `lineMenu.close(); detailModal.open(line)`
  - **Copy to clipboard** → `navigator.clipboard.writeText(line.message); lineMenu.close()`
  - **Pin / Unpin** (label depends on `pinStore.isPinned(seq)`) → `pinStore.pin(line)`/`unpin(seq)`, then explicitly re-run `renderLogs()` + the pinned-bar render (pin mutation doesn't flow through `store.subscribe`, so this call is required or the UI won't reflect it until the next unrelated log batch).
- `renderPinnedBar()`: renders `pinStore.getAll()` into `#mpl-pinned-bar` as a collapsible "📌 Pinned (N)" header + list; each item shows pod + truncated message, an Unpin button, and reuses `detailModal.open(snapshot)` for its own "view" affordance. Subscribed to `pinStore`.
- `clearBtn` handler: call **both** `store.clear()` and `pinStore.clear()` (confirmed: Clear wipes pins too).
- `startSession()`: also call `pinStore.clear()` (new stream context resets pins).

## CSS (`renderer/styles.css`)

New section near the existing `.yaml-*` rules (~line 1690). Note: `multiPodLogViewer.js` is currently 100% inline-styled — switching to CSS classes here is unavoidable (pseudo-classes like `:hover` can't be inline) and is a deliberate convergence toward the rest of the renderer's existing convention (`.yaml-*`, `.manage-confirm-*` already use classes), not a new one-off style.

- `.mpl-log-line` (`position:relative`, subtle hover background), `.mpl-line-menu-trigger` (`opacity:0` default, revealed via `.mpl-log-line:hover`/`:focus-visible`).
- `.mpl-line-menu` + `.mpl-line-menu-item` (+ `:hover`/`:focus-visible`).
- `.mpl-detail-overlay` (mirrors `.manage-confirm-overlay`) + `.mpl-detail-card` (`max-width:640px; max-height:70vh; overflow:hidden; display:flex; flex-direction:column`) + `.mpl-detail-header` + `.mpl-detail-body` (`overflow-y:auto`) + `.mpl-detail-kv-table/-key/-val` + `.mpl-detail-actions`.
- `.json-key/.json-string/.json-number/.json-bool/.json-null/.json-punct` — reuse the same CSS vars as `.yaml-*` (`--accent`, `--green`, `--missing-text`, `--badge-b`, `--text-dim`) for visual consistency.
- `.mpl-pinned-bar` + `-header` + `-list` + `-item`; `.mpl-log-line.mpl-pinned` (accent left-border/background) + `.mpl-pin-badge` (📌 prefix).
- Z-index: current max in the stylesheet is 210 (`.manage-audit-overlay`) — use 220 for `.mpl-detail-overlay`, 230 for `.mpl-line-menu`.

## Known limitations (intentionally out of scope for v1)

- Keyboard tab-through of up to 5000 per-row trigger buttons isn't optimized (matches Grafana Loki Explore's own mouse-first behavior for this exact feature).
- A line with two separate top-level JSON blobs concatenated only gets the first parsed; the rest stays as unparsed `suffix` text.
- Adding a button per row marginally increases per-batch render cost, since `viewport.innerHTML` is still wholesale-regenerated every ~80-100ms (pre-existing non-virtualized behavior, not something this feature fixes).

## Tests (`tests/unit/renderer/<name>.test.js`, flat naming, `@vitest-environment node`, hand-mocked DOM — matches existing convention)

- **`logContentParser.test.js`**: text-prefixed JSON detected correctly; truncated/malformed JSON falls through to `text` without throwing; logfmt with a quoted value parses correctly; false-positive text (`"result = 42 and that's fine"`) stays `text`.
- **`jsonHighlighter.test.js`**: correct token classes; a JSON string value containing `<script>"'` is fully `escHtml`'d in the output; nested object/array produces well-formed markup.
- **`logPinStore.test.js`**: pin/unpin/isPinned; `clear()` empties and notifies; `subscribe` fires on mutations (mirrors `filteredLogStore.test.js`).
- **`logLineMenu.test.js`**: renders `escHtml`'d items; item click invokes callback then closes; Escape/outside-click closes; re-opening replaces the previous instance.
- **`logLineDetailModal.test.js`**: renders JSON/kv/text correctly with escaping; Copy button copies the *pretty* text, not raw; Escape/backdrop closes, inside-card click doesn't.
- **`multiPodLogViewer.test.js`** (extend existing file): row markup includes `data-seq` + trigger button; delegated click opens the menu with the 3 actions for the right seq; pin toggle adds `.mpl-pinned` on the next render; Clear clears both `store` and `pinStore`; `startSession()` also clears `pinStore`.

## Verification

1. `npm test` — full Vitest suite passes, including new/extended test files.
2. `npm run build:renderer` — esbuild bundles cleanly (new `require()`d files resolve, no syntax errors).
3. Manual: `npm start` (or `npm run dev`), open a Manage cluster logs pane, hover a log line → `⋮` trigger appears → click → menu shows Show content / Copy to clipboard / Pin. Verify auto-detect + pretty-print against both a JSON-formatted log line and a logfmt-style line. Verify Pin → appears in the collapsible pinned bar at top. Verify Clear → both the main log list and the pinned bar are empty afterward.
