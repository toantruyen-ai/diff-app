---
name: audit-standards
description: Read-only audit of the k8s-env-diff codebase against the Naming Conventions (§1b) and Security Coding Standard (§1c) defined in implement-code-flow/SKILL.md and mirrored in CLAUDE.md. Reports deviations with file:line, category, severity, and a suggested fix — makes NO code changes unless the user explicitly asks for remediation afterward.
---

# Standards Audit (Naming §1b + Security §1c)

This skill re-checks the codebase against the standards already codified in
`implement-code-flow/SKILL.md` §1b (Naming Conventions) and §1c (Security Coding Standard),
and mirrored in `CLAUDE.md`. It does **not** rediscover conventions from scratch — it diffs
real code against the already-written rules. Use it any time after a batch of changes, before
a release, or periodically to catch drift.

## 1. Scope

- Audit target: `src/**/*.js` (main, preload, renderer), plus `main.js`/`preload.js` entry points.
- Read `implement-code-flow/SKILL.md` §1b and §1c first — those are the source of truth. If they've
  since been edited, audit against the current text, not what's summarized below.
- This is **read-only**. Never edit files during the audit. Produce a report; wait for the user
  to decide what to remediate and how (see `implement-code-flow`, `fix-bug-flow`, `refactor-code-flow`
  for the execution skills once a fix is approved).

## 2. What to Check

### Naming (§1b)
- File suffixes match role: `*Service.js`, `*Handler.js`, `*Db.js`, `*Constants.js`, util files as plain camelCase nouns.
- Exported constants are `UPPER_SNAKE_CASE`.
- Service/util functions are verb-first `camelCase` (`loadX`, `getX`, `applyX`, `checkX`, `listX`, …).
- IPC channels (`ipcMain.handle` / `ipcRenderer.invoke`) are `kebab-case` verb-noun; streaming lifecycle
  pairs use `<domain>-start`/`<domain>-stop`; session-scoped push events use `<base>:${sid}`.
- Preload keys in `window.k8sApi` mirror their IPC channel 1:1 in camelCase; push-event subscribers are
  `on` + PascalCase and return an unsubscribe function.
- Test files mirror their `src/` path under `tests/unit/`.

### Security (§1c)
- `BrowserWindow` `webPreferences`: `contextIsolation: true`, `nodeIntegration: false` (flag any window that doesn't).
- Preload exposes only named, curated methods — no raw `ipcRenderer`, `require`, `process`, or generic `invoke(channel, ...)` passthrough.
- No shell injection: flag any `execSync`/`exec`/`spawn` where a template literal or string concatenation
  injects a variable into the command string; these must be `execFile`/`spawn` with an arg array and `shell: false`,
  or fully static strings.
- IPC handlers validate renderer input before using it in shell commands, file paths, K8s calls, or SQL —
  flag handlers that pass raw args straight through unchecked, especially identifiers (name/namespace/resourceGroup/pod).
- File paths passed to `fs.*` or shelled-out tools originate only from a native dialog result or a stored
  kubeconfig id — flag any renderer-supplied path used directly.
- Secret/token values are never `console.log`ged or returned un-redacted; Secret resource payloads route
  through `redactSecretData` before crossing back to the renderer or being persisted/logged.
- Temp credential files (kubeconfigs, tokens) are cleaned up in a `finally` block.
- Audit-DB (`mssql`) queries use parameterized `request.input(...)` — flag any string-concatenated SQL.
- Destructive K8s actions (delete/scale/restart/replace) go through the audit/write-gate path — flag any
  that bypass it.

## 3. How to Run It

- For a full-repo pass, prefer a broad **read-only search agent** (Explore or general-purpose) rather than
  reading every file inline — this audit spans many files and doesn't need the main context window.
- Grep-first, then read only the flagged lines in context:
  - Shell risk: `grep -rnE "exec(Sync)?\(|spawn\(" src/main`
  - IPC channels: `grep -rhoE "ipcMain\.handle\('[^']+'" src/main/ipc`
  - Preload surface: check `src/preload/index.js` for any non-`k8sApi`-scoped bridge exposure.
  - Secrets: `grep -rn "console.log" src/main | grep -iE "token|secret|kubeconfig|password"`
  - SQL: `grep -rn "request.query\|SELECT\|INSERT\|UPDATE" src/main/db/auditDb.js`
- Note any known accepted exceptions already called out in §1c (e.g. `trigger-update`'s static `curl | bash`,
  `sandbox: false` if still in place) — these are documented trade-offs, not new findings, unless the audit
  finds them used somewhere new or with unvalidated input.

## 4. Report Format

For each finding: `file:line` · category (`naming` | `security`) · severity (`high`/`medium`/`low`) ·
one-line description · suggested fix (reference the exact §1b/§1c rule violated).

Group findings by category, most severe first. End with a short summary: counts by severity, and which
findings are pre-existing/known (already noted in §1c) vs. newly introduced.

## 5. Rules & Red Lines

- ❌ **No Silent Fixes**: This skill reports only. Never edit files as part of an audit run.
- ❌ **No Re-deriving Conventions**: Don't invent new rules — check against §1b/§1c exactly as written; if a
  finding suggests the standard itself is incomplete, say so explicitly rather than quietly applying a new rule.
- ❌ **No Unranked Dumps**: Every finding must carry a severity and a category; don't return an unsorted list.
- ❌ **No Ignoring Documented Exceptions**: Don't re-flag a trade-off §1c already accepts unless its risk profile changed (e.g. new input path feeding into it).
