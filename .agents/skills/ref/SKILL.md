---
name: ref
description: Standardized workflow for refactoring code in k8s-env-diff. Alias for refactor-code-flow. Enforces behavior-preserving changes, green tests before and after, and small safe steps.
---

# Code Refactoring Standard Operating Procedure (SOP)

This is a short alias for `refactor-code-flow`.

## Quick Rules:
1. State scope & motivation; read only the target module + its direct callers.
2. Run existing tests GREEN first — if none, write characterization tests pinning current behavior.
3. Freeze public contracts: IPC channels, `window.k8sApi`, return shapes `{ ok, error, reason }`.
4. Refactor in small reversible steps (prefer `serena` for renames/moves); stay green after each step.
5. Safety-net tests must pass UNCHANGED; run full `npm test` (100%); `node --check`; `npm run build:renderer` if renderer changed.
6. Add a `Changed:` entry to `CHANGELOG.md`; update the architecture map in `CLAUDE.md` if layout changed.
