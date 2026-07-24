---
name: imp
description: Standardized workflow for implementing code in k8s-env-diff. Alias for implement-code-flow. Enforces modular design, TDD, and mandatory test verification.
---

# Code Implementation Standard Operating Procedure (SOP)

This is a short alias for `implement-code-flow`.

## Quick Rules:
1. Locate target file in `src/main/services/` or `src/main/utils/` (< 200 lines).
2. Design clean API return `{ ok: true/false }`.
3. Write/update unit test in `tests/unit/`.
4. Implement code modularly.
5. Run `npm test` and verify 100% pass before finishing.
