---
name: fix
description: Standardized workflow for fixing bugs in k8s-env-diff. Alias for fix-bug-flow. Enforces root-cause analysis, regression test first, and mandatory test verification.
---

# Bug Fix Standard Operating Procedure (SOP)

This is a short alias for `fix-bug-flow`.

## Quick Rules:
1. Reproduce the bug; identify the failing layer (Renderer / IPC / Service / Util / DB).
2. Trace the IPC flow to the ROOT CAUSE module — read only that path (< 200 lines).
3. Write a FAILING regression test in `tests/unit/` first (`npx vitest run <file>`).
4. Apply the minimal fix at the root cause — no scope creep, keep audit/write-gate & teardown intact, and honor §1c security (no shell injection, validate input, redact secrets, parameterized SQL).
5. Run full `npm test` (100% pass); `node --check` changed files; `npm run build:renderer` if renderer changed; if IPC/main wiring changed, also run `npm run dev` and confirm the app boots with no thrown error.
6. Add a `Fixed:` entry to `CHANGELOG.md` under `## Unreleased`.
