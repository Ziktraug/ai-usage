# Plan 052: Align Overview Records With Campaign Aggregation

> **Executor instructions**: Follow the steps in order and run every verification
> command. Stop on any condition in **STOP conditions**; do not widen this plan
> into Cursor attribution, loading states, breakdown sorting, or presentation.
> When complete, update plan 052 in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat f4f9650..HEAD -- packages/report-core/src/focused-report-query.ts packages/report-core/src/focused-report-query.test.ts apps/web/src/overview.tsx apps/web/src/overview-model.ts apps/web/src/overview-model.test.ts`
> If the record or campaign excerpts below no longer match, stop and report.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: MEDIUM — two trusted Overview figures change aggregation domain.
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `f4f9650`, 2026-07-28

## Why this matters

The `Top session` card is session-scoped while the adjacent top-session list is
campaign-scoped, so the same label can show `$907.54` and `$2 195.88`.
Plan 045 locked the rule that every top-level row is a campaign, including a
campaign of one session. This plan applies that rule to `Top session` and
`Longest session`; day-scoped `Busiest day` and `Streak` remain unchanged.

## Current state and target contract

- `packages/report-core/src/focused-report-query.ts:260-266` types `topCost` and
  `longest` as `SessionPresentationRow`.
- `overviewSessionItems` at lines 987-1020 already produces the authoritative
  campaign/session presentation item with `costApprox`, `durationMs`, `label`,
  `row`, and `sessionCount`.
- `buildRecords` at lines 1218-1237 reduces raw visible rows.
- `topSessions` at lines 1297-1300 reduces `sessionItems`.
- `apps/web/src/overview.tsx:739-754` renders record cards and passes their
  selected row to the drawer.

Lock this contract:

1. Change `FocusedOverviewRecords.topCost` and `.longest` to
   `FocusedOverviewSessionItem | null`.
2. Make `buildRecords` accept `sessionItems` for those two reductions while
   continuing to accept visible/timeline rows for day aggregates.
3. Render `item.label`; pass `item.row` to `onSelectSession`.
4. Campaign duration remains `campaign.visibleTotals.durationMs`, whose current
   definition is root-session duration. Do not calculate wall-clock campaign span.

## Commands

| Purpose | Command | Expected |
| --- | --- | --- |
| Focused core | `bun test packages/report-core/src/focused-report-query.test.ts` | all pass |
| Overview model | `bun test apps/web/src/overview-model.test.ts` | all pass |
| Types | `bun run typecheck` | exit 0 |
| Diff | `git diff --check` | no output |

Do not run `bun install`. Use only synthetic fixtures.

## Scope

**In scope**:

- `packages/report-core/src/focused-report-query.ts`
- `packages/report-core/src/focused-report-query.test.ts`
- `apps/web/src/overview.tsx`
- `apps/web/src/overview-model.ts`
- `apps/web/src/overview-model.test.ts`

**Out of scope**: campaign identity, `sessionCampaignKeyFor`, `costApprox`
arithmetic, day records, labels outside the four record cards, and plan 053+.

## Steps

### Step 1: Characterize the campaign record contract

Add focused-query tests with a multi-row campaign whose combined cost exceeds
each child and whose root duration differs from a child. Assert:

- `topCost.kind === 'campaign'`;
- `topCost.costApprox` equals the campaign total;
- `longest.durationMs` equals the existing campaign/root-duration semantic;
- `busiest` and `streak` retain their current values.

**Verify**: `bun test packages/report-core/src/focused-report-query.test.ts`
→ the new test fails only on the session-scoped record assertions.

### Step 2: Move record selection onto `sessionItems`

Apply the target contract above. Preserve exact focused-result decoding by
updating its assertion only for the new item shape; reuse the existing
`FocusedOverviewSessionItem` validator rather than defining a competing shape.

**Verify**: `bun test packages/report-core/src/focused-report-query.test.ts`
→ all pass.

### Step 3: Adapt the record-card renderer

Use `item.label` for the subtitle and `item.row` for drawer selection. Add or
update the Overview model test so selecting a campaign record still selects its
root row.

**Verify**:
`bun test apps/web/src/overview-model.test.ts packages/report-core/src/focused-report-query.test.ts`
→ all pass.

### Step 4: Run repository gates

**Verify**: `bun run typecheck && bun run check && git diff --check`
→ all commands exit 0 and `git diff --check` prints nothing.

## Done criteria

- [ ] The card and first top-session row use the same campaign aggregate.
- [ ] Record-card clicks still open the campaign root row.
- [ ] Day records are unchanged by tests.
- [ ] Only in-scope files plus `plans/README.md` are modified.
- [ ] All commands above pass.

## STOP conditions

- Campaign duration is no longer root-session duration.
- The change requires campaign identity or cost arithmetic changes.
- Exact-result decoding cannot reuse the existing overview-item contract.
- A verification fails twice after a reasonable correction.

## Maintenance notes

Reviewers should compare record selection and `topSessions` selection side by
side: future changes must keep them on the same `sessionItems` domain.
