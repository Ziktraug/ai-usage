# Plan 064: Label Data Quality Without Dropping Data

> Presentation may classify and explain artefacts but must never delete, merge,
> or rewrite collected rows. Automated render assertions are authoritative.
>
> **Drift check**:
> `git diff --stat f4f9650..HEAD -- apps/web/src/project-summary.tsx apps/web/src/group-panel.tsx apps/web/src/routes/sync.tsx apps/web/src/manual-transfer-model.ts`

## Status

- **Priority**: P3
- **Effort**: M
- **Risk**: LOW
- **Depends on**: plans 053 and 059
- **Category**: direction
- **Planned at**: commit `f4f9650`, 2026-07-28

## Locked presentation rules

- A project basename ending in `.csv` case-insensitively gets “Filename-like”.
  A basename matching `^(agent|worktree)-[a-z0-9][a-z0-9-]*$`
  case-insensitively gets “Worktree-like”. `(unknown)`
  gets “No detected project”. Each offers the existing project-group management
  disclosure; no automatic grouping.
- DAT-2 is rejected for this run: the provider domain has no explicit register
  or kind, so presentation must leave provider labels unchanged. Never infer a
  kind from capitalization or substrings.
- The invalid-row notice on `/sync` becomes a disclosure. It may show reason
  counts only if the immutable freshness contract already carries them; otherwise
  keep the count and explain “Rows failed stored-row validation; details were not
  retained.” Never fabricate row identities.
- A stale machine card includes the existing snapshot command
  `bun run cli -- snapshot --out <path>` and states the 30-day freshness window.
  The path remains a placeholder, never a local real path.

## Scope

- `apps/web/src/project-summary.tsx` and render tests
- `apps/web/src/project-presentation.ts` and tests (pure classification)
- `apps/web/src/group-panel.tsx`
- `apps/web/src/routes/sync.tsx` and render tests
- `apps/web/src/sync-machine-fleet.tsx` (presentation-only extraction for
  deterministic DOM assertions)
- `apps/web/src/css-bundle.test.ts` (exact 619-byte gzip allowance for this
  plan's data-quality presentation)
- `apps/web/src/manual-transfer-model.ts` and tests
- `apps/web/e2e/dashboard-presentation.spec.ts`
- `apps/web/e2e/machine-staleness.spec.ts`

No collectors, normalization, grouping mutation, provider renaming, stored-row
payload expansion, or real machine paths.

## Steps

### Step 1: Test conservative project classification

Include positive and negative filename/worktree cases; ambiguous labels remain
unbadged.

**Verify**: pure presentation tests pass.

### Step 2: Render labels and existing management affordance

**Verify**: desktop/mobile Project render tests agree and retain every row.

### Step 3: Expand sync explanations conservatively

Render only facts in the immutable input and the locked generic explanation.

**Verify**: sync tests cover invalid count, unavailable details, stale command,
and no real path.

### Step 4: Run browser and repository gates

**Verify**:
`bun run check && bun run lint && bun run typecheck && bun run test && bun run test:e2e-demo && git diff --check`
→ all pass; DOM assertions prove every input row remains rendered.

## STOP conditions

- A label requires deleting or regrouping a row.
- Provider kind or invalid-row detail would be inferred from display strings.
- Any generated command contains a real maintainer path.
