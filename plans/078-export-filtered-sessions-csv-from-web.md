# Plan 078: Export Filtered Session Rows as CSV From the Web Sessions View

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 5e4cf954..HEAD -- apps/web/src/dashboard-breakdown-export.ts apps/web/src/lib/features/report/actions/ apps/web/src/lib/features/report/composition/ packages/report-core/src/csv.ts`
> On any mismatch with the "Current state" excerpts, STOP.

## Status

- **Priority**: P2
- **Effort**: S–M
- **Risk**: LOW
- **Depends on**: none
- **Category**: direction
- **Planned at**: commit `5e4cf954`, 2026-08-20

## Why this matters

The CLI exports row-level CSV (`--csv`), and `packages/report-core/src/csv.ts`
documents `usageRowCsvColumns` as "the single source of truth for the usage
row → CSV projection. Both the CLI and the web export adapter feed it" — but
no web caller of `serializedRowsToCSV` exists. A user who filters the
Sessions table in the browser (project, model, campaign, machine, time range
— all UI state) cannot get those rows out; reconstructing the filter as CLI
flags is impossible for campaign or machine filters. This plan adds a
Sessions-view export that serializes the **loaded** filtered rows through
the existing shared projection, with the row scope stated in the UI so the
bound is visible rather than assumed.

## Current state

- `packages/report-core/src/csv.ts`:
  - lines 4–13: CSV escaping + formula-injection neutralization
    (`CSV_FORMULA_PREFIX` prefixes `'`) — already handled, do not re-implement.
  - lines 19–23: the `usageRowCsvColumns` docblock quoted above.
  - lines 63–71: `serializedRowsToCSV(rows: SerializedRow[])` — header +
    body from `usageRowCsvColumns`.
  - The file also exports `reportCsvFilename(dimension, generatedAt)` (used
    by the breakdown exports; read its signature before use).
- `apps/web/src/dashboard-breakdown-export.ts` — the exemplar adapter:
  `createAnalyticsExport` / `createProjectExport` dynamically import
  `@ai-usage/report-core/csv` and return `{ csv, filename }`. Model the new
  sessions adapter on this file exactly (dynamic import keeps the CSV module
  out of the initial bundle).
- `apps/web/src/lib/features/report/actions/report-sharing-actions.svelte` —
  reusable actions block: props `{ createExport: () => Promise<ExportFile>, environment? }`,
  renders "Copy link" + "Export CSV" + notice, hides under `_print`. Already
  mounted by `projects-panel.svelte:58` and `harness-provider-panel.svelte:96`.
- `apps/web/src/lib/features/report/actions/sharing.ts` — `ExportFile`,
  `exportVisibleBreakdown`, `browserSharingEnvironment` (download via
  `apps/web/src/report-export.ts`'s `downloadReportCsv`).
- `apps/web/src/lib/features/report/composition/sessions-destination.svelte`:
  - line 59: prop `onRowsChange: (rows: readonly SessionPresentationRow[]) => void`.
  - lines 127–163: `{#snippet children(_rows)}` renders `SessionTable` with
    `rows={_rows}`; `queryState?.sessionCount` carries the total filtered
    count (line 156).
  - `sessions-destination-state.svelte` line 40: rows are
    `SessionPresentationRow` (which extends the serialized row shape —
    compatible with `serializedRowsToCSV`, whose columns read only base
    fields).
- Loading model: session pages load progressively (bounded continuous
  scrolling, ADR 0004); at any moment the browser holds `_rows.length` of
  `sessionCount` filtered rows. The export scope is the **loaded** rows —
  the honest client-side bound; a full-set server export is out of scope.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `bun run typecheck` | exit 0 |
| Format/lint | `bun x ultracite fix` then `bun run check` | exit 0 |
| Web unit tests | `bun run --cwd apps/web test` | all pass |
| Package tests | `bun test packages/report-core` | all pass |

## Scope

**In scope**:
- `apps/web/src/dashboard-breakdown-export.ts` (add `createSessionsExport`)
  and its test file (find it: `grep -rln "createAnalyticsExport" apps/web/src --include="*.test.ts"`)
- `apps/web/src/lib/features/report/composition/sessions-destination.svelte`
  (mount the actions; add the `generatedAt` prop — it does not exist yet)
- `apps/web/src/lib/features/report/composition/live-report-destination.svelte`
  and `synthetic-report-destination.svelte` (thread `generatedAt` into the
  sessions destination at their existing call sites — both compositions
  already hold `support.generatedAt`)
- `packages/report-core/src/csv.ts` **only if** `reportCsvFilename` rejects a
  `'sessions'` dimension (check first; extend the accepted union if needed,
  plus its test)

**Out of scope** (do NOT touch):
- Any new server/oRPC surface — this is a client-side export of loaded rows.
- `serializedRowsToCSV` and `usageRowCsvColumns` — the shared projection is
  the contract; web must not fork its own column set.
- The session drawer, campaign expansion, and the sessions query lifecycle.
- The CLI.

## Git workflow

- Commit style: `feat(report): export loaded session rows as CSV`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Sessions export adapter

In `apps/web/src/dashboard-breakdown-export.ts`, add:

```ts
export const createSessionsExport = async (
  generatedAt: string,
  rows: readonly SessionPresentationRow[],
): Promise<{ csv: string; filename: string }> => {
  const { serializedRowsToCSV, reportCsvFilename } = await import('@ai-usage/report-core/csv');
  return {
    csv: serializedRowsToCSV([...rows]),
    filename: reportCsvFilename('sessions', generatedAt),
  };
};
```

(Import the `SessionPresentationRow` type from
`@ai-usage/report-core/session-query`; if `reportCsvFilename`'s dimension
union lacks `'sessions'`, extend it in `csv.ts` with a test.) Add unit
cases in the adapter's test file: emits the shared header row; a
formula-prefixed session label survives already-neutralized (assert the
leading `'`).

**Verify**: `bun run --cwd apps/web test` and `bun test packages/report-core` → all pass.

### Step 2: Mount the actions on the Sessions destination

In `sessions-destination.svelte`, render `ReportSharingActions` above
`SessionTable` (inside the same container so it inherits the destination's
layout), with:

```svelte
<ReportSharingActions createExport={() => createSessionsExport(generatedAt, _rows)} />
```

`sessions-destination.svelte` has **no** `generatedAt` prop today: add one,
and thread `bootstrap.support.generatedAt` (live) /
`reportSupport.generatedAt` (synthetic) from the two composition callers —
both files are in scope for exactly this edit.
Next to the actions, render the scope label so the bound is visible:

```svelte
<span class={/* existing muted/meta class in this file's imports */}>
  Exports the {_rows.length.toLocaleString()} loaded of
  {(queryState?.sessionCount ?? _rows.length).toLocaleString()} filtered sessions
</span>
```

**Verify**: `bun run typecheck` → exit 0.

### Step 3: Component assertion

Extend the closest existing test over the sessions destination (find it:
`grep -rln "sessions-destination" apps/web/src --include="*.test.ts"`) to
assert the actions block renders on the sessions view and the scope label
names both counts. If only SSR tests exist for this composition, follow the
`campaign-session-controls.ssr.test.ts` pattern.

**Verify**: `bun run --cwd apps/web test` → all pass with the new cases.

### Step 4: Gates

**Verify**: `bun x ultracite fix && bun run check && bun run typecheck && bun run test` → all pass. Run `bun run test:e2e` if any e2e spec renders the Sessions destination (grep `data-report-sharing-actions` under `apps/web/e2e/` first).

## Test plan

- Adapter: header parity with the CLI export (compare against
  `usageRowCsvColumns` headers), formula-injection neutralization retained,
  empty rows → header-only CSV.
- Composition: actions visible on Sessions; scope label shows
  `loaded of filtered` counts.

## Done criteria

- [ ] `grep -rn "serializedRowsToCSV" apps/web/src | grep -v test` → at least one production hit
- [ ] `bun run typecheck` exits 0
- [ ] `bun run --cwd apps/web test` exits 0 with new cases
- [ ] `bun test packages/report-core` exits 0
- [ ] `plans/README.md` status row updated

## STOP conditions

- `SessionPresentationRow` is not structurally accepted by
  `serializedRowsToCSV` (a column reads a field the presentation row
  narrowed away) — report the exact type error; do not cast with `as`.
- `reportCsvFilename` turns out to be breakdown-specific in a way that makes
  extending it wrong (e.g. it encodes breakdown tab semantics) — report and
  propose a `sessionsCsvFilename` beside it instead.
- Threading `generatedAt` requires touching oRPC/web-contract or the
  destination query shapes — adding the component prop from the two
  composition callers is in scope, but the value must already exist in
  those callers; if it does not, report rather than extending contracts.

## Maintenance notes

- The export scope is deliberately "loaded rows": exporting the full
  filtered set requires a bounded server-side export procedure and belongs
  to a separate plan if real use demands it — record that demand rather than
  silently growing this button's scope.
- Reviewer should scrutinize: the scope label counts (loaded vs filtered)
  and that no new column set was invented on the web side.
- When campaign child rows are loaded and expanded, they are part of
  `_rows` only if the table model materializes them into the row list —
  verify during review and state the actual behavior in the button's
  tooltip if children are excluded.
