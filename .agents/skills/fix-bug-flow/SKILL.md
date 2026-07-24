---
name: fix-bug-flow
description: Standardized workflow for diagnosing and fixing bugs in k8s-env-diff. Enforces root-cause analysis, regression tests before fix, minimal modular edits, and mandatory test verification.
---

# Bug Diagnosis & Fix Standard Operating Procedure (SOP)

This skill governs how bugs must be investigated and fixed in the `k8s-env-diff` codebase.
It complements `implement-code-flow`: use this skill when something is **broken**, that one when
building something **new**. The architecture, file mapping, and red lines from `implement-code-flow` still apply.

## 1. Standard 6-Step Bug-Fix Flow

### Step 1: Reproduce & Capture Symptoms
- Get the exact symptom: error message, stack trace, wrong output, or failing user action.
- Identify the layer from the symptom (Renderer UI, IPC channel, Service, Util, DB) using the
  file mapping in `implement-code-flow`.
- If you cannot reproduce, do NOT guess a fix — ask for repro steps, logs, or the affected context/namespace/resource.

### Step 2: Locate the Root Cause (not the symptom)
- Trace the IPC flow: `window.k8sApi.*` → `src/preload/index.js` → `src/main/ipc/*` → `src/main/services/*`.
- **CRITICAL**: Read only the modules on the failing path. Never open monolithic files or unrelated modules — preserve context window.
- Distinguish root cause from symptom. Ask "why" until the earliest broken assumption is found
  (e.g. a bad unit parse in `unitParser.js` surfacing as a wrong metric in the UI — fix the parser, not the UI).
- State the root cause in one sentence before touching code.

### Step 3: Write a Failing Regression Test FIRST
- Add/update a test under `tests/unit/<path>/<module>.test.js` that reproduces the bug and **fails** for the right reason.
- Run only that suite to confirm red: `npx vitest run tests/unit/<path>/<module>.test.js`.
- This test is the proof the bug existed and guards against regression. Skip it only for pure UI/CSS glitches that unit tests genuinely cannot cover — and say so explicitly.

### Step 4: Apply the Minimal Fix
- Fix at the root-cause module only; make the smallest change that turns the test green.
- Respect all `implement-code-flow` red lines:
  - Return structured errors `{ ok: false, error: e.message }` (add `reason` when the caller must branch).
  - Use `withTimeout` for external/cluster calls; reuse existing helpers.
  - Mutations stay on the audit/write-gate path; streaming/DB handles keep a registered teardown in `src/main/index.js`.
  - No magic values — use `k8sConstants.js`.
  - Honor §1c security: don't introduce shell interpolation, unvalidated IPC input, un-redacted secrets, or string-built SQL while fixing.
- Do NOT refactor unrelated code or "improve" things beyond the bug. Scope creep hides regressions.
- If the bug **is** a security issue (injection, path traversal, leaked secret, ungated mutation), apply the §1c control as the fix and add a regression test that proves the exploit is blocked.

### Step 5: Verify
- Confirm the new test now passes (green).
- **Before declaring done**: run the full `npm test` and verify a 100% pass rate — the fix must not break other suites.
- Run `node --check <file>` on every changed `.js` file.
- **If any renderer code changed** (`renderer/app.js` or `src/renderer/*`), run `npm run build:renderer`
  so `dist/app.js` reflects the fix — passing tests do NOT prove the app updated.
- **If any `src/main/` wiring changed** (IPC handler registration, `src/main/ipc/index.js`, `src/main/index.js`
  bootstrap), run `npm run dev` and confirm the app window opens with no thrown error. `npm test` mocks
  modules individually and will NOT catch a real wiring mismatch between layers.

### Step 6: Document
- Update `CHANGELOG.md` under `## Unreleased` with a `Fixed:` entry describing the symptom and root cause.

## 2. Rules & Red Lines

- ❌ **No Symptom Patching**: Never mask a bug at the UI/output layer when the root cause is upstream.
- ❌ **No Fix Without a Failing Test First**: (except unit-untestable UI glitches, stated explicitly).
- ❌ **No Blind Fixes**: Never change code you cannot explain the failure of — reproduce or gather evidence first.
- ❌ **No Scope Creep**: A bug fix touches only what the root cause requires.
- ❌ **No Unverified Claims**: Never declare fixed without full `npm test` at 100% pass.
- ❌ **No Stale Bundles**: Renderer fixes require `npm run build:renderer`; `index.html` loads `dist/app.js`, not `app.js`.
- ❌ **No Regression on Mutations**: Never remove or bypass the audit/write-gate path while fixing a mutation bug.
- ❌ **No Undocumented Fix**: Never declare a bug fixed without a `Fixed:` entry in `CHANGELOG.md` under `## Unreleased` (Step 6) — this is a completion gate, same as `npm test`, not an optional step.
- ❌ **No Untested Boot**: Never declare an IPC/main-process wiring fix done from `npm test` alone — run `npm run dev` and confirm the app boots without a thrown error.
