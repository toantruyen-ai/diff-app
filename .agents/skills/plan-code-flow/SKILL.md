---
name: plan-code-flow
description: Standardized workflow for planning work in k8s-env-diff BEFORE writing code. Produces a layered, file-mapped, test-first implementation plan and hands off to implement/fix/refactor skills. No code is written during planning.
---

# Planning Standard Operating Procedure (SOP)

This skill governs how a feature, fix, or refactor must be **planned** before any code is written in `k8s-env-diff`.
Planning = deciding WHAT to change, WHERE (which layer/file), and IN WHAT ORDER — producing a reviewable plan.
It writes NO production code. Execution happens afterward via `implement-code-flow`, `fix-bug-flow`, or `refactor-code-flow`.
The architecture, file mapping, and red lines from `implement-code-flow` apply to the plan's targets.

## 1. Standard 6-Step Planning Flow

### Step 1: Clarify the Goal & Type of Work
- Restate the request in one sentence and classify it: **feature** (→ implement), **bug** (→ fix), or **refactor** (→ ref).
- List explicit requirements and, separately, assumptions. If a requirement is ambiguous or missing
  (target namespace/context, expected behavior, edge cases), **ask before planning** — do not guess.
- Define done: the observable outcome and how it will be verified.

### Step 2: Investigate the Current State (read-only)
- Explore only the relevant path: `window.k8sApi.*` → `src/preload/index.js` → `src/main/ipc/*` → `src/main/services/*`,
  plus related `utils/`, `constants/`, `db/`. Use `serena` (`get_symbols_overview`, `find_symbol`, `find_referencing_symbols`)
  to map symbols and callers without reading whole monolithic files.
- Note what already exists and can be reused (helpers, constants, sibling services) vs. what is genuinely new.
- **CRITICAL**: Planning is read-only. Never edit files in this phase.

### Step 3: Map Changes to Layers & Files
- For each change, name the exact target and layer using the file-mapping table:
  Constants / Utils / DB / Services / IPC Handlers / Preload / Renderer / Tests.
- For a new IPC channel, plan all four touch points: service method → IPC handler → preload exposure → renderer usage.
- Flag any long-lived resource (watch, log stream, port-forward, exec, DB handle) that needs a teardown in `src/main/index.js`.
- Flag any mutation that must go through the audit/write-gate path.

### Step 4: Design Contracts & Test Strategy
- Define API contracts up front: input params, return shape `{ ok: true, ... }` / `{ ok: false, error, reason }`,
  and names — files, functions, constants, IPC channels, preload keys — following the **Naming Conventions (§1b)**
  in `implement-code-flow` (kebab-case IPC verb-noun ↔ camelCase preload/service 1:1; no invented styles).
- List the unit tests to write under `tests/unit/<path>/`: success paths, edge cases (null/empty/missing), error/timeout.
- Confirm no breaking change to existing IPC channels or `window.k8sApi` surface (or call it out explicitly if unavoidable).
- **Security (§1c)**: for any change touching shell-out, file paths, SQL, Secrets, or new IPC input, plan the controls up front —
  input validation/allow-list, `execFile` arg-arrays (no shell interpolation), secret redaction, parameterized SQL, curated preload.

### Step 5: Sequence the Work into Small Steps
- Break the plan into an ordered, individually-verifiable checklist (each step small enough to test on its own).
- Order to minimize risk: constants/utils first, then services, then IPC, then preload, then renderer, then rebuild.
- Identify risks, unknowns, and rollback points. Note where renderer rebuild (`npm run build:renderer`) is required.
- State which execution skill each step hands off to.

### Step 6: Present the Plan for Approval
- Output a concise, structured plan: Goal · Assumptions/Open questions · Files by layer · Contracts · Test plan · Ordered steps · Risks.
- For a large/multi-session effort, persist it (e.g. under `~/.claude/plans/` or a `docs/` note) and record a pointer.
- **Do not start coding** until the plan is confirmed. Then invoke the matching execution skill.

## 2. Rules & Red Lines

- ❌ **No Code in Planning**: This skill produces a plan only — never edit production files here.
- ❌ **No Guessing on Ambiguity**: Ask for missing requirements/context before committing to a plan.
- ❌ **No Unmapped Changes**: Every planned change names its exact layer and target file(s).
- ❌ **No Ignored Invariants**: The plan must account for timeouts, audit/write-gate, teardown, and constants — not defer them.
- ❌ **No Hidden Contract Breaks**: Any change to an IPC channel or `window.k8sApi` surface must be called out explicitly.
- ❌ **No Test-Free Plans**: Every plan includes the unit tests to be written under `tests/unit/`.
- ❌ **No Monolith Reading**: Use `serena` symbol tools and targeted reads to map the path token-efficiently.
