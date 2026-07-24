---
name: refactor-code-flow
description: Standardized workflow for refactoring code in k8s-env-diff. Enforces behavior-preserving changes, green-tests-before-and-after, small safe steps, and mandatory test verification.
---

# Code Refactoring Standard Operating Procedure (SOP)

This skill governs how code must be restructured in the `k8s-env-diff` codebase.
Refactoring = **changing structure WITHOUT changing observable behavior**. If behavior must change,
that is a feature (`implement-code-flow`) or a bug fix (`fix-bug-flow`), not a refactor.
The architecture, file mapping, and red lines from `implement-code-flow` still apply.

## 1. Standard 6-Step Refactor Flow

### Step 1: Define Scope & Motivation
- State WHY: e.g. a service file exceeds ~200 lines, duplicated logic across modules, a monolith
  needs splitting into `src/main/services` / `src/main/utils`, unclear naming, or tangled responsibilities.
- Define the boundary: which files/symbols change and which public contracts must stay identical.
- **CRITICAL**: Read only the target module and its direct callers. Never open unrelated monolithic files.

### Step 2: Establish the Safety Net (tests GREEN first)
- Identify the tests covering the target under `tests/unit/<path>/`.
- Run them and confirm they PASS **before** touching anything: `npx vitest run tests/unit/<path>/<module>.test.js`.
- If coverage is missing, **write characterization tests first** that pin the CURRENT behavior — you cannot
  refactor safely what you cannot verify. These tests must stay unchanged through the refactor.

### Step 3: Freeze the Public Contract
- List every boundary that callers depend on and MUST remain byte-identical:
  - IPC channel names (`src/main/ipc/*`) and their request/response shapes.
  - `window.k8sApi.*` surface in `src/preload/index.js`.
  - Service return shapes `{ ok, error, reason, ... }` and exported function signatures.
- Refactor changes internals ONLY. Any contract change disqualifies this as a refactor — stop and switch skills.

### Step 4: Refactor in Small, Reversible Steps
- One transformation at a time (extract function, split file, rename symbol, dedupe, move to util/constant).
- Prefer `serena` symbol tools (`find_symbol`, `find_referencing_symbols`, `rename_symbol`, `replace_symbol_body`)
  for safe renames/moves so all references update together.
- Preserve all `implement-code-flow` red lines:
  - Keep files single-responsibility and < 200 lines; move pure helpers to `src/main/utils/`, magic values to `k8sConstants.js`.
  - Do NOT remove `withTimeout`, audit/write-gate paths, or teardown registrations in `src/main/index.js`.
  - Extracted renderer code in `src/renderer/` stays inert until `renderer/app.js` imports it.
- Re-run the affected suite after each step to stay continuously green — never batch many changes then test once.

### Step 5: Verify (behavior unchanged)
- The safety-net tests from Step 2 must pass **without modification** — if you had to change a test's
  assertions, you changed behavior, which is not a refactor. Investigate.
- Run the full `npm test` at 100% pass.
- Run `node --check <file>` on every changed `.js` file.
- **If any renderer code changed** (`renderer/app.js` or `src/renderer/*`), run `npm run build:renderer`
  so `dist/app.js` reflects the new structure.

### Step 6: Document
- Update `CHANGELOG.md` under `## Unreleased` with a `Changed:` entry noting the restructure (and that behavior is unchanged).
- If file layout changed (splits/renames/moves), update the architecture map in `CLAUDE.md`.

## 2. Rules & Red Lines

- ❌ **No Behavior Change**: A refactor never alters observable output, IPC contracts, or `window.k8sApi` surface.
- ❌ **No Test Rewrites to Pass**: Never change a test's assertions to make a refactor "work" — that hides a behavior change.
- ❌ **No Refactor Without a Safety Net**: If tests don't cover it, write characterization tests first.
- ❌ **No Big-Bang Rewrites**: Change in small reversible steps, staying green after each.
- ❌ **No Feature Smuggling**: Do not add capabilities or fix bugs mid-refactor — do those in a separate pass/skill.
- ❌ **No Stale Bundles**: Renderer restructures require `npm run build:renderer`; `index.html` loads `dist/app.js`.
- ❌ **No Broken Invariants**: Never drop `withTimeout`, audit/write-gate, teardown, or constants usage while restructuring.
