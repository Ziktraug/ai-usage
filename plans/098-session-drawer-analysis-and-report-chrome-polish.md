# Plan 098: Session Drawer, Analysis, and Report Chrome Polish

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`. This is child 9 (the last) of program plan 086; plan
> 088 edits `session-drawer.svelte` and `records.svelte` before you and plans
> 093/094 may edit `packages/design-system/src/preset.ts` and
> `executive-overview.svelte` — read the drift check output with that in mind.
>
> **Drift check (run first)**:
> `git diff --stat 51815b70..HEAD -- apps/web/src/lib/features/sessions/detail/session-drawer.svelte apps/web/src/lib/features/sessions/detail/drawer-detail-item.svelte apps/web/src/lib/features/sessions/detail/session-analysis.svelte apps/web/src/lib/features/sessions/detail/session-vcs-summary.svelte apps/web/src/lib/features/sessions/detail/components.ssr.test.ts packages/design-system/src/svelte/overlays/styles.ts packages/design-system/src/svelte/overlays/styles.test.ts packages/design-system/src/svelte.ts packages/design-system/src/preset.ts packages/design-system/src/preset.test.ts apps/web/src/lib/features/report/breakdown/model.ts apps/web/src/lib/features/report/breakdown/model.test.ts apps/web/src/lib/features/report/breakdown/model-analysis-table.ssr.test.ts apps/web/src/lib/features/report/core/report-view-model.ts apps/web/src/lib/features/report/core/report-view-model.test.ts apps/web/src/lib/features/report/core/report-header.svelte apps/web/src/lib/features/report/core/report-components.test.ts apps/web/src/lib/features/report/overview/records.svelte apps/web/src/lib/features/report/overview/overview-page.svelte apps/web/src/lib/features/report/overview/executive-overview-model.ts apps/web/src/lib/features/report/overview/executive-overview-model.test.ts apps/web/src/lib/features/report/overview/overview-components.test.ts apps/web/src/lib/foundation/presentation/format.ts apps/web/src/lib/foundation/presentation/format.test.ts apps/web/src/dashboard-metric-model.ts apps/web/e2e/session-viewport-geometry.spec.ts apps/web/e2e/drawer-value-presentation.spec.ts apps/web/e2e/production-report.spec.ts apps/web/e2e/shell-rail-geometry.spec.ts apps/web/e2e/dashboard.spec.ts apps/web/e2e/time-range.spec.ts`
> Plans 088, 093 and 094 are *expected* to have touched `session-drawer.svelte`,
> `records.svelte`, `preset.ts`/`preset.test.ts` and `overview-page.svelte`
> before you. For those files, open the file and re-find each excerpt quoted
> in "Current state" by its text, not by its line number; if an excerpt no
> longer exists at all (not merely moved), treat it as a STOP. Any other
> in-scope file that changed since `51815b70` is a STOP.

## Status

- **Priority**: P2 (program rank) — carries one P1 finding (U29)
- **Effort**: M
- **Risk**: LOW–MED (drawer header layout, popover trigger restyle, one
  pinned preset hash; every change is presentation or copy, no data path)
- **Depends on**: plan 088 (campaign-vs-root semantics in
  `session-drawer.svelte` and `records.svelte` — land it first; this plan
  never names root vs campaign); plan 094 if it touched `records.svelte` or
  `overview-page.svelte`; plan 093 if it touched `preset.ts`
- **Category**: presentation / copy
- **Planned at**: commit `51815b70`, 2026-08-23
- **Audit findings**: U09, U10, U29, U31, U33, U37 (copy part only — plan 089
  owns the native date inputs)

## Why this matters

Six small things a reader meets in the first ten minutes, each of which makes
the app look less careful than it is:

- **U29** — the session drawer header gives the navigation cluster an `auto`
  grid track and the harness badge a `minmax(0, 1fr)` track with
  `overflow: hidden`, so at the desktop drawer width a long matching-session
  count plus several minimum-size controls squeezes the badge down to its
  padding: a coloured circle with no text, touching the count. In the Analyze
  timeline, the compressed-gap hatch `⫽` is absolutely positioned over the
  axis *label* row, so a break near the start is drawn through its timestamp.
  The metric grid shows several "i" triggers that the drawer body's broad
  minimum-button-size rule inflates from compact icons to full touch-target
  bordered circles — a second, heavier "i" pattern next to the compact
  provenance marker used everywhere else. "Resolve GitHub links" names a
  mechanism, not what happens (it runs your local `gh pr list` for the recorded
  branch).
- **U09** — a singular busiest-day count is rendered with the plural noun
  "sessions": the Investigate record never pluralises while the heatmap next
  to it does.
- **U10** — Models shows a complete-looking coverage ratio and percentage
  beside a "≥" value and a "—" per-1M; the cell's second line explains the
  small subset of sessions without token counters, but never says the
  consequence, so the complete percentage reads as a contradiction.
- **U31** — "Generated" followed by a timestamp is read as render time. It is
  in fact the time the *stored report revision* was assembled (renewals update
  only `published_at`, never `generated_at`), i.e. data freshness — but the
  word "Generated" hides that, and the value moves whenever collectors add
  rows.
- **U33** — the document is the scroll root and `shell` is a centred
  fixed-maximum-width container; when the page scrollbar appears or disappears
  between sub-tabs the content re-centres by roughly half a scrollbar.
- **U37 (copy)** — the comparison line under the hero has two sentences for
  what a reader sees as one situation: a custom or preset range that already
  starts before the first recorded session says "No sessions exist in the
  previous period." while All time says "No previous period exists before
  the full recorded range." Plan 056 locked both sentences for two *different*
  states; the bug is that the state is picked by range *mode* instead of by
  the actual boundary, so the same case gets either sentence.

## Current state

Every excerpt below was read from the worktree at `51815b70`.

### U29a — drawer header (badge collapse)

- `apps/web/src/lib/features/sessions/detail/session-drawer.svelte`
  - lines 122–127:
    ```ts
    const positionLabel = (): string => {
      if (snapshot.navigation) {
        return `${fmtNum(snapshot.navigation.total)} matching sessions`;
      }
      return position >= 0 ? `${fmtNum(position + 1)} / ${fmtNum(rows.length)}` : 'Outside filters';
    };
    ```
  - lines 304–354: the header. Line 305 `<HarnessBadge name={row.harness} />`
    is the grid's first child; line 306
    `<nav aria-label={`Session navigation, ${positionLabel()}`} class={drawerNav} data-session-drawer-navigation>`;
    lines 307–309 `<span class={drawerPosition}>{positionLabel()}</span>`;
    lines 310–329 the ↑ / ↓ `drawerClose` buttons; lines 330–342 the analysis
    toggle:
    ```svelte
    {#if snapshot.revision}
      <button
        aria-controls="session-analysis-panel"
        aria-expanded={snapshot.analysisOpen ? 'true' : 'false'}
        aria-label={analysisButtonAriaLabel()}
        class={ghostButton}
        disabled={closing}
        onclick={toggleAnalysis}
        type="button"
      >
        {analysisButtonLabel()}
      </button>
    {/if}
    ```
    lines 343–352 the ✕ close button (`bind:this={closeButton}`).
  - lines 466–473 the actions row:
    ```svelte
    <div class={drawerActions}>
      <button class={ghostButton} onclick={() => onFieldFilter('project', row.projectKey)} type="button">
        Filter project: {row.projectLabel}
      </button>
      <button class={ghostButton} onclick={() => onFieldFilter('model', row.modelKey)} type="button">
        Filter model: {row.modelKey}
      </button>
    </div>
    ```
    followed by lines 474–485 `{#if snapshot.analysisOpen}<div id="session-analysis-panel" …>`.
  - `snapshot.navigation` is set only when the selection carries a query
    (`session-detail-query-slot.svelte:99–107`,
    `total: selection.total ?? rows.length`) — i.e. when the drawer is opened
    from the Sessions table. The synthetic e2e client
    (`composition/synthetic-report-destination.svelte:342–348`) has no
    `detail`/`neighbors`, and its selection has no `revision`, so in
    `bun run test:e2e` the header shows "1 / 12"-style labels and **no**
    Analyze button; the symptom reproduces only in the repository-owned
    `apps/web/e2e/production-report.spec.ts` fixture (a many-session selection
    with "Analyze root").
- `packages/design-system/src/svelte/overlays/styles.ts` (consumed only by the
  session drawer — `grep -rn "drawerTop\|drawerNav\|drawerPosition" apps/web/src --include="*.svelte"`
  → `session-drawer.svelte` only):
  - lines 27–37:
    ```ts
    export const drawerTop = css({
      display: 'grid',
      gridTemplateColumns: 'minmax(0, 1fr) auto',
      alignItems: 'center',
      gap: '10px',
      p: '12px 16px',
      borderBottom: '1px solid token(colors.line)',
      flexShrink: 0,
      minW: 0,
      '& > :first-child': { minW: 0, overflow: 'hidden' },
    });
    ```
  - line 49 (inside `drawerBody`): `'& button, & a[href], & summary': { minH: '44px', minW: '44px' },`
  - lines 67–75 `drawerNav` (`display: flex`, `justifyContent: 'flex-end'`,
    `gap: '6px'`, `minW: 0`, `whiteSpace: 'nowrap'`, `'& button': { minH: '44px', minW: '44px' }`).
  - lines 77–83 `drawerPosition` (`display: { base: 'none', md: 'block' }`,
    `textStyle: 'numeric'`, `color: 'faint'`, `fontSize: '11px'`, `mr: '4px'`).
  - lines 145–163 `provenanceMarkerClass` (14 px round bordered glyph,
    `fontSize: '10px'`, `fontWeight: 700`) and lines 165–168
    `provenanceMarkerWarningClass` — the app-wide "i"/"!" marker used by
    `provenance-marker.svelte` in the Sessions table.
- `packages/design-system/src/svelte/overlays/styles.test.ts` lines 35–38:
  `expect(drawerTop).toContain('d_grid'); expect(drawerNav).toContain('min-h_44px'); expect(drawerPosition).toContain('d_none'); expect(drawerPosition).toContain('md:d_block');`
- `packages/design-system/src/svelte.ts` lines 136–150 re-export the drawer
  styles (`drawer … drawerTop`); `provenanceMarkerClass` is **not** exported
  there (only `ProvenanceMarker`, `provenanceMarkerGlyph`, `provenanceTitle`,
  lines 127–135).
- Design-system `harness-badge.svelte` lines 4–21: the badge is
  `inline-flex`, `h: 22px`, `px: 9px`, `whiteSpace: nowrap`, with a 6 px
  `::before` dot — so a clipped badge is exactly "a circle".
- `HarnessBadge` accessible width is pinned nowhere; the desktop drawer test
  `apps/web/e2e/session-viewport-geometry.spec.ts` lines 382–417 opens the
  Build report UI root session at 1280×900 and asserts drawer geometry
  (`width: 440`) and `actionGeometry.length >= 3`, each ≥ 44×44. The mobile
  test (lines 193–260) asserts `[data-session-drawer-header]` and
  `[data-session-drawer-navigation]` `scrollWidth <= clientWidth + 1`.
- `apps/web/e2e/production-report.spec.ts` line 636 clicks
  `getByRole('button', { name: 'Resolve GitHub repository and pull request links' })`;
  line 638 clicks `'Analyze root session chronology'`; line 798
  `expect(headerActionGeometry).toHaveLength(4);` (mobile: ↑ ↓ Analyze ✕).
- `apps/web/e2e/visual-regression.spec.ts` lines 315–329 require ≥ 3 header
  buttons ≥ 44 px and capture `overview-session-drawer.png`.

### U29b — compressed-gap hatch over the left axis label

- `apps/web/src/lib/features/sessions/detail/session-analysis.svelte`
  - lines 43–51 `axisLabels` (`display: flex`, `justifyContent: 'space-between'`, mono 10 px);
    line 52 `const axisTrack = css({ position: 'relative', minW: 0 });`
  - lines 59–67:
    ```ts
    const scaleBreakClass = css({
      position: 'absolute',
      top: '-2px',
      color: 'ink',
      fontSize: '14px',
      fontWeight: 700,
      lineHeight: 1,
      transform: 'translateX(-50%)',
    });
    ```
  - lines 450–473 the `renderTimelineAxis` snippet: lines 455–459 the labels
    row (`<time>` · `Compressed gaps`/`Wall-clock time` · `<time>`), lines
    460–468 the breaks rendered *as siblings inside the same `axisTrack`*,
    absolutely positioned at `left: {atPercent}%` — over the label row.
  - `apps/web/src/session-analysis-model.ts` lines 404–424 place a break at
    `gapStartPercent + 1` (fixed 2 % gap width), so a long first gap after a
    short first turn lands at ~2 %, i.e. over the left `<time>`.
- `apps/web/src/lib/features/sessions/detail/components.ssr.test.ts` lines
  207–253 render `SessionAnalysis` with a 5 h gap fixture and pin
  `title="5h"` (line 220) and `html.match(/Compressed gaps/g)).toHaveLength(2)`
  (line 238, one per timeline shell). No test asserts where the hatch lives.
- No default-e2e fixture has compressible gaps
  (`production-report.spec.ts:659` asserts `Show real gaps` count 0), so the
  gate for this item is a DOM-structure assertion in the SSR test.

### U29c — five "i" triggers

- `apps/web/src/lib/features/sessions/detail/drawer-detail-item.svelte`
  - lines 10–25:
    ```ts
    const detailInfoButton = css({
      display: 'inline-grid',
      placeItems: 'center',
      w: '24px',
      h: '24px',
      p: 0,
      border: '1px solid token(colors.line)',
      borderRadius: 'full',
      bg: 'surfaceMuted',
      color: 'muted',
      fontSize: '12px',
      fontWeight: 700,
      cursor: 'pointer',
      _hover: { borderColor: 'lineStrong', color: 'ink' },
      _focusVisible: { outline: '2px solid token(colors.accent)', outlineOffset: '2px' },
    });
    ```
  - lines 79–101 the markup; lines 93–95 the trigger snippet
    `<span aria-hidden="true">i</span>`; `triggerAriaLabel={`About ${label}`}`
    (line 88) and `triggerTitle` (line 91).
  - Because `drawerBody` forces `min-height/min-width: 44px` on every button
    (styles.ts line 49) and `min-*` beats `height/width`, the trigger renders
    44×44 with a 1 px border and `surfaceMuted` fill — five bordered circles.
- `session-drawer.svelte` hint-bearing items: Total tokens (391–396), RTK
  token savings (397–402), API value (403–408), Subscription value (417–422),
  duration (430–435), plus conditional Charged amount / Partial / Usage data /
  Reconciliation.
- `apps/web/e2e/drawer-value-presentation.spec.ts` lines 15–33 pin the
  accessible names `About Subscription value`, `About Task-open time`, and
  `aria-haspopup="dialog"`; line 69 `About Partial`.
  `components.ssr.test.ts` lines 196–204 pin `data-detail-item="Sub value"`,
  `aria-label="About Sub value"`, `aria-haspopup="dialog"`.

### U29d — "Resolve GitHub links"

- `apps/web/src/lib/features/sessions/detail/session-vcs-summary.svelte`
  - line 43 `const note = css({ color: 'muted', fontSize: '11px', lineHeight: 1.45, m: 0 });`
  - lines 119–134 `unavailableMessage()` (`'GitHub lookup timed out.'`,
    `'GitHub lookup requires the source machine.'`, …, default
    `'GitHub lookup is unavailable.'`).
  - lines 135–140:
    ```ts
    const resolveLabel = (): string => {
      if (resolving) {
        return 'Resolving GitHub links…';
      }
      return unavailable ? 'Retry GitHub lookup' : 'Resolve GitHub links';
    };
    ```
  - lines 264–282: the resolving note, the unavailable note, and
    `{#if canResolve}<button aria-label={resolving ? 'Resolving GitHub repository and pull request links' : 'Resolve GitHub repository and pull request links'} …>{resolveLabel()}</button>{/if}`.
  - `canResolve` (lines 114–116) = `onResolve && repository && branches.length > 0 && pullRequests.length === 0 && !available`.
- What the button actually does — `apps/web/src/server/session-vcs.server.ts`
  lines 144–200: finds the local `gh` executable and runs
  `gh pr list --repo <ownerPath> --head <branch> --state all --limit N --json number,url`;
  `unavailable('resolver-unavailable')` when `gh` is missing, `'not-found'` when
  the list is empty.

### U09 — "1 sessions"

- `apps/web/src/lib/features/report/overview/records.svelte` lines 96–107, the
  Busiest day record:
  ```svelte
  <span class={recordSub}
    >{fmtDateOnly(presentedRecords.busiest.date)}
    · {fmtNum(presentedRecords.busiest.sessions)} sessions</span
  >
  ```
  and lines 138–142 `· Campaign · {fmtNum(item.sessionCount)} sessions` (plan
  088 owns that suffix's semantics — see Scope).
- `apps/web/src/lib/features/report/overview/activity-heatmap.svelte:69`
  already does `${fmtNum(item.sessions)} ${item.sessions === 1 ? 'session' : 'sessions'}`;
  `executive-overview-model.ts:204` and `breakdown/model.ts:107` repeat the
  same inline ternary. `apps/web/src/lib/foundation/presentation/format.ts`
  (lines 15–36: `fmtNum`, `fmtMoney`, `fmtPct`, `fmtMaybeNum`, `fmtCompact`)
  has no count helper; `apps/web/src/session-analysis-model.ts:493`
  `countLabel` exists but without thousands separators and in the wrong layer.
- `overview-components.test.ts:94` pins `'Campaign · 3 sessions'`;
  `packages/report-core` `FocusedOverviewRecords.busiest` is
  `{ cost: number; date: string; sessions: number } | null`
  (`focused-report-query.ts:308–314`).

### U10 — coverage cell

- `apps/web/src/lib/features/report/breakdown/model.ts`
  - lines 174–180:
    ```ts
    const unavailableCounterQualification = (group: AnalyticsGroup): string | null => {
      if (group.usageUnavailable <= 0) {
        return null;
      }
      const verb = group.usageUnavailable === 1 ? 'has' : 'have';
      return `${fmtNum(group.usageUnavailable)} of ${fmtNum(group.sessions)} model sessions ${verb} unavailable token counters`;
    };
    ```
  - lines 182–203 `pricingCoveragePresentation`: line 200
    `label: `${fmtNum(group.priced)} / ${fmtNum(group.sessions)} · ${fmtPct((group.priced / group.sessions) * 100)}``,
    qualification = partially-measured phrase and/or the sentence above,
    joined by `' · '`.
  - lines 129–145 `modelValue` (`usageUnavailable > 0` → `≥ $x` lower-bound)
    and 147–172 `modelValuePerMillion` (`usageUnavailable > 0` → `'—'`).
  - Why the observed complete-looking coverage is "priced":
    `packages/report-core/src/analytics.ts:234–242` counts a row as `priced`
    when `usageRowPricedCost(row) != null`, i.e.
    `costKnown` (`usage-row.ts:266`), and `costKnown` comes from the model's
    price table (`usage-row.ts:188–199`) regardless of missing counters
    (`codex-history.ts:1199–1205` nulls the tokens of a usage-unavailable
    session). A counter-less session on a priced model is "priced at $0".
- `apps/web/src/lib/features/report/breakdown/model.test.ts` lines 185–201
  pin `pricingCoverageLabel: '3 / 3 · 100%'`,
  `pricingQualification: '1 of 3 model sessions has unavailable token counters'`,
  `processedTokensQualification: '1 of 3 model sessions has unavailable token counters'`.
- `model-analysis-table.svelte` lines 151–156 (table) and 216–223 (cards)
  render `pricingCoverageLabel` then `pricingQualification` inside the same
  cell (`modelQualification`, `breakdown/styles.ts:204–211`, warn colour).
  `model-analysis-table.ssr.test.ts` lines 85–134 render three groups, none
  with `usageUnavailable`.

### U31 — "Generated"

- `apps/web/src/lib/features/report/core/report-view-model.ts` lines 98–103:
  ```ts
  export const reportGeneratedLabel = (generatedAt: string | null, hasReportData: boolean): string => {
    if (!(hasReportData && generatedAt)) {
      return 'Report payload unavailable';
    }
    return `Generated ${dateTimeFormatter.format(new Date(generatedAt))}`;
  };
  ```
  `liveReportShellModel` (line 56) takes `result.manifest.generatedAt`;
  `syntheticReportShellModel` (line 82) takes `payload.generatedAt`.
- `apps/web/src/lib/features/report/core/report-header.svelte` line 39:
  `<div class={meta}>{reportGeneratedLabel(generatedAt, hasReportData)}</div>`.
- `report-view-model.test.ts` line 41
  `expect(reportGeneratedLabel('2026-08-01T10:00:00', model.hasReportData)).toBe('Generated Aug 01, 10:00');`
  and line 63 the unavailable copy.
- What the value is: `packages/usage-engine-runtime/src/live.ts:1133`
  `const publicationTime = currentTime();` → `generatedAt: publicationTime`
  (line 1152); `packages/usage-store/src/served-report-store.ts:948–968`
  `renewCurrentRevision` updates only `published_at, expires_at` — a renewed
  unchanged revision keeps its `generated_at`. So the label is the assembly
  time of the current revision's content — data freshness — and changes only
  when collected data changed (CONTEXT.md "Served revision": metadata may be
  renewed, content is not rewritten).
- `apps/web/e2e/dashboard.spec.ts` lines 66–79 (`loads a deterministic report
  overview`) assert the `Usage report` heading; the synthetic payload has
  `generatedAt: '2026-06-11T12:00:00.000Z'` (`report-data.ts:214`) and e2e
  runs with `TZ=UTC`.

### U33 — scrollbar gutter

- The document is the scroll root: `packages/design-system/src/components/layout.ts:15–27`
  (`page`: `minHeight: 100vh`; `shell`: `maxWidth: '1380px', mx: 'auto'`),
  `apps/web/src/lib/features/shell/app-shell.svelte:35–40` (`content` is a
  left-margin offset only), `route-frame.svelte` (no overflow container).
- Global `html` rules live in `packages/design-system/src/preset.ts` lines 17–28
  (`colorScheme`, `bg`, `accentColor`, `scrollPaddingTop`, theme attributes);
  `apps/web/src/index.css` only imports the generated stylesheet and the
  reduced-motion block. `grep -rn "scrollbar-gutter\|scrollbarGutter" apps/web/src packages/design-system/src`
  → no matches.
- `packages/design-system/src/preset.test.ts` lines 149–152 pin a SHA-256 of
  `JSON.stringify(aiUsagePreset)`:
  `expect(presetHash).toBe('f4ea6ba5b77516c81b7ba1a950a36135b54e80ebc43b0a52055795c27b13b15d');`
- `apps/web/e2e/shell-rail-geometry.spec.ts` lines 27–54 measure the rail and
  `document.documentElement.scrollWidth <= clientWidth` per viewport; headless
  Chromium launches with `--hide-scrollbars`, so scrollbar *geometry* cannot
  be observed in e2e — the computed style can.

### U37 (copy) — two sentences for one boundary

- `apps/web/src/dashboard-metric-model.ts` lines 27–45:
  ```ts
  export type MetricComparisonState = 'available' | 'full-range' | 'no-prior-data';

  const metricComparisonMessages: Record<Exclude<MetricComparisonState, 'available'>, string> = {
    'full-range': 'No previous period exists before the full recorded range.',
    'no-prior-data': 'No sessions exist in the previous period.',
  };

  export const metricComparisonStateFor = (
    rangeMode: DateRangeMode,
    previousSummary: object | null | undefined,
  ): MetricComparisonState => {
    if (previousSummary) {
      return 'available';
    }
    return rangeMode === 'all' ? 'full-range' : 'no-prior-data';
  };
  ```
- `apps/web/src/lib/features/report/overview/executive-overview-model.ts`
  lines 29–36 `ExecutiveOverviewModelInput` (`executive`, `previousSummary`,
  `rangeMode`, `summary`, `topItems`, `totalSessionCount`); lines 100–118
  `comparisonFor(summary, previousSummary, rangeMode)` calls
  `metricComparisonStateFor(rangeMode, previousSummary)`.
- `apps/web/src/lib/features/report/overview/overview-page.svelte` lines 67–76
  build the model from `result.view.previousSummary`, `range.mode`, … — the
  component also has `range: DashboardDateRangeSearch`, `result.dateDomain`
  (`FocusedOverviewResult.dateDomain`, filter-scoped and range-free,
  `focused-report-query.ts:1468–1470`) and `result.metadata.generatedAt`.
- The resolver the request itself uses:
  `apps/web/src/lib/features/report/range/report-range-model.ts:50–59`
  `rangeBounds(range, generatedAt)` → `{ from: Date | null; to: Date | null }`
  (already consumed by `composition/report-search.ts:42` with
  `bootstrap.support.generatedAt`, the same value as
  `result.metadata.generatedAt`). Plan 089 edits lines 82–90 of that file
  (day count) — **read-only import here, never edit it**.
- report-core `previousPeriodSummary` (`focused-report-query.ts:1432–1447`)
  returns `null` when the window `[from − span, from − 1]` holds no
  filter-scoped rows — whether because the window overlaps a gap, or because
  it lies entirely before the first recorded row.
- `plans/056-explain-full-range-period-comparison.md` (DONE) **locks both
  sentences** and requires "Full-range and bounded-no-data states have
  different copy". It does not lock *how the state is chosen*.
- Tests pinning the current behaviour:
  `executive-overview-model.test.ts` lines 205–213 (`rangeMode: 'all'` →
  full-range copy) and 223–241 (`rangeMode: '30d'`, `previousSummary: null`,
  no boundary → no-prior-data copy); `apps/web/e2e/time-range.spec.ts:274`
  `await expect(executiveValue).toContainText('No sessions exist in the previous period.');`
  for the 90d deep link (Mar 13 → Jun 11 on a fixture whose first row is
  2026-04-12, `report-data.ts:123`) and line 322 the negative assertion.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `bun run typecheck` | exit 0 |
| Lint (incl. export-consumer and boundary checks) | `bun run lint` | exit 0 |
| Format then check | `bun x ultracite fix && bun run check` | exit 0 |
| Design-system unit tests | `bun test packages/design-system/src/svelte/overlays/styles.test.ts packages/design-system/src/preset.test.ts` | all pass |
| One web SSR/unit file | `cd apps/web && bun test src/lib/features/sessions/detail/components.ssr.test.ts` | all pass |
| All web unit+SSR tests | `bun run --cwd apps/web test` | all pass |
| One e2e spec | `bun run --cwd apps/web test:e2e -- e2e/session-viewport-geometry.spec.ts` | all pass |
| Production e2e (drawer header symptom lives here) | `bun run --cwd apps/web test:e2e-production` | all pass |
| Visual snapshot refresh (only if Step 4 moves pixels) | `cd apps/web && bun run test:e2e -- e2e/visual-regression.spec.ts --update-snapshots` | snapshot PNG rewritten; inspect the diff |
| New preset hash (Step 8) | `bun -e "import('./packages/design-system/src/preset.ts').then(({aiUsagePreset}) => console.log(new Bun.CryptoHasher('sha256').update(JSON.stringify(aiUsagePreset)).digest('hex')))"` | 64 hex chars |
| PII guard | the `grep -n -i …` from plan 086 "Cross-cutting rules → PII", pointed at `plans/098-session-drawer-analysis-and-report-chrome-polish.md` | no output |

On NixOS, if Playwright's bundled Chromium fails to launch, export
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to the system Chrome binary first
(`--channel chrome` does not work here).

## Scope

**In scope** (the only files you should modify):
- `apps/web/src/lib/features/sessions/detail/session-drawer.svelte`
- `apps/web/src/lib/features/sessions/detail/drawer-detail-item.svelte`
- `apps/web/src/lib/features/sessions/detail/session-analysis.svelte`
- `apps/web/src/lib/features/sessions/detail/session-vcs-summary.svelte`
- `apps/web/src/lib/features/sessions/detail/components.ssr.test.ts`
- `packages/design-system/src/svelte/overlays/styles.ts`, `styles.test.ts`
- `packages/design-system/src/svelte.ts` (one added re-export)
- `packages/design-system/src/preset.ts`, `preset.test.ts`
- `apps/web/src/lib/features/report/breakdown/model.ts`, `model.test.ts`,
  `model-analysis-table.ssr.test.ts`
- `apps/web/src/lib/features/report/core/report-view-model.ts`,
  `report-view-model.test.ts`, `report-header.svelte`,
  `report-components.test.ts`
- `apps/web/src/lib/features/report/overview/records.svelte`,
  `overview-page.svelte`, `executive-overview-model.ts`,
  `executive-overview-model.test.ts`, `overview-components.test.ts`
- `apps/web/src/lib/foundation/presentation/format.ts`, `format.test.ts`
- `apps/web/src/dashboard-metric-model.ts`
- `apps/web/e2e/session-viewport-geometry.spec.ts`,
  `drawer-value-presentation.spec.ts`, `production-report.spec.ts`,
  `shell-rail-geometry.spec.ts`, `dashboard.spec.ts`, `time-range.spec.ts`
- `apps/web/e2e/visual-regression.spec.ts-snapshots/overview-session-drawer.png`
  (regenerated only if Step 4 moves pixels)

**Out of scope** (do NOT touch):
- Root-vs-campaign naming anywhere in the drawer, the campaign suffix in
  `records.svelte` Top sessions, the "Campaign · N sessions" semantics —
  plan 088. If 088 left a `Campaign · {fmtNum(n)} sessions` suffix, Step 1
  may route it through the new count helper (pure pluralisation), nothing more.
- `apps/web/src/lib/features/report/range/report-range-model.ts`,
  `apps/web/src/date-range.ts`, `range/report-period-control.svelte` — plan 089
  (day count, filter bounds, date inputs). This plan only *imports*
  `rangeBounds`.
- `packages/report-core/**` — no `AnalyticsGroup` field, no change to how
  `priced`/`usageUnavailable` are counted, no change to `previousPeriodSummary`.
- The locked sentences of plan 056 (both stay verbatim).
- `activity-heatmap.svelte` (plan 094, U38), `executive-overview.svelte`
  (plans 093/094), `filter-bar.svelte` (092), `sessions/table/**` (091).
- The drawer's 44 px hit-area rule (`drawerBody` line 49) — keep it; Step 4
  works with it, not around it.
- `provenance-marker.svelte` / `session-cell.svelte` marker density — plan 091 (U14).

## Git workflow

- Work on the program branch `plan/086-ui-ux-audit-remediation` in this
  worktree; plans 087–097 land before this one.
- One commit for this plan, message exactly:
  `Session drawer, analysis, and report chrome polish` (child title; the
  program plan 086 requires it). Stage by explicit path — never `git add -A`
  (peer sessions share the checkout).
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: U09 — a count helper, used by the Busiest day record

1. In `apps/web/src/lib/foundation/presentation/format.ts`, after `fmtNum`
   (line 15), add:
   ```ts
   export const fmtCount = (count: number, noun: string, plural = `${noun}s`): string =>
     `${fmtNum(count)} ${count === 1 ? noun : plural}`;
   ```
2. In `format.test.ts` (`preserves report number and value labels`, lines
   5–14) add `expect(fmtCount(1, 'session')).toBe('1 session');`
   `expect(fmtCount(1234, 'session')).toBe('1,234 sessions');`
   `expect(fmtCount(0, 'day')).toBe('0 days');`.
3. In `records.svelte` lines 103–106 replace
   `· {fmtNum(presentedRecords.busiest.sessions)} sessions` with
   `· {fmtCount(presentedRecords.busiest.sessions, 'session')}` and add
   `fmtCount` to the import on line 22 (drop `fmtNum` from that import only if
   nothing else in the file uses it — line 140 does, unless 088 removed it).
4. Optional, same file: if the Top sessions suffix still reads
   `· Campaign · {fmtNum(item.sessionCount)} sessions` (line 140), switch it
   to `fmtCount(item.sessionCount, 'session')`; `overview-components.test.ts:94`
   (`'Campaign · 3 sessions'`) keeps passing.
5. In `breakdown/model.ts:107` replace the inline ternary in `sessionSummary`
   with `fmtCount(group.sessions, 'session')` (import it on line 11); the
   existing expectations in `model.test.ts` are unchanged by this.
6. Add an SSR assertion in `overview-components.test.ts`: load
   `/apps/web/src/lib/features/report/overview/records.svelte` through the
   existing `viteServer` and render it with
   `records: { busiest: { cost: 1.5, date: '2026-08-04T00:00:00.000Z', sessions: 1 }, longest: null, streak: 0, streakEnd: null, topCost: null }`,
   `topSessions: []`; assert `body` contains `· 1 session<` and does not
   contain `1 sessions`.

**Verify**: `cd apps/web && bun test src/lib/foundation/presentation/format.test.ts src/lib/features/report/overview/overview-components.test.ts src/lib/features/report/breakdown/model.test.ts` → all pass; `grep -n "sessions</span" apps/web/src/lib/features/report/overview/records.svelte` → no hit on the Busiest day record.

### Step 2: U29a — the drawer header can no longer clip the badge

1. `packages/design-system/src/svelte/overlays/styles.ts`:
   - `drawerTop` (lines 27–37): change `gridTemplateColumns` to
     `'auto minmax(0, 1fr)'` and **delete** the
     `'& > :first-child': { minW: 0, overflow: 'hidden' }` line. The badge
     keeps its intrinsic width; the navigation cluster owns the flexible
     track.
   - `drawerNav` (lines 67–75): change `'& button': { minH: '44px', minW: '44px' }`
     to `'& button': { minH: '44px', minW: '44px', flexShrink: 0 }`.
   - `drawerPosition` (lines 77–83): add
     `flex: '0 1 auto', minW: 0, overflow: 'hidden', textOverflow: 'ellipsis'`
     — when (and only when) space runs out, the *label* truncates; buttons and
     badge never do.
2. `styles.test.ts` lines 35–38: add
   `expect(drawerTop).toContain('grid-tc_auto_minmax(0,_1fr)');`
   `expect(drawerTop).not.toContain('ov_hidden');`
   `expect(drawerPosition).toContain('ov_hidden');`
   `expect(drawerPosition).toContain('ellipsis');`.
3. `session-drawer.svelte`:
   - Move the analysis toggle (lines 330–342, the whole `{#if snapshot.revision}` block) out of the
     `<nav>` and make it the **first** child of `<div class={drawerActions}>`
     (line 466). Keep every attribute (`aria-controls`, `aria-expanded`,
     `aria-label`, `class={ghostButton}`, `disabled`, `onclick`). The header
     nav is now: position label · ↑ · ↓ · ✕.
   - On the position span (line 307) add `data-session-drawer-position` and
     `title={positionLabel()}` (the full text survives truncation; the nav
     `aria-label` already carries it).
   - Wrap the badge so tests can address it:
     `<span data-session-drawer-harness><HarnessBadge name={row.harness} /></span>`
     (a plain inline wrapper; the grid's first track is `auto`).
4. e2e — `apps/web/e2e/production-report.spec.ts`:
   - After line 629 (`await expect(rootDrawer).toBeVisible();`) add a
     geometry block (this is the assertion that **fails today** — at 1280 px
     the nav needs ~400 px of 408 and the badge is clipped to its padding):
     ```ts
     const rootHeader = rootDrawer.locator('[data-session-drawer-header]');
     const rootBadge = rootHeader.locator('[data-session-drawer-harness] > *').first();
     const rootPosition = rootHeader.locator('[data-session-drawer-position]');
     await expect(rootPosition).toHaveText(/matching sessions$/);
     const headerGeometry = await rootHeader.evaluate((header) => {
       const badge = header.querySelector('[data-session-drawer-harness] > *');
       const position = header.querySelector('[data-session-drawer-position]');
       const navigation = header.querySelector('[data-session-drawer-navigation]');
       if (!(badge instanceof HTMLElement && position instanceof HTMLElement && navigation instanceof HTMLElement)) {
         throw new Error('Expected the drawer header badge, position label, and navigation');
       }
       const badgeBox = badge.getBoundingClientRect();
       return {
         badgeClipped: badge.scrollWidth > badge.clientWidth + 1,
         badgeRight: Math.round(badgeBox.right),
         badgeWidth: Math.round(badgeBox.width),
         headerOverflows: header.scrollWidth > header.clientWidth + 1,
         navigationOverflows: navigation.scrollWidth > navigation.clientWidth + 1,
         positionLeft: Math.round(position.getBoundingClientRect().left),
       };
     });
     expect(headerGeometry.badgeClipped).toBe(false);
     expect(headerGeometry.badgeWidth).toBeGreaterThan(40);
     expect(headerGeometry.badgeRight).toBeLessThanOrEqual(headerGeometry.positionLeft);
     expect(headerGeometry.navigationOverflows).toBe(false);
     expect(headerGeometry.headerOverflows).toBe(false);
     ```
   - Line 798: `expect(headerActionGeometry).toHaveLength(4)` → `toHaveLength(3)`
     and add, right after it,
     `await expect(drawerBody.getByRole('button', { name: 'Analyze root session chronology' })).toBeVisible();`
     (`drawerBody` is declared on line 786).
   - Line 638 and 746 (`Analyze root session chronology` clicks) need no
     change — `getByRole` on the drawer finds the button in the body.
5. e2e — `apps/web/e2e/session-viewport-geometry.spec.ts`, desktop test
   (lines 382–417): after the `actionGeometry` assertions add the same
   invariant (it passes before and after — a regression guard for the
   synthetic fixture): `[data-session-drawer-harness] > *` not clipped,
   `badgeRight <= positionLeft`, navigation and header not overflowing
   (reuse the evaluate block above; the label here is `"1 / N"`-shaped, assert
   `toHaveText(/\/|matching sessions/)`).

**Verify**: `bun test packages/design-system/src/svelte/overlays/styles.test.ts` → pass; `bun run --cwd apps/web test:e2e -- e2e/session-viewport-geometry.spec.ts e2e/drawer-value-presentation.spec.ts` → pass; `bun run --cwd apps/web test:e2e-production` → the new header block passes (run it once *before* editing styles/markup to watch `badgeClipped` be `true` — that is the symptom).

### Step 3: U29b — the compressed-gap hatch gets its own strip

1. `session-analysis.svelte` styles:
   - line 52 `axisTrack` → `css({ display: 'grid', gap: '2px', minW: 0 })`
     (no longer `position: relative`).
   - add `const axisBreaks = css({ position: 'relative', h: '14px', minW: 0 });`
   - `scaleBreakClass` (lines 59–67): `top: '-2px'` → `top: 0`.
2. `renderTimelineAxis` snippet (lines 450–473):
   - add `data-session-analysis-axis-labels` to the `axisLabels` div
     (line 455);
   - move the `{#each scale.breaks …}` block (lines 460–468) out of the
     labels' sibling position into a new
     `{#if scale.breaks.length > 0}<div aria-hidden="true" class={axisBreaks} data-session-analysis-axis-breaks>…{/each}</div>{/if}`
     rendered **after** the labels div, still inside `axisTrack`. Keep the
     `title={formatSessionDuration(scaleBreak.gapMs)}` and
     `style:left` on each `⫽` span.
3. `components.ssr.test.ts`, test at lines 207–253: add
   ```ts
   const axisLabels = html.indexOf('data-session-analysis-axis-labels');
   const axisBreaks = html.indexOf('data-session-analysis-axis-breaks');
   const hatch = html.indexOf('⫽');
   expect(axisLabels).toBeGreaterThan(-1);
   expect(axisLabels).toBeLessThan(axisBreaks);
   expect(axisBreaks).toBeLessThan(hatch);
   expect(html.slice(axisLabels, axisBreaks)).not.toContain('⫽');
   expect(html.match(/data-session-analysis-axis-breaks/g)).toHaveLength(2);
   ```
   (two timeline shells — tasks and phases — each get a strip; the existing
   `title="5h"` and `Compressed gaps` ×2 assertions stay).

**Verify**: `cd apps/web && bun test src/lib/features/sessions/detail/components.ssr.test.ts` → pass, including the five new lines; before the markup move, the `not.toContain('⫽')` line fails (the hatch sits between the labels and the `<ol>`).

### Step 4: U29c — one "i" affordance: the 14 px marker inside a transparent 44 px hit area

1. `packages/design-system/src/svelte.ts` lines 136–150: add
   `provenanceMarkerClass` to the `./svelte/overlays/styles` export list.
2. `drawer-detail-item.svelte`:
   - import `provenanceMarkerClass` from `@ai-usage/design-system/svelte`
     (the file already imports `Popover` from there).
   - replace `detailInfoButton` (lines 10–25) with a transparent hit area:
     ```ts
     const detailInfoButton = css({
       display: 'inline-grid',
       placeItems: 'center',
       w: '44px',
       h: '44px',
       m: '-14px -12px -14px 0',
       p: 0,
       border: 0,
       bg: 'transparent',
       color: 'muted',
       cursor: 'help',
       '&:hover > [data-detail-hint-glyph]': { borderColor: 'lineStrong', color: 'ink' },
       '&:focus-visible': { outline: 'none' },
       '&:focus-visible > [data-detail-hint-glyph]': { outline: '2px solid token(colors.accent)', outlineOffset: '2px' },
     });
     ```
     The negative vertical margins keep the label row at text height while
     the button's box stays 44×44 (the `drawerBody` rule is satisfied, not
     fought); `mr: -12px` is the grid column gap, so the glyph's visual edge
     sits inside its column.
   - trigger snippet (lines 93–95):
     `<span aria-hidden="true" class={provenanceMarkerClass} data-detail-hint-glyph>i</span>`.
3. `components.ssr.test.ts` lines 196–204: add
   `expect(detail).toContain('data-detail-hint-glyph');` and
   `expect(detail).toContain(provenanceMarkerClass);` — import
   `provenanceMarkerClass` from `@ai-usage/design-system/svelte` at the top of
   the test (the test already resolves workspace packages through Vite; if the
   bare import fails under `bun test`, import it from
   `'../../../../../../../packages/design-system/src/svelte/overlays/styles'`).
4. `apps/web/e2e/drawer-value-presentation.spec.ts`, after line 18
   (`toHaveAttribute('aria-haspopup', 'dialog')`) and before the click, add:
   ```ts
   const hintGeometry = await subValueHelp.evaluate((button) => {
     const glyph = button.querySelector('[data-detail-hint-glyph]');
     const row = button.parentElement;
     if (!(glyph instanceof HTMLElement && row instanceof HTMLElement)) {
       throw new Error('Expected the hint glyph inside its label row');
     }
     const style = getComputedStyle(button);
     return {
       borderWidth: style.borderTopWidth,
       background: style.backgroundColor,
       glyphWidth: Math.round(glyph.getBoundingClientRect().width),
       hitHeight: Math.round(button.getBoundingClientRect().height),
       hitWidth: Math.round(button.getBoundingClientRect().width),
       rowHeight: Math.round(row.getBoundingClientRect().height),
     };
   });
   expect(hintGeometry.hitWidth).toBeGreaterThanOrEqual(44);
   expect(hintGeometry.hitHeight).toBeGreaterThanOrEqual(44);
   expect(hintGeometry.borderWidth).toBe('0px');
   expect(hintGeometry.background).toBe('rgba(0, 0, 0, 0)');
   expect(hintGeometry.glyphWidth).toBeLessThanOrEqual(16);
   expect(hintGeometry.rowHeight).toBeLessThanOrEqual(24);
   ```
   Today this fails on `borderWidth` (`1px`), `background` (`surfaceMuted`),
   and `rowHeight` (44).
5. Run `cd apps/web && bun run test:e2e -- e2e/visual-regression.spec.ts`. If
   `overview-session-drawer.png` differs (it will — the drawer body shows
   hint triggers), regenerate with `--update-snapshots`, open the PNG, and
   confirm the only change is the lighter "i" glyphs (and, if Step 2 shifted
   it, the header). Do not add a snapshot.

**Verify**: `bun run --cwd apps/web test:e2e -- e2e/drawer-value-presentation.spec.ts e2e/visual-regression.spec.ts` → pass; `bun run lint` → exit 0 (the new export has a consumer).

### Step 5: U29d — say what "Resolve GitHub links" does

1. `session-vcs-summary.svelte`:
   - `resolveLabel()` (lines 135–140): `'Resolve GitHub links'` →
     `'Find pull requests on GitHub'`; `'Retry GitHub lookup'` → keep;
     `'Resolving GitHub links…'` → `'Looking up pull requests…'`.
   - button `aria-label` (lines 272–274):
     `'Resolve GitHub repository and pull request links'` →
     `'Find pull requests for the recorded branch on GitHub'`;
     `'Resolving GitHub repository and pull request links'` →
     `'Looking up pull requests for the recorded branch on GitHub'`.
   - Immediately before the `{#if canResolve}` button (line 270) add, inside
     the same `{#if canResolve}` guard so it appears only with the button:
     `<p class={note}>Uses the GitHub CLI (gh) signed in on this machine to list pull requests whose head is the recorded branch. Only that lookup leaves the machine, and only when you click.</p>`
   - `unavailableMessage()` default branch (line 132): `'GitHub lookup is unavailable.'`
     → `'GitHub lookup is unavailable — the gh CLI was not found or returned nothing usable.'`
     (the `resolver-unavailable` reason covers both, see
     `session-vcs.server.ts:155–162, 194–197`).
   - line 265 `Resolving GitHub links…` → `Looking up pull requests…`.
2. `components.ssr.test.ts` (`keeps unavailable Retry semantics and sanitized VCS links exact`,
   lines 282–299): add `expect(vcs).toContain('Find pull requests on GitHub');`
   `expect(vcs).toContain('Uses the GitHub CLI (gh)');`
   `expect(vcs).not.toContain('Resolve GitHub links');`.
3. `production-report.spec.ts` line 636: the accessible name →
   `'Find pull requests for the recorded branch on GitHub'`.

**Verify**: `grep -rn "Resolve GitHub" apps/web/src apps/web/e2e` → no matches; `cd apps/web && bun test src/lib/features/sessions/detail/components.ssr.test.ts` → pass.

### Step 6: U10 — the coverage cell names the consequence

1. `breakdown/model.ts`:
   - `unavailableCounterQualification` (lines 174–180) → return
     `${fmtNum(group.usageUnavailable)} of ${fmtNum(group.sessions)} sessions without token counters`
     (drop the `has/have` verb; the phrase is reused by both cells).
   - `pricingCoveragePresentation` (lines 195–198): when
     `unavailableQualification` is non-null push
     `` `${unavailableQualification} · API value is a lower bound` `` instead
     of the bare phrase. The complete coverage label is legitimate pricing
     coverage; the second line now says why the value shows `≥`.
2. `model.test.ts` lines 185–201 (`qualifies mixed missing counters…`):
   `pricingQualification: '1 of 3 sessions without token counters · API value is a lower bound'`,
   `processedTokensQualification: '1 of 3 sessions without token counters'`;
   the `pricingCoverageLabel: '3 / 3 · 100%'`, `value`, `valuePerMillion`
   expectations stay.
3. `model-analysis-table.ssr.test.ts`: add a fourth group to the first test,
   `group('counterless', { costSum: 4, priced: 3, sessions: 3, usageUnavailable: 1 })`,
   bump the `scope="row"` count expectation (it is `groups.length`, so it
   follows), and assert the table body contains
   `'3 / 3 · 100%'` **and** `'1 of 3 sessions without token counters · API value is a lower bound'`
   inside the same `<td>` (slice the body from the label to the next `</td>`
   and assert the qualification is in that slice), and that the mobile card
   slice (`body.slice(body.indexOf('data-model-analysis-cards'))`) contains
   the same qualification once.

**Verify**: `cd apps/web && bun test src/lib/features/report/breakdown/model.test.ts src/lib/features/report/breakdown/model-analysis-table.ssr.test.ts` → pass.

### Step 7: U31 — "Data as of", not "Generated"

1. `report-view-model.ts` lines 98–103: replace `reportGeneratedLabel` with
   two exports (keep `dateTimeFormatter`):
   ```ts
   /**
    * The stored report revision's assembly time. Renewing an unchanged revision keeps it
    * (`served-report-store.ts` renews `published_at` only), so it moves when collected data
    * changed — never because the reader navigated.
    */
   export const reportFreshnessTime = (generatedAt: string): string =>
     dateTimeFormatter.format(new Date(generatedAt));

   export const reportFreshnessLabel = (generatedAt: string | null, hasReportData: boolean): string => {
     if (!(hasReportData && generatedAt)) {
       return 'Report payload unavailable';
     }
     return `Data as of ${reportFreshnessTime(generatedAt)}`;
   };
   ```
2. `report-header.svelte` line 39 → render the label with a machine-readable
   time and an explanation (visible text must be exactly
   `Data as of <Mon DD, HH:MM>`):
   ```svelte
   <div
     class={meta}
     data-report-freshness
     title="When the stored report was last assembled from collected usage. It changes only when the data changes, not when you navigate."
   >
     {#if hasReportData && generatedAt}
       Data as of <time datetime={generatedAt}>{reportFreshnessTime(generatedAt)}</time>
     {:else}
       {reportFreshnessLabel(generatedAt, hasReportData)}
     {/if}
   </div>
   ```
3. `report-view-model.test.ts` line 41 → `toBe('Data as of Aug 01, 10:00')`
   (rename the import); line 63 unchanged. In
   `report-components.test.ts` (`renders filters, period, active summary, then
   the Overview in decision order`, lines 154–170, demo payload) add
   `expect(body).toContain('data-report-freshness');` and
   `expect(body).toMatch(/Data as of Jun 11, \d{2}:\d{2}/);` (the unit runner's
   time zone is not pinned, so do not assert the hour there).
4. `apps/web/e2e/dashboard.spec.ts` test at lines 66–79 (e2e runs with
   `TZ=UTC`): add
   `expect(initialHtml).not.toContain('Generated ');`
   `await expect(page.locator('[data-report-freshness]')).toHaveText('Data as of Jun 11, 12:00');`
   `await expect(page.locator('[data-report-freshness] time')).toHaveAttribute('datetime', '2026-06-11T12:00:00.000Z');`.

**Verify**: `grep -rn "reportGeneratedLabel\|Generated \${" apps/web/src` → no matches; `cd apps/web && bun test src/lib/features/report/core/report-view-model.test.ts src/lib/features/report/core/report-components.test.ts` → pass; `bun run --cwd apps/web test:e2e -- e2e/dashboard.spec.ts` → pass.

### Step 8: U33 — reserve the scrollbar gutter on the scroll root

1. `packages/design-system/src/preset.ts` globalCss `html` (lines 18–28): add
   `scrollbarGutter: 'stable',` next to `scrollPaddingTop` with a one-line
   comment: "The shell is a centred max-width container; without a reserved
   gutter every sub-tab whose height crosses the viewport re-centres the page
   by half a scrollbar."
2. `preset.test.ts`: before the hash test (line 149) add
   `test('reserves a stable scrollbar gutter on the document scroll root', () => { expect((aiUsagePreset.globalCss as { html: { scrollbarGutter?: string } }).html.scrollbarGutter).toBe('stable'); });`
   then recompute the hash with the command from the table and replace the
   literal on line 151.
3. `apps/web/e2e/shell-rail-geometry.spec.ts`, inside the loop after the
   `scrollWidth <= clientWidth` assertion (lines 50–52), add
   `expect(await page.evaluate(() => getComputedStyle(document.documentElement).scrollbarGutter)).toBe('stable');`.
   (Headless Chromium hides scrollbars, so computed style is the observable;
   do not try to measure the shift.)

**Verify**: `bun test packages/design-system/src/preset.test.ts` → pass with the new hash; `bun run --cwd apps/web test:e2e -- e2e/shell-rail-geometry.spec.ts` → pass; `bun run typecheck` → exit 0.

### Step 9: U37 (copy) — pick the comparison sentence by the boundary, not the range mode

1. `apps/web/src/dashboard-metric-model.ts`: extend the state resolver
   without touching either sentence:
   ```ts
   export interface MetricComparisonBoundary {
     /** Resolved start of the current period; null for the full range. */
     readonly rangeFrom: Date | null;
     /** Earliest recorded activity under the current filters (ISO), or null when nothing is recorded. */
     readonly recordedFirst: string | null;
   }

   const nothingRecordedBefore = (boundary: MetricComparisonBoundary | undefined): boolean =>
     Boolean(
       boundary?.rangeFrom &&
         boundary.recordedFirst !== null &&
         Date.parse(boundary.recordedFirst) >= boundary.rangeFrom.getTime(),
     );

   export const metricComparisonStateFor = (
     rangeMode: DateRangeMode,
     previousSummary: object | null | undefined,
     boundary?: MetricComparisonBoundary,
   ): MetricComparisonState => {
     if (previousSummary) {
       return 'available';
     }
     return rangeMode === 'all' || nothingRecordedBefore(boundary) ? 'full-range' : 'no-prior-data';
   };
   ```
   Semantics: the previous equal-length window lies entirely before the
   first recorded row ⇔ "no previous period exists before the recorded
   range" — the plan-056 full-range sentence; a previous window that overlaps
   recorded history but holds no sessions keeps the bounded sentence.
2. `executive-overview-model.ts`: add
   `readonly comparisonBoundary?: MetricComparisonBoundary;` to
   `ExecutiveOverviewModelInput` (lines 29–36) and pass it through
   `comparisonFor` (lines 100–118) as the third argument.
3. `overview-page.svelte` lines 67–76: import `rangeBounds` from
   `'../range/report-range-model'` and pass
   ```ts
   comparisonBoundary: {
     rangeFrom: rangeBounds(range, new Date(result.metadata.generatedAt)).from,
     recordedFirst: result.dateDomain?.first ?? null,
   },
   ```
4. `executive-overview-model.test.ts`: keep the two existing cases (lines
   205–213, 223–241 — the second still resolves to `no-prior-data` because it
   passes no boundary) and add three:
   - `rangeMode: '90d'`, `previousSummary: null`,
     `comparisonBoundary: { rangeFrom: new Date('2026-03-13T00:00:00.000Z'), recordedFirst: '2026-04-12T09:20:00.000Z' }`
     → `state: 'full-range'`, `explanation: 'No previous period exists before the full recorded range.'`;
   - `rangeMode: '30d'`, `previousSummary: null`,
     `comparisonBoundary: { rangeFrom: new Date('2026-05-12T00:00:00.000Z'), recordedFirst: '2026-04-12T09:20:00.000Z' }`
     → `state: 'no-prior-data'`, `explanation: 'No sessions exist in the previous period.'`;
   - `rangeMode: 'custom'`, `previousSummary: null`,
     `comparisonBoundary: { rangeFrom: new Date('2026-04-12T00:00:00.000Z'), recordedFirst: '2026-04-12T09:20:00.000Z' }`
     → `state: 'full-range'`.
5. `apps/web/e2e/time-range.spec.ts` line 274: the 90d deep link starts
   2026-03-13 and the fixture's first row is 2026-04-12, so the sentence
   becomes the full-range one —
   `await expect(executiveValue).toContainText('No previous period exists before the full recorded range.');`
   and line 322 → `not.toContainText('No previous period')` (the comparison
   case with the 2026-02-12 row keeps its delta sentence). If after the change
   line 274 still shows the bounded sentence, the fixture's first row is not
   what "Current state" says — STOP and report the actual `dateDomain.first`.

**Verify**: `cd apps/web && bun test src/lib/features/report/overview/executive-overview-model.test.ts src/lib/features/report/overview/overview-components.test.ts` → pass (three new cases); `bun run --cwd apps/web test:e2e -- e2e/time-range.spec.ts` → pass; `git diff --stat -- apps/web/src/lib/features/report/range/report-range-model.ts apps/web/src/date-range.ts` → empty.

### Step 10: Gates

`bun x ultracite fix && bun run check && bun run lint && bun run typecheck && bun test packages/design-system/src && bun run --cwd apps/web test && bun run --cwd apps/web test:e2e && bun run --cwd apps/web test:e2e-production`
→ all exit 0. Then the PII guard from the commands table → no output. Then
update the 098 row in `plans/README.md` and commit (message in "Git workflow").

## Test plan

- **U09**: `format.test.ts` (`fmtCount` singular/plural/thousands),
  `overview-components.test.ts` (`· 1 session<` in a rendered `Records`).
- **U29a**: `styles.test.ts` token assertions (`grid-tc_auto_minmax(0,_1fr)`,
  ellipsis on the label, no `ov_hidden` on the header);
  `production-report.spec.ts` computed-geometry block (badge not clipped,
  badge right ≤ label left, nav/header not overflowing; fails at `51815b70`);
  `session-viewport-geometry.spec.ts` same invariant on the synthetic
  fixture; header button count 4 → 3 in the mobile production test.
- **U29b**: `components.ssr.test.ts` DOM-order assertions (labels row,
  then the breaks strip, then the `⫽` glyph; no glyph between the two).
- **U29c**: `drawer-value-presentation.spec.ts` computed style/geometry
  (transparent borderless 44 px hit area, ≤ 16 px glyph, ≤ 24 px label row);
  `components.ssr.test.ts` asserts the shared `provenanceMarkerClass` token on
  the glyph; `overview-session-drawer.png` regenerated and eyeballed.
- **U29d**: SSR copy assertions; production e2e accessible name.
- **U10**: `model.test.ts` and `model-analysis-table.ssr.test.ts` — the
  qualification names the consequence in the same cell as `100%`.
- **U31**: `report-view-model.test.ts` label; `dashboard.spec.ts` exact text
  `Data as of Jun 11, 12:00`, `<time datetime>`, and no `Generated ` in the
  SSR HTML.
- **U33**: `preset.test.ts` explicit `scrollbarGutter === 'stable'` plus the
  recomputed hash; `shell-rail-geometry.spec.ts` computed style on
  `documentElement` at eight viewports.
- **U37**: three new model cases; `time-range.spec.ts` 90d deep link flips to
  the full-range sentence and the comparison case keeps its delta.

## Done criteria

- [ ] `grep -rn "Resolve GitHub\|Generated \${\|reportGeneratedLabel" apps/web/src apps/web/e2e` → no matches
- [ ] `grep -n "scrollbarGutter: 'stable'" packages/design-system/src/preset.ts` → 1 hit; `bun test packages/design-system/src/preset.test.ts` passes with the recomputed hash
- [ ] `grep -n "grid-tc_auto_minmax" packages/design-system/src/svelte/overlays/styles.test.ts` → 1 hit; `grep -c "first-child" packages/design-system/src/svelte/overlays/styles.ts` → 0
- [ ] `grep -n "data-session-analysis-axis-breaks" apps/web/src/lib/features/sessions/detail/session-analysis.svelte` → 1 hit
- [ ] `grep -n "data-detail-hint-glyph" apps/web/src/lib/features/sessions/detail/drawer-detail-item.svelte` → ≥ 1 hit; `grep -n "provenanceMarkerClass" packages/design-system/src/svelte.ts` → 1 hit
- [ ] `grep -n "fmtCount" apps/web/src/lib/features/report/overview/records.svelte apps/web/src/lib/foundation/presentation/format.ts` → ≥ 2 hits
- [ ] `grep -n "API value is a lower bound" apps/web/src/lib/features/report/breakdown/model.ts` → 1 hit
- [ ] `grep -n "comparisonBoundary" apps/web/src/lib/features/report/overview/overview-page.svelte` → 1 hit; both plan-056 sentences still present verbatim in `apps/web/src/dashboard-metric-model.ts`
- [ ] `git diff --stat 51815b70..HEAD -- packages/report-core apps/web/src/lib/features/report/range/report-range-model.ts apps/web/src/date-range.ts` shows no change from this plan's commit
- [ ] `bun run lint && bun run typecheck` exit 0
- [ ] `bun test packages/design-system/src && bun run --cwd apps/web test` exit 0
- [ ] `bun run --cwd apps/web test:e2e && bun run --cwd apps/web test:e2e-production` exit 0
- [ ] Exactly four PNGs remain under `apps/web/e2e/visual-regression.spec.ts-snapshots/`
- [ ] `git status` shows no modified file outside the in-scope list
- [ ] PII guard empty; `plans/README.md` row 098 updated

## STOP conditions

Stop and report back (do not improvise) if:

- An in-scope file other than `session-drawer.svelte`, `records.svelte`,
  `overview-page.svelte`, `preset.ts`/`preset.test.ts` differs from
  `51815b70`, or one of those four no longer contains an excerpt quoted above
  (text search, not line numbers).
- Plan 088 moved the analysis toggle, the position label, or the badge out of
  `[data-session-drawer-header]`, or renamed `data-session-drawer-navigation`
  — report the new header shape instead of re-laying it out twice.
- After Step 2 the production-report header block still reports
  `badgeClipped: true` or `navigationOverflows: true` at 1280 px — the
  navigation cluster has more content than this plan assumed (report the
  measured widths; do not shrink the 44 px controls).
- `drawer-value-presentation.spec.ts` cannot find
  `About Subscription value` after Step 4 (the Popover trigger lost its
  accessible name) — report, do not add a second label.
- The SSR test cannot import `provenanceMarkerClass` by either path given in
  Step 4.3.
- `time-range.spec.ts:274` does not flip after Step 9 (fixture's first row is
  not 2026-04-12) — report the observed `dateDomain.first`.
- Any test asserts the exact text `Generated ` or `Resolve GitHub links`
  outside the files listed in Scope.
- Plan 093 changed `preset.ts` and its hash test in a way that the recomputed
  hash in Step 8 would overwrite an intermediate, uncommitted value — commit
  order matters; report rather than guess.

## Maintenance notes

- `fmtCount` is the single pluralisation helper; the remaining inline
  `=== 1 ? 'session' : 'sessions'` ternaries (`activity-heatmap.svelte:69`,
  `executive-overview-model.ts:204`) belong to other plans' files and can be
  migrated opportunistically by whoever edits them next.
- The drawer header now has one rule: the badge track is `auto`, the
  navigation track is flexible, and only the position label may truncate.
  Anything new in the header must be a 44 px icon control or go to the body
  actions row (where the analysis toggle now lives).
- `provenanceMarkerClass` is now the app's only "i" glyph style (table
  markers and drawer hints). A drawer hint trigger stays a 44 px transparent
  hit area around it; do not reintroduce a bordered trigger.
- `MetricComparisonBoundary` keeps plan 056's two sentences honest: the
  full-range sentence means "nothing is recorded before this period", the
  bounded sentence means "the previous window overlaps history but is
  empty". If report-core ever echoes the resolved query range in
  `FocusedOverviewResult`, replace the `rangeBounds` call with that value.
- The preset hash in `preset.test.ts` will change again whenever any plan
  touches tokens or globalCss; the explicit `scrollbarGutter` assertion is
  the one that names this plan's intent.
- Reviewer should scrutinise: the negative margins on the hint trigger
  (hit area must not overlap a neighbouring *control*; it overlaps the next
  column's label text by ≤ 3 px on purpose), the regenerated
  `overview-session-drawer.png`, and that no sentence from plan 056 changed.
- Deferred (not in this plan): a true "Updated N minutes ago" relative
  freshness label (needs a client clock and a refresh policy); per-machine
  freshness in the header (plan 080's rail already shows stale machines).
