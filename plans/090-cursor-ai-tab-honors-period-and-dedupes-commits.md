# Plan 090: Scope the Cursor AI Tab to the Report Period and List One Row per Commit

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 51815b70..HEAD -- apps/web/src/lib/features/report/breakdown/cursor.ts apps/web/src/lib/features/report/breakdown/cursor.test.ts apps/web/src/lib/features/report/breakdown/cursor-attribution-panel.svelte apps/web/src/lib/features/report/breakdown/dashboard-breakdown.svelte apps/web/src/lib/features/report/breakdown/model-analysis-table.ssr.test.ts apps/web/src/lib/features/report/composition/live-report-destination.svelte apps/web/src/lib/features/report/composition/synthetic-report-destination.svelte apps/web/src/lib/features/report/composition/report-destination.ts apps/web/src/lib/features/report/composition/report-search.ts apps/web/e2e/dashboard.spec.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition. Plans 088 and 089 are on the same
> program branch and touch `live-report-destination.svelte` /
> `report-range-model.ts` respectively — a diff in those files is expected if
> they landed first; re-verify only the excerpts quoted below.

## Status

- **Priority**: P1
- **Effort**: S–M
- **Risk**: LOW
- **Depends on**: none (sequence-independent; see Scope for 088/089 touch points)
- **Category**: data honesty / presentation
- **Planned at**: commit `51815b70`, 2026-08-23
- **Audit findings**: U08

## Why this matters

Every other Analysis sub-tab (Models, Harnesses & providers, Projects) is
computed from the session rows that match the report's range and filters.
The Cursor AI sub-tab is the exception: the Cursor commit-attribution
dataset is passed through the breakdown untouched, so under a selected recent
period the reader sees commits dated months earlier, the "Scored commits" /
"Branch rows" tiles count the whole history, and the period control above the
table silently does nothing. On top of that, Cursor stores one attribution row
per branch a commit was observed on, and the table renders those raw rows — the
same commit appears repeatedly with the same numbers and a different branch
name — and the rows arrive in the order the store returns them (sorted by a
SHA-256 item key, i.e. effectively random), so there is no date order. The
reader cannot answer the one question the tab exists for: "of the code I
committed in this period, how much did Cursor attribute to AI?"

This plan makes the tab honour the period that the rest of the breakdown
already honours, lists each commit once with its branches, orders rows by
date descending, and shows the date that the period filter actually uses —
so the displayed date and the filter bound are the same field (the lesson of
finding U05, owned by plan 089).

## Current state

### The rows and what their two dates mean

- `packages/report-core/src/datasets.ts:4-22` — the row contract
  `CursorCommitAttributionRow`: `branchName: string`,
  `commitDate: string | null`, `commitHash: string`,
  `commitMessage: string | null`, `scoredAt: string | null`, plus twelve
  numeric fields (`blankLines*`, `composerLines*`, `humanLines*`, `lines*`,
  `tabLines*`, `v1AiPercentage`, `v2AiPercentage`).
  - line 136: `isNullableStrictIsoTimestamp(value.scoredAt)` — `scoredAt` is a
    strict ISO instant or null.
  - line 138: `isNullableParseableTimestamp(value.commitDate)` — `commitDate`
    is any `Date.parse`-able string or null (lines 121–122 define the
    predicate). In practice it is git's default date text, e.g. the demo row's
    `'Fri Mar 6 09:32:20 2026 +0100'`.
- `packages/local-collectors/src/facets.ts:26-48` — the collector SQL:
  `SELECT commitHash, branchName, scoredAt, … commitMessage, commitDate, …
  FROM scored_commits WHERE linesAdded IS NOT NULL ORDER BY scoredAt DESC`.
  `scoredAt` is **when Cursor scored the commit** (line 90 converts a numeric
  epoch via `scoredAtIso`); `commitDate` is the **git commit date** copied as
  text (line 114: `commitDate: typeof row.commitDate === 'string' ? row.commitDate : null`).
  In the demo fixture the two differ by a week (committed Mar 6, scored
  Mar 13).
- `packages/local-collectors/src/datasets.ts:35-38` — the store identity of a
  row is `cursorCommitAttributionItemKey = sha256(JSON.stringify([commitHash, branchName]))`,
  i.e. **one item per (commit, branch) pair** — this is why one commit yields
  one row per branch.
- `packages/usage-store/src/index.ts:3241` — the stored read that feeds every
  report: `ORDER BY dataset_key, machine_id, source_id, item_key`. The
  collector's `ORDER BY scoredAt DESC` is lost; rows reach the web in SHA-256
  key order (effectively random). No layer re-sorts them.

### Where the range is applied — and where it is not

- `packages/report-core/src/focused-report-query.ts:1511-1536`
  (`projectFocusedBreakdown`, used by the e2e/demo synthetic destination):
  lines 1517–1519 filter the session rows with
  `.filter((row) => matchesFocusedReportQuery(row, request.query, support.timeZone))`,
  but line 1523 passes the Cursor dataset through unfiltered:
  `cursorCommitAttribution: support.datasets?.cursorCommitAttribution ?? [],`.
- `packages/usage-store/src/focused-report-query-sqlite.ts:1249-1267`
  (`runBreakdown`, the live path): line 1260 is the same unfiltered
  pass-through `cursorCommitAttribution: support.datasets?.cursorCommitAttribution ?? [],`.
- `packages/report-core/src/focused-report-query.ts:544-545` — the session
  range predicate, for reference on the bound semantics this plan mirrors:
  `(!query.range.from || (row.activeTime !== null && row.activeTime >= Date.parse(query.range.from))) && (!query.range.to || (row.activeTime !== null && row.activeTime <= Date.parse(query.range.to)))`.
- `apps/web/src/lib/features/report/composition/report-search.ts:42` and `:61`
  — how the web derives the range the server answers:
  `const bounds = rangeBounds(search.range, new Date(generatedAt));` and
  `range: { from: canonicalDate(bounds.from), to: canonicalDate(bounds.to) },`
  (ISO instants or null; `to` is an end-of-day instant, see
  `report-range-model.ts` `rangeBounds`). `apps/web/src/date-range.ts:85-96`:
  mode `all` → `{ from: null, to: null }`; `30d` (the default,
  `apps/web/src/dashboard-search.ts:89`) → `from: rollingDaysAgo(generatedAt, 30), to: null`.
- `apps/web/src/lib/features/report/composition/report-destination.ts:16`
  `export type FocusedQuerySnapshot = Omit<FocusedReportQueryScope, 'revision'>;`
  and lines 43–48: `FocusedReportCommit` carries `destination: FocusedReportDestination`
  whose every variant has `query: FocusedQuerySnapshot` — so the **exact range
  a committed breakdown answered** is available next to its result as
  `commit.destination.query.range`.

### The web wiring

- `apps/web/src/lib/features/report/composition/live-report-destination.svelte:589-599`:
  ```svelte
  {#if commit?.breakdown && dashboardBreakdownModule}
    {@const DashboardBreakdown = dashboardBreakdownModule.default}
    <DashboardBreakdown
      data={{
        cursorRows: commit.breakdown.context.cursorCommitAttribution,
        generatedAt: bootstrap.support.generatedAt,
  ```
- `apps/web/src/lib/features/report/composition/synthetic-report-destination.svelte`:
  - lines 232–236: `const focusedQuery = $derived({ filters: destination.sessions.filters, range: destination.sessions.range, revision });`
  - line 244: `const breakdown = $derived(projectFocusedBreakdown(serializedRows, reportSupport, { query: focusedQuery }));`
  - lines 466–469: `<DashboardBreakdown data={{ cursorRows: breakdown.context.cursorCommitAttribution, generatedAt: reportSupport.generatedAt, …`
  - line 156: `reportSupport` is `demoReportPayload` minus rows, so e2e/demo
    mode ships the demo Cursor dataset (`apps/web/src/report-data.ts:228-247`:
    one row, `commitHash: 'da59e06cc4c9627584edec0f8dc06f7e4cdd199d'`,
    `branchName: 'main'`, `commitMessage: 'tanstack init'`,
    `commitDate: 'Fri Mar 6 09:32:20 2026 +0100'`,
    `scoredAt: '2026-03-13T08:28:49.536Z'`) under `generatedAt: '2026-06-11T12:00:00.000Z'`
    (line 214). Under the default 30d window (May 12 → Jun 11) that commit is
    outside the period — the deterministic e2e lever this plan uses.
- `apps/web/src/lib/features/report/breakdown/dashboard-breakdown.svelte`:
  - lines 31–38: the `data` prop type —
    `cursorRows: readonly CursorCommitAttributionFacet[]; generatedAt: string; harnesses…; harnessProviders…; models…; projects…;`
    — **no range**.
  - lines 104–106: `{#snippet cursorPanel()} <section class={section}><CursorAttributionPanel rows={data.cursorRows} /></section> {/snippet}`.
  - The `Tabs` primitive mounts panels lazily
    (`packages/design-system/src/svelte/compound/tabs.svelte:77` `lazyMount`,
    `:78` `unmountOnExit`), so the Cursor panel only renders when its tab is
    selected.
- `apps/web/src/lib/features/report/breakdown/cursor-attribution-panel.svelte`
  (89 lines, the whole symptom):
  - line 28: `let { rows }: { rows: readonly CursorCommitAttributionFacet[] } = $props();`
    — no range prop.
  - lines 29–30: `aiPercentage = $derived(summarizeCursorAiPercentage(rows))`, `humanLines = $derived(rows.reduce(…))` over **all** rows.
  - lines 35–36: `{#if rows.length === 0}` → `<div class={empty}>No Cursor commit attribution data in this payload</div>` — the only empty state.
  - lines 44–48: tile `label="Branch rows"`, `value={fmtNum(rows.length)}`,
    `hint="Cursor stores attribution per branch, so commits can repeat"` — the
    code knows about the duplication and documents it instead of folding it.
  - lines 60–67: headers `<th>Commit</th> <th>Branch</th> … <th>Scored</th>`.
  - line 71: `{#each rows as row (`${row.commitHash}:${row.branchName}`)}` —
    one `<tr>` per branch row, in payload order.
  - line 77: `<td>{row.branchName}</td>`; line 83: `<td>{fmtDate(row.scoredAt)}</td>`
    — the visible date is the **scoring time**, not the commit date, and it
    is not what any filter uses.
- `apps/web/src/lib/features/report/breakdown/cursor.ts:9-42` —
  `summarizeCursorAiPercentage(rows)` already groups by `commitHash`
  (line 12 `const commits = new Map<string, …>()`), counts
  `totalCommits: commits.size`, and treats a commit as "measured" only when
  all its branch rows agree on percentage and line total (line 25). Keep it;
  feed it the in-range rows.
- `apps/web/src/lib/features/report/breakdown/cursor.test.ts` — two cases for
  `summarizeCursorAiPercentage` only; rows are partial casts.
- `apps/web/src/lib/features/report/breakdown/model-analysis-table.ssr.test.ts`
  — the SSR harness to copy (lines 53–73: Vite `createServer` with the svelte
  plugin, `ssrLoadModule`, `svelte/server` `render`); lines 136–146 render
  `dashboard-breakdown.svelte` with a `data` literal that has no `range`.
- `apps/web/e2e/dashboard.spec.ts:35-41` `openHydratedReport(page, url)`;
  lines 232–233 locate the `tablist` named `Analysis dimension`. No e2e
  visits the Cursor AI tab today (`grep -rn "cursor-ai" apps/web/e2e` → none).
- `apps/web/src/lib/foundation/presentation/format.ts:38`
  `fmtDate = (value: string | null) => value ? dateTimeFormatter.format(new Date(value)) : '—'`
  — accepts an ISO string; formats in the process time zone (do not assert
  formatted text in SSR tests).
- Vocabulary (`CONTEXT.md:73`): a **Dataset** is "a named set of collected
  and enriched report data transported alongside usage rows, such as provider
  status or Cursor commit attribution."

### Decisions this plan makes (do not reopen)

1. **Where to filter**: in the web panel, using the range the committed
   breakdown was answered with (`commit.destination.query.range` /
   `focusedQuery.range`). Rationale: the bounds are byte-identical to what the
   server used for the other three tabs; no `report-core`/`usage-store`
   contract change, no second implementation to keep in parity, and the panel
   can still distinguish "no Cursor data at all" from "none in this period"
   (a server-side filter would lose that). If plan 088 later moves Cursor
   scoping server-side, the pure helpers from Step 1 move with it.
2. **Which date is "the" date**: the git commit date (`commitDate`), falling
   back to `scoredAt` when the commit date is missing or unparseable, and
   `null` when neither exists. The same helper drives the filter *and* the
   displayed date (header "Committed"); the scoring time moves to the cell's
   `title`. Rationale: the reader's question is about code committed in the
   period; scoring lags commits by days (demo: one week).
3. **Undated rows** (no commit date, no scored time) are **kept** under every
   range and show `—` with `data-cursor-date-source="none"` — the repo's
   partial-data rule: a filter default must never exclude "unknown". Bounds are
   inclusive on both ends, like the session predicate.
4. **Grouping**: one table row per `(commitHash, identical metric set)`; the
   branches of the merged rows are listed in one cell, sorted. Branch rows of
   the same commit that **disagree** on any metric are *not* merged (each
   keeps its own row with its own branch subset) — never average or pick one.
   In practice Cursor stores identical numbers per branch; the rule only
   guards honesty.
5. **Order**: commit date descending; undated rows last; ties by `commitHash`
   ascending, then by the joined branch list — fully deterministic.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `bun run typecheck` | exit 0 |
| Format/lint | `bun x ultracite fix` then `bun run check` | exit 0 |
| Prepare web test prerequisites (design-system build + svelte-kit sync + panda) | `bun run --cwd apps/web dev:prepare` | exit 0 — required once before any `*.ssr.test.ts` run; a missing `.svelte-kit` surfaces as a bogus `node:module` resolve error |
| Breakdown unit + SSR tests | `cd apps/web && bun test src/lib/features/report/breakdown/` | all pass |
| All web unit tests | `bun run --cwd apps/web test` | all pass |
| One e2e spec | `cd apps/web && bun run test:e2e -- e2e/dashboard.spec.ts` | all pass |

On NixOS, if Playwright's downloaded chromium fails to launch, set
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to the system Chrome binary before
running e2e (`--channel chrome` does not work here).

## Scope

**In scope** (the only files you should modify):
- `apps/web/src/lib/features/report/breakdown/cursor.ts` (new pure helpers)
- `apps/web/src/lib/features/report/breakdown/cursor.test.ts`
- `apps/web/src/lib/features/report/breakdown/cursor-attribution-panel.svelte`
- `apps/web/src/lib/features/report/breakdown/cursor-attribution-panel.ssr.test.ts` (new)
- `apps/web/src/lib/features/report/breakdown/dashboard-breakdown.svelte` (thread `range`)
- `apps/web/src/lib/features/report/breakdown/model-analysis-table.ssr.test.ts` (add `range` to the `data` literal)
- `apps/web/src/lib/features/report/composition/live-report-destination.svelte` (one prop)
- `apps/web/src/lib/features/report/composition/synthetic-report-destination.svelte` (one prop)
- `apps/web/e2e/dashboard.spec.ts` (one new test)

**Out of scope** (do NOT touch):
- `packages/report-core/src/focused-report-query.ts`,
  `packages/usage-store/src/focused-report-query-sqlite.ts`,
  `packages/report-core/src/datasets.ts` — the breakdown context contract
  stays "all stored rows"; scoping is a web projection (Decision 1).
- `packages/local-collectors/**`, `packages/usage-store/src/index.ts` — the
  per-branch item identity and the store read order are correct storage
  facts; the web sorts.
- `apps/cli/**` — the CLI does not render a commit table.
- Range bounds, day counting, range URL encoding — plan 089 (U04/U05/U32).
  This plan consumes `range.from`/`range.to` exactly as produced and changes
  nothing about how they are produced. The e2e in Step 6 uses the current
  JSON `range=` URL form; plan 089 promises backward-compatible decoding, so
  the test keeps working if 089 lands first (or after).
- Canonical-number consolidation across surfaces — plan 088. That plan may
  move breakdown scoping server-side later; it must then reuse the helpers
  from Step 1, not re-derive the date rule.
- Web Cursor CSV import / machine label — plan 079 (different feature).
- `fmtDate` having no year (U36/U38 family) — plan 091/094 territory; keep
  the existing formatter.

## Git workflow

- Work on the program branch `plan/086-ui-ux-audit-remediation` (already
  checked out in this worktree). Do not create a new branch.
- One commit for this plan. Stage by explicit path (peer sessions may write to
  this repo): `git add apps/web/src/lib/features/report/breakdown/cursor.ts …`
  — never `git add -A`.
- Commit style (from `git log`): `fix(web): scope the Cursor AI tab to the report period and list branches per commit`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add the pure helpers next to `summarizeCursorAiPercentage`

In `apps/web/src/lib/features/report/breakdown/cursor.ts`, export (keep
`summarizeCursorAiPercentage` unchanged):

```ts
export const CURSOR_COMMIT_METRIC_KEYS = [
  'blankLinesAdded', 'blankLinesDeleted', 'composerLinesAdded', 'composerLinesDeleted',
  'humanLinesAdded', 'humanLinesDeleted', 'linesAdded', 'linesDeleted',
  'tabLinesAdded', 'tabLinesDeleted', 'v1AiPercentage', 'v2AiPercentage',
] as const;
export type CursorCommitMetrics = Pick<CursorCommitAttributionFacet, (typeof CURSOR_COMMIT_METRIC_KEYS)[number]>;

export type CursorCommitDateSource = 'commit' | 'none' | 'scored';
export interface CursorCommitActivity {
  readonly source: CursorCommitDateSource;
  readonly time: number | null; // epoch ms
}
/** Commit date first; scoring time when the commit date is missing or unparseable; never throws. */
export const cursorCommitActivity = (row: Pick<CursorCommitAttributionFacet, 'commitDate' | 'scoredAt'>): CursorCommitActivity

export interface CursorCommitRange { readonly from: string | null; readonly to: string | null; }
/** Inclusive on both bounds; rows whose activity is null are kept (partial-data rule). */
export const cursorRowsInRange = <Row extends Pick<CursorCommitAttributionFacet, 'commitDate' | 'scoredAt'>>(
  rows: readonly Row[], range: CursorCommitRange,
): Row[]

export interface CursorCommitGroup {
  readonly branches: readonly string[];   // distinct, sorted
  readonly commitHash: string;
  readonly commitMessage: string | null;  // first non-null among merged rows
  readonly date: string | null;           // ISO of the group's activity (min over merged rows)
  readonly dateSource: CursorCommitDateSource;
  readonly key: string;                   // `${commitHash}:${branches.join(',')}` — unique by construction
  readonly metrics: CursorCommitMetrics;
  readonly rowCount: number;              // branch rows merged into this group
  readonly scoredAt: readonly string[];   // distinct ISO scoring times, ascending
}
/** Groups by (commitHash, identical metric set); sorted date desc, undated last, then commitHash, then key. */
export const groupCursorCommits = (rows: readonly CursorCommitAttributionFacet[]): CursorCommitGroup[]
```

Implementation notes (Biome will enforce most of this): build the group map
with `for…of` and a `Map` keyed by
`${row.commitHash} ${JSON.stringify(CURSOR_COMMIT_METRIC_KEYS.map((key) => row[key]))}`;
no spread in accumulators; the date rule is
`Number.isFinite(Date.parse(commitDate ?? ''))` → `'commit'`, else
`Number.isFinite(Date.parse(scoredAt ?? ''))` → `'scored'`, else `'none'`
(guard against `Date.parse('')` returning NaN — that is the desired "not a
date" outcome). Range test: `time === null || ((from === null || time >= Date.parse(from)) && (to === null || time <= Date.parse(to)))`.
Sorting comparator (write it as a small named function with early returns —
Biome rejects nested ternaries): if exactly one side has `time === null` it
sorts after the other; if both are numbers and differ, larger `time` first;
otherwise compare `commitHash` ascending, then `key` ascending (plain `<`
comparisons; no `localeCompare`, so the order is engine-independent).

**Verify**: `bun run typecheck` → exit 0 (nothing consumes the helpers yet).

### Step 2: Unit-test the helpers

In `apps/web/src/lib/features/report/breakdown/cursor.test.ts`, add a full-row
factory (all 17 fields; no `as` cast needed) and cases:

- `cursorCommitActivity`: commit date wins over scoredAt
  (`commitDate: 'Mon Jul 13 10:00:00 2026 +0200'`, `scoredAt: '2026-07-20T00:00:00.000Z'`
  → `source: 'commit'`, `time: Date.parse('2026-07-13T08:00:00.000Z')`);
  `commitDate: null` → `'scored'` with the scoredAt instant;
  `commitDate: 'not a date'` + scoredAt → `'scored'`; both null → `{ source: 'none', time: null }`.
- `cursorRowsInRange`: `{ from: null, to: null }` returns every row; a row
  whose commit instant equals `to` exactly is kept (inclusive); a row whose
  commit date is outside but whose `scoredAt` is inside is **dropped** (the
  filter uses the commit date); the reverse is kept; an undated row is kept
  under a narrow range.
- `groupCursorCommits`: three rows of one hash on `main`, `release/y`,
  `feature/x` with identical metrics and different `scoredAt` → one group,
  `branches` `['feature/x', 'main', 'release/y']`, `rowCount: 3`, `scoredAt`
  ascending distinct, `commitMessage` from the rows; two rows of one hash with
  a differing `v2AiPercentage` → two groups with disjoint branches and
  different `key`s; ordering: a later-dated commit first, an undated commit
  last, equal dates ordered by `commitHash`.
- Keep the two existing `summarizeCursorAiPercentage` cases.

**Verify**: `cd apps/web && bun test src/lib/features/report/breakdown/cursor.test.ts` → all pass.

### Step 3: Thread the committed range into the breakdown

- `apps/web/src/lib/features/report/breakdown/dashboard-breakdown.svelte`:
  add `import type { SessionQueryRange } from '@ai-usage/report-core/session-query';`
  and `range: SessionQueryRange;` to the `data` prop type (lines 31–38);
  change line 105 to `<CursorAttributionPanel range={data.range} rows={data.cursorRows} />`.
- `apps/web/src/lib/features/report/composition/live-report-destination.svelte`
  line 593 block: add `range: commit.destination.query.range,` to the `data`
  literal (the `{#if commit?.breakdown …}` guard already narrows `commit`).
- `apps/web/src/lib/features/report/composition/synthetic-report-destination.svelte`
  line 469 block: add `range: focusedQuery.range,`.
- `apps/web/src/lib/features/report/breakdown/model-analysis-table.ssr.test.ts`
  lines 139–146: add `range: { from: null, to: null },` to the `data` literal
  so the fixture matches the prop contract (the panel is lazily mounted there
  and will not render, but the literal must be complete).

**Verify**: `bun run typecheck` → exit 0; `grep -n "range: commit.destination.query.range" apps/web/src/lib/features/report/composition/live-report-destination.svelte` → 1 hit; `grep -n "range: focusedQuery.range" apps/web/src/lib/features/report/composition/synthetic-report-destination.svelte` → 1 hit.

### Step 4: Rewrite the panel over the helpers

In `apps/web/src/lib/features/report/breakdown/cursor-attribution-panel.svelte`:

- Props: `let { range, rows }: { range: SessionQueryRange; rows: readonly CursorCommitAttributionFacet[] } = $props();`
- Deriveds:
  ```ts
  const visibleRows = $derived(cursorRowsInRange(rows, range));
  const groups = $derived(groupCursorCommits(visibleRows));
  const aiPercentage = $derived(summarizeCursorAiPercentage(visibleRows));
  const humanLines = $derived(visibleRows.reduce((total, row) => total + row.humanLinesAdded + row.humanLinesDeleted, 0));
  const outsideCommits = $derived(summarizeCursorAiPercentage(rows).totalCommits);
  ```
- Empty states (exact copy — the e2e in Step 6 asserts it):
  ```svelte
  {#if rows.length === 0}
    <div class={empty} data-cursor-empty-state="payload">No Cursor commit attribution data in this payload</div>
  {:else if visibleRows.length === 0}
    <div class={empty} data-cursor-empty-state="period">No Cursor commits in this period · {fmtNum(outsideCommits)} scored {outsideCommits === 1 ? 'commit' : 'commits'} outside it</div>
  {:else}
  ```
- Tiles: keep the four tiles; feed them the deriveds above; hints become
  `"Unique commit hashes Cursor scored, in this period"` (Scored commits) and
  `"Cursor stores one row per branch a commit was seen on; the table lists each commit once with its branches"` (Branch rows).
- Table: headers `Commit | Branches | AI % | Composer | Tab | Human | Total +/- | Committed`;
  give the last header
  `title="Git commit date. When Cursor stored no commit date, the scoring time is shown and marked · scored."`.
  Body:
  ```svelte
  {#each groups as group (group.key)}
    <tr data-cursor-commit={group.commitHash}>
      <td class={strongCell} title={group.commitHash}>
        <div>{group.commitMessage || group.commitHash.slice(0, COMMIT_HASH_PREVIEW_LENGTH)}</div>
        <div class={meta}>{group.commitHash.slice(0, COMMIT_HASH_PREVIEW_LENGTH)}</div>
      </td>
      <td data-cursor-branch-count={group.branches.length}>{group.branches.join(', ')}</td>
      <td class={numCell}>{group.metrics.v2AiPercentage === null ? '—' : fmtPct(group.metrics.v2AiPercentage)}</td>
      … composer / tab / human / total cells read from group.metrics exactly as today …
      <td data-cursor-date-source={group.dateSource} title={group.scoredAt.length ? `Scored ${group.scoredAt.map(fmtDate).join(', ')}` : 'Scoring time unavailable'}>
        {fmtDate(group.date)}{#if group.dateSource === 'scored'}<span class={meta}> · scored</span>{/if}
      </td>
    </tr>
  {/each}
  ```
- Remove every direct `row.` read from the template; `rows` is only read for
  `rows.length` and `outsideCommits`.

**Verify**: `grep -n "row\.scoredAt\|row\.branchName" apps/web/src/lib/features/report/breakdown/cursor-attribution-panel.svelte` → no matches; `bun run typecheck` → exit 0.

### Step 5: SSR presentation gate

Create `apps/web/src/lib/features/report/breakdown/cursor-attribution-panel.ssr.test.ts`
by copying the Vite/`svelte/server` harness from
`model-analysis-table.ssr.test.ts` (lines 1–24 and 53–73, loading
`/apps/web/src/lib/features/report/breakdown/cursor-attribution-panel.svelte`).
Fixture rows (full rows; reuse the Step 2 factory by exporting it from
`cursor.test.ts` or duplicating it — do not add a shared fixture module):

- `A` = `'a'.repeat(40)`, `commitDate: 'Mon Jul 13 10:00:00 2026 +0200'`, three
  rows on `main` / `release/y` / `feature/x`, identical metrics, `scoredAt`
  Jul 14 / Jul 15 / Jul 16.
- `B` = `'b'.repeat(40)`, `commitDate: 'Wed Aug 5 09:00:00 2026 +0200'`, one row on `main`.
- `C` = `'c'.repeat(40)`, `commitDate: null`, `scoredAt: null`, one row on `main` (undated).
- `D` = `'d'.repeat(40)`, `commitDate: 'Fri Mar 6 09:32:20 2026 +0100'`, one row (outside).
- `E` = `'e'.repeat(40)`, `commitDate: null`, `scoredAt: '2026-07-20T00:00:00.000Z'`, one row (scored fallback, inside).

Render with `range: { from: '2026-07-01T00:00:00.000Z', to: '2026-08-31T23:59:59.999Z' }` and assert on `body`:

- `body.match(/data-cursor-commit="/g)` has length 4 (A, B, C, E) and
  `body` does not contain `'d'.repeat(40)` (D filtered by **commit** date even
  though nothing else excludes it).
- A's row contains `>feature/x, main, release/y<` and `data-cursor-branch-count="3"`; the hash `'a'.repeat(40)` occurs in exactly one `data-cursor-commit` attribute (dedupe).
- Order: `body.indexOf('data-cursor-commit="' + B)` < `… E` < `… A` < `… C` (date desc; undated last).
- `data-cursor-date-source="commit"` on A and B, `"scored"` on E with the text `· scored` inside E's row, `"none"` on C with `>—<` in C's date cell.
- Tiles: "Scored commits" is `4` (A, B, C, E) and "Branch rows" is `6` (A's 3 + B + C + E; D is out of range). `MetricTile` renders `<div …>{label}</div><div><div …>{value}</div>…` (`packages/design-system/src/svelte/controls/metric-tile.svelte:16-19`), so assert on slices: `body.slice(body.indexOf('Scored commits'), body.indexOf('Branch rows'))` matches `/>4</` and `body.slice(body.indexOf('Branch rows'), body.indexOf('AI line share'))` matches `/>6</`.
- Second render with the rows **A, B, D, E only** (C is undated and would be kept under any range by Decision 3, so it cannot be part of an "everything outside" case) and `range: { from: '2027-01-01T00:00:00.000Z', to: null }` → body contains `data-cursor-empty-state="period"` and the exact text `No Cursor commits in this period · 4 scored commits outside it`, and does **not** contain `No Cursor commit attribution data in this payload`.
- Third render with all seven fixture rows (A ×3, B, C, D, E) and the same 2027 range → the table renders exactly one `data-cursor-commit="` (C, the undated row) with `data-cursor-date-source="none"` — proof that a narrow range never hides "unknown".
- Fourth render with `rows: []` → body contains `data-cursor-empty-state="payload"`.
- Do not assert formatted date text (process time zone).

**Verify**: `bun run --cwd apps/web dev:prepare` (once) then `cd apps/web && bun test src/lib/features/report/breakdown/` → all pass, including the new file. Sanity-check the gate: temporarily revert Step 4's `{#each groups …}` to the old `{#each rows …}` loop and confirm the dedupe/order assertions fail, then restore.

### Step 6: E2E through the real tab and URL range

Append to `apps/web/e2e/dashboard.spec.ts` (next to the breakdown tests around line 224):

```ts
test('scopes the Cursor AI analysis to the report period and lists one row per commit', async ({ page }) => {
  await openHydratedReport(page, '/?tab=cursor-ai');
  const breakdownTabs = page.getByRole('tablist', { name: 'Analysis dimension' });
  await expect(breakdownTabs.getByRole('tab', { name: 'Cursor AI' })).toHaveAttribute('aria-selected', 'true');
  // Default 30d window (May 12 → Jun 11, 2026 in the fixture) excludes the Mar 6 fixture commit.
  await expect(page.locator('[data-cursor-empty-state="period"]')).toHaveText(
    'No Cursor commits in this period · 1 scored commit outside it',
  );
  await expect(page.locator('[data-cursor-commit]')).toHaveCount(0);

  await openHydratedReport(page, `/?${new URLSearchParams({ range: JSON.stringify({ mode: 'all' }), tab: 'cursor-ai' })}`);
  const commitRows = page.locator('[data-cursor-commit]');
  await expect(commitRows).toHaveCount(1);
  await expect(commitRows.first()).toHaveAttribute('data-cursor-commit', 'da59e06cc4c9627584edec0f8dc06f7e4cdd199d');
  await expect(commitRows.first().locator('[data-cursor-branch-count]')).toHaveText('main');
  await expect(commitRows.first().locator('[data-cursor-date-source]')).toHaveAttribute('data-cursor-date-source', 'commit');
});
```

If plan 089 has already landed its readable range URLs, build the second URL
with its helper/form instead (the test intent is unchanged: an "all time"
range).

**Verify**: `cd apps/web && bun run test:e2e -- e2e/dashboard.spec.ts` → all pass.

### Step 7: Gates

Run `bun x ultracite fix`, `bun run check`, `bun run typecheck`,
`bun run --cwd apps/web test`, then the e2e spec from Step 6. Then update the
`plans/README.md` status row for 090 and commit (Git workflow above).

**Verify**: all commands exit 0; `git status` shows only in-scope files.

## Test plan

- Unit (`cursor.test.ts`): date rule (commit > scored > none, never throws),
  inclusive range with undated rows kept, commit-date-not-scoredAt filtering,
  grouping/merging/non-merging, deterministic order.
- SSR (`cursor-attribution-panel.ssr.test.ts`): DOM-level proof that the
  symptom is gone — one `<tr data-cursor-commit>` per commit, branch list
  cell, date-desc order, date-source marking, both empty states. This is the
  presentation gate for U08.
- E2E (`dashboard.spec.ts`): the real tab under the default period shows the
  period-empty state; `range=all` shows the single fixture commit once, on
  `main`, dated by commit date. Exercises the synthetic wiring
  (`focusedQuery.range` → panel); the live wiring
  (`commit.destination.query.range`) is covered by typecheck and the same
  panel code.
- Existing: `model-analysis-table.ssr.test.ts` keeps passing with the
  completed `data` literal; `summarizeCursorAiPercentage` cases untouched.

## Done criteria

- [ ] `grep -c "export const cursorCommitActivity\|export const cursorRowsInRange\|export const groupCursorCommits" apps/web/src/lib/features/report/breakdown/cursor.ts` → 3
- [ ] `grep -n "data-cursor-commit=\|data-cursor-branch-count=\|data-cursor-date-source=\|data-cursor-empty-state=" apps/web/src/lib/features/report/breakdown/cursor-attribution-panel.svelte | wc -l` ≥ 5
- [ ] `grep -n "row\.scoredAt\|row\.branchName" apps/web/src/lib/features/report/breakdown/cursor-attribution-panel.svelte` → no matches
- [ ] `grep -n "range: commit.destination.query.range" apps/web/src/lib/features/report/composition/live-report-destination.svelte` → 1 hit; `grep -n "range: focusedQuery.range" apps/web/src/lib/features/report/composition/synthetic-report-destination.svelte` → 1 hit
- [ ] `git diff --stat 51815b70..HEAD -- packages/report-core packages/usage-store packages/local-collectors apps/cli` → empty for this plan's commit
- [ ] `bun run typecheck` exits 0
- [ ] `cd apps/web && bun test src/lib/features/report/breakdown/` exits 0 with the new SSR file and the new unit cases
- [ ] `cd apps/web && bun run test:e2e -- e2e/dashboard.spec.ts` exits 0 with the new test
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The "Current state" excerpts do not match the working tree (in particular
  `commit.destination.query.range` is not reachable inside the
  `{#if commit?.breakdown …}` block, or `focusedQuery` no longer carries
  `range` in the synthetic destination) — report the actual shape instead of
  threading `search.range` + `rangeBounds` as a substitute (that would compute
  a second range next to the one the server answered).
- `Date.parse` of the fixture git-format dates returns NaN under Bun in the
  SSR/unit run (would mean the engine stopped accepting git's default date
  text; the fallback logic masks it — report, do not change the fixture to
  ISO to make it pass).
- The e2e default-period assertion fails because the fixture's
  `generatedAt`/Cursor row dates moved (`apps/web/src/report-data.ts:214`,
  `:228-247`) — report; do not edit `report-data.ts`.
- Any existing e2e or visual-regression test starts failing on the Cursor AI
  tab (none reference it today — a failure means another plan added one).
- The Vite SSR harness fails for a reason other than the missing
  `.svelte-kit` sync (which `bun run --cwd apps/web dev:prepare` fixes).

## Maintenance notes

- The date rule (commit date > scoring time > none) and the inclusive-bounds
  predicate live only in `cursor.ts`. If plan 088 moves Cursor scoping into
  the breakdown query, import/move these helpers rather than re-deriving them
  in `report-core`; the SSR test keeps guarding the panel either way.
- The breakdown payload still ships every stored Cursor row (bounded at
  50,000 by `maximumNormalizedDatasetItems`); filtering client-side is cheap
  at that size, and the table now renders far fewer rows than before. If the
  payload size ever matters, server-side scoping is the next step, not a
  table cap.
- Reviewer should scrutinize: Decision 4 (merge only identical metric sets)
  against `summarizeCursorAiPercentage`'s "measured only when branch rows
  agree" rule — they are deliberately consistent; and the exact empty-state
  copy, which the e2e pins.
- Deferred: a visible "Scored" column (the scoring time is now a `title`
  only); a year in `fmtDate`.

## Execution notes

Executed 2026-08-23 in an isolated worktree on the program branch. Drift check
returned an empty diff and every "Current state" excerpt matched the working
tree, so no STOP condition applied. Deviations from the literal steps:

- **Step 4 / Step 5, date cell markup.** The step's inline
  `{fmtDate(group.date)}{#if …}<span> · scored</span>{/if}` is not a fixed point
  of `bun x ultracite fix`: the formatter reflows the `{#if}` onto its own
  lines, Svelte collapses the introduced newline into a text space, and the SSR
  output became `>— <!--…-->` instead of `>—<`. The date value is therefore
  wrapped in its own `<span>` — `<span>{fmtDate(group.date)}</span>` — which is
  format-stable and restores the step's literal `>—<` assertion. The marker span
  drops its leading space (`· scored`) because the element separation now
  supplies it. Nothing else about the cell changed.
- **Step 2 / Step 5, fixtures.** The row factory is duplicated in
  `cursor.test.ts` and `cursor-attribution-panel.ssr.test.ts` (the step's second
  option). Exporting it from `cursor.test.ts` would make the SSR run import a
  test module and re-register its suites.
- **Step 2, existing cases.** The two `summarizeCursorAiPercentage` cases are
  unchanged in intent and values, but their local helper now builds on the new
  full-row factory instead of an `as CursorCommitAttributionFacet` cast.
- **Step 7, `bun run check` / `bun run lint`.** Both are no-ops or spurious
  failures inside a worktree because `biome.json` excludes
  `**/.claude/worktrees`, so `biome check .` sees 0 files. They were run with
  the changed paths passed explicitly instead (`bun x ultracite check <paths>`
  → 9 files, 0 findings; the root `lint` biome invocation plus all five
  `tools/check-*.ts` guards with explicit workspace roots → 1077 files, clean).

Guards checked beyond the plan's list:

- `bun run test:web-bundle` **cannot run inside a worktree** and this is not
  caused by the change: the dependency provisioning resolves third-party
  packages at the repository root, so the Vite client manifest keys the
  SvelteKit entry as `../../../../../node_modules/@sveltejs/kit/…` while
  `bundle/client-bundle.test.ts` looks up `../../node_modules/@sveltejs/kit/…`
  and throws before reading a single byte of app code. The first-load budget is
  structurally untouched anyway: a production build places the new helpers and
  the rewritten panel in the `dashboard-breakdown.svelte` chunk, which the
  manifest reaches only through `dynamicImports` from route node 3 and through
  no static import.

### Rework round 1 (adversarial review)

Three blocking findings, all accepted and fixed. Each is now pinned by a test
that fails on the pre-rework code.

1. **Duplicate render key (runtime defect).** Step 1 specified
   `key = ${commitHash}:${branches.join(',')}` as "unique by construction", but
   group identity is `(commitHash, metric set)`, so that key collides whenever
   one commit on one branch is stored twice with different numbers. That is a
   normal dataset, not a contrived one: `collected_dataset_items` has
   `PRIMARY KEY (source_id, machine_id, dataset_key, schema_version, item_key)`
   while `cursorCommitAttributionItemKey` hashes only `[commitHash, branchName]`
   — the same commit collected on two machines is two stored rows. Reproduced:
   `groupCursorCommits` returned two groups both keyed `<hash>:main`, which
   Svelte rejects in a keyed `{#each}`. The key now carries the group's metric
   signature (`${commitHash}:${branches}:${signature}`), which is exactly the
   discriminator the group map already used. **The plan's stated key shape is
   therefore wrong and was not followed.** Note that Svelte's *SSR* renderer does
   not validate keys (verified: it renders duplicates without throwing), so the
   gate is the unit case `keeps same-branch rows apart when two machines
   disagree on the numbers`, backed by an SSR case asserting both rows render.
2. **Accessibility: hover-only scoring time.** Step 4 moved the scoring time
   into a `title` and Step 4/"Deferred" accepted losing the visible `Scored`
   column. Native `title` is not keyboard- or touch-reachable, and CONTRIBUTING
   requires preserving accessibility. The scoring time is now visible text in
   the date cell (`data-cursor-scored-at`: `Scored <times>`, `No scoring time
   recorded`, or `No commit date recorded`), and the date rule moved from a
   `<th title>` to a visible `<p>` referenced by the table's `aria-describedby`
   — the pattern `model-analysis-table.svelte` already uses. `scope="col"` was
   added to the eight headers. The pre-existing `title` on the `AI %` header and
   on the metric tiles is untouched (out of scope; it predates this plan).
3. **Unpinned tile projections.** The out-of-range SSR fixture row had zero
   metrics, so reverting the AI-share or Human-lines projections from
   `visibleRows` to `rows` left the suite green. That row now carries 1,000
   lines / 900 human lines / 99%, and the tiles are asserted at
   `4/4 measured`, `67%` and `358`. Verified by mutation: unscoping either
   projection alone now fails.

Weak tests the reviewer flagged, both fixed:

- The non-merge unit case used two different branches, so it could not expose
  the same-branch collision; a same-branch case was added alongside it.
- The e2e "one row per commit" claim was unfalsifiable — the synthetic payload
  ships one Cursor row, so raw un-deduped rendering would also produce one row.
  The test is renamed to `scopes the Cursor AI analysis to the report period`
  and carries a comment pointing at the SSR file as the de-duplication gate.
  `apps/web/src/report-data.ts` was **not** edited (Scope forbids it).

### Rework round 2 (adversarial review)

Four blocking findings, all accepted and fixed; each is pinned by a test that
fails on the round-1 code.

1. **Mixed-provenance groups falsely claimed a scoring fallback.** The group's
   date took the earliest activity of any merged row regardless of its source,
   so a commit whose `main` row carried a July 13 git commit date and whose
   `topic/z` row carried only a July 1 scoring time was labelled
   `dateSource: 'scored'` and dated July 1 — while the panel's own copy told
   the reader the scoring time appears only when Cursor stored *no* commit date.
   Source now outranks recency (`cursorDateSourceRank`, `outranksDraftActivity`):
   the earliest **commit date** among the merged rows wins, and the earliest
   scoring time is used only when no merged row carries a commit date. Proved by
   the unit case `prefers a real commit date over another row's scoring
   fallback` and the SSR case `dates a mixed-provenance commit from its commit
   date and says so`, both rendering fixture **G** (`'g'.repeat(40)`: `main`
   with commit date July 13 + scoredAt July 14, `topic/z` with no commit date +
   scoredAt July 1, identical metrics so the two rows merge). A companion unit
   case pins "earliest commit date wins when several rows carry one".
2. **Copy contradicted the settled disagreement rule.** The Branch rows tile
   said the table "lists each commit once with its branches", which the
   deliberate split-on-disagreement rule makes false. Both the tile hint and the
   table description now say the table folds branch rows into one row per commit
   and keeps a commit on separate rows only when its stored numbers disagree.
3. **Presentation-gate gaps.** (a) The tile hints had no DOM assertion — the new
   SSR case `states in the tiles what each number counts` asserts all four.
   (b) `shows every scoring time as visible text` measured commas across the
   whole row, where the branch list already supplies two, and a scoring-dated
   group rendered only `No commit date recorded`, hiding every instant but the
   earliest. The label now always lists the instants
   (`No commit date recorded — Scored <a> · <b>`), the instants are joined with
   ` · ` so the count is independent of time zone and date format, and the test
   reads **only** the `data-cursor-scored-at` cell via `scoredAtTextFor`. New
   fixture **F** (`'f'.repeat(40)`) is a scoring-dated commit with two scoring
   times; the assertions pin 3 instants for A, 1 for E, 2 for F.
4. **Weak oracles.** The `cursorCommitActivity` timestamp expectations re-ran the
   same `Date.parse` the implementation uses. They are now literal epochs
   (`JULY_13_2026_0800_UTC`, `JULY_20_2026_0000_UTC`).

**Provenance audit requested by the orchestrator** — the other derivations in
`cursor.ts` that reduce a multi-row group to one value:

- `metrics` — identical across merged rows by construction (the metric signature
  is the group key), so there is no winner to pick.
- `branches` and `scoredAt` — unions, never a selection; every value survives.
- `rowCount` — a count.
- `commitMessage` — **was** "first non-null wins", which is a silent winner over
  a nondeterministic order: stored rows arrive in SHA-256 item-key order, so two
  reads could render different messages. It now takes the lexicographically
  smallest non-null message, so the render is stable; a row that stored no
  message never displaces one that did. Pinned by `resolves a commit message the
  same way regardless of stored row order`. (Within a group the commit hash is
  identical, so a genuine message disagreement is not expected — this guards
  determinism, not a data conflict.)
- `date` / `dateSource` — the finding above.

**Orchestrator-directed deviation (do not "restore" the plan text).** Step 4 of
this plan puts the scoring time in a native `title` and its Maintenance notes
defer a visible scoring presentation. That instruction was **superseded by
orchestrator direction in rework round 1**: a native `title` is not keyboard- or
touch-discoverable, so the scoring time is visible text in the date cell and the
date rule is a visible `<p>` wired to the table with `aria-describedby`. A later
reader should treat the plan's `title` wording as obsolete, not as a regression
to repair.

### Maintainer reopening — complete-group period semantics

Decision D20 reopened the exhausted child on 2026-08-24. TDD reproduced the
remaining blocker: filtering branch rows before grouping let an in-period
scoring fallback render a commit whose authoritative git date was outside the
period. The inverse also discarded branch data when the authoritative commit
date was in-period but a sibling row's scoring fallback was outside it.

`cursorRowsInRange` now resolves the date source and instant for each complete
render group before applying the inclusive period, then retains either every
row in the accepted group or none. The existing commit-date-over-scoring rule
is shared with `groupCursorCommits`; no second date precedence was introduced.
The unit case `resolves a complete commit group before applying the period`
pins both directions. The SSR case `does not let an in-period scoring fallback
override its commit group date` renders the exact former false-positive state
through the shipped panel and proves that neither the row nor its visible copy
survives.

Final child gates on the rebased program tree: targeted model and SSR 30/30;
web 989/989; lint 1,085 files plus all five guards; typecheck 28/28 with zero
Svelte errors or warnings; `dashboard.spec.ts` 28/28 under the shared lock with
two workers; build 15/15 immediately followed by bundle 4/4. Two sandboxed
Playwright starts collected no tests because loopback port binding was denied;
the canonical out-of-sandbox run under the same lock passed and is the only
credited browser result. Structural acceptance and diff checks are clean.
