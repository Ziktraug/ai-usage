# Plan 089: Period Semantics — Inclusive Day Counts, Honest Campaign Dates, Auto Interval, Readable Range URLs

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 51815b70..HEAD -- apps/web/src/lib/features/report/range/report-range-model.ts apps/web/src/lib/features/report/range/report-range-model.test.ts apps/web/src/lib/features/report/range/report-period-control.svelte apps/web/src/lib/features/report/range/activity-explorer.svelte apps/web/src/lib/features/report/overview/executive-overview-model.ts apps/web/src/lib/features/report/overview/executive-overview-model.test.ts apps/web/src/lib/features/report/overview/executive-overview.svelte apps/web/src/lib/features/report/overview/overview-page.svelte apps/web/src/lib/features/report/overview/overview-page.fixture.svelte apps/web/src/lib/features/report/overview/overview-components.test.ts apps/web/src/lib/features/report/composition/report-search.ts apps/web/src/lib/features/report/composition/report-search.test.ts apps/web/src/lib/features/report/composition/live-report-destination.svelte apps/web/src/lib/features/report/composition/synthetic-report-destination.svelte apps/web/src/lib/features/report/core/report-bootstrap.ts apps/web/src/lib/foundation/navigation/svelte/dashboard-url.ts apps/web/src/lib/foundation/navigation/svelte/dashboard-url.test.ts apps/web/src/lib/features/shell/navigation.ts apps/web/src/dashboard-search.ts apps/web/src/dashboard-search.test.ts apps/web/src/dashboard-model.ts apps/web/src/dashboard-model.test.ts packages/report-core/src/session-query.ts packages/report-core/src/session-query.test.ts packages/usage-store/src/session-query-sqlite.ts packages/usage-store/src/session-query-sqlite.test.ts apps/web/e2e/time-range.spec.ts apps/web/e2e/dashboard.spec.ts apps/web/e2e/production-report.spec.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P0 (U04, U05 are data-consistency bugs) with P1/P2 riders
- **Effort**: M–L (five findings; U05 must land in three engines that are
  kept in parity by tests — unavoidable, the parity harness already exists)
- **Risk**: MED (U19 touches the Overview request pipeline; the hydration
  cache-hit invariant is pinned by a new unit test, see Step 6)
- **Depends on**: none. Sequence note: plan 093 edits
  `activity-explorer.svelte` (metric toggle) and `executive-overview.svelte`
  (hero value), plan 074 edits `live-report-destination.svelte` (quota
  history gate), plan 088 edits `session-query.ts` neighbours. Whoever lands
  second rebases; this plan's edits are confined to the blocks named below.
- **Category**: bug
- **Planned at**: commit `51815b70`, 2026-08-23
- **Audit findings**: U04 (day count + partial-day comparison caveat only;
  plan 093 owns the single-day chart label overflow), U05, U19, U32, U37
  (date inputs only; plan 098 owns the duplicated comparison copy)

## Why this matters

The 2026-08-23 fresh-eyes audit (Chrome headless via CDP, live dev app, all
routes, 1920/1280/1024/768/390, dark + light) found that the report's notion
of "a period" is internally inconsistent in five visible ways:

- **U04 (P0)** — "Today" and a Rhythm-day click read `Aug 23 → Aug 23, 2026 ·
  0 days`. The count is the fence-post difference between two day starts, so
  a one-day window is 0 and a 30-day window is 30 even though the chart draws
  31 bars and the brush spans 31 positions — the e2e harness even compensates
  with `toBe(days + 1)`. The hero's "60 % lower than the previous equal-length
  period" at 09:39 compared a partial day with a full day and said nothing.
- **U05 (P0)** — a day filter (Rhythm click → custom Jul 15 → Jul 15) listed a
  row whose Date column read Jul 18. Single sessions are filtered and
  displayed on the same instant (`activeDate`, the last activity). Campaign
  display rows are not: their date is the latest of the *matched members plus
  every automated-review (classifier) member regardless of the range*, and
  their date sort key follows the same rollup. The classifier rollup is a
  deliberate feature for the origin filter; it leaks into the date.
- **U19 (P1)** — All time (439 days) at Day interval draws ~1.6 px bars; the
  first ten months are a line. The Interval control exists but has no
  automatic mode.
- **U32 (P2)** — `?range=%7B%22mode%22%3A%227d%22%7D` is JSON in the URL.
- **U37 (P2, date inputs only)** — the custom From/To inputs are native
  `type="date"` inputs whose display format is chosen by the browser's UI
  language, not by the page; the rest of the period control speaks `en`
  month names and the URL speaks ISO. A French reader saw `MM/DD/YYYY` beside
  `Aug 23 → Aug 23, 2026` and had to guess the field order.

One coherent rule fixes all five: **a period is an inclusive set of calendar
days; every surface (count, chart buckets, filter, displayed dates, URL,
inputs) derives from the same inclusive projection**.

## Current state

Every excerpt below was read from the worktree at `51815b70`.

### U04a — day count

- `apps/web/src/lib/features/report/range/report-range-model.ts`
  - line 82: `const days = Math.max(0, Math.round((to.getTime() - from.getTime()) / DAY_MS));`
    where `from`/`to` are both `startOfDay` (lines 69–72, 78–79).
  - line 90: ``summary: `${summaryDayFormatter.format(from)} → ${summaryEndFormatter.format(to)} · ${days} ${days === 1 ? 'day' : 'days'}`,``
  - lines 80–81: `selectionIndexes` already span `toIndex - fromIndex + 1`
    positions (inclusive), so the brush and the chart disagree with the text.
  - `ReportRangeProjection` (lines 19–27) has no day-count field.
- `apps/web/src/date-range.ts:88–99` — `today` → `{ from: startOfDay(generatedAt), to: endOfDay(generatedAt) }`;
  `7d`/`30d`/`90d` → `{ from: rollingDaysAgo(generatedAt, N), to: null }`
  (N×24 h back, then `rangeBounds` snaps `from` to the day start — the
  window therefore covers N+1 calendar days, the last one partial).
- `apps/web/src/lib/features/report/range/report-range-model.test.ts`
  pins the fence-post counts: line 28 `'May 12 → Jun 11, 2026 · 30 days'`,
  line 37 `'Mar 13 → Jun 11, 2026 · 90 days'`, line 47 `'Jun 3 → Jul 03, 2026 · 30 days'`.
- e2e pins: `apps/web/e2e/time-range.spec.ts:133` (`· 30 days`), `:271`
  and `:477` (`· 90 days`), `:511` (`May 25 → Jun 05, 2026 · 11 days` — 12
  inclusive), `:586` (`May 20 → Jun 05, 2026 · 16 days` — 17 inclusive),
  `:716–717`:
  ```ts
      // One bucket per calendar day the range covers, inclusive of both ends.
      expect(geometry.buckets, preset).toBe(days + 1);
  ```
  `apps/web/e2e/dashboard.spec.ts:493` (`Apr 12 → Jun 11, 2026 · 60 days` —
  61 inclusive), `apps/web/e2e/production-report.spec.ts:570`
  (`Jun 26 → Jul 03, 2026 · 7 days` — 8 inclusive).
- `apps/web/src/lib/features/report/composition/live-report-destination.svelte:440–441`
  — Rhythm click: `range: { from: date, mode: 'custom', to: date }`.

### U04b — partial-period comparison

- `packages/report-core/src/focused-report-query.ts:1432–1447`
  (`previousPeriodSummary`): `const span = Math.max(86_400_000, to - from);`
  and the previous window is `[from - span, from - 1]`. For `today` the
  previous period is the full previous calendar day; the current one runs
  only to `generatedAt`. The core cannot say "partial" — it does not know
  whether `range.to` lies in the future relative to `generatedAt`, but the
  web layer does: `rangeBounds(range, generatedAt).to` is `endOfDay(today)`
  for `today` and for any custom range ending today.
- `apps/web/src/lib/features/report/overview/executive-overview-model.ts`
  - lines 30–37: `ExecutiveOverviewModelInput` (`executive`,
    `previousSummary`, `rangeMode`, `summary`, `topItems`,
    `totalSessionCount`) — no notion of an in-progress period.
  - lines 39–43: `ExecutiveComparisonPresentation { delta, explanation, state }`.
  - lines 102–119 `comparisonFor`: line 114
    ``hint: `Previous period of equal length: ${fmtMoney(previousSummary.totalCost)}`,``
  - lines 219–253 `periodInsight`: line 249
    ``` `API-equivalent value is ${fmtPct(Math.abs(changePercent))} ${direction} than the previous equal-length period.`, ```
- `apps/web/src/lib/features/report/overview/executive-overview.svelte`
  - lines 107–114 `comparisonText`: line 111
    ``return `${fmtPct(Math.abs(comparison.delta.pct))} ${direction} than the previous equal-length period.`;``
  - lines 150–152: `{#if comparisonText}<p class={comparison}>{comparisonText}</p>{/if}`
  - line 6: `const qualification = css({ color: 'muted', fontSize: '12px', lineHeight: 1.5, m: 0, maxW: '58ch' });`
    (reuse for the caveat; add no css block).
- `apps/web/src/lib/features/report/overview/overview-page.svelte:68–77`
  builds the model from `result.view.previousSummary`, `range.mode`; the
  page owns `range: DashboardDateRangeSearch` (line 44) and
  `result.metadata.generatedAt`.
- `apps/web/src/lib/features/report/overview/overview-page.fixture.svelte:35,46,55`
  hardcodes `range={{ mode: '30d' }}`.
- `apps/web/src/dashboard-metric-model.ts:27–45` — the two "no comparison"
  strings; **plan 098 owns their wording; do not touch this file.**
- Demo payload (`apps/web/src/report-data.ts:214` `generatedAt: '2026-06-11T12:00:00.000Z'`)
  has a measured row on Jun 11 (`campaign-root`, `costApprox: 3.2`) and on
  Jun 10 (`costApprox: 0.17`), so `today` yields a previous summary with
  `totalCost > 0` and a delta.

### U05 — campaign display date vs. range filter

- Filter instant: `packages/report-core/src/usage-row.ts:252`
  `export const usageRowActiveDate = (row: Row) => row.endDate ?? row.date;`
  → `activeDate`; `apps/web/src/date-range.ts:114` `const value = row.activeDate ?? row.date;`
  (`rowTime`); `packages/report-core/src/session-query.ts:1432–1437` and
  `packages/usage-store/src/session-query-sqlite.ts:265–270` filter on
  `activeTime`/`active_time`.
- Displayed instant: `apps/web/src/lib/features/sessions/table/session-columns.ts:52`
  `column('date', 'Date', { align: 'left', format: (row) => fmtDate(row.activeDate), widthPx: 104 }),`
  and `session-table.svelte:587` (mobile card). Single rows: same instant
  both sides — consistent.
- Campaign display rows (the only rows the table shows — every singleton is
  a one-session campaign):
  - `packages/report-core/src/session-query.ts:1183–1188`
    ```ts
        const matchedRows = rows.filter((row) => visibleIds.has(row.rowId));
        if (matchedRows.length === 0) {
          continue;
        }
        const visibleIdsWithClassifierRollup = new Set([...matchedRows, ...allClassifiers].map((row) => row.rowId));
        const visibleRowsForTotals = rows.filter((row) => visibleIdsWithClassifierRollup.has(row.rowId));
    ```
    `SessionCampaignView` (lines 244–257) exposes `visibleRows` (= matched ∪
    all classifiers) and `visibleCount` (= `matchedRows.length`) but not
    `matchedRows` itself.
  - lines 1331–1334 (`sessionCampaignDisplayRow`):
    ```ts
      const latestVisibleRow = campaign.visibleRows.reduce(
        (latest, row) => (row.sortDate > latest.sortDate ? row : latest),
        campaign.visibleRows[0] ?? campaign.root,
      );
    ```
    lines 1337–1338 `activeDate: latestVisibleRow.activeDate, activeTime: latestVisibleRow.activeTime,`
    line 1368 `sortDate: latestVisibleRow.sortDate,`.
  - line 1233 (`campaignSortValue`, `case 'date'`):
    `return Math.max(...visibleRows.map((row) => row.sortDate), root.sortDate);`
    — also folds in the root even when the root is outside the range.
  - `packages/usage-store/src/session-query-sqlite.ts:355–372`
    ```sql
    campaign_latest_candidates AS (
      SELECT
        campaign_key,
        active_date,
        active_time,
        ROW_NUMBER() OVER (
          PARTITION BY campaign_key
          ORDER BY sort_date DESC, ordinal ASC
        ) AS latest_position
      FROM campaign_rollup
      WHERE campaign_key IS NOT NULL
    ),
    campaign_latest_rows AS (
      SELECT campaign_key, active_date, active_time
      FROM campaign_latest_candidates
      WHERE latest_position = 1
    )
    ```
    `campaign_rollup` (lines 330–345) = `filtered` ∪ classifier rows outside
    the filter whose campaign has a filtered member; lines 437–439 in
    `campaign_items`: `MAX(latest.active_date) AS latest_active_date,
    MAX(latest.active_time) AS latest_active_time, MAX(visible.sort_date) AS sort_date,`
    where `visible` is `campaign_rollup`. Line 505 joins `campaign_latest_rows AS latest`.
  - The web copy used by the synthetic (e2e/demo) destination,
    `apps/web/src/dashboard-model.ts`: `CampaignView` (lines 106–120),
    `buildCampaignViews` (lines 134–192; `matchedRows` at 164), `campaignSortValue`
    line 205 `return Math.max(...campaign.visibleRows.map((row) => row.sortDate), root.sortDate);`,
    `campaignDisplayRow` lines 324–327 (`latestVisibleRow` from `visibleRows`),
    333–334, 359.
- Mechanism of the symptom: a campaign whose subagent member was active on
  Jul 15 and whose automated review ran on Jul 18 matches a Jul 15 filter (one
  member matched), then displays and sorts on Jul 18. Nothing else in the
  code path can move a displayed date outside the filter: `fmtDate`
  (`apps/web/src/lib/foundation/presentation/format.ts:2–8,38`) formats in
  the runtime's local zone, the same zone `rangeBounds` uses.
- Parity harness: `packages/usage-store/src/session-query-sqlite.test.ts`
  compares every SQL page with `projectSessionPage` (`:662–708` classifier
  parity, `:798–826` date-filtered paging). Its `row()` fixture gives every
  row `activeDate: '2026-07-01T10:01:00.000Z'` (line 53) — no test varies
  member dates under a range, which is why the divergence is invisible.

### U19 — timeline interval

- Granularity is part of the **server request**: `packages/report-core/src/focused-report-query.ts:116`
  `timeline: { dimension: FocusedTimelineDimension; granularity: FocusedTimelineGranularity };`
  buckets are built per granularity (lines 744–770).
- `apps/web/src/lib/features/report/composition/report-destination.ts:94–101`
  ```ts
  /**
   * Timeline the report opens on. Shared by the server prefetch and the hydrated component so both
   * derive the same Overview request fingerprint — a mismatch would silently miss the seeded cache.
   */
  export const INITIAL_REPORT_TIMELINE: FocusedOverviewRequest['timeline'] = Object.freeze({
    dimension: 'harness',
    granularity: 'day',
  });
  ```
  used by `apps/web/src/lib/features/report/core/report-bootstrap.ts:110–115`
  (server prefetch) and `live-report-destination.svelte:109–110, 116–118`.
- `apps/web/src/lib/features/report/composition/live-report-destination.svelte`
  - line 110: `let granularity = $state<MigrationGranularity>(INITIAL_REPORT_TIMELINE.granularity);`
  - line 170: `const timeline = $derived({ dimension, granularity });`
  - lines 171–172: `reportDestinationForSearch(search, bootstrapResult.bootstrap.support.generatedAt, timeline)`
  - line 197: `const commit = $derived(destinationQuery.data);` — `destinationQuery`
    is created at line 189 **before** `commit` exists; the query key is the
    single current alias (`reportDestinationKey()` in
    `apps/web/src/lib/query/options/report-destination.ts:207`), so `commit`
    keeps the previous destination's data while a new one loads
    (`commitAnswersRequest`, lines 275–277). A destination change is pushed
    by the effect at lines 231–253 (`refreshReportDestination`).
  - lines 444–452 `updateOverviewOptions` set `dimension`, `granularity`,
    `timelineValue`; line 649 passes `granularity`, line 653
    `onOptionsChange: updateOverviewOptions`; line 646
    `dateDomain: commit.overview.dateDomain`.
- `apps/web/src/lib/features/report/composition/synthetic-report-destination.svelte`
  - line 215: `let granularity = $state<'day' | 'month' | 'week'>('day');`
  - lines 228–230: `reportDestinationForSearch(renderedSearch, reportSupport.generatedAt, { dimension, granularity })`
  - lines 237–242: `projectFocusedOverview(serializedRows, reportSupport, { …, timeline: { dimension, granularity } })`
    — **synchronous**: a granularity rule that reads `overview.dateDomain`
    would be a `$derived` cycle here. `allRows` (line 158, enriched rows with
    `activeTime`) is a plain constant.
  - lines 524, 530: `granularity,` / `granularity = options.granularity;`
- `apps/web/src/lib/features/report/range/activity-explorer.svelte`
  - lines 85–108 `Props`: line 90 `granularity: MigrationGranularity;`, lines
    94–98 `onOptionsChange?: (options: { dimension; granularity: MigrationGranularity; value }) => void;`
  - lines 213–217:
    ```ts
      const granularityItems = [
        { label: 'Day', value: 'day' },
        { label: 'Week', value: 'week' },
        { label: 'Month', value: 'month' },
      ] as const;
    ```
  - lines 263–267 `chartSummary` = `` `${dimensionLabel} · ${Granularity} · ${valueLabel}` `` (pinned by
    e2e `time-range.spec.ts:153,428,439,450,459`, `category-visibility.spec.ts:78`, and
    `overview-components.test.ts:90` — all expect the **resolved** label, e.g. `· Day ·`).
  - lines 402–406 `changeGranularity` accepts `'day' | 'week' | 'month'`.
  - lines 515–521: `<SegmentedControl ariaLabel="Interval" items={granularityItems} label="Interval" onValueChange={changeGranularity} value={granularity} />`
    (`SegmentedControl` items are `{ label, value }`, rendered as `role="radio"`;
    `presetGroup` wraps, so a fourth item is safe at 390 px).
  - line 131 `const projection = $derived(reportRangeProjection(range, generatedDate, dateDomain));`
    is the shared projection; the control state only stores
    `options.granularity` at creation (line 135) and never reads it back.
- `apps/web/src/lib/features/report/overview/timeline-window.ts:7–12`: "The
  Activity chart renders the selected report window, not the whole domain"
  — the relevant count is the selection's day count, not the domain's.
- `apps/web/src/overview-model.ts:205` `export type MigrationGranularity = 'day' | 'month' | 'week';`

### U32 — range URL encoding

- `apps/web/src/lib/foundation/navigation/svelte/search-codec.ts:44–61`
  (`stringifyValue`) JSON-encodes objects; a string that is **not** valid
  JSON passes verbatim (lines 52–59). `parseTanStackSearch` (lines 15–42)
  JSON-parses any string that parses and keeps the rest verbatim — so
  `range=7d`, `range=today`, `range=2026-07-15..2026-07-15` all survive both
  directions untouched, and legacy `range=%7B%22mode%22%3A%227d%22%7D` still
  decodes to a record.
- `apps/web/src/lib/foundation/navigation/svelte/dashboard-url.ts`
  - lines 23–26: `DashboardSearchCodec { defaults; validate }` — no encode hook.
  - line 50: `const encoded = new URLSearchParams(stringifyTanStackSearch(dashboardRecord(canonical)));`
    line 53 compares `canonical[key]` with `codec.defaults[key]` (object
    forms) — the comparison must stay on the canonical object.
- `apps/web/src/dashboard-search.ts`
  - lines 83–87 `DashboardDateRangeSearch { from?; mode; to? }`, line 89
    `defaultDashboardDateRangeMode = '30d'`, lines 149–150 `dateRangeModes`/`dateRangeModeSet`.
  - lines 262–287 `parseRange`: `if (!isRecord(value)) { return fallback; }`
    then mode/from/to validation via `validDateInput` (lines 159–164,
    strict `YYYY-MM-DD` through `parseLocalDate`).
- `apps/web/src/lib/features/shell/navigation.ts:29–32`
  `export const dashboardSearchCodec: DashboardSearchCodec<DashboardSearch> = { defaults: dashboardSearchDefaultsFor('date'), validate: validateDashboardSearch };`
- Tests: `apps/web/src/lib/foundation/navigation/svelte/dashboard-url.test.ts:51–58`
  builds its own codec from the dynamically imported module (`defaults`,
  `validate`); `:235–276` `[url:dashboard.range]` asserts round trips and
  one invalid legacy-JSON URL (line 243). `apps/web/src/dashboard-search.test.ts:137–156`
  covers record parsing only.
- e2e readers of the raw param: `apps/web/e2e/time-range.spec.ts:80`
  `reportRangeValue`, `:81` `ninetyDayReportUrl` (legacy JSON, keep as the
  backward-compat proof), `:483,506,566,574` `toContain('"from":"2026-…"')`,
  `:767` `toContain('"mode":"custom"')`; `apps/web/e2e/production-report.spec.ts:401`
  (`not.toBeNull()`, fine); `apps/web/e2e/session-scroll.scale.ts:20` (legacy
  JSON route — must keep decoding; do not edit).

### U37 — custom date inputs

- `apps/web/src/lib/features/report/range/report-period-control.svelte:196–231`
  — two native inputs, `type="date"` at lines 209 and 224, `value={draftFrom}` /
  `value={draftTo}` (ISO `YYYY-MM-DD` from `inputValueForRange` →
  `toDateInputValue`), `onchange` commits via `validateCustomRangeInputs`
  (strict ISO, `report-range-model.ts:102–122`; messages line 106
  `'Enter a valid From date.'`, line 109 `'Enter a valid To date.'`), Escape
  restores (`restoreOnEscape`, lines 151–156). Labels `From`/`To` (lines
  198, 213). `input` css at lines 36–46.
- Every other date in the control is English (`report-range-model.ts:29–31`
  `Intl.DateTimeFormat('en', …)`), the URL is ISO, Rhythm keys are ISO
  (`data-heatmap-day="2026-05-25"`). Native date inputs ignore the page
  `lang` (`apps/web/src/app.html:2` `<html lang="en">`) and follow the browser
  UI language — the app cannot make them consistent with its own copy.
- e2e reads them as textboxes: `apps/web/e2e/dashboard.spec.ts:735–736`
  `getByRole('textbox', { name: 'From' })…toHaveValue(selectedDay)`;
  `apps/web/e2e/time-range.spec.ts:105–111` `getByLabel('From', { exact: true })`
  then `.fill('2026-05-20')` (ISO; works for both `type="date"` and text).
- `report-range-model.test.ts:160–168` already asserts the control's source
  text (`aria-invalid={invalidFrom}`, `restoreCommittedDraft()`).

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `bun run typecheck` | exit 0 |
| Format + lint | `bun x ultracite fix` then `bun run lint` | exit 0 |
| Range model tests | `cd apps/web && bun test src/lib/features/report/range/report-range-model.test.ts` | pass |
| Executive model tests | `cd apps/web && bun test src/lib/features/report/overview/executive-overview-model.test.ts` | pass |
| Overview SSR tests | `cd apps/web && bun test src/lib/features/report/overview/overview-components.test.ts` | pass |
| URL codec tests | `cd apps/web && bun test src/lib/foundation/navigation/svelte/dashboard-url.test.ts src/dashboard-search.test.ts` | pass |
| Report search tests | `cd apps/web && bun test src/lib/features/report/composition/report-search.test.ts` | pass |
| Web campaign copy tests | `cd apps/web && bun test src/dashboard-model.test.ts` | pass |
| report-core tests | `cd packages/report-core && bun test src/session-query.test.ts` | pass |
| SQLite parity tests | `cd packages/usage-store && bun test src/session-query-sqlite.test.ts` | pass |
| All web unit tests | `bun run --cwd apps/web test` | pass |
| e2e (targeted) | `bun run --cwd apps/web test:e2e -- e2e/time-range.spec.ts e2e/dashboard.spec.ts` | pass |
| e2e (full) | `bun run --cwd apps/web test:e2e` | pass |

On NixOS set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to the system Chrome before
e2e (`--channel chrome` does not work here).

## Scope

**In scope** (the only files you may modify):

- `apps/web/src/lib/features/report/range/report-range-model.ts` (+ `.test.ts`)
- `apps/web/src/lib/features/report/range/report-period-control.svelte`
- `apps/web/src/lib/features/report/range/activity-explorer.svelte` — only
  the Interval block (lines 85–108 props, 213–217, 402–406, 515–521)
- `apps/web/src/lib/features/report/overview/executive-overview-model.ts` (+ `.test.ts`)
- `apps/web/src/lib/features/report/overview/executive-overview.svelte` —
  only `comparisonText` (107–114) and the `<p class={comparison}>` line (151)
- `apps/web/src/lib/features/report/overview/overview-page.svelte`,
  `overview-page.fixture.svelte`, `overview-components.test.ts`
- `apps/web/src/lib/features/report/composition/report-search.ts` (+ `.test.ts`)
- `apps/web/src/lib/features/report/composition/live-report-destination.svelte`
  — only the granularity state/derivations (110, 170, 444–452, 649)
- `apps/web/src/lib/features/report/composition/synthetic-report-destination.svelte`
  — only lines 215, 228–230, 237–242, 524, 530
- `apps/web/src/lib/features/report/core/report-bootstrap.ts` (lines 110–115)
- `apps/web/src/lib/foundation/navigation/svelte/dashboard-url.ts` (+ `.test.ts`)
- `apps/web/src/lib/features/shell/navigation.ts` (lines 29–32)
- `apps/web/src/dashboard-search.ts` (+ `.test.ts`)
- `apps/web/src/dashboard-model.ts` (+ `.test.ts`) — campaign view/date only
- `packages/report-core/src/session-query.ts` (+ `.test.ts`) — campaign
  view/date/sort only
- `packages/usage-store/src/session-query-sqlite.ts` (+ `.test.ts`) — the two
  CTEs and three aggregate columns only
- `apps/web/e2e/time-range.spec.ts`, `apps/web/e2e/dashboard.spec.ts`,
  `apps/web/e2e/production-report.spec.ts` (pinned strings + new assertions)
- `apps/web/e2e/visual-regression.spec.ts-snapshots/overview-*.png`
  (regenerated only; the period summary text changes)

**Out of scope** (do NOT touch):

- `apps/web/src/date-range.ts` — preset bounds (`rollingDaysAgo(generatedAt, N)`)
  stay as they are. The 30d preset covers 31 calendar days and will now say
  so; changing the preset window would move every reported number and is a
  product decision, not a bug fix.
- `packages/report-core/src/focused-report-query.ts` — `previousPeriodSummary`
  is correct for complete periods; the caveat is a presentation fact the web
  layer owns. The classifier rollup into **totals** is also untouched (plan
  088 owns "one canonical number per concept"; report there if you think the
  rollup should be range-bounded too).
- `apps/web/src/dashboard-metric-model.ts` — plan 098 owns the two
  "no comparison" strings.
- Single-day chart rendering / value-label overflow — plan 093.
- `apps/web/src/lib/features/report/overview/timeline-model.ts`,
  `activity-timeline.svelte` — plan 093 (palette, metric toggle).
- `apps/web/src/time-range-control-state.ts` — its `options.granularity` stays
  the resolved `MigrationGranularity`.
- `apps/web/e2e/session-scroll.scale.ts` — its legacy JSON route is the
  backward-compatibility proof for U32; leave it.
- Any RPC/contract change (no date domain is added to the bootstrap).

## Git workflow

- Work on the program branch `plan/086-ui-ux-audit-remediation` in this
  worktree. Peer plans commit to the same branch: stage by explicit path,
  never `git add -A`.
- One commit for this plan, style from `git log`:
  `fix(report): inclusive periods, range-true campaign dates, auto interval, readable range URLs`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Count periods inclusively and expose the count (U04a)

In `report-range-model.ts`:

- Line 82 → `const days = Math.round((to.getTime() - from.getTime()) / DAY_MS) + 1;`
  (`from`/`to` are both day starts, so the rounded difference is the
  fence-post count; `+ 1` makes it inclusive; a same-day range is 1).
- Add `readonly dayCount: number;` to `ReportRangeProjection` (lines 19–27)
  and return `dayCount: days` (line 83–91 object).
- Add, next to `rangeBounds`:
  ```ts
  /** True while the selected period still extends past the report's generation instant. */
  export const reportPeriodInProgress = (range: DashboardDateRangeSearch, generatedAt: Date): boolean => {
    const { to } = rangeBounds(range, generatedAt);
    return to !== null && to.getTime() > generatedAt.getTime();
  };
  ```
  (`today` → `endOfDay(generatedAt) > generatedAt` → true; `7d`/`30d`/`90d`/
  `all` → `to === null` → false; custom ending before today → false.)

In `report-range-model.test.ts`: update line 28 to `'May 12 → Jun 11, 2026 · 31 days'`,
line 37 to `'… · 91 days'`, line 47 to `'Jun 3 → Jul 03, 2026 · 31 days'`; add
cases: `{ mode: 'today' }` → summary ends `· 1 day` and `dayCount === 1`;
`{ mode: 'custom', from: '2026-06-11', to: '2026-06-11' }` → `· 1 day`;
`{ mode: 'custom', from: '2026-05-25', to: '2026-06-05' }` → `· 12 days`;
`dayCount === selectionIndexes[1] - selectionIndexes[0] + 1` for the 30d
preset; `reportPeriodInProgress` true for `today` and for a custom range
ending on `generatedAt`'s day, false for `7d`, `all`, and a custom range
ending the day before.

**Verify**: `cd apps/web && bun test src/lib/features/report/range/report-range-model.test.ts` → pass.

### Step 2: Say when a comparison is against a period still in progress (U04b)

- `executive-overview-model.ts`:
  - `ExecutiveOverviewModelInput`: add `readonly periodInProgress: boolean;`.
  - `ExecutiveComparisonPresentation`: add `readonly caveat: string | null;`.
  - `comparisonFor(summary, previousSummary, rangeMode, periodInProgress)`:
    `caveat: delta && periodInProgress ? 'This period is still in progress, so the comparison is provisional.' : null`.
  - `periodInsight(summary, previousSummary, topItems, periodInProgress)`:
    when `periodInProgress`, the first sentence becomes
    ``` `API-equivalent value is ${pct} ${direction} than the previous equal-length period (this period is still in progress).` ```
    (tuple shape `[string, string]` unchanged).
  - Thread `periodInProgress` through `buildExecutiveOverviewModel`.
- `executive-overview.svelte` lines 107–114: keep `comparisonText` as is; add
  `const comparisonCaveat = $derived(model.primary.comparison.caveat);` and
  render line 151 as
  ```svelte
  <p class={comparison}>{comparisonText}{#if comparisonCaveat} <span class={qualification} data-period-comparison-caveat>{comparisonCaveat}</span>{/if}</p>
  ```
- `overview-page.svelte` line 69 call: add
  `periodInProgress: reportPeriodInProgress(range, new Date(result.metadata.generatedAt)),`
  (import from `'../range/report-range-model'`).
- `overview-page.fixture.svelte`: add an optional `range` prop
  (`range = { mode: '30d' }`) and pass it to `<ReportPeriodControl>`,
  `activity.range`, and `<OverviewPage range={range}>` so SSR tests can render
  `today`.
- Tests:
  - `executive-overview-model.test.ts`: add `periodInProgress: false` to the
    `modelInput` helper (lines 66–81); new cases: `periodInProgress: true`
    with a delta → `comparison.caveat` equals the sentence above and
    `insight?.sentences[0]` carries the parenthetical; `periodInProgress: true`
    with `previousSummary: null` → `caveat === null` (no delta, no caveat);
    `periodInProgress: false` → `caveat === null`. Keep the
    `FORBIDDEN_INSIGHT_CLAIMS` assertion on the new text.
  - `overview-components.test.ts`: new SSR case — build the overview with the
    demo payload for `range: { from: '2026-06-11T00:00:00.000Z', to: '2026-06-11T23:59:59.999Z' }`
    (mirroring the `focusedOverview()` helper at lines 51–62), render the
    fixture with `range: { mode: 'today' }`, and assert `body` contains
    `data-period-comparison-caveat` and the caveat sentence; render the
    default (`30d`) and assert it does **not**. If the demo data yields no
    delta for `today` (check `model.primary.comparison.delta` first), render
    `executive-overview.svelte` directly through the same vite server with a
    model from `buildExecutiveOverviewModel` instead — the assertion is the
    same.

**Verify**: `cd apps/web && bun test src/lib/features/report/overview/executive-overview-model.test.ts src/lib/features/report/overview/overview-components.test.ts` → pass.

### Step 3: Make a campaign row's date and date-sort follow the matched members only (U05)

Definition to implement in all three engines: **a campaign display row's
`activeDate`/`activeTime`/`sortDate` (and its `date` sort key) is the latest
among the members that match the current query. Classifier members pulled
in by the rollup, and an unmatched root, contribute to totals as today but
never to the row's date.**

- `packages/report-core/src/session-query.ts`:
  - `SessionCampaignView` (244–257): add `matchedRows: SessionPresentationRow[];`
    (doc: "members that satisfy the current query; the classifier rollup is excluded").
  - `buildSessionCampaignViews` (1183–1203): push `matchedRows` on the view.
  - `campaignSortValue` line 1233: `return Math.max(...campaign.matchedRows.map((row) => row.sortDate));`
    (`matchedRows` is non-empty — line 1184 skips empty campaigns).
  - `sessionCampaignDisplayRow` lines 1331–1334: reduce over
    `campaign.matchedRows` (seed `campaign.matchedRows[0] ?? campaign.root`).
    Lines 1337–1338 and 1368 then read the matched latest automatically.
- `packages/usage-store/src/session-query-sqlite.ts`:
  - lines 355–372: `campaign_latest_candidates` selects `campaign_key,
    active_date, active_time, sort_date, ROW_NUMBER() …` **`FROM filtered`**
    (not `campaign_rollup`); `campaign_latest_rows` also projects `sort_date`.
  - line 439: `MAX(latest.sort_date) AS sort_date,` (replacing
    `MAX(visible.sort_date)`); lines 437–438 unchanged (they already read
    `latest`). The `INNER JOIN campaign_latest_rows AS latest` (line 505) is
    safe: every campaign item has at least one `filtered` member.
- `apps/web/src/dashboard-model.ts` (synthetic destination copy): add
  `matchedRows: DashboardRow[]` to `CampaignView` (106–120), set it in
  `buildCampaignViews` (line 164 already computes it), use it at line 205
  and lines 324–327.
- Tests (each must fail before the change on the date assertion):
  - `packages/report-core/src/session-query.test.ts`: new case next to the
    classifier-rollup test (564): rows `campaign-root` (human, `activeDate`
    `'2026-07-16T08:00:00.000Z'`), `campaign-child` (subagent, parent
    `campaign-root`, `activeDate '2026-07-15T10:00:00.000Z'`),
    `classifier-review` (classifier, parent `campaign-root`, `activeDate
    '2026-07-18T09:00:00.000Z'`), plus a standalone row dated
    `'2026-07-15T12:00:00.000Z'`; request `range: { from: '2026-07-15T00:00:00.000Z', to: '2026-07-15T23:59:59.999Z' }`,
    sort `date desc`. Expect: 2 items; the campaign row has
    `activeDate === '2026-07-15T10:00:00.000Z'`, `campaignVisibleCount === 1`,
    `campaignClassifierCount === 1` (totals still roll up), and the standalone
    (12:00) sorts **before** the campaign (10:00). Also assert
    `buildSessionCampaignViews(rows, visible)[…].matchedRows` has length 1.
  - `packages/usage-store/src/session-query-sqlite.test.ts`: same fixture via
    `openRowsDatabase` (override `activeDate`/`date`/`endDate` per row as the
    `row()` helper allows), `queryRequest({ range: …, sort: [{ desc: true, id: 'date' }] })`,
    `expect(executeMaterializedSessionQuery(database, 'sessions', request)).toEqual(projectSessionPage(fixtureRows, request))`
    **and** the explicit `activeDate` assertion (parity alone would pass if
    both engines were wrong the same way).
  - `apps/web/src/dashboard-model.test.ts`: sibling of "projects campaign
    table rows with aggregate metrics and latest visible date" (553) with a
    classifier dated later than the visible child and `visibleRows` limited to
    the child: `rows[0]?.activeDate` is the child's date and `sortDate` the
    child's.

**Verify**: `cd packages/report-core && bun test src/session-query.test.ts && cd ../usage-store && bun test src/session-query-sqlite.test.ts && cd ../../apps/web && bun test src/dashboard-model.test.ts` → pass, including the three new cases.

### Step 4: Readable `range` URLs with legacy decode (U32)

- `apps/web/src/dashboard-search.ts`:
  - Add after `DashboardDateRangeSearch`:
    ```ts
    /** `7d` | `today` | `all` | `90d` | `30d` | `custom` | `<from>..<to>` with either bound optional. */
    export const serializeDashboardDateRange = (range: DashboardDateRangeSearch): string => {
      if (range.mode !== 'custom') {
        return range.mode;
      }
      if (range.from === undefined && range.to === undefined) {
        return 'custom';
      }
      return `${range.from ?? ''}..${range.to ?? ''}`;
    };
    export const dashboardSearchUrlValues = (search: DashboardSearch): Record<string, unknown> => ({
      ...search,
      range: serializeDashboardDateRange(search.range),
    });
    ```
  - `parseRange` (262–287): before `if (!isRecord(value))`, accept strings:
    a member of `dateRangeModeSet` → `{ mode }` (for `'custom'` → `{ mode: 'custom' }`);
    a match of the top-level literal `/^(\d{4}-\d{2}-\d{2})?\.\.(\d{4}-\d{2}-\d{2})?$/`
    with at least one bound → recurse into the existing record branch with
    `{ mode: 'custom', from: match[1], to: match[2] }` so every validation
    rule (impossible date, reversed bounds) is reused; any other string →
    `fallback`. The record branch is unchanged (legacy JSON URLs).
- `apps/web/src/lib/foundation/navigation/svelte/dashboard-url.ts`:
  - `DashboardSearchCodec`: add `readonly encode?: (search: Search) => DashboardUrlSearch;`.
  - line 50: `stringifyTanStackSearch(dashboardRecord(codec.encode ? codec.encode(canonical) : canonical))`.
    Line 53's default comparison stays on `canonical`.
- `apps/web/src/lib/features/shell/navigation.ts:29–32`: add
  `encode: dashboardSearchUrlValues,`.
- Tests:
  - `dashboard-search.test.ts`: `validateDashboardSearch({ range: '7d' })` →
    `{ mode: '7d' }`; `'2026-06-01..2026-06-03'` → custom both bounds;
    `'2026-06-01..'` / `'..2026-06-03'` → open bounds; `'custom'` →
    `{ mode: 'custom' }`; `'2026-03-03..2026-02-28'`, `'2026-02-30..'`,
    `'..'`, `'yesterday'` → defaults; legacy record still parses;
    `serializeDashboardDateRange` round-trips every case.
  - `dashboard-url.test.ts`: extend the fixture codec (51–58) with
    `encode: dashboardSearchModule.dashboardSearchUrlValues` (declare it on
    `DashboardSearchModule`); in `[url:dashboard.range]` assert
    `dashboardUrlFor(…, { range: { mode: '7d' } }).search === '?range=7d'`,
    custom from-only → `'?range=2026-02-01..'`, both bounds →
    `'?range=2026-02-01..2026-02-28'`; keep the invalid legacy-JSON case and
    add a **valid** one: `new URL('http://local/?range=%7B%22mode%22%3A%227d%22%7D')`
    → `{ mode: '7d' }`.
- e2e: `time-range.spec.ts:483,506,566,574` → `toContain('2026-03-13..')` etc.
  (the custom URL is now `<from>..<to>`); `:767` →
  `toMatch(/^\d{4}-\d{2}-\d{2}\.\.\d{4}-\d{2}-\d{2}$/)`; keep
  `ninetyDayReportUrl` (81) as the legacy-decode proof and add one navigation
  to `/?range=90d` asserting the 90d button is pressed.

**Verify**: `cd apps/web && bun test src/dashboard-search.test.ts src/lib/foundation/navigation/svelte/dashboard-url.test.ts` → pass; `grep -rn "range=%7B" apps/web/src --include=*.ts` → only the legacy-decode test lines.

### Step 5: Locale-neutral ISO date inputs (U37, date inputs only)

In `report-period-control.svelte` lines 199–226: change both inputs to
`type="text"`, add `autocomplete="off"`, `inputmode="numeric"` is **not**
wanted (the hyphen is needed) — leave the input mode default; add
`placeholder="YYYY-MM-DD"`, `spellcheck="false"`, `maxlength="10"`, and
`title="Date as YYYY-MM-DD"`. Keep ids, labels, `aria-invalid`,
`aria-describedby`, `onchange`, `onkeydown`, `value` bindings unchanged.
The RangeBrush (line 235) and the Rhythm calendar remain the pointer pickers.

In `report-range-model.ts` lines 106 and 109 name the format:
`'Enter a valid From date (YYYY-MM-DD).'` / `'Enter a valid To date (YYYY-MM-DD).'`
and update the pinned messages in `report-range-model.test.ts:95,99` (and
anywhere else `grep -rn "Enter a valid" apps/web` finds them).

Tests: extend the source assertion in `report-range-model.test.ts:160–168`
with `expect(source).not.toContain('type="date"')` and
`expect(source).toContain('placeholder="YYYY-MM-DD"')`; in
`apps/web/e2e/dashboard.spec.ts:735–736` add
`await expect(page.getByRole('textbox', { name: 'From' })).toHaveAttribute('placeholder', 'YYYY-MM-DD');`
and in the same test, after the day click, assert the period summary
`'May 25 → May 25, 2026 · 1 day'` is visible (the U04a symptom: fails on
`51815b70` with `· 0 days`).

**Verify**: `cd apps/web && bun test src/lib/features/report/range/report-range-model.test.ts` → pass.

### Step 6: Automatic interval for long selections (U19)

- `report-range-model.ts`: add
  ```ts
  import type { MigrationGranularity } from '../../../../overview-model';
  export type TimelineGranularityPreference = MigrationGranularity | 'auto';
  /** Up to this many selected days the chart keeps one bar per day (the 90d preset is 91). */
  export const AUTO_INTERVAL_DAY_LIMIT_DAYS = 120;
  /** Up to this many selected days the chart uses weeks; beyond it, months. */
  export const AUTO_INTERVAL_WEEK_LIMIT_DAYS = 730;
  export const resolveTimelineGranularity = (
    preference: TimelineGranularityPreference,
    selectedDayCount: number,
  ): MigrationGranularity => {
    if (preference !== 'auto') {
      return preference;
    }
    if (selectedDayCount <= AUTO_INTERVAL_DAY_LIMIT_DAYS) {
      return 'day';
    }
    return selectedDayCount <= AUTO_INTERVAL_WEEK_LIMIT_DAYS ? 'week' : 'month';
  };
  ```
  Tests: explicit preferences pass through; 1, 91, 120 → day; 121, 439, 730 →
  week; 731 → month.
- `report-search.ts`: add
  ```ts
  export const initialReportTimelineFor = (
    range: DashboardDateRangeSearch,
    generatedAt: string,
  ): FocusedOverviewRequest['timeline'] => ({
    dimension: INITIAL_REPORT_TIMELINE.dimension,
    granularity: resolveTimelineGranularity('auto', reportRangeProjection(range, new Date(generatedAt), null).dayCount),
  });
  ```
  (import `INITIAL_REPORT_TIMELINE` from `./report-destination`). Test in
  `report-search.test.ts`: `{ mode: '30d' }`, `{ mode: '7d' }`, `{ mode: '90d' }`,
  `{ mode: 'today' }`, `{ mode: 'all' }` (domain unknown → 30-day fallback)
  all equal `INITIAL_REPORT_TIMELINE` — **this is the hydration cache-hit
  invariant**; `{ mode: 'custom', from: '2026-01-01', to: '2026-06-11' }` →
  `granularity: 'week'`.
- `report-bootstrap.ts:110–115`: pass `initialReportTimelineFor(search, bootstrap.bootstrap.support.generatedAt)`
  instead of `INITIAL_REPORT_TIMELINE`.
- `live-report-destination.svelte`:
  - line 110 → `let granularityPreference = $state<TimelineGranularityPreference>('auto');`
  - before line 170, add
    ```ts
    let knownDateDomain = $state<FocusedDateDomain | null>(null);
    const rangeProjection = $derived(
      reportRangeProjection(search.range, new Date(bootstrapResult.bootstrap.support.generatedAt), knownDateDomain),
    );
    const granularity = $derived(resolveTimelineGranularity(granularityPreference, rangeProjection.dayCount));
    ```
    (`timeline` at line 170 keeps `{ dimension, granularity }`). Do **not**
    read `commit`/`destinationQuery` here — both are declared after the
    query is created (TDZ). After line 197 add
    ```ts
    $effect(() => {
      const domain = commit?.overview.dateDomain;
      if (domain) {
        knownDateDomain = domain;
      }
    });
    ```
  - lines 116–118: build `initialDestination` with
    `initialReportTimelineFor(search, bootstrapResult.bootstrap.support.generatedAt)`
    (same function as the server prefetch).
  - lines 444–452: `options.granularity` is now a `TimelineGranularityPreference`
    → assign `granularityPreference`.
  - line 649 area: pass both `granularity` (resolved) and
    `granularityPreference`.
- `synthetic-report-destination.svelte`: line 215 →
  `let granularityPreference = $state<TimelineGranularityPreference>('auto');`
  plus
  ```ts
  const syntheticDateDomain = buildFocusedDateDomain(allRows.flatMap((row) => (row.activeTime === null ? [] : [row.activeTime])));
  const granularity = $derived(
    resolveTimelineGranularity(
      granularityPreference,
      reportRangeProjection(renderedSearch.range, new Date(reportSupport.generatedAt), syntheticDateDomain).dayCount,
    ),
  );
  ```
  (`buildFocusedDateDomain` is exported from `@ai-usage/report-core/focused-report-query`;
  the static domain keeps `overview` out of the derivation — see the cycle
  note in Current state). Lines 228–230 and 237–242 keep using `granularity`;
  line 524 passes both props; line 530 assigns `granularityPreference`.
- `activity-explorer.svelte`:
  - Props: keep `granularity: MigrationGranularity` (resolved); add
    `granularityPreference?: TimelineGranularityPreference` defaulting to
    `granularity`; `onOptionsChange`'s `granularity` becomes
    `TimelineGranularityPreference`.
  - lines 213–217 → a `$derived` list:
    `[{ label: \`Auto (${resolvedGranularityLabel})\`, value: 'auto' }, Day, Week, Month]`
    where `resolvedGranularityLabel` is the existing capitalised label used
    by `chartSummary` (263–267) — `chartSummary` itself is unchanged and keeps
    printing the resolved word, so every `· Day ·` assertion still holds.
  - lines 402–406: accept `'auto'` too.
  - lines 515–521: `value={granularityPreference}`.
- Tests:
  - `report-range-model.test.ts`: the resolver cases above.
  - `report-search.test.ts`: the invariant cases above.
  - e2e `time-range.spec.ts`: (a) in "changes every chart option" (408–430)
    after the Week/Month/Day loop, click `getByRole('radio', { name: /^Auto/ })`
    and expect it checked; (b) new test: `page.goto('/?range=2026-01-01..2026-06-11')`
    (162 days, also exercises the readable URL), open the explorer, expect
    `getByRole('radio', { name: 'Auto (Week)' })` to be checked and
    `activityFor(page).getByText('Harness · Week · Estimated API-equivalent value', { exact: true })`
    visible; click `Day` → `· Day ·` visible and the `[role="img"]` bucket
    count grows; (c) line 717 → `toBe(days)` (the summary is inclusive now).

**Verify**: `bun run typecheck` → exit 0; `cd apps/web && bun test src/lib/features/report/composition/report-search.test.ts src/lib/features/report/range/report-range-model.test.ts` → pass.

### Step 7: Update the remaining pinned strings and run the gates

- Pinned day counts: `time-range.spec.ts:133` → `· 31 days`, `:271,477` →
  `· 91 days`, `:511` → `· 12 days`, `:586` → `· 17 days`;
  `dashboard.spec.ts:493` → `· 61 days`; `production-report.spec.ts:570` →
  `· 8 days`.
- `bun x ultracite fix && bun run lint && bun run typecheck && bun run --cwd apps/web test`.
- `bun run --cwd apps/web test:e2e -- e2e/time-range.spec.ts e2e/dashboard.spec.ts e2e/production-report.spec.ts`.
- `bun run --cwd apps/web test:e2e` (full). `visual-regression.spec.ts` will
  fail on the period summary text (`· 30 days` → `· 31 days`) — regenerate
  with `bun run --cwd apps/web test:e2e -- e2e/visual-regression.spec.ts --update-snapshots`
  and inspect the PNG diff: the only change must be the summary digits.

**Verify**: all commands exit 0.

## Test plan

- Unit, fail-before/pass-after: inclusive count (`· 1 day` for today and a
  same-day custom range; `dayCount` equals the selection width); period in
  progress predicate; comparison caveat + insight parenthetical; campaign
  date from matched members in report-core, SQLite (parity + explicit date)
  and the web copy; readable range encode/decode with legacy JSON decode;
  resolver thresholds; `initialReportTimelineFor` equals
  `INITIAL_REPORT_TIMELINE` for every preset (cache-hit invariant).
- SSR: `[data-period-comparison-caveat]` present for `today`, absent for `30d`.
- e2e: Rhythm day click shows `· 1 day` and ISO placeholder; `?range=7d`,
  `?range=90d`, `?range=2026-01-01..2026-06-11` decode; legacy JSON URL still
  decodes; Auto (Week) resolved for the 162-day custom range, Day after an
  explicit click; bucket count equals the inclusive day count; Today preset
  renders the caveat (optional, add only if the demo data yields a delta —
  see Step 2).

## Done criteria

- [x] `grep -n "Math.max(0, Math.round" apps/web/src/lib/features/report/range/report-range-model.ts` → no match; `grep -n "dayCount" …/report-range-model.ts` ≥ 2
- [x] `grep -n "data-period-comparison-caveat" apps/web/src/lib/features/report/overview/executive-overview.svelte` → 1 hit
- [x] `grep -n "matchedRows" packages/report-core/src/session-query.ts apps/web/src/dashboard-model.ts` → ≥ 3 hits each; `grep -n "FROM campaign_rollup" packages/usage-store/src/session-query-sqlite.ts` → no hit inside `campaign_latest_candidates`; `grep -n "MAX(visible.sort_date)" …/session-query-sqlite.ts` → no match
- [x] `grep -n "serializeDashboardDateRange\|dashboardSearchUrlValues" apps/web/src/dashboard-search.ts apps/web/src/lib/features/shell/navigation.ts` → definitions + one `encode:` use
- [x] `grep -n 'type="date"' apps/web/src/lib/features/report/range/report-period-control.svelte` → no match; `placeholder="YYYY-MM-DD"` → 2 hits
- [x] `grep -n "resolveTimelineGranularity" apps/web/src --include=*.ts --include=*.svelte -r | grep -v test | wc -l` ≥ 4 (definition, report-search, live, synthetic)
- [x] `grep -n "INITIAL_REPORT_TIMELINE" apps/web/src/lib/features/report/core/report-bootstrap.ts` → no match (replaced by `initialReportTimelineFor`)
- [x] `grep -n "toBe(days + 1)" apps/web/e2e/time-range.spec.ts` → no match
- [x] `bun run typecheck`, `bun run lint`, `bun run --cwd apps/web test`, `cd packages/report-core && bun test src/session-query.test.ts`, `cd packages/usage-store && bun test src/session-query-sqlite.test.ts` all exit 0
- [x] `bun run --cwd apps/web test:e2e` exits 0 (snapshots regenerated and inspected)
- [x] `git status` shows no file outside the in-scope list
- [x] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The "Current state" excerpts do not match the worktree (another program
  plan landed first on `activity-explorer.svelte`, `executive-overview.svelte`,
  `live-report-destination.svelte`, or `session-query.ts`) — rebase is fine,
  but report if the named lines no longer exist.
- The SQLite parity test passes only with the SQL change **or** only with
  the report-core change — that means the two engines disagree on something
  else (e.g. the unmatched-root sort key at `session-query.ts:1233`); report
  the failing `toEqual` diff rather than papering over it.
- After Step 6 the default route (`/`, 30d) issues a second Overview
  destination fetch on hydration (watch `production-report.spec.ts` RPC
  counts or the network panel): `initialReportTimelineFor({ mode: '30d' })`
  must equal `INITIAL_REPORT_TIMELINE` — if it does not, the resolver
  threshold or `dayCount` is wrong; report, do not raise the limit to hide it.
- `visual-regression.spec.ts` PNG diffs show anything but the period
  summary digits.
- The demo payload yields no comparison delta for `today` **and** rendering
  `executive-overview.svelte` directly through the SSR vite server fails —
  report; do not weaken the caveat assertion to a source-text grep.

## Maintenance notes

- `all`-time URLs open at day granularity from the seeded cache and upgrade
  to week/month once the first commit carries the date domain (one extra
  destination fetch, only in `all` mode; the default 30d route is unchanged).
  If a date domain ever joins the bootstrap payload, feed it to
  `initialReportTimelineFor` and the upgrade fetch disappears.
- The thresholds (`120`/`730` days) are named constants in
  `report-range-model.ts`; move one number, reason in the commit.
- The classifier rollup still contributes to campaign **totals** outside the
  range (intentional for the origin filter). If plan 088 decides the rollup
  should be range-bounded, the place is `visibleIdsWithClassifierRollup`
  (`session-query.ts:1187`) and `campaignRollupCte` (`session-query-sqlite.ts:330`);
  the date logic from this plan is unaffected.
- `serializeDashboardDateRange` is the single place that writes the `range`
  param; `parseRange` accepts the readable form, the legacy JSON record, and
  nothing else. Do not add a third shape without a decode test.
- Reviewer should scrutinize: the `+ 1` in Step 1 against the e2e
  `toBe(days)` bucket proof; the `knownDateDomain` effect in Step 6 (it must
  only ever widen knowledge, never reset to `null`); the ISO text inputs
  at 390 px (the brush stays the touch picker).

## Execution notes

- Executed on 2026-08-23 from `3a0bf943`; the child drift check against
  `51815b70` was empty for every in-scope path.
- Implemented U04a/U04b, U05, U19, U32, and the date-input portion of U37.
  Campaign totals still include the established classifier rollup while the
  displayed date and date sort now use only query-matched members.
- Materialized the SQLite `filtered` campaign CTE. Reading matched dates from
  that CTE exposed a 5,000-campaign regression (~47 s); materialization
  restored the existing proof to 1.19 s without changing query results.
- The same source session on `machine-a` and `machine-b`, with different API
  values, remains two campaign rows. This proves machine identity stays in
  grouping keys instead of being inferred from the shared session id or label.
- Every changed visible sentence is pinned by a unit, SSR, or e2e assertion:
  inclusive summaries, provisional comparison copy, ISO validation guidance,
  and the resolved Auto interval label all have direct coverage.
- Worktree lint used the explicit Biome path set plus all five repository
  guards because bare `bun run lint` processes zero files below
  `.claude/worktrees`. Typecheck, 986 web tests, report-core (31), usage-store
  SQLite (22), and the full Playwright suite (151, `--workers=2` under the
  shared lock) passed. The visual update command passed all four snapshots and
  produced no PNG diff, so there was no visual change beyond already accepted
  output to inspect.
- A discretionary root `bun run test` passed all package tests and 121/122
  tool tests. The one worktree-only failure was
  `precommit-staged-only.test.ts`: its temporary repository could not resolve
  `ultracite/biome/core` through the provisioned dependency shadow. The
  required explicit-path formatter and lint gates above passed.
- Codex review round 1 requested two copy-gate corrections. The To-date
  validation now has an independent exact literal assertion, and the
  in-progress insight pins its complete reader-facing sentence rather than
  only its parenthetical suffix. Production code was unchanged.
