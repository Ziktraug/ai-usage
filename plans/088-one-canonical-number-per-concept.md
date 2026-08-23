# Plan 088: One Canonical Number Per Concept

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 51815b70..HEAD -- packages/report-core/src/focused-report-query.ts packages/report-core/src/focused-report-query.test.ts packages/report-core/src/analytics.ts packages/usage-store/src/focused-report-query-sqlite.ts packages/usage-store/src/focused-report-query-sqlite.test.ts apps/web/src/session-analysis-target.ts apps/web/src/session-analysis-target.test.ts apps/web/src/lib/features/report/composition/live-report-destination.svelte apps/web/src/lib/features/report/composition/synthetic-report-destination.svelte apps/web/src/lib/features/sessions/detail/session-drawer.svelte apps/web/src/lib/features/report/actions/campaign-session-controls.svelte apps/web/src/lib/features/report/actions/campaign-session-controls.ssr.test.ts apps/web/src/lib/features/report/overview/records.svelte apps/web/src/lib/features/report/overview/overview-components.test.ts apps/web/src/lib/features/sync/machine-fleet.svelte apps/web/src/lib/features/sync/machine-comparison.svelte apps/web/src/lib/features/sync/sync-render.test.ts apps/web/e2e/dashboard.spec.ts apps/web/e2e/drawer-value-presentation.spec.ts apps/web/e2e/origin-campaign.spec.ts docs/session-analysis-sources.md`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P0
- **Effort**: L (four P0 findings; each is S–M on its own — keep the step order,
  it is designed so U02 and U03 land before the riskier U06/U42 work)
- **Risk**: MEDIUM — aggregation semantics change in report-core and its SQLite
  mirror (parity tests are the safety net); the Overview drawer starts showing
  campaign aggregates (one e2e value and one visual snapshot change on purpose)
- **Depends on**: none. Plan 098 (`session-drawer.svelte` polish) and plan 097
  (`/sync` duplication/jargon) depend on this plan and must run after it.
- **Category**: bug / data honesty
- **Planned at**: commit `51815b70`, 2026-08-23
- **Audit findings**: U02, U03, U06, U42

## Why this matters

The 2026-08-23 fresh-eyes audit found four places where the same concept is
computed twice and the two numbers disagree on screen at the same minute with
the same filters:

- **U02** — Overview "API value by harness" says Claude Code `≥ $3,430 (24 %)`
  while Analysis › Harnesses & providers says Claude Code `≥ $3,222 (23 %)`;
  Codex and OpenCode agree in both. The breakdown drops the known subtotal of
  every *partially priced* session (it counts only fully priced sessions), the
  Overview keeps it. ~$208 of honestly-known value disappears between two tabs,
  and the breakdown row's own tooltip ("≥ values include lower bounds from
  incomplete pricing") promises the opposite of what it does.
- **U03** — `/sync` shows 4,954 + 3,171 = 8,125 sessions per machine while the
  report says 7,979 sessions for All time. The fleet counts every active stored
  row; the published report drops zero-token sessions (`minTokens: 1`) and reads
  the last published revision, not the live store. Both were labelled
  "Sessions".
- **U06** — Top sessions row "Campaign · 267 sessions · ≥ $2,567" opens a
  drawer for *one* session ($1,020, Calls 1, Subagent Yes) because the Overview
  hands the drawer the campaign **root** row, not the campaign aggregate. In the
  Sessions tab the drawer's campaign header recomputes "Campaign · $8.65 · 5
  turns · 83 tools" from the loaded member list while the metric grid below
  shows the campaign display row ($14.36 / 9 turns / 160 tools, which includes
  rolled-up automated reviews). Two aggregations of "this campaign" in one
  drawer.
- **U42** — "Longest session 53.2h" is a Codex campaign root's task-open time
  (root session only, by the locked plan 052 rule). The card never says so.

The settled rule is one canonical aggregation per concept, reused by every
surface, and explicit naming where two legitimately different concepts meet
(root vs campaign; stored rows vs reportable sessions). Provenance stays per
metric; nothing partial is hidden.

## Current state

### U02 — breakdown groups drop partial lower bounds that the Overview keeps

- `packages/report-core/src/analytics.ts:44-60` — `AnalyticsRowInput` has an
  optional `costLowerBound?: number` ("Known subtotal retained when the
  complete price is unavailable"). `groupAnalytics` (lines 185–249) uses it
  only for unpriced rows:
  ```ts
      if (input.pricedCost == null) {
        group.unpriced++;
        group.costSum += input.costLowerBound ?? 0;
      } else {
  ```
- `packages/report-core/src/focused-report-query.ts:946-966` — two projections
  onto that input. The breakdown one has **no** `costLowerBound`; the executive
  one adds it:
  ```ts
  const analyticsInput = (row: SessionPresentationRow): AnalyticsRowInput => ({
    ambiguous: row.ambiguous ?? false,
    cache: row.tokCr,
    ...
    pricedCost: row.costKnown ? row.costApprox : null,
    ...
  });

  const executiveAnalyticsInput = (row: SessionPresentationRow): AnalyticsRowInput => ({
    ...analyticsInput(row),
    costLowerBound: usageRowApiPriceMeasurement(row).knownCost,
  });
  ```
- `focused-report-query.ts:1022-1032` — the Overview's harness groups use the
  executive input and a lower-bound-inclusive denominator:
  ```ts
  const buildFocusedExecutiveOverview = (rows: readonly SessionPresentationRow[]): FocusedExecutiveOverview => {
    const knownCost = rows.reduce((total, row) => total + usageRowApiPriceMeasurement(row).knownCost, 0);
    return {
      harnesses: buildFocusedExecutiveGroups(
        groupAnalytics(rows, executiveAnalyticsInput, (row) => row.harness, knownCost).map(
  ```
- `focused-report-query.ts:1511-1539` — the breakdown uses the plain input and
  a fully-priced-only denominator:
  ```ts
    const totalCost = visible.reduce((sum, row) => sum + (row.costKnown ? row.costApprox : 0), 0);
    ...
        harnesses: groupAnalytics(visible, analyticsInput, (row) => row.harness, totalCost),
        harnessProviders: groupAnalytics(visible, harnessProviderAnalyticsInput, harnessProviderKey, totalCost),
        models: groupModelAnalytics(visible),
        projects: projectGroups(visible),
        providers: groupAnalytics(visible, analyticsInput, (row) => row.providerDisplay, totalCost),
  ```
  `harnessProviderAnalyticsInput` (line 1035) spreads `analyticsInput`, so the
  provider children inherit the same gap. `groupModelAnalytics`
  (`analytics.ts:295-319`) already passes `costLowerBound: segment.costApprox`,
  which is why the Models tab agrees with the Overview and the harness tab does
  not.
- `focused-report-query.ts:1042-1070` — `projectGroups` has the same gap for
  the Projects tab (`if (row.costKnown) { group.cost += row.costApprox; group.priced++; }`
  at lines 1063–1066), and `apps/web/src/lib/features/report/breakdown/project-summary.svelte:68`
  presents it as `≥ $cost` when `priced < sessions` — a lower bound that omits
  the known subtotals.
- The SQLite mirror has the identical asymmetry, written out explicitly.
  `packages/usage-store/src/focused-report-query-sqlite.ts`:
  - line 349 (`readExecutiveOverview`, Overview groups): `SUM(cost_approx) AS cost,`
  - lines 1145–1146 (`readAnalyticsGroups`, breakdown groups):
    ```sql
        SUM(CASE WHEN cost_known = 1 OR kind = 'model' THEN cost_approx ELSE 0 END) AS cost_sum,
        SUM(CASE WHEN cost_known = 1 THEN cost_approx ELSE 0 END) AS priced_cost_sum,
    ```
    and line 1183: `SUM(grouped.cost_sum) OVER (PARTITION BY grouped.kind) AS total_cost`
  - line 1223 (`readProjectGroups`): `SUM(CASE WHEN cost_known = 1 THEN cost_approx ELSE 0 END) AS cost,`
  `priced_cost_sum` must stay fully-priced: it feeds `costPerSession`,
  `medianCost`, `costPer100Lines` (means never mix lower bounds —
  `docs/session-analysis-sources.md:34-35`).
- The share denominators differ the same way: Overview
  `groupPresentation(group, summary.totalCost)`
  (`apps/web/src/lib/features/report/overview/executive-overview-model.ts:199-210`,
  `:286`) divides by `summary.totalCost = summary.priceMeasurement.knownCost`
  (`focused-report-query.ts:597-598`, lower-bound inclusive); the breakdown
  divides `costSum / totalCost` with the fully-priced-only `totalCost` above.
  That is the 24 % vs 23 %.
- `apps/web/src/lib/features/report/breakdown/breakdown-row.svelte:62-63`
  already documents the intended semantics:
  `'Share of the known API-value subtotal in this breakdown; ≥ values include lower bounds from incomplete pricing'`.
  No presentation change is needed there; the data must start matching the hint.
- Existing parity tests that will carry the change:
  `packages/report-core/src/focused-report-query.test.ts:293-363`
  ("preserves partial lower bounds and segment-accurate processed tokens",
  executive only) and
  `packages/usage-store/src/focused-report-query-sqlite.test.ts:930-1025`
  ("keeps partial API-value lower bounds dimension-invariant in SQLite
  timelines") which builds `partialRow` (`costKnown: false`, one priced segment
  `costApprox: 2`) and asserts `breakdown.groups.models[0].costSum === 2` but
  says nothing about `groups.harnesses[0]` (today `0`).
- `docs/session-analysis-sources.md:34-38` is partially stale:
  "Overall report summaries intentionally total only fully priced sessions …"
  while `buildFocusedReportSummary` (`focused-report-query.ts:571-602`) totals
  `combineApiPriceMeasurements(...).knownCost`, i.e. lower-bound inclusive (the
  hero reads `≥ $…`). Means (`meanCost`, `costPerSession`) are fully-priced.

### U03 — `/sync` counts stored rows, the report counts reportable sessions

- `packages/usage-store/src/index.ts:2580-2690` (`queryUsageMachineFleetWithDatabase`),
  SQL at lines 2606–2675:
  ```sql
  /* queryUsageMachineFleet */
  WITH ranked_rows AS (
    SELECT active_date, last_seen_at, machine_label, origin_machine_id, row_key, source_authority, status, ...
    FROM usage_rows
    WHERE fleet_metadata_valid = 1
  ),
  machine_rows AS (
    SELECT ...
      SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS session_count
    FROM ranked_rows
    GROUP BY origin_machine_id
  ),
  ```
  Every active stored row counts, regardless of tokens. The test
  `packages/usage-store/src/index.test.ts:1511-1540` ("uses only normalized
  columns for the bounded machine fleet read") asserts the fleet SQL never
  touches `row_json` or any `json_` function
  (`ROW_JSON_QUERY_PATTERN = /row_json|json_/i`, line 59) — a `json_extract`
  of `usageUnavailable` is therefore not an option without a schema change.
- The report excludes zero-token rows at publication:
  `packages/usage-engine-runtime/src/live.ts:1157-1163` passes
  `options: { limit: null, minTokens: 1, project: null, since: null, sort: 'date' }`
  and `packages/report-core/src/report-data.ts:333-346` applies it:
  ```ts
  export const filterUsageRows = (rows: UsageRow[], options: ReportOptions) =>
    rows.filter((row) => {
      const activeAt = usageRowActiveDate(row);
      if (usageRowTokenTotal(row) < options.minTokens && !row.usageUnavailable) {
        return false;
      }
  ```
  The report total on screen is
  `apps/web/src/lib/features/report/composition/live-report-destination.svelte:332`
  `const totalSessions = $derived(bootstrap.support.analytics.sessionCount);`
  rendered by `apps/web/src/lib/features/report/breakdown/active-filters.svelte:60-61`
  as `{fmtNum(visible)} / {fmtNum(total)} sessions`. `analytics.sessionCount`
  is `calculateAnalytics(report.rows).sessionCount` after that filter. The
  fleet is also read from the **live** store (`queryUsageSyncFleet`, lines
  2778–2810) while the report reads the last **published** revision, so even
  an identical rule can differ transiently by the unpublished rows.
- Neither side dedupes sessions across machines: the stored row key is
  `['v1', source.machineId, source.harnessKey, sourceId].join(':')`
  (`packages/report-core/src/merge-bundle.ts:135`), so the "dedupe across
  machines" hypothesis in the audit is not a report-vs-fleet divergence.
- Labels today:
  `apps/web/src/lib/features/sync/machine-fleet.svelte:95`
  `<span class={machineFactLabel}>Sessions</span><span>{machine.sessionCount.toLocaleString()}</span>`;
  `apps/web/src/lib/features/sync/machine-comparison.svelte:38`
  `<div class={panelSub}>Session share across the loaded fleet.</div>`, `:46`
  `<th class={numCell} scope="col">Sessions</th>`, `:80` `<dt>Sessions</dt>`.
  SSR test: `apps/web/src/lib/features/sync/sync-render.test.ts:26-41` renders a
  fleet fixture with `sessionCount: 7` and asserts `body` contains `'7'`.

### U06 — Overview hands the drawer the campaign root; the Sessions drawer aggregates twice

- `packages/report-core/src/focused-report-query.ts:1156-1189` builds the
  Overview items. Campaign items carry the **root** row:
  ```ts
      ...campaigns.map(
        (campaign): FocusedOverviewSessionItem => ({
          costApprox: campaign.visibleTotals.totalCost,
          costKnown: campaign.visibleTotals.costKnown,
          durationMs: campaign.visibleTotals.durationMs,
          harness: campaign.root.harness,
          kind: 'campaign',
          label: campaign.root.sessionLabel,
          row: campaign.root,
          sessionCount: campaign.visibleCount,
        }),
      ),
  ```
  The same file already imports `buildSessionCampaignViews` from
  `./session-query`; `sessionCampaignDisplayRow` (`session-query.ts:1323-1378`)
  is the served aggregate row builder — `projectSessionPage`
  (`session-query.ts:1524`) calls it as
  `sessionCampaignDisplayRow(item.campaign, request.sort, false)` and that form
  is parity-tested against the SQLite `campaignDisplayRow`
  (`packages/usage-store/src/session-query-sqlite.ts:520-597`).
- SQLite Overview mirror:
  `packages/usage-store/src/focused-report-query-sqlite.ts:722-856`
  (`readOverviewSessionSelections`) selects `MIN(root.ordinal) AS root_ordinal`
  (line 756) for campaign items and `overviewSessionItemFromRecord` (lines
  705–719) parses that root JSON into `row`. `OverviewSessionSelectionRecord`
  (lines 165–173) has no `campaign_key`. `runOverview` (lines 896–945) calls it
  with `visibleFilter` only (line 913). `sessionRequest(query)` (lines 74–84)
  already builds a `pageSize: 1` `SessionQueryRequest` from the focused scope,
  and `executeMaterializedSessionQuery(database, 'sessions', request, trace)`
  (`session-query-sqlite.ts:996-1045`) returns `items[0].row` as the campaign
  display row when `filters.fields.campaign` is set
  (`buildSessionQuerySqlFilter`, `session-query-sqlite.ts:245-246`).
- Web selection from the Overview:
  `apps/web/src/lib/features/report/composition/live-report-destination.svelte:410-423`
  ```ts
    const selectOverviewSession = (item: FocusedOverviewSessionItem): void => {
      ...
      const presented = presentSessionItem(item);
      detailRows = commit?.overview.view.topSessions.map((candidate) => presentSessionItem(candidate).row) ?? [
        presented.row,
      ];
      selection = {
        ...(commit?.overview.revision === undefined ? {} : { revision: commit.overview.revision }),
        row: presented.row,
      };
  ```
  (no `target`), and
  `apps/web/src/lib/features/report/composition/synthetic-report-destination.svelte:365-377`
  (`selection = { row: presentedRow };`). The drawer slot defaults the target to
  a plain session:
  `apps/web/src/lib/features/sessions/detail/session-detail-query-slot.svelte:74-76`
  `selection?.target ?? (selection ? sessionAnalysisTargetForSession(selection.row) : undefined)`.
  The Sessions tab does it right:
  `apps/web/src/lib/features/report/composition/sessions-destination.svelte:89-115`
  passes `sessionAnalysisTargetForPageItem({ ...pageItem, row })` and
  `apps/web/src/session-analysis-target.ts:38-51` reads
  `campaignTotalCount` / `campaignVisibleCount` off the row.
- Drawer header vs grid:
  `apps/web/src/lib/features/report/actions/campaign-session-controls.svelte:56-62`
  ```ts
    const visibleTotals = $derived({
      costApprox: visibleRows.reduce((sum, row) => sum + row.costApprox, 0),
      costKnown: visibleRows.every((row) => row.costKnown),
      freshTokens: visibleRows.reduce((sum, row) => sum + row.freshTokens, 0),
      tools: visibleRows.reduce((sum, row) => sum + row.tools, 0),
      turns: visibleRows.reduce((sum, row) => sum + row.turns, 0),
    });
  ```
  and lines 82–89 / 93–96 render `campaignTotals` from it under the
  `<div class={drawerTitle}>Campaign</div>`. `visibleRows` comes from
  `campaignSessionControlsState` (`campaign-session-controls-model.ts:55-78`):
  root-if-visible + the loaded, filtered `campaignChildren` page — which
  excludes rolled-up automated reviews and any not-yet-loaded page. The metric
  grid (`session-drawer.svelte:388-437`) renders `row.*` where `row` is the
  campaign display row whose totals are `campaign.visibleTotals` =
  matched rows **plus all classifier children**
  (`session-query.ts:1187-1202`, `visibleRowsForTotals`). The `campaign` prop
  of the controls is that same display row
  (`sessions-destination-state.svelte:42-44`, `:57`).
  `session-drawer.svelte:356-359` is the title block:
  ```svelte
        <div>
          <div class={drawerTitle}>{row.sessionLabel}</div>
          <div class={muted}>{row.providerDisplay} · {row.modelLabel}</div>
        </div>
  ```
  Nothing in the drawer says "campaign" except the Sessions-tab slot.
  Labels already exist in report-core:
  `session-query.ts:1391` `campaignBadgeLabelForSessionRow(row)` →
  `Campaign · N sessions`, `:1398` `classifierRollupLabelForSessionRow(row)` →
  `+ N automated reviews`.
- The deterministic e2e fixture (`apps/web/src/report-data.ts:7-123`) has one
  campaign, "Build report UI": root ($3.20, 203,500 tokens, 22 turns, 64 tools,
  18 calls), child "Review analytics model" ($0.17, 76,600, 11, 18, 9) and
  classifier "Tune collector fixtures" ($0.84, 120,800, 16, 27, 12) — campaign
  total $4.21 / 400,900 tokens. Pinned today:
  `apps/web/e2e/dashboard.spec.ts:12`
  `OPEN_BUILD_REPORT_UI_ACCESSIBLE_NAME_PATTERN = /^Open details for Build report UI\..*Campaign.*\$4\.21/`
  (row label, stays), `apps/web/e2e/drawer-value-presentation.spec.ts:11-12`
  `await expect(totalTokens).toContainText('204k'); await expect(totalTokens).not.toContainText('203,500');`
  (root-only value, **changes on purpose**), and `:23-27` the Codex help button
  `name: 'About Task-open time'` (becomes the campaign-root label
  `Root task-open time`, see `apps/web/src/session-analysis-model.ts:114-137`).
  `apps/web/e2e/visual-regression.spec.ts:264-330` screenshots
  `overview-session-drawer.png` after opening the first Top session.
  `apps/web/e2e/origin-campaign.spec.ts:17-24` opens the same campaign from the
  Sessions table and asserts `[data-detail-item="Subagent"]` is `No`.
- The campaign-controls SSR test
  `apps/web/src/lib/features/report/actions/campaign-session-controls.ssr.test.ts:60-96`
  renders a campaign row with `costApprox: 99` and asserts
  `expect(html).not.toContain('$99.00 API');` — that assertion guards the member
  list ("never prepends the aggregate"), it is not a statement that the header
  must ignore the campaign row.

### U42 — "Longest session" is a root-session duration by a locked rule

- `packages/report-core/src/focused-report-query.ts:1419-1422`:
  ```ts
    const longest = sessionItems.reduce<FocusedOverviewSessionItem | null>(
      (best, item) =>
        (item.durationMs ?? 0) > 0 && (best === null || (item.durationMs ?? 0) > (best.durationMs ?? 0)) ? item : best,
  ```
  and `session-query.ts:1135` `durationMs: campaignRoot?.durationMs ?? null,`
  — campaign duration is the **root session's** recorded duration. Plan 052
  (DONE, `plans/052-align-overview-records-with-campaigns.md`, contract item 4)
  locked this: "Campaign duration remains `campaign.visibleTotals.durationMs`,
  whose current definition is root-session duration. Do not calculate
  wall-clock campaign span." Do **not** reopen it; the fix is naming.
- `apps/web/src/lib/features/report/overview/records.svelte:86-95`:
  ```svelte
      {#if presentedRecords.longest}
        <button class={recordCard} onclick={() => onSelectSession(presentedRecords.longest!)} type="button">
          <span class={srOnly}>Open details for longest session {presentedRecords.longest.label}. </span>
          <span class={cx(recordLabel, recordActionLabel)}
            >Longest session <span aria-hidden="true" class={disclosureIcon}>↗</span></span
          >
          <span class={recordValue}>{fmtDuration(presentedRecords.longest.durationMs)}</span>
          <span class={recordSub}>{presentedRecords.longest.label}</span>
        </button>
      {/if}
  ```
- `apps/web/src/session-analysis-model.ts:124-137` already names the semantic
  per harness and root-only mode:
  `sessionDurationSemantics(harnessKey, rootSessionOnly)` →
  `metricLabel` `'Task-open time'` (codex) / `'Assistant time'` (opencode) /
  `'Recorded turn time'` (claude) / `'Interval time'` (generic), and
  `'Root task-open time'` / `'Root assistant time'` / `'Root interval time'`
  when `rootSessionOnly`; `metricHint` explains ("Campaign time uses the root
  session only. …"). The drawer imports it from
  `'../../../../session-analysis-model'` (`session-drawer.svelte:44`); the same
  relative path works from `records.svelte`.
- SSR test harness: `apps/web/src/lib/features/report/overview/overview-components.test.ts:64-123`
  renders the Overview fixture and asserts markers (pattern to follow).

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `bun run typecheck` | exit 0 |
| Format | `bun x ultracite fix` | exit 0 |
| Lint | `bun run lint` | exit 0 |
| report-core focused tests | `bun test packages/report-core/src/focused-report-query.test.ts` | all pass |
| usage-store SQLite parity | `bun test packages/usage-store/src/focused-report-query-sqlite.test.ts` | all pass |
| usage-store fleet tests | `bun test packages/usage-store/src/index.test.ts` | all pass |
| web SSR prerequisites | `cd apps/web && bun run dev:prepare` | `.svelte-kit` exists (needed once before Vite SSR tests) |
| web unit/SSR tests | `cd apps/web && bun test src/session-analysis-target.test.ts src/lib/features/report/actions/campaign-session-controls.ssr.test.ts src/lib/features/report/overview/overview-components.test.ts src/lib/features/sync/sync-render.test.ts` | all pass |
| e2e (touched specs) | `cd apps/web && bun run test:e2e -- e2e/dashboard.spec.ts e2e/drawer-value-presentation.spec.ts e2e/origin-campaign.spec.ts e2e/value-presentation.spec.ts e2e/visual-regression.spec.ts` | all pass |
| Full e2e | `bun run test:e2e` | all pass |

On NixOS, if Playwright's downloaded chromium fails to launch, set
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to the system Chrome binary
(`--channel chrome` does not work here).

## Scope

**In scope** (the only files you should modify):
- `packages/report-core/src/focused-report-query.ts`
- `packages/report-core/src/focused-report-query.test.ts`
- `packages/usage-store/src/focused-report-query-sqlite.ts`
- `packages/usage-store/src/focused-report-query-sqlite.test.ts`
- `apps/web/src/session-analysis-target.ts`, `apps/web/src/session-analysis-target.test.ts`
- `apps/web/src/lib/features/report/composition/live-report-destination.svelte`
- `apps/web/src/lib/features/report/composition/synthetic-report-destination.svelte`
- `apps/web/src/lib/features/sessions/detail/session-drawer.svelte` (one qualifier line + one data attribute only)
- `apps/web/src/lib/features/report/actions/campaign-session-controls.svelte`
- `apps/web/src/lib/features/report/actions/campaign-session-controls.ssr.test.ts`
- `apps/web/src/lib/features/report/overview/records.svelte`
- `apps/web/src/lib/features/report/overview/overview-components.test.ts`
- `apps/web/src/lib/features/sync/machine-fleet.svelte`, `machine-comparison.svelte`, `sync-render.test.ts`
- `apps/web/e2e/dashboard.spec.ts`, `apps/web/e2e/drawer-value-presentation.spec.ts`, `apps/web/e2e/origin-campaign.spec.ts`
- `apps/web/e2e/visual-regression.spec.ts-snapshots/` (regenerated PNGs only)
- `docs/session-analysis-sources.md` (one paragraph)

**Out of scope** (do NOT touch):
- `packages/report-core/src/analytics.ts` — `groupAnalytics` already supports
  `costLowerBound`; `calculateAnalytics`/`rowToAnalyticsInput` feed the CLI
  (`apps/cli/src/render/analytics.ts`) whose summary and groups are both
  fully-priced-only and therefore agree with each other. Changing the CLI is a
  separate decision (note in Maintenance).
- `packages/usage-store/src/index.ts` — no fleet SQL or schema change here.
  Making the fleet count report-eligible rows needs a normalized
  `usage_unavailable` column (the fleet read may not parse `row_json`, see
  U03 above); that is the deferred follow-up named in Maintenance notes.
- `/sync` layout/duplication and Sources jargon (plan 097), which must keep the
  "Stored sessions" label and caption introduced here.
- Drawer header badge/"matching sessions"/"i" buttons (plan 098, U29); the
  heatmap "1 sessions" pluralisation (plan 098, U09 — the same plural bug is
  visible at `records.svelte:140`, leave it to 098); campaign badge "Campaign ·
  1 session" suppression (plan 091, U13) and child titles (plan 076).
- `apps/web/src/session-analysis-model.ts`, `session-analysis.svelte` — keep
  `sessionDurationSemantics(..., target.kind === 'campaign-root')` as is;
  `apps/web/e2e/production-report.spec.ts:749` pins `Root interval time`.
- `campaign-session-controls-model.ts` (hidden/loaded counts are correct).

## Git workflow

- Work on the program branch `plan/086-ui-ux-audit-remediation` in this
  worktree; base `51815b70`.
- One commit for this plan, staged by explicit path (never `git add -A` —
  peer sessions write to this repository). Suggested message:
  `fix(report): one canonical aggregation per concept (U02, U03, U06, U42)`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1 (U02): make breakdown groups and project groups lower-bound inclusive (pure)

In `packages/report-core/src/focused-report-query.ts`:

1. Move `costLowerBound: usageRowApiPriceMeasurement(row).knownCost,` into
   `analyticsInput` (lines 946–961) and delete `executiveAnalyticsInput`
   (lines 963–966); change line 1026 to pass `analyticsInput`.
2. In `projectFocusedBreakdown` replace line 1520 with
   `const totalCost = visible.reduce((sum, row) => sum + usageRowApiPriceMeasurement(row).knownCost, 0);`
   (same expression as `buildFocusedExecutiveOverview` line 1023 — the share
   denominator is now the same number on both tabs).
3. In `projectGroups` (lines 1063–1066) accumulate
   `group.cost += usageRowApiPriceMeasurement(row).knownCost;` for every row and
   keep `group.priced++` inside `if (row.costKnown)`.

Add a comment above `analyticsInput`: "Known subtotal of every visible session
— fully priced or not. Overview groups, breakdown groups, project groups and
`buildFocusedReportSummary` must all sum this; only means use fully priced
rows."

**Verify**:
`grep -n "executiveAnalyticsInput" packages/report-core/src/focused-report-query.ts` → no matches;
`bun test packages/report-core/src/focused-report-query.test.ts` → the existing
cases pass (none pins the old breakdown behaviour; if one does, it is a STOP).

### Step 2 (U02): mirror it in SQLite

In `packages/usage-store/src/focused-report-query-sqlite.ts`:

1. Line 1145: `SUM(cost_approx) AS cost_sum,` (drop the
   `cost_known = 1 OR kind = 'model'` case). Leave line 1146
   (`priced_cost_sum`) exactly as is.
2. Line 1223: `SUM(cost_approx) AS cost,` in `readProjectGroups`.

`cost_approx` is the row's known subtotal for partially priced rows
(`docs/session-analysis-sources.md:27-32`), which is what the executive query
already sums on line 349.

**Verify**: `grep -n "OR kind = 'model'" packages/usage-store/src/focused-report-query-sqlite.ts` → no matches.

### Step 3 (U02): pin the invariant in tests

1. `packages/report-core/src/focused-report-query.test.ts` — extend
   "preserves partial lower bounds and segment-accurate processed tokens"
   (line 293): run `projectFocusedBreakdown([partialSegmentedRow], support, { query: request.query })`
   and assert `groups.harnesses[0]` has `costSum: 2`, `unpriced: 1`,
   `costPercent: 100`, and that `groups.harnesses[0].costSum` equals
   `result.view.executive.harnesses[0].total`; assert
   `groups.harnessProviders[0].costSum === 2`, `groups.providers[0].costSum === 2`,
   and `groups.projects[0].cost === 2` with `priced: 0`.
2. `packages/usage-store/src/focused-report-query-sqlite.test.ts` — in
   "keeps partial API-value lower bounds dimension-invariant in SQLite
   timelines" (line 930) add, next to the existing `groups.models[0]`
   assertion, `expect('groups' in breakdown ? breakdown.groups.harnesses[0] : null).toMatchObject({ costSum: 2, key: 'Codex', priced: 0, unpriced: 1 })`
   and the same `costSum: 2` for `groups.harnessProviders[0]` and
   `groups.projects[0].cost`. The existing
   `expect(breakdown).toEqual(projectFocusedBreakdown([partialRow], support, breakdownRequest))`
   on line 1006 is the pure/SQLite parity proof — it must keep passing.

**Verify**: both test files pass; additionally
`bun test packages/report-core/src/csv.test.ts packages/report-core/src/analytics.test.ts` → pass (untouched callers).

### Step 4 (U02): update the documented rule

`docs/session-analysis-sources.md:34-38` — replace the paragraph starting
"Overall report summaries intentionally total only fully priced sessions" with:
"Report summaries, Overview harness/model groups, breakdown groups and project
groups all total the known API-value subtotal of every visible session — a
partially priced session contributes its priced segments — and expose
priced-session coverage beside it. Means and medians (`meanCost`,
`costPerSession`, `medianCost`, `costPer100Lines`) use fully priced sessions
only. Breakdown percentages are shares of that known subtotal, not shares of an
unknown final bill."

**Verify**: `grep -n "intentionally total only fully priced" docs/session-analysis-sources.md` → no matches.

### Step 5 (U03): name the `/sync` number for what it is

1. `apps/web/src/lib/features/sync/machine-fleet.svelte:95` — label
   `Stored sessions` (was `Sessions`).
2. `apps/web/src/lib/features/sync/machine-comparison.svelte` — line 46 and
   line 80: `Stored sessions`; line 38 `panelSub` text:
   `Share of stored sessions across the loaded fleet. The store keeps every active row per machine, including zero-token sessions that the report leaves out, so the report's session total can be lower.`
3. `apps/web/src/lib/features/sync/sync-render.test.ts` — in the first case
   (line 88–101) add `expect(body).toContain('Stored sessions');` and
   `expect(body).toContain('zero-token sessions that the report leaves out');`
   and `expect(body).not.toMatch(/<th[^>]*>Sessions<\/th>/);`.

This is the "label what is counted" option from the audit. The numbers are
two different concepts (rows a transfer would carry vs reportable sessions in
the published revision) and must not share one word. Making them the *same*
number needs a normalized `usage_unavailable` column in `usage_rows` (the
fleet read may not parse `row_json`); see Maintenance notes.

**Verify**: `cd apps/web && bun test src/lib/features/sync/sync-render.test.ts` → pass;
`grep -rn ">Sessions<" apps/web/src/lib/features/sync/` → no matches.

Optional read-only check against a real store (no writes; skip if the file is
absent): Overview → "Group by Machine", metric "Sessions", All time — the
per-machine legend totals are the report's numbers; `/sync` now says "Stored
sessions" for the store's numbers.

### Step 6 (U06): Overview items carry the campaign display row (pure)

`packages/report-core/src/focused-report-query.ts:1170` — replace
`row: campaign.root,` with
`row: sessionCampaignDisplayRow(campaign, OVERVIEW_ITEM_SORT, false),` where
`const OVERVIEW_ITEM_SORT = [{ desc: true, id: 'date' }] as const;` is declared
next to `overviewSessionItems` (sorting only orders children, and children are
excluded — this is the same form `projectSessionPage` serves on line 1524 of
`session-query.ts`). Import `sessionCampaignDisplayRow` from `./session-query`
in the existing import block (lines 28–35). `label`, `harness`, `costApprox`,
`durationMs`, `sessionCount` stay as they are (they already equal the display
row's values); `rowId` is unchanged because the display row spreads the root.

Extend `focused-report-query.test.ts` "uses campaign aggregates for session
records while preserving day records" (line 837): assert
`result.view.topSessions[0].row` and `result.view.records?.longest?.row` have
`campaignKey` defined, `campaignVisibleCount: 2`, `campaignTotalCount: 2`,
`costApprox: 12`, `rowId` equal to the root's `rowId`, and that
`result.view.topSessions[0].row.costApprox === result.view.topSessions[0].costApprox`
(the row can no longer disagree with its own list entry). Also assert
`parseFocusedReportQueryResult('overview', JSON.parse(JSON.stringify(result)), overviewRequest)`
round-trips (campaign rows pass `parseSessionPresentationRow`,
`session-query.ts:659-698`).

**Verify**: `bun test packages/report-core/src/focused-report-query.test.ts` → pass.

### Step 7 (U06): SQLite Overview returns the same display row

In `packages/usage-store/src/focused-report-query-sqlite.ts`:

1. `OverviewSessionSelectionRecord` (line 165): add `campaign_key: string | null;`.
2. In the `items` CTE (lines 753–781) select `rollup.campaign_key AS campaign_key`
   for the campaign branch and `NULL AS campaign_key` for the session branch;
   carry `campaign_key` through both `SELECT … FROM top_sessions` /
   `FROM longest_item` projections (lines 797–822).
3. Change the signature to
   `readOverviewSessionSelections(database, query: FocusedReportQueryScope, filter, trace)`
   and, in `itemFromRecord` (line 839), when `record.campaign_key !== null`
   obtain the row with
   ```ts
   const page = executeMaterializedSessionQuery(
     database,
     'sessions',
     {
       ...sessionRequest(query),
       filters: { ...query.filters, fields: { ...query.filters.fields, campaign: record.campaign_key } },
     },
     trace,
   );
   const row = page.items[0]?.row;
   if (!row) throw new Error('Focused report query database omitted an Overview campaign display row');
   ```
   and build the item from that row (label = `row.sessionLabel`, harness =
   `row.harness`, the other fields from the record as today). Keep the root
   JSON path for `campaign_key === null` records. Memoize by `campaign_key`
   inside the call (the longest item is often also a top session). Import
   `executeMaterializedSessionQuery` from `./session-query-sqlite` (that module
   does not import this one; no cycle). Update the call at line 913 to pass
   `request.query`.

This reuses the served campaign aggregation instead of re-deriving it in a
second SQL shape — that is the point of the plan. At most six extra
campaign-scoped page queries per Overview refresh; `campaign_key` is indexed
(`packages/usage-store/src/served-revision.ts:221`).

**Verify**: `bun test packages/usage-store/src/focused-report-query-sqlite.test.ts` →
all parity cases pass unchanged (`expect(overview).toEqual(projectFocusedOverview(...))`
at lines 202, 291, 394, 424, 550, 641, 804, 1004–1005 now compare display
rows). If one fails, read the diff field-by-field — see STOP conditions.
In "matches pure Overview and Breakdown projections with bounded query
counts" (line 195) the `basicOverviewTrace` structural assertions (lines
233–240: no `source_row_json`, no unbounded `SELECT row_json … ORDER BY`, no
`SELECT * FROM session_rows`) must still hold for the added page queries; add
`expect(basicOverviewTrace.filter((sql) => sql.includes('FROM campaign_rollup AS visible')).length).toBeLessThanOrEqual(6);`
there to keep the per-refresh bound explicit (`FROM campaign_rollup AS visible`
is the session-page SQL, `session-query-sqlite.ts:500`; the Overview selection
SQL says `FROM campaign_rollup AS rollup`).

### Step 8 (U06): the web opens a campaign target from the Overview

1. `apps/web/src/session-analysis-target.ts` — add and export
   ```ts
   export const sessionAnalysisTargetForOverviewRow = (row: DashboardRow): SessionAnalysisTarget =>
     row.campaignKey !== undefined && row.campaignTotalCount !== undefined && row.campaignVisibleCount !== undefined
       ? sessionAnalysisTargetForPageItem({ campaignKey: row.campaignKey, kind: 'campaign', row })
       : sessionAnalysisTargetForSession(row);
   ```
   and two cases in `apps/web/src/session-analysis-target.test.ts` (campaign
   display row → `kind: 'campaign-root'` with both counts; plain row →
   `kind: 'session'`).
2. `live-report-destination.svelte:418-421` — add `target: sessionAnalysisTargetForOverviewRow(presented.row),`
   to the selection object; import it next to the existing
   `sessionAnalysisTargetForSession` import (line 30).
3. `synthetic-report-destination.svelte:375` —
   `selection = { row: presentedRow, target: sessionAnalysisTargetForOverviewRow(presentedRow) };`
   (import from `'../../../../session-analysis-target'`).

**Verify**: `bun run typecheck` → exit 0;
`cd apps/web && bun test src/session-analysis-target.test.ts` → pass.

### Step 9 (U06): the drawer names root vs campaign, once

In `apps/web/src/lib/features/sessions/detail/session-drawer.svelte`:

1. Import `campaignBadgeLabelForSessionRow` and `classifierRollupLabelForSessionRow`
   from `'@ai-usage/report-core/session-query'` (the type import on line 40
   already targets that module).
2. Derive
   ```ts
   const campaignScope = $derived(
     target?.kind === 'campaign-root' && (row?.campaignTotalCount ?? 1) > 1 && row
       ? [campaignBadgeLabelForSessionRow(row), classifierRollupLabelForSessionRow(row)].filter(Boolean).join(' · ')
       : null,
   );
   ```
3. In the title block (lines 356–359) add the attribute
   `data-session-drawer-scope={campaignScope ? 'campaign' : 'session'}` on the
   wrapping `<div>` and, when `campaignScope` is set, render after the
   provider/model line:
   `<div class={muted} data-session-drawer-campaign-scope title="Values below are campaign totals across the listed sessions. Analyze root opens the root session's chronology.">{campaignScope}</div>`
   Reuse the imported `muted` class; add no new `css()` block. A campaign of
   one (plan 045 rule: every top-level row is a campaign) renders nothing extra.

In `apps/web/src/lib/features/report/actions/campaign-session-controls.svelte`:

4. Delete `visibleTotals` (lines 56–62) and derive `campaignTotals` from the
   `campaign` prop (the display row):
   `apiValuePresentation(campaign).label`, `campaign.freshTokens`,
   `campaign.turns`, `campaign.tools`. Put `data-campaign-totals` on the
   `<div style="margin-top: 6px">` that renders it (line 95).
5. In the counts line (lines 96–109) append
   `{#if classifierRollupLabelForSessionRow(campaign)} · {classifierRollupLabelForSessionRow(campaign)}{/if}`
   (import from `'@ai-usage/report-core/session-query'`) so "4 / 4 sessions
   shown · + 2 automated reviews" explains why the totals exceed the four
   listed sessions. `visibleRows` stays a prop (the model still needs it for
   hidden flags).

**Verify** (SSR, deterministic): in
`campaign-session-controls.ssr.test.ts` first case (line 68) replace
`expect(html).not.toContain('$99.00 API');` with
`expect(html.split('$99.00 API').length - 1).toBe(1);` and
`expect(html.indexOf('data-campaign-totals')).toBeLessThan(html.indexOf('$99.00 API'));` and
`expect(html.indexOf('$99.00 API')).toBeLessThan(html.indexOf('data-campaign-session-list'));`
(header shows the campaign row's value exactly once, the member list never
does); keep `expect(html).toContain('$0.10 API');`. Add a case whose campaign
has `campaignClassifierCount: 2` and assert `'+ 2 automated reviews'` appears
inside the counts line. `cd apps/web && bun test src/lib/features/report/actions/campaign-session-controls.ssr.test.ts` → pass.
(The drawer itself is a client-only portal —
`apps/web/src/lib/features/sessions/detail/components.ssr.test.ts:304-330`
proves SSR renders none of its body — so its assertions live in e2e, Step 10.)

### Step 10 (U06): e2e assertions that fail today and pass now

1. `apps/web/e2e/dashboard.spec.ts` "opens a session from Overview without
   leaving the current analysis" (line 502): after `toBeVisible()` on the
   dialog add
   ```ts
   const drawer = page.getByRole('dialog', { name: 'Session details' });
   await expect(drawer.locator('[data-session-drawer-campaign-scope]')).toContainText('Campaign · 3 sessions');
   await expect(drawer.locator('[data-detail-item="API value"]')).toContainText('$4.21');
   ```
   (the trigger's accessible name already pins `$4.21`; the drawer must say the
   same number).
2. `apps/web/e2e/drawer-value-presentation.spec.ts:11-12` — the Overview drawer
   now shows campaign totals: change `'204k'` to the campaign total computed
   from the fixture (`203_500 + 76_600 + 120_800 = 400_900` → `fmtCompact` →
   `'401k'`; recompute if the fixture differs) and `not.toContainText('203,500')`
   to `not.toContainText('400,900')`. Line 24: `'About Task-open time'` →
   `'About Root task-open time'` (the explanation text on lines 28–30 still
   matches — `metricHint` is prefixed, assert with `toContainText`). Then add
   `await expect(drawer.locator('[data-session-drawer-scope="campaign"]')).toHaveCount(1);`
   right after the dialog is visible.
3. `apps/web/e2e/origin-campaign.spec.ts:22-24` (Sessions-tab campaign drawer):
   add
   ```ts
   const campaignTotals = drawer.locator('[data-campaign-totals]');
   await expect(campaignTotals).toContainText('$4.21 API');
   await expect(drawer.locator('[data-detail-item="API value"]')).toContainText('$4.21');
   await expect(drawer.locator('[data-session-drawer-campaign-scope]')).toContainText('Campaign · 3 sessions');
   ```
   Note `page.getByText('Campaign · 3 sessions', { exact: true })` on line 17 is
   asserted before the drawer opens; keep that order.
4. Run `cd apps/web && bun run test:e2e -- e2e/visual-regression.spec.ts`; if
   `overview-session-drawer.png` (and Overview snapshots that include the
   Investigate cards, after Step 11) differ, regenerate with
   `--update-snapshots` and inspect: the only diffs allowed are the drawer's
   campaign values/qualifier line and the Longest-session sub-line.

**Verify**: `cd apps/web && bun run test:e2e -- e2e/dashboard.spec.ts e2e/drawer-value-presentation.spec.ts e2e/origin-campaign.spec.ts e2e/value-presentation.spec.ts e2e/visual-regression.spec.ts` → all pass.

### Step 11 (U42): say which duration "Longest session" measures

`apps/web/src/lib/features/report/overview/records.svelte`:

1. Import `sessionDurationSemantics` from `'../../../../session-analysis-model'`.
2. Derive, for the longest item,
   `const longestSemantics = $derived(presentedRecords?.longest ? sessionDurationSemantics(presentedRecords.longest.row.source?.harnessKey, presentedRecords.longest.kind === 'campaign' && presentedRecords.longest.sessionCount > 1) : null);`
3. Lines 88–93: make the sub-line
   `<span class={recordSub} data-longest-session-semantic title={longestSemantics?.metricHint}>{presentedRecords.longest.label} · {longestSemantics?.metricLabel}</span>`
   and the sr-only text
   `Open details for longest session {label} ({metricLabel}).`
   The value and the selected item do not change (plan 052 rule).

**Verify** (SSR, deterministic): in
`apps/web/src/lib/features/report/overview/overview-components.test.ts` first
case (line 65) add
```ts
const longest = result.view.records?.longest;
if (!longest) throw new Error('Expected the Overview fixture to include a longest session');
const expectedSemantic = longest.kind === 'campaign' && longest.sessionCount > 1 ? 'Root task-open time' : 'Task-open time';
expect(body).toContain(`data-longest-session-semantic`);
expect(body).toContain(`${longest.label} · ${expectedSemantic}`);
```
(the fixture's longest item is the Codex campaign root "Build report UI",
6,120,000 ms, 3 sessions → `Root task-open time`; if the fixture says
otherwise, use the derived value). `cd apps/web && bun test src/lib/features/report/overview/overview-components.test.ts` → pass.

### Step 12: gates

`bun x ultracite fix && bun run lint && bun run typecheck`, then the three
package test commands, the web unit/SSR command, and the e2e command from the
table. Commit with the message from **Git workflow**, staging only in-scope
paths.

## Test plan

- Pure + SQLite parity for U02 (Step 3): a partially priced row's harness,
  harness-provider, provider and project groups carry its known subtotal, and
  the harness group's `costSum` equals the Overview group's `total`.
- Pure + SQLite parity for U06 (Steps 6–7): Overview items' `row` is the
  campaign display row; the existing `toEqual` parity suites compare it.
- Unit: `sessionAnalysisTargetForOverviewRow` (Step 8).
- SSR: campaign-controls header derives from the campaign row; automated
  review rollup named (Step 9); `/sync` labels (Step 5); Longest-session
  semantic (Step 11).
- e2e (presentation gate): Overview drawer shows the campaign's `$4.21` and
  `Campaign · 3 sessions`; Sessions-tab drawer header and grid show the same
  `$4.21`; `drawer-value-presentation` totals updated; visual snapshots
  regenerated and inspected (Step 10).

## Done criteria

- [ ] `grep -n "executiveAnalyticsInput" packages/report-core/src/focused-report-query.ts` → no matches; `grep -n "costLowerBound" packages/report-core/src/focused-report-query.ts` → 1 hit inside `analyticsInput`
- [ ] `grep -n "OR kind = 'model'" packages/usage-store/src/focused-report-query-sqlite.ts` → no matches
- [ ] `grep -n "row: campaign.root," packages/report-core/src/focused-report-query.ts` → no matches
- [ ] `grep -n "campaign_key" packages/usage-store/src/focused-report-query-sqlite.ts | grep -c "OverviewSessionSelectionRecord\|campaign_key: string | null"` ≥ 1 and `grep -c "executeMaterializedSessionQuery" packages/usage-store/src/focused-report-query-sqlite.ts` ≥ 2 (import + call)
- [ ] `grep -n "sessionAnalysisTargetForOverviewRow" apps/web/src/lib/features/report/composition/live-report-destination.svelte apps/web/src/lib/features/report/composition/synthetic-report-destination.svelte` → 2 files
- [ ] `grep -n "data-session-drawer-scope\|data-session-drawer-campaign-scope" apps/web/src/lib/features/sessions/detail/session-drawer.svelte` → both present
- [ ] `grep -n "visibleTotals" apps/web/src/lib/features/report/actions/campaign-session-controls.svelte` → no matches; `grep -n "data-campaign-totals"` → 1 hit
- [ ] `grep -rn ">Sessions<" apps/web/src/lib/features/sync/` → no matches; `grep -n "Stored sessions" apps/web/src/lib/features/sync/machine-fleet.svelte apps/web/src/lib/features/sync/machine-comparison.svelte` → 3 hits
- [ ] `grep -n "sessionDurationSemantics\|data-longest-session-semantic" apps/web/src/lib/features/report/overview/records.svelte` → both present
- [ ] `grep -n "intentionally total only fully priced" docs/session-analysis-sources.md` → no matches
- [ ] `bun test packages/report-core/src/focused-report-query.test.ts packages/usage-store/src/focused-report-query-sqlite.test.ts` exits 0 with the new cases
- [ ] `cd apps/web && bun test src/session-analysis-target.test.ts src/lib/features/report/actions/campaign-session-controls.ssr.test.ts src/lib/features/report/overview/overview-components.test.ts src/lib/features/sync/sync-render.test.ts` exits 0
- [ ] `cd apps/web && bun run test:e2e -- e2e/dashboard.spec.ts e2e/drawer-value-presentation.spec.ts e2e/origin-campaign.spec.ts e2e/value-presentation.spec.ts e2e/visual-regression.spec.ts` exits 0
- [ ] `bun run typecheck` and `bun run lint` exit 0
- [ ] `git status` shows no modified files outside the in-scope list
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The "Current state" excerpts do not match the working tree (drift check).
- After Step 7 a SQLite parity `toEqual` fails on an Overview item's `row`:
  report the differing field (e.g. `sortDate`, `activeDate`, `priceMeasurement`,
  `lineDelta`) — it means the served campaign display row and
  `sessionCampaignDisplayRow(…, false)` disagree, which is a real parity bug to
  surface, not to paper over with a hand-built row.
- `executeMaterializedSessionQuery(database, 'sessions', …)` with
  `fields.campaign` returns zero items for a campaign the Overview SQL found
  (would mean `matchesFocusedReportQuery` and `matchesSessionQuery` disagree on
  a predicate) — report the request that returned nothing.
- An existing test pins the old breakdown semantics (a harness/provider
  `costSum` that excludes a known subtotal) or the old Overview root row — name
  it; do not delete assertions silently.
- `apps/web/e2e/production-report.spec.ts` starts failing on
  `Analyze root session chronology` / `Root interval time` (the duration
  gating in `session-analysis.svelte` is out of scope; if it moved, report).
- The regenerated visual snapshots differ anywhere other than the drawer values
  / qualifier line and the Longest-session sub-line.

## Maintenance notes

- Rule, in one sentence (also in `docs/session-analysis-sources.md` after
  Step 4): every API-value total on every surface sums the known subtotal of
  each visible session; only means use fully priced sessions. A new breakdown
  dimension should call `groupAnalytics(visible, analyticsInput, …)` and its
  SQLite twin must `SUM(cost_approx)` — never a `cost_known = 1` case.
- Deferred (U03, one number instead of two labels): add a normalized
  `usage_unavailable INTEGER NOT NULL DEFAULT 0` column to `usage_rows`
  (`packages/usage-store/src/index.ts:1053-1075`; insert/update statements at
  1830–1866; backfill migration following the
  `migration.machine-fleet-metadata-v1` pattern at 1446–1466), export
  `SERVED_REPORT_MIN_TOKENS = 1` from `packages/report-core/src/report-budgets.ts`
  and use it in `packages/usage-engine-runtime/src/live.ts:1159`, then count
  `status = 'active' AND (token_total >= ? OR usage_unavailable = 1)` in the
  fleet SQL and drop the "Stored sessions" qualifier. Keep the
  `ROW_JSON_QUERY_PATTERN` guard (`index.test.ts:1511-1540`) green. The
  live-store vs published-revision lag stays a transient, honest difference.
- CLI: `calculateAnalytics` (`packages/report-core/src/analytics.ts:344-381`)
  still totals fully priced rows for both its summary and `byHarness` — it is
  internally consistent; aligning it with the web rule is a separate, explicit
  decision.
- Plan 098 (drawer chrome): build on `data-session-drawer-scope` /
  `data-session-drawer-campaign-scope`; do not add a second campaign label.
  `records.svelte:140` still says "Campaign · 1 sessions" for single-session
  campaigns (U09/U13 territory, plans 098/091).
- Reviewer should scrutinize: Step 7's per-campaign page query (bounded to ≤ 6
  per refresh, memoized) and the updated `drawer-value-presentation` numbers
  (derive them from `apps/web/src/report-data.ts`, do not copy from this plan
  blindly).

## Execution notes

Executed 2026-08-23 in the `exec/088` worktree from program tip `a70cf1aa`.
Drift check clean: no in-scope file had changed since `51815b70`, and every
"Current state" excerpt matched the tree.

### Deviations from the written steps

1. **Step 8/10 — the synthetic destination had no drawer target at all.**
   Step 10.3 asks the Sessions-tab drawer to expose
   `[data-session-drawer-campaign-scope]`, but the e2e and demo runtimes render
   `synthetic-report-destination.svelte`, not `sessions-destination.svelte`.
   Its `selectSessionRow` set `selection = { row }` with no `target`, so the
   drawer slot defaulted to a plain session target and the qualifier never
   rendered (the assertion failed on the first run). Fixed by threading the
   same canonical helper through it:
   `selection = { row, target: sessionAnalysisTargetForOverviewRow(row) }`.
   `synthetic-report-destination.svelte` is already in scope, the helper's
   guard keeps loaded campaign members atomic, and U06 would otherwise stay
   visibly unfixed on `bun run demo` — which the program gate walks.

2. **Step 5 — the `>Sessions<` grep matched the new test's own regex.**
   The literal `/<th[^>]*>Sessions<\/th>/` in `sync-render.test.ts` made the
   Done-criterion grep non-empty. The pattern is now
   `/<th[^>]*>\s*Sessions\s*<\/th>/u`, hoisted to module scope (Biome's
   `useTopLevelRegex`). It is a strict superset of the written assertion.

3. **Step 11 — the SSR assertion is whitespace-normalized.**
   `bun x ultracite fix` wraps the record sub-line, so Svelte's SSR output
   contains `Build report UI\n          · Root task-open time`. The browser
   collapses it (the e2e passes), so the SSR check now compares against
   `body.replaceAll(/\s+/g, ' ')`, as other SSR tests here do.

4. **Step 7 — the trace bound also asserts a lower bound.**
   `expect(campaignPageQueries).toBeGreaterThan(0)` sits next to the
   `toBeLessThanOrEqual(6)` the plan asked for; measured value is 3 for the
   fixture. Without it the bound would still pass if the campaign page query
   silently disappeared.

### Repo guards the plan did not run

- **Bundle closure.** `bun run test:web-bundle` cannot run in a nested
  worktree (its `INITIAL_CLOSURE_ENTRY_KEYS` hard-code
  `../../node_modules/@sveltejs/kit/...`; the emitted manifest key here is
  `../../../../../node_modules/...`). Measured the same closure by hand from
  the emitted manifest, in this environment, at three points:
  HEAD `286,073 B` gzip · this change without `records.svelte` `286,451 B` ·
  this change `289,091 B`. So the change costs **+3,018 B**, of which
  **+2,640 B** is `records.svelte` newly importing `sessionDurationSemantics`
  from `session-analysis-model.ts` into the eager report closure. Against the
  recorded `284,579 B` that is **1.585 % drift** — under the 2 % tolerance and
  under the 300 KB ceiling, so the guard stays green and
  `RECORDED_GZIP_CLOSURE_BYTES` was **not** moved (this worktree's own build
  is already +0.525 % over the recorded number, so writing my figure into the
  guard would bake in an environment artefact). Duplicating the semantic to
  dodge the import was rejected: two definitions of one concept is the exact
  defect this plan removes. Plans 093/094/097/098 should know ~1 % of the
  drift budget is now spent.
- **`bun run lint`** is a no-op-then-fail inside a worktree (`biome.json`
  excludes `**/.claude/worktrees`, so `biome check .` processes 0 files and
  exits 1). Ran the equivalent explicitly over `apps packages tools plans docs
  ./*.json ./*.ts` plus the five `tools/check-*.ts` guards: 1076 files, exit 0.
- **`tools/precommit-staged-only.test.ts`** fails here with
  `Could not resolve ultracite/biome/core`. It runs `lint-staged` with a `/tmp`
  cwd; this worktree's `node_modules` holds only `@ai-usage/*` and `.bin`
  symlinks, so a `/tmp` cwd has no upward path to `ultracite`. Unrelated to
  this diff (it never reads a changed file). `bun run test:packages` is green.

### Canonical helpers introduced (for plans 094 / 097 / 098)

- `sessionAnalysisTargetForOverviewRow(row)` in
  `apps/web/src/session-analysis-target.ts` — the one way to turn a *presented
  display row* (which may be a campaign aggregate) into a drawer target. Used
  by both report destinations. Do not add a second variant.
- `OVERVIEW_ITEM_SORT` + `sessionCampaignDisplayRow(campaign, …, false)` in
  `packages/report-core/src/focused-report-query.ts` — Overview campaign items
  now carry the same aggregate row the Sessions page serves.
- `data-session-drawer-scope` (`campaign` | `session`) and
  `data-session-drawer-campaign-scope` on the drawer title block, and
  `data-campaign-totals` on the campaign header line. Plan 098 should build on
  these rather than adding a second campaign label.
- `analyticsInput` in `focused-report-query.ts` now carries `costLowerBound`
  for every group; the SQLite twin is a plain `SUM(cost_approx)`. A new
  breakdown dimension must use both — never a `cost_known = 1` case.

## Execution notes — rework round 1

Four findings from the adversarial review, all fixed.

1. **BLOCKING 1 (fixed) — the automated-review suffix double-counted.**
   `classifierRollupLabelForSessionRow(campaign)` always printed
   `campaignClassifierCount`, but the in-memory collection *lists* its
   classifiers, so the drawer read `3 / 3 sessions shown · + 1 automated
   review` while that review was one of the three rows on screen. The suffix
   now counts only the reviews the member list does **not** show:
   `campaignClassifierCount − (listed rows whose origin is 'classifier',
   excluding the campaign row itself)`, floored at 0. The served page lists no
   classifiers, so the live path still shows all of them; the in-memory path
   shows none when they are all listed. The canonical label still owns the
   phrasing (it is applied to the corrected count), so "automated review(s)"
   has exactly one definition.
   *Why the gates missed it*: no fixture ever put a classifier **in** the
   listed collection. Added `listedClassifier` (a row with
   `origin: 'classifier'`) and three cases that relate the count to the list:
   none listed → `+ 2 automated reviews`; the only review listed → no suffix
   at all; one of three listed → `+ 2 automated reviews`. Verified the two new
   cases **fail** against the previous implementation and pass against this one.

2. **BLOCKING 2 (fixed) — U03 was gated on one surface.**
   `sync-render.test.ts` now asserts each renamed surface at the rendered
   level with its own pattern — the fleet card's `<span>`, the desktop
   `<th>`, and the mobile `<dt>` — plus a single negative
   `/<(dt|span|th)[^>]*>\s*Sessions\s*<\/\1>/u`. Verified by regressing each
   surface independently (including the mobile `<dt>` alone): each regression
   fails the suite.

3. **BLOCKING 3 (fixed) — two assertions that could not fail.**
   - `focused-report-query.test.ts`: `rowId: campaignItem.row.rowId` compared a
     property with itself. The `toMatchObject` now pins the independent
     `sessionRowIdentity(campaignRoot)` and the literal expected campaign key
     `machine-a:codex:record-campaign-root`; the redundant follow-up
     assertions were removed.
   - `campaign-session-controls.ssr.test.ts`: the ordering checks compared two
     `indexOf` results and passed on two `-1`s. Added a `positionOf` helper
     that asserts presence (`toBeGreaterThanOrEqual(0)`) before returning the
     index, and a `countsLine` helper that asserts both boundary markers exist
     before slicing. Every position comparison in this file now goes through
     them.

4. **STANDARDS (fixed).** `(r) => r.root_ordinal` →
   `(record) => record.root_ordinal` in
   `focused-report-query-sqlite.ts`; removed the comment I had duplicated at
   `focused-report-query-sqlite.test.ts`.

### Program-wide check: one entity from two machines

Nothing this plan introduces assumes a globally unique entity. Every key I
added is already machine-scoped, matching the storage primary key:

- **Campaign identity** — `sessionCampaignKeyFor` is
  `machineId:harnessKey:rootSourceSessionId` (`session-query.ts:1078`). The
  Overview campaign items I changed key off exactly this.
- **The SQLite memo I introduced** — `campaignRowsByKey` in
  `readOverviewSessionSelections` is keyed by the `campaign_key` column, which
  carries the same machine-scoped value. This was the one genuinely new
  cache in the diff and the one place a non-scoped key would have served one
  machine's aggregate for another's item.
- **Row identity** — `sessionRowIdentity` includes `source.machineId`, so
  `sessionAnalysisTargetForOverviewRow`'s fallback path is scoped too.
- **Group totals** (`costLowerBound` in `analyticsInput`) group by harness /
  provider / project, which are deliberately cross-machine; two machines
  observing the same logical session are two stored rows and contribute
  twice. That is the pre-existing, intended semantic — my change only extends
  *which cost* is summed, not the grouping — and `/sync`'s new "Stored
  sessions" label exists precisely to say these are per-machine stored rows.

Proved by two new fixtures, both with two machines emitting identical
`sourceSessionId`s (`shared-root` / `shared-child`):
- `focused-report-query.test.ts` → "keeps the same campaign observed on two
  machines as two Overview items": two campaign keys, `[2, 2]` sessions,
  `[12, 12]` cost, two distinct `rowId`s, `summary.sessionCount === 4`.
- `focused-report-query-sqlite.test.ts` → the same assertions through the
  served path plus the pure/SQLite `toEqual` parity. Verified this one
  **fails** when the memo key is changed to a non-machine-scoped value.

### The same double-count was in the drawer's own scope line (found while fixing BLOCKING 1)

Step 9.2 specified the qualifier as
`[campaignBadgeLabelForSessionRow(row), classifierRollupLabelForSessionRow(row)].filter(Boolean).join(' · ')`,
which rendered `Campaign · 3 sessions · + 1 automated review` for the shipped
fixture — where that review is one of the three sessions. `visibleCount` is
`matchedRows.length` (`session-query.ts:1189`) and the classifier matched, so
the badge already counted it.

Unlike the controls panel, the drawer cannot fix this by counting: it holds
only the display row, and nothing on that row says how many of
`campaignClassifierCount` are already inside `campaignVisibleCount`
(`|matched ∩ classifiers|` is not carried, and inferring it from
`min(totalCount, visibleCount + classifierCount)` over-counts whenever an
origin filter matches a classifier but not its siblings). Inventing that
number is exactly what this plan exists to stop, and carrying it properly
means a new field on `sessionCampaignDisplayRow` plus its SQLite mirror and
parser — out of scope here.

So the drawer scope line now states one canonical count,
`campaignBadgeLabelForSessionRow(row)` → `Campaign · N sessions`, the same
number the row that opened the drawer shows. The rolled-up-review explanation
lives only in the campaign controls panel directly below it, where the member
list makes it exact. `classifierRollupLabelForSessionRow` is no longer
imported by `session-drawer.svelte`.

Gated deterministically: the e2e scope assertions are `toHaveText` (exact), so
any appended suffix fails, and `origin-campaign.spec.ts` additionally asserts
the counts line reads `3 / 3 sessions shown`, contains no `automated review`,
and that `Tune collector fixtures` — the review — is visible in the list.
The regenerated `overview-session-drawer-linux.png` now reconciles end to
end: `$4.21 = 3.20 + 0.17 + 0.84`, `49 turns = 22 + 11 + 16`,
`109 tools = 64 + 18 + 27` across exactly the three rows on screen.

**Note for plan 098** (drawer chrome): the scope line is deliberately just
`Campaign · N sessions`. If 098 wants the rolled-up reviews named in the
drawer header, the honest way is to carry the covered-session count on the
campaign display row from `session-query.ts` — not to re-append
`classifierRollupLabelForSessionRow` there.

## Execution notes — rework round 2

1. **BLOCKING 1 (fixed) — U02 now has a rendered gate.**
   `overview-components.test.ts` gains "U02 — one API-value total per harness
   across Overview and Analysis": one fixture, one query, both surfaces
   rendered — the Overview's "API value by harness" list (via
   `overview-page.fixture.svelte`) and `harness-provider-panel.svelte` — and
   the Codex value and share compared between them. The fixture has a
   partially priced row with a **non-zero** known subtotal ($2 of a
   two-segment session) plus a fully priced $3 Codex row, and a second,
   fully priced $5 Claude harness so the two share denominators differ.
   Verified against the reintroduced defect: the breakdown renders
   `≥ $3.00` / `38%` while the Overview renders `≥ $5.00` / `50%` — both
   halves of the audit symptom (the missing subtotal and the 24 %-vs-23 %
   share) fail the gate, and both pass after the fix.

2. **BLOCKING 2 (fixed) — all four header values pinned.**
   The SSR campaign fixture now carries `freshTokens: 777_000`,
   `turns: 4242`, `tools: 3131` — none of which is the member-page sum — and
   the test pins the whole header string
   `$99.00 API · 777k fresh tokens · 4,242 turns · 3,131 tools`, asserts it
   appears exactly once, and asserts the member-page sums (`2,003 fresh`,
   `7 turns`, `3 tools`) appear nowhere. Verified by regressing all three
   previously unpinned fields back to `visibleRows` sums: the suite fails.
   `origin-campaign.spec.ts` pins the rendered header with `toHaveText`
   (`$4.21 API · 155k fresh tokens · 49 turns · 109 tools`).

3. **BLOCKING 3 (fixed) — the tooltip was false and is now pinned.**
   It said the values are totals "across the listed sessions"; they are the
   whole matching aggregate plus rolled-up automated reviews, including
   members not loaded or listed. New copy: "Values below cover the whole
   campaign: every session matching the current filters plus its rolled-up
   automated reviews, including any not listed below. Analyze root opens the
   root session's chronology." Pinned by a `toHaveAttribute('title', …)`
   assertion in `origin-campaign.spec.ts`, so the copy cannot drift from its
   own test again.

4. **BLOCKING 4** — squashed to one commit on the merge-base `a70cf1aa` via
   `git commit-tree` + `git update-ref` (no reset, no force, working tree
   untouched); tree verified byte-identical to the pre-squash tree.

### The served-page premise was wrong; the computation was not

The reviewer is right about `session-query-sqlite.ts`: `runCampaignChildren`
builds `rollupWhere` as
`campaign_key = ? AND campaign_root = 0 AND ((<filter>) OR session_rows.origin = 'classifier')`
and uses it for the `items` projection, so the **served children query does
return classifiers** — `matchedWhere` (classifier-free) is used only for
`session_count`. My comment claiming the served page excludes them was wrong
and is corrected.

**The computation was already right**, because it never depended on that
premise: it counts classifier rows in the *rendered list* (`model.sessions`)
and subtracts, so it is correct whichever shape the collection has. What the
wrong premise did cost was a missing case, now added: a review that is
**loaded but filtered out of the list** — the served shape, where
`collection.items` carries the classifier via the rollup but `visibleRows`
does not — must still be counted. That case is pinned in
`campaign-session-controls.ssr.test.ts` ("still counts a loaded review that
the current filters keep out of the list") and passes.

So: **comment corrected, computation unchanged, one missing test case added.**

### Not taken (non-blocking)

The two-machine campaign graphs in `focused-report-query.test.ts` and
`focused-report-query-sqlite.test.ts` stay separate. They live in different
packages (`report-core` vs `usage-store`) and the SQLite one must go through
`SerializedRow` → `publishFixture`; a shared fixture would need a new exported
test helper crossing the package boundary. The parity `toEqual` in the SQLite
test already fails if the two graphs drift apart, which is the drift that
matters.

## Execution notes — exceptional rework round 3

The orchestrator granted one narrow budget extension after the third Codex
review reproduced a data-honesty defect at the campaign-controls adapter seam.
The finding was accepted in full.

### Production seam and regression

`runCampaignChildren` deliberately returns the union of children matching the
active filter and classifier rows needed by the campaign rollup. Its
`sessionCount` remains the count of children that actually match. The web
adapter previously copied every returned item into `visibleRows` but used the
filter-derived `campaignVisibleCount` for the count line. The focused red
fixture therefore rendered a root and its automated review while saying
`1 / 2 sessions shown · 1 hidden by current filters`, with no review
explanation.

The fix keeps the settled pure/SQLite rollup parity and carries the query's
exact `itemCount - sessionCount` delta through
`campaignSessionControlsState`, the live binding, and the component model as
`rolledUpClassifierCount`. That count has three presentation effects:

- the main ratio is explicitly the number of sessions that match the active
  filters, not the number of rendered rows;
- a classifier returned for campaign totals is not also called hidden;
- the same count renders `+ N automated reviews included in campaign totals`,
  using the canonical review label and pluralization.

`campaign-session-controls.ssr.test.ts` now drives
`SessionWindowView -> campaignSessionControlsState -> CampaignSessionControls`
with the served shape: an origin filter matches the root, the filtered child
page returns the review through the rollup rule, and the page's
`sessionCount` excludes it. The test went red on the exact reported symptom,
then green with both rows rendered and the copy
`1 / 2 sessions match current filters · + 1 automated review included in
campaign totals`; it also asserts that no `hidden by current filters` claim is
rendered. The manually impossible test that removed the returned classifier
from `visibleRows` was deleted, and the contradictory served-page comment was
replaced.

### Two-machine applicability

This correction does not group across machines. The adapter indexes exactly
one page pair by the selected `campaignKey`, whose identity is
`machineId:harnessKey:rootSourceSessionId`, and `uniqueRows` uses the
machine-scoped `rowId`. The two existing plan fixtures remain the systemic
proof: `focused-report-query.test.ts` presents the same `shared-root` /
`shared-child` IDs from two machines as two campaigns,
and `focused-report-query-sqlite.test.ts` proves the served projection has the
same result in pure/SQLite parity. Both passed in this round's focused package
run. No new different-value fixture is required for this seam: the new delta
is computed only after one exact machine-scoped map lookup and never iterates,
groups, counts, or de-duplicates entries from another campaign key.

### Round 3 verification

- Red/green adapter SSR loop: 7 passing / 1 failing before the fix; 7 passing
  after removing the impossible duplicate case.
- Focused package gate: 138 tests passed across report-core focused/CSV/
  analytics and usage-store focused/index suites.
- Full web unit/SSR gate: 935 tests passed across 172 files.
- Worktree-safe Biome lint checked 1,076 files; all five repository lint guards
  passed.
- `bun run typecheck`: 28 tasks passed, Svelte reported zero errors and zero
  warnings.
- Locked Playwright gate: the five plan specs passed 35/35 with two workers.
