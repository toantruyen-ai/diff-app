---
name: plan
description: Standardized workflow for planning work in k8s-env-diff before coding. Alias for plan-code-flow. Produces a layered, file-mapped, test-first plan and hands off to implement/fix/refactor. No code is written.
---

# Planning Standard Operating Procedure (SOP)

This is a short alias for `plan-code-flow`.

## Quick Rules:
1. Restate the goal; classify as feature / bug / refactor; ask if requirements are ambiguous (no guessing).
2. Investigate read-only via the IPC path + `serena` symbol tools — never edit files while planning.
3. Map every change to an exact layer/file (Constants / Utils / DB / Services / IPC / Preload / Renderer / Tests).
4. Design contracts `{ ok, error, reason }` + IPC channel names; list the `tests/unit/` cases to write.
5. Sequence into small, individually-testable steps (utils → services → IPC → preload → renderer → rebuild); note risks.
6. Present the plan for approval; write NO code until confirmed, then hand off to `imp` / `fix` / `ref`.
