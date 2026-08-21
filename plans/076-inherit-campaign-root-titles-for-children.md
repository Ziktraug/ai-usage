# Plan 076: Display Campaign Root Titles on Generic Child Sessions

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 5e4cf954..HEAD -- apps/web/src/lib/features/sessions/table/ packages/report-core/src/session-query.ts`
> On any mismatch with the "Current state" excerpts, STOP.

## Status

- **Priority**: P2
- **Effort**: S–M
- **Risk**: LOW–MED
- **Depends on**: none
- **Category**: direction
- **Planned at**: commit `5e4cf954`, 2026-08-20

## Why this matters

Campaign grouping is delivered: top-level rows aggregate a root session with
its subagent/classifier children, and expanding a campaign lazily loads the
child rows. But untitled children render as `subagent 4f2a9c31` — expanding a
campaign reveals cost without meaning. `docs/future-work.md` names this as
the remaining gap: "subagent/orchestrator children fall back to generic ids —
children could inherit the parent's title once campaign grouping is surfaced
in the UI." This plan adds **display-only** inheritance: a child with a
generic title shows the campaign root's title next to its identifier, marked
as inherited. Search, sort, and filter semantics must not change.

## Current state

- `packages/local-machine/src/claude-session-facts.ts:713–719` — where the
  generic names come from:
  ```ts
  const name = title ?? `${sidechain ? 'subagent ' : 'claude '}${input.sourceSessionId.slice(0, 8)}`;
  let titleSource: ClaudeReportFacts['titleSource'] = 'id';
  if (title) { titleSource = 'ai'; } else if (sidechain) { titleSource = 'agent-role'; }
  ```
- `packages/report-core/src/types.ts:10` — `TitleSource = 'ai' | 'first-prompt' | 'agent-role' | 'id'`;
  `types.ts:78` — `titleSource?: TitleSource` on the row; it survives
  serialization (`serialized-usage-validation.ts:52` lists `'titleSource'`).
- `packages/report-core/src/session-query.ts`:
  - line 190: `children?: SessionPresentationRow[]` on the presentation row.
  - lines 956–986: `enrichSessionPresentationRow` builds `searchText` (line
    977) and `sortSession` (line 984) from `row.sessionLabel`. **Do not touch
    this function** — inherited display must not enter search or sort.
  - line 1367 (campaign display row): `sessionLabel: campaign.root.sessionLabel`
    — the top-level campaign row already borrows the root title; children do
    not.
- `apps/web/src/lib/features/sessions/table/session-table.svelte`:
  - lines 311–317: expanding a row with `row.campaignKey` and no loaded
    children calls `onLoadCampaignChildren?.(row.campaignKey)`.
  - line 89/115: `campaignChildren?: ReadonlyMap<string, SessionCampaignPage>`
    prop supplies loaded child pages.
  - lines ~488–558: virtual rows render `SessionCell` with
    `depth={virtualRow.row.depth}` — the table is a TanStack table whose row
    instances expose the tree (children attach as sub-rows).
- `apps/web/src/lib/features/sessions/table/session-cell.svelte`:
  - props include `depth: number` and `row: SessionPresentationRow` (lines
    16–37); the session column branch renders highlighted `projection.segments`
    of `row.sessionLabel` plus optional muted annotations with
    `data-session-origin` / `data-session-campaign-annotation` attributes
    (lines 41–82) — follow that annotation pattern for the inherited title.
- `apps/web/src/lib/features/sessions/table/session-cell-projection.ts`:
  - line 231–232: the session projection uses
    `provenanceFacts(row, 'title')` and
    `highlightedSegments(row.sessionLabel, query)`.
- Vocabulary (`CONTEXT.md`): a **Session origin** that is absent "is
  expressed by provenance, never by a sentinel value". The same rule governs
  this plan: inherited display is marked as inherited (tooltip/attribute),
  never presented as an observed title.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `bun run typecheck` | exit 0 |
| Format/lint | `bun x ultracite fix` then `bun run check` | exit 0 |
| Web unit tests | `bun run --cwd apps/web test` | all pass |
| Targeted tests | `bun test apps/web/src/lib/features/sessions/table/session-table-components.test.ts` | all pass |
| E2e (if touched) | `cd apps/web && bun run test:e2e -- e2e/dashboard.spec.ts` | all pass |

## Scope

**In scope**:
- `apps/web/src/lib/features/sessions/table/session-cell.svelte`
- `apps/web/src/lib/features/sessions/table/session-cell-projection.ts` (only
  if the inherited flag is computed there rather than in the component)
- `apps/web/src/lib/features/sessions/table/session-table.svelte` (thread the
  root label to child cells)
- `apps/web/src/lib/features/sessions/table/session-table-components.test.ts`
  and/or `session-cell-projection` tests

**Out of scope** (do NOT touch):
- `enrichSessionPresentationRow` (`session-query.ts:956`) — `searchText`,
  `sortSession`, and `sessionLabel` are contract surfaces; changing them
  changes filter/sort results.
- `packages/local-machine/**` collectors — the generic fallback names are
  correct observed facts.
- The session drawer and Top Sessions (`records.svelte`) — campaign entries
  there already use the root label.
- The campaign label override editor (plan 051 feature) — local overrides
  already flow into `sessionLabel`; inheritance must compose with them for
  free by reading the parent row's final `sessionLabel`.

## Git workflow

- Commit style: `fix(report): show campaign root titles on child sessions`
  (matches `4d227d2a fix(report): preserve declared campaign identity`).
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Decide the inherited flag in the projection layer

In `session-cell-projection.ts`, export a pure helper:

```ts
export const sessionTitleIsGeneric = (row: SessionPresentationRow): boolean =>
  row.titleSource === 'agent-role' || row.titleSource === 'id';
```

Add unit cases: `'ai'` → false, `'first-prompt'` → false, `'agent-role'` →
true, `'id'` → true, `undefined` → false (an absent titleSource means the
harness declared nothing; do not guess).

**Verify**: targeted test file passes with the new cases.

### Step 2: Thread the campaign root label to child cells

In `session-table.svelte`, at each `SessionCell` render site that passes
`depth={virtualRow.row.depth}`, also pass
`campaignRootLabel={virtualRow.row.getParentRow()?.original.sessionLabel}`.
(TanStack table rows expose `getParentRow()`; the parent of a child row is
the campaign display row whose `sessionLabel` is the root title, possibly
overridden by a local campaign label — exactly what should be inherited.)

**Verify**: `bun run typecheck` → exit 0.

### Step 3: Render the inherited title in BOTH table branches

The table has two render paths: desktop rows go through `SessionCell`, but
the narrow-viewport branch (`session-table.svelte:541–546`) calls
`projectSessionCell(virtualRow.row.original, 'session', searchQuery)`
directly and prints its segments without `SessionCell`. Covering only the
component would fix desktop and leave mobile children generic. So put the
decision in the shared projection: extend `projectSessionCell`'s session
branch with an optional `campaignRootLabel` argument that, when the Step 1
predicate holds, adds an `inheritedTitle: string` field to the session
projection. Both branches then render it:

In `session-cell.svelte`: add the optional prop
`campaignRootLabel?: string`, pass it through to `projectSessionCell`, and
when `projection.inheritedTitle` is set (the projection enforces
`depth > 0` via the caller passing the label only for child rows,
`sessionTitleIsGeneric(row)`, non-empty, different from
`row.sessionLabel`), render it *before* the highlighted segments. In the
mobile branch of `session-table.svelte` (lines 541–546), pass the same
parent label into the `mobileSession` projection call and render
`inheritedTitle` before the segments there too, with the same
`data-session-inherited-title` attribute:

```svelte
<span
  data-session-inherited-title
  title="Title inherited from the campaign root session"
>{campaignRootLabel}</span>
<span class={muted}> · </span>
```

then the existing segments (which keep rendering the child's own
`subagent 4f2a9c31` label, preserving search highlighting and uniqueness
between siblings). Reuse the imported `muted` class; add no new css() block.

**Verify**: `bun run --cwd apps/web test` → all pass.

### Step 4: Component test

In `session-table-components.test.ts` (follow its existing SSR/render
pattern), add cases:

- child row with `titleSource: 'agent-role'` under an expanded campaign
  renders `[data-session-inherited-title]` with the root's label;
- child row with `titleSource: 'ai'` renders no inherited annotation;
- top-level rows (`depth === 0`) never render the annotation;
- the mobile branch (narrow mode) renders the same annotation for a
  generic child — assert against the mobile row markup, not `SessionCell`.

**Verify**: `bun test apps/web/src/lib/features/sessions/table/session-table-components.test.ts` → all pass, including 3 new cases.

### Step 5: Gates

**Verify**: `bun x ultracite fix && bun run check && bun run typecheck && bun run --cwd apps/web test` → all pass.

## Test plan

Covered by Steps 1 and 4. No e2e change expected: the annotation only
appears after expanding a campaign, which the deterministic overview
snapshots do not do — if `dashboard.spec.ts` or a presentation spec fails,
treat it as a STOP (an assertion is pinning child-row text).

## Done criteria

- [ ] `grep -n "data-session-inherited-title" apps/web/src/lib/features/sessions/table/session-cell.svelte` → 1 hit
- [ ] `git diff packages/report-core/src/session-query.ts` → empty (searchText/sort untouched)
- [ ] `bun run typecheck` exits 0
- [ ] `bun run --cwd apps/web test` exits 0 with the new cases
- [ ] `plans/README.md` status row updated

## STOP conditions

- The TanStack row instance in `session-table.svelte` does not expose
  `getParentRow()` (or child rows are not modeled as sub-rows of the campaign
  row) — report the actual child-row wiring instead of inventing a parallel
  lookup map.
- `SessionPresentationRow` does not expose `titleSource` at the table layer
  (it should, via serialization — if it was stripped, report where).
- Any test asserts the exact text content of child session cells (would mean
  another plan owns that presentation).

## Maintenance notes

- If `firstPrompt` propagation lands later (see plan 084), prompt-derived
  titles arrive with `titleSource: 'first-prompt'` and are correctly treated
  as real titles by `sessionTitleIsGeneric` — no change needed here.
- Reviewer should scrutinize: that the annotation is display-only (no change
  to `searchText`, sort keys, or CSV output) and that campaign label
  overrides (plan 051) flow into the inherited text automatically.
- Deferred: inheriting titles in the session drawer header for child
  sessions — do it only if the drawer proves confusing in real use.
