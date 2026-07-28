# Plan 053: Make Cursor and Project Line Measurements Honest

> Follow each step and gate. Zero is a valid measurement and must never be used
> as an absence sentinel. Update plan 053 in `plans/README.md` when complete.
>
> **Drift check**:
> `git diff --stat f4f9650..HEAD -- packages/report-core/src/datasets.ts packages/report-core/src/focused-report-query.ts apps/web/src/cursor-attribution-panel.tsx apps/web/src/dashboard-analytics.ts apps/web/src/project-summary.tsx`

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MEDIUM
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `f4f9650`, 2026-07-28

## Why this matters

Cursor shows a 2.4% headline above commit rows near 97% because the headline uses
optional component counters while rows use Cursor's `v2AiPercentage`. Project
aggregation also coerces nullable line counts to zero and loses coverage.

## Locked contracts

For the Cursor headline, group by `commitHash`. A commit is measurable when its
non-null duplicate `v2AiPercentage` values agree and `linesAdded + linesDeleted`
is positive. Use that line total as weight and compute
`sum(percentage × weight) / sum(weight)`. Conflicting, null-only, and zero-weight
commits are excluded from the calculation but included in coverage. Render
`measured distinct commits / all distinct commits`; zero coverage renders `—`.

Do not infer component-counter absence from zero: those dataset fields are
required numbers. Leave Composer/Tab/Human/Total numeric and add this header
hint: “Component counters are vendor fields; zero may mean no attributed lines.
AI % is Cursor's v2 score.” A nullable collector migration is out of scope.

For Projects, add `lineMeasurement: { measuredSessions; totalSessions }` to
focused and client group shapes. A row is measured only when both line counts
are non-null. Sum measured rows only. Render `—` for zero coverage, the sum plus
`N/M measured` for partial coverage, and measured `+0/-0` as zero.

## Scope

**In scope**:

- `packages/report-core/src/focused-report-query.ts`
- `packages/report-core/src/focused-report-query.test.ts`
- `packages/report-data/src/focused-report-query-sqlite.ts`
- `packages/report-data/src/focused-report-query-sqlite.test.ts`
- `apps/web/src/cursor-attribution-panel.tsx`
- `apps/web/src/cursor-attribution-panel.test.ts` (create)
- `apps/web/src/dashboard-analytics.ts`
- `apps/web/src/dashboard-model.test.ts`
- `apps/web/src/project-summary.tsx`
- `apps/web/src/project-summary.render.test.tsx` (create)

**Out of scope**: collector SQL, stored/portable schemas, nullable Cursor
component fields, campaign metrics, cost provenance, and hiding rows.

## Steps

### Step 1: Characterize Cursor aggregation

Extract a pure helper and test identical duplicates, conflicting duplicates,
null percentages, zero weights, partial coverage, and zero coverage.

**Verify**: `bun test apps/web/src/cursor-attribution-panel.test.ts` → all pass.

### Step 2: Render the authoritative Cursor headline

Replace the component-line ratio, show coverage, identify v2 authority, and add
the locked component-counter hint.

**Verify**: the Cursor render test shows a line-weighted value, `N/M`, and `—`
for zero coverage.

### Step 3: Preserve Project line coverage

Extend the core, SQLite, and client project aggregation paths and strict
focused-result validation with the identical coverage shape. Add parity fixtures
for complete, partial, unmeasured, and measured-zero groups.

**Verify**:
`bun test packages/report-core/src/focused-report-query.test.ts packages/report-data/src/focused-report-query-sqlite.test.ts apps/web/src/dashboard-model.test.ts`
→ focused/SQLite/client results agree.

### Step 4: Render Project coverage once

Use one formatter/component shared by desktop and mobile summaries.

**Verify**: the Project render test distinguishes `—`, `N/M measured`, and
measured `+0/-0`.

### Step 5: Run gates

**Verify**:
`bun run typecheck && bun run check && bun run lint && bun run test && git diff --check`
→ all exit 0; diff check is silent.

## Done criteria

- [ ] Cursor uses distinct-commit, line-weighted v2 percentages.
- [ ] Conflicts lower coverage instead of being silently chosen.
- [ ] Project missing, partial, and measured zero are distinct.
- [ ] Focused/SQLite/client aggregation parity is tested.

## STOP conditions

- Correctness requires guessing whether a numeric Cursor zero is absent.
- Project coverage requires a portable schema change.
- Duplicate Cursor rows require an authority rule beyond the locked contract.

## Maintenance notes

If Cursor later exposes presence explicitly, migrate component fields to nullable
in a separate schema plan; never infer nullability from observed zeros.
