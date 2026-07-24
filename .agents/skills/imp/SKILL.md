---
name: imp
description: Standardized workflow for implementing code in k8s-env-diff. Alias for implement-code-flow. Enforces modular design, TDD, and mandatory test verification.
---

# Code Implementation Standard Operating Procedure (SOP)

This is a short alias for `implement-code-flow`.

## Quick Rules:
1. Locate target file in `src/main/services/` or `src/main/utils/` (< 200 lines).
2. Design clean API return `{ ok: true/false }`. **Names follow §1b of `implement-code-flow`**: files `<domain>Service/Handler/Db/Constants.js`; verb-first camelCase functions; `UPPER_SNAKE_CASE` constants; IPC `kebab-case` verb-noun ↔ preload camelCase 1:1 (push subscribers `onXxx`).
3. Write/update unit test in `tests/unit/`.
4. Implement code modularly. **Security §1c**: validate renderer input (allow-list identifiers); no shell interpolation (`execFile`/arg-arrays, `shell:false`); redact secrets via `redactSecretData`; parameterized SQL; never expose raw `ipcRenderer`.
5. Run `npm test` and verify 100% pass before finishing.
6. If IPC handler registration or `src/main/index.js` bootstrap changed, run `npm run dev` and confirm the app boots with no thrown error — `npm test` mocks modules individually and won't catch a real wiring mismatch.
