# Plan 093: Activity Explorer Controls, Model Palette, and Hero Number Format

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 51815b70..HEAD -- apps/web/src/lib/features/report/range/activity-explorer.svelte apps/web/src/lib/features/report/range/range-brush.svelte apps/web/src/lib/features/report/range/report-range-model.ts apps/web/src/lib/features/report/range/report-range-model.test.ts apps/web/src/lib/features/report/overview/activity-timeline.svelte apps/web/src/lib/features/report/overview/timeline-model.ts apps/web/src/lib/features/report/overview/timeline-model.test.ts apps/web/src/lib/features/report/overview/timeline-window.ts apps/web/src/lib/features/report/overview/timeline-window.test.ts apps/web/src/lib/features/report/overview/executive-overview.svelte apps/web/src/lib/features/report/overview/overview-components.test.ts apps/web/src/lib/foundation/presentation/format.ts apps/web/src/lib/foundation/presentation/format.test.ts apps/web/src/api-value.test.ts apps/web/src/lib/features/report/breakdown/model.test.ts packages/design-system/src/preset.ts packages/design-system/src/preset.test.ts packages/design-system/src/components/chart.ts packages/design-system/src/components/chart.test.ts packages/design-system/src/components/executive-overview.ts packages/design-system/src/components/executive-overview.test.ts apps/web/e2e/time-range.spec.ts apps/web/e2e/dashboard-presentation.spec.ts apps/web/src/focused-report-e2e-fixture.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition. Plan 089 (period semantics) edits
> `report-range-model.ts` lines 82–90, `timeline-window.ts`, and
> `activity-explorer.svelte` in hunks that do not overlap this plan's; if 089
> has already landed on the program branch, re-read those three files before
> Step 1 and rebase the excerpts mentally — do not revert 089's changes.

## Status

- **Priority**: P1
- **Effort**: M–L (four findings, one commit; Steps 1–3 are U17, Steps 4–6
  are U18, Step 7 is U34, Step 8 is the U04 chart part, Step 9 is gates)
- **Risk**: MED (a design-token addition changes the pinned preset hash and two
  visual-regression snapshots; a shared 2-button control that three e2e specs
  select by role becomes a 4-button control)
- **Depends on**: none (coordinate with plan 089 on the three shared files
  named in the drift check)
- **Category**: presentation / UX
- **Planned at**: commit `51815b70`, 2026-08-23
- **Audit findings**: U17, U18, U34, plus the single-day chart-rendering part
  of U04 (plan 089 owns the `0 days` count and the partial-day comparison
  caveat)

## Why this matters

The 2026-08-23 fresh-eyes audit (Chrome headless via CDP, all routes,
1920/1280/1024/768/390, dark and light) found four presentation defects in the
one panel every reader meets first — the Activity explorer and the hero value
next to it:

- **U17** — two controls drive one piece of state. The "API value / Tokens"
  toggle above the chart and the four-option "Metric" chooser inside
  "Explore activity" both set `value`; choosing Share or Sessions in the
  chooser leaves the toggle with nothing selected. The "Exact report window"
  slider is a bare pill: no ticks, no dates on the track, so the reader cannot
  tell where a month starts without dragging a handle and reading its
  `aria-valuetext`.
- **U18** — "Group by: Model" paints series from a 6-entry palette indexed by
  a string hash modulo 6. Two of the synthetic model keys in the audit hashed
  to the same slot (`stableHueFor('gpt-5.6-sol') % 6 === 2` and
  `stableHueFor('claude-opus-5') % 6 === 2`, both `chart.c3`), so the top two
  series — 76 % and 11 % of value — were the same lavender. With up to twelve
  named series and six colours, collisions are guaranteed, not unlucky. The
  `Other` series' member disclosure ("58 grouped") renders as a block under
  its legend entry and floats alone below the legend row.
- **U34** — the hero reads `≥ $14134.47`: no thousands separator while the KPI
  tiles beside it use `fmtNum` and read `36,971`; at 1024 px the KPI column is
  ~340 px wide, the 52 px mono value does not fit, and `overflow-wrap: anywhere`
  breaks after `≥`, leaving the symbol alone on a line.
- **U04 (chart part)** — a single-day window renders one bucket as a
  full-width, full-height bar; the peak label (`$111.91`, absolutely positioned
  top-right with a surface background) is drawn over the bar's corner and reads
  as a notch cut out of it.

Maintainer preferences that bound the fixes (from `plans/README.md` and
memory): dense stacked bars with **every model its own colour**; the legend
total is Sessions-only; the hero value tracks the brush live; provenance
(`≥`, "Partially measured") is per metric and stays; the `Other` series never
becomes a filter (plan 082 delivered its member disclosure — keep it, just put
it on the right line). Plan 073's decision D012 keeps the metric a **local,
zero-RPC presentation choice** — this plan keeps that core and only retires
D012's consequence that "the executive control exposes only API value and
Tokens".

## Current state

### U17 — the duplicated metric control and the bare slider

- `apps/web/src/lib/features/report/range/activity-explorer.svelte`
  - lines 17–18, the two local styles of the top-level toggle:
    `const executiveMetricGroup = css({ border: 0, m: 0, minW: 0, order: { md: -1 }, p: 0 });`
    `const executiveMetricButton = css({ minH: '44px' });`
  - lines 218–227, two item lists for the same state:
    ```ts
    const valueItems = [
      { label: 'Estimated API-equivalent value', value: 'cost' },
      { label: 'Tokens', value: 'tokens' },
      { label: 'Sessions', value: 'sessions' },
      { label: 'Share', value: 'share' },
    ] as const;
    const executiveValueItems = [
      { label: 'API value', value: 'cost' },
      { label: 'Tokens', value: 'tokens' },
    ] as const;
    ```
  - line 234: `const executiveValue = $derived(executiveTimelineValue(value));`
    — null for `sessions`/`share`, which is exactly why the toggle goes blank.
  - lines 407–411, `changeValue` already accepts all four values.
  - lines 438–450, the top-level toggle:
    `<fieldset aria-label="Activity metric" class={cx(presetGroup, executiveMetricGroup)}>` …
    `{#each executiveValueItems as item (item.value)}` …
    `aria-pressed={executiveValue === item.value}` …
    `data-active={executiveValue === item.value ? 'true' : 'false'}`.
  - lines 451–457, the disclosure summary:
    `<span class={timeChartOptionsCurrent}>Grouping, interval, metric, exact dates</span>`.
  - lines 459–462, `<span>Exact report window</span><span>{projection.summary}</span>`.
  - lines 463–506, the brush: `<div class={timeSliderBrushColumn} data-report-range-part="brush">`
    wrapping `<div class={timeSliderBrushTrack} …>` with the range, dims, pan
    button and two `role="slider"` handles positioned by
    `style:left={`${percentFor(index)}%`}` (line 502). Nothing else is drawn on
    or under the track.
  - lines 507–523, `<div class={timeRangeViewControls}>` holding three
    `SegmentedControl`s; line 522 is the duplicate:
    `<SegmentedControl ariaLabel="Metric" items={valueItems} label="Metric" onValueChange={changeValue} {value} />`.
  - `activeProjection.domainFirst` / `activeProjection.maxIndex` (lines
    179–187) are the brush's day-indexed domain; `percentFor(index)` (184–185)
    is the one percent mapping the handles already use.
- `apps/web/src/lib/features/report/range/range-brush.svelte` lines 226–269 —
  the period control's custom-mode brush (`data-report-range-part="period-brush"`)
  is the same track markup with the same `percentFor` (lines 85–86) and no
  axis either.
- `apps/web/src/lib/features/report/overview/timeline-model.ts` lines 52–55:
  `export type ExecutiveTimelineValue = Extract<TimelineValue, 'cost' | 'tokens'>;`
  `export const executiveTimelineValue = (value: TimelineValue): ExecutiveTimelineValue | null => …`
  — the only production consumer is `activity-explorer.svelte:71,234`.
  `timeline-model.test.ts` lines 55–60 pin it
  (`test('only marks an executive metric toggle with one of its own values'`).
- `apps/web/src/lib/features/report/range/report-range-model.ts` — the brush
  domain comes from `reportRangeProjection` (lines 61–92): `domainFirst`
  (line 75) is `min(dataFirst, selectedFrom)` and `maxIndex` (line 77) is
  `dateIndexFrom(domainLast, domainFirst)`. **Lines 82 and 90 (`days` and the
  summary string) belong to plan 089 — do not touch them.** `dateFromIndex` /
  `shiftCalendarDays` live in `apps/web/src/date-range.ts:60–71`.
- `apps/web/src/lib/features/report/overview/timeline-window.ts` lines
  14–15 and 156–190: the chart's own month-tick rule
  (`MONTH_TICK_MINIMUM_BUCKETS = 8`, `MAX_VISUAL_TICKS = 14`,
  `visibleTimelineMonthTicks`, January stamped `Jan ’27`) and line 21
  `const monthTickFormatter = new Intl.DateTimeFormat('en', { month: 'short' });`
  — the label convention the brush axis should copy.
- `apps/web/src/lib/features/report/range/report-range-model.test.ts` lines
  140–158, `test('keeps the executive API value and Tokens toggle above advanced activity options'`,
  pins the source strings `aria-pressed={executiveValue === item.value}`,
  `data-active={executiveValue === item.value ? 'true' : 'false'}`,
  `{ label: 'API value', value: 'cost' }`, `{ label: 'Tokens', value: 'tokens' }`,
  and `<fieldset aria-label="Activity metric"`.
- `apps/web/e2e/time-range.spec.ts`:
  - line 145 pins the ordered part list
    `['total-legend', 'chart', 'chart-axis', 'activity-explorer', 'brush']`.
  - line 162: `await expect(chartOptions.getByText('Metric', { exact: true })).toBeVisible();`
  - lines 175–222, `test('switches API value and processed tokens locally without changing report identity'`:
    `await expect(metricControl.getByRole('button')).toHaveCount(2);` (line 182)
    and lines 204–210 select Sessions through
    `.getByRole('radiogroup', { name: 'Metric' }).getByRole('radio', { exact: true, name: 'Sessions' })`
    then assert **both** toggle buttons are `aria-pressed="false"` — the test
    codifies the U17 symptom.
  - lines 237–241: `toHaveCount(2)` and the ≥ 44 px height loop at 390 px.
  - lines 423–426: `for (const option of ['Share', 'Sessions', 'Tokens', 'Estimated API-equivalent value'])` → radios.
  - lines 445–447, 456, 843, 847: `chartOptions.getByRole('radio', { exact: true, name: 'Sessions' })` /
    `'Estimated API-equivalent value'` / `'Share'`.
  - lines 31–37 `BRUSH_GEOMETRY_VIEWPORTS` (1440/1024/768/361) and lines
    623–656 `test('anchors the brush handles to the selected report window at every viewport'`
    — the geometry harness (`readBrushGeometry`, lines 53–79) the axis test
    extends.
  - lines 97–104 `openActivityExplorer`, line 94 `activityFor`.
- The synthetic e2e domain: `apps/web/src/report-data.ts` rows span
  2026-04-12 → 2026-06-11 with `generatedAt: '2026-06-11T12:00:00.000Z'`
  (line 214); the default 30d range therefore projects a brush domain of
  Apr 12 → Jun 11 (`maxIndex` 60) with month boundaries at index 19 (May) and
  index 50 (Jun). `time-range.spec.ts:616–620` shows the domain shrinks to 7
  days when a filter narrows the data (`aria-valuemax` `'7'`) — the axis needs
  a short-domain mode.

### U18 — hash-indexed model palette and the orphan disclosure

- `packages/design-system/src/components/chart.ts`:
  - lines 4–11: `export const chartSwatchClasses = [css({ bg: 'chart.c1' }), … css({ bg: 'chart.c6' })];`
  - lines 13–24: `stableHueFor` (string hash mod 360), `stableSeriesColor`,
    `stableSeriesIndex = (value, itemCount) => itemCount > 0 ? stableHueFor(value) % itemCount : 0`.
  - lines 39–60 `dimensionSwatch(dimension, key)`; the model branch (49–52):
    `const className = chartSwatchClasses[stableSeriesIndex(key, chartSwatchClasses.length)];`
    — six slots, hash-indexed, no knowledge of rank or of the `Other` series.
    `campaign | machine | origin | project | provider` use `stableSeriesColor`
    (hash hue, HSL 42 % 60 %), harness uses branded tokens via `harnessFillFor`.
  - `chart.test.ts` lines 4–15 pin `stableSeriesIndex('gpt-5', 6) === 3`,
    `stableSeriesIndex('claude-sonnet', 6) === 4` and that two specific model
    keys differ — a property that is false for other pairs.
- `packages/design-system/src/preset.ts` lines 135–144, the categorical tokens:
  ```ts
  chart: {
    c1: dual('#9B4210', '#F19A57'),
    c2: dual('#0E7569', '#46C3AC'),
    c3: dual('#6A47C8', '#AC92F2'),
    c4: dual('#2061B4', '#7FA9E8'),
    c5: dual('#647722', '#A9BB5E'),
    c6: dual('#0F6FA8', '#5FB5E2'),
  },
  ```
  `c2`, `c3`, `c4`, `c6` equal `harness.codex/cursor/opencode/gemini.fg`
  (lines 157–161). Measured at planning time in OKLab (×100): `c4 ↔ c6` is
  ΔE 5.0 light / 5.2 dark — a second near-identical pair already inside the
  six. `session-analysis.svelte:113–120` also reads `chart.c1..c6` as phase
  tones; the token values must not change, only be added to.
- `packages/design-system/src/preset.test.ts` lines 149–152 pin the preset:
  `expect(presetHash).toBe('f4ea6ba5b77516c81b7ba1a950a36135b54e80ebc43b0a52055795c27b13b15d');`
  and lines 107–125 assert `chart.c1 !== accent`, `!== harness.claude.fg`,
  `!== status.warn` per scheme.
- `apps/web/src/lib/features/report/overview/activity-timeline.svelte`:
  - line 362: `const swatchFor = (key: string): DimensionSwatch => (timeline ? dimensionSwatch(timeline.dimension, key) : {});`
    — called for legend swatches (line 382) and bar segments (line 457) with
    the key only. Rank is already available: `visibleTimelineBars` gives each
    segment a `rank` (`timeline-window.ts:113,123`), and `legendSeries` (lines
    226–230) preserves `timeline.series` order, which `focused-report-query.ts`
    ranks by cost, then sessions, then key (lines 816–819; `MAX_TIMELINE_SERIES = 12`
    at line 417; the tail beyond 11 collapses into one `Other` series with
    `memberKeys`, lines 828–895).
  - lines 378–419, each legend entry is a bare `<li>` (line 384) holding the
    `legendButton` and, for the aggregate, the disclosure:
    ```svelte
    {#if disclosure}
      <details data-timeline-other-members>
        <summary class={legendButton}>{disclosure.label}</summary>
        <ul class={legend}>…</ul>
      </details>
    {/if}
    ```
    `<li>` is block-level, `<details>` is block-level, so the summary
    ("58 grouped") stacks under the button instead of beside it.
  - line 88: `const legend = css({ display: 'flex', flexWrap: 'wrap', gap: '8px 12px', mt: '4px' });`
- `timeline-model.ts` lines 180–195 `timelineOtherDisclosure` builds
  `label: \`${fmtNum(memberKeys.length)} grouped\`` — the copy is fine; the
  placement is the defect.
- `apps/web/src/focused-report-e2e-fixture.ts` line 35
  `export const FOCUSED_REPORT_E2E_MODEL_TAIL_KEY = '__aiUsageE2EModelTail';`,
  line 148 `const MODEL_TAIL_ROW_COUNT = 20;`, line 207 — an opt-in flag that
  appends 20 `tail-model-NN` rows so the model dimension aggregates a tail
  into `Other`. **No e2e spec consumes it today**
  (`grep -rn "ModelTail" apps/web/e2e` → nothing).
- `apps/web/e2e/time-range.spec.ts` lines 853–875,
  `test('fills harness series with their branded tokens rather than one hashed hue'`,
  reads every legend swatch's computed `backgroundColor` and asserts they are
  pairwise distinct — the pattern to reuse for the model dimension.

### U34 — hero formatting and wrapping

- `apps/web/src/lib/foundation/presentation/format.ts` line 17:
  `export const fmtMoney = (value: number | null | undefined): string => (value == null ? '—' : \`$${value.toFixed(2)}\`);`
  — no grouping. `fmtNum` (line 15) uses `Intl.NumberFormat('en', { maximumFractionDigits: 0 })`,
  which is why the KPI tiles have separators and the hero does not.
- `apps/web/src/lib/foundation/presentation/report-value.ts` lines 35–62:
  `apiValuePresentation` and `aggregateApiValuePresentation` build
  `\`≥ ${fmtMoney(…)}\`` / `fmtMoney(…)` — every `$` label on the report goes
  through `fmtMoney`. CSV export does not (`packages/report-core/src/csv.ts:230`
  keeps `toFixed(2)` — leave it).
- `apps/web/src/api-value.test.ts` lines 12–31 and 34–53 pin `$68.09`,
  `≥ $69.30`, `≥ $4.63` — all below 1,000; `format.test.ts:7` pins
  `fmtMoney(12.345) === '$12.35'` and `fmtMoney(null) === '—'`.
- The only tests pinning a ≥ 4-digit money label:
  `apps/web/src/lib/features/report/breakdown/model.test.ts` line 84
  `valuePerMillion: { label: '$100000.00', status: 'exact' }` and line 130
  `valuePerMillion: { label: '≥ $30000.00', status: 'lower-bound' }`.
- `packages/design-system/src/components/executive-overview.ts` lines 67–74:
  ```ts
  export const numericDisplay = css({
    textStyle: 'numeric',
    color: 'ink',
    fontSize: { base: '40px', md: '52px' },
    fontWeight: 650,
    lineHeight: 0.98,
    overflowWrap: 'anywhere',
  });
  ```
  `textStyle: 'numeric'` is the mono, tabular face (`preset.ts:90–95`), so
  every glyph is ≈ 0.6 em wide — the label width is predictable from its
  character count. `executive-overview.test.ts` lines 38–43 pin `fs_40px` and
  `md:fs_52px`. `containerType: 'inline-size'` is already used in the repo
  (`provider-status.svelte:11`).
- `apps/web/src/lib/features/report/overview/executive-overview.svelte`:
  - line 4: `const answer = css({ display: 'grid', gap: { base: '14px', md: '18px' }, minW: 0 });`
  - lines 97–105 `displayedValue` (hero label, tracks the brush preview);
  - line 148: `<strong class={numericDisplay} title={model.primary.value.title}>{displayedValue}</strong>`.
  - `executiveGrid` (`executive-overview.ts:3–9`) gives the KPI column
    `minmax(18rem, 0.85fr)` at `lg`; with the 56 px shell rail at 1024–1279
    (`e2e/shell-rail-geometry.spec.ts:4–6`) the column is ≈ 340 px.
- `apps/web/e2e/dashboard-presentation.spec.ts` lines 32–39 and 62–75: the
  first-read scenarios assert `kpiSize > metricSize` at every viewport and
  `kpiSize >= 44` at ≥ 1280 px — the new rule must keep both.

### U04 (chart part) — the single-bucket window

- `apps/web/src/lib/features/report/overview/timeline-window.ts` lines 144–154:
  ```ts
  export const timelineBucketLayout = (bucketCount: number): TimelineBucketLayout => {
    const count = Math.max(1, Math.round(bucketCount));
    return {
      bucketGap: count > 1 ? `clamp(0px, calc((100% - ${count * SPACED_BUCKET_MIN_WIDTH_PX}px) / ${count - 1}), ${SPACED_BUCKET_GAP_PX}px)` : '0px',
      bucketMinWidth: `min(${SPACED_BUCKET_MIN_WIDTH_PX}px, calc(100% / ${count}))`,
    };
  };
  ```
  `timeline-window.test.ts:304–307` pins `timelineBucketLayout(1)` to exactly
  `{ bucketGap: '0px', bucketMinWidth: 'min(2px, calc(100% / 1))' }`.
- `activity-timeline.svelte`: `seriesStack` (lines 19–27) is `display: flex`
  with no `justifyContent`; `bucketClass` (28–34) is `flex: '1 1 0'` — one
  bucket therefore fills the plot. The peak label (lines 63–75, 429) is
  `position: absolute; top: 11px; insetInlineEnd: 10px; bg: 'surface'` and so
  sits over the single bar's top-right corner. The origin gap band row
  (lines 469–484) mirrors the bar layout with `style:gap={layout.bucketGap}`
  and `style:min-width={layout.bucketMinWidth}` and must keep mirroring it.
  The crosshair uses `timelineBucketCenterPercent(offset, bars.length)`
  (line 502; `timeline-window.ts:243–244` returns 50 % for one bucket) and
  pointer inspection divides the plot width by `bars.length` (lines 261–277):
  a single centred bar keeps both correct.
- The e2e fixture has a row dated 2026-06-11, the fixture "today"
  (`report-data.ts:9`), so the `Today` preset yields exactly one bucket
  (`time-range.spec.ts:835` already clicks it).

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `bun run typecheck` | exit 0 |
| Format + check | `bun x ultracite fix` then `bun run check` | exit 0 |
| Lint (incl. design-export consumer guard) | `bun run lint` | exit 0 |
| Design-system unit tests | `bun test packages/design-system/src` | all pass |
| One web unit/SSR test | `cd apps/web && bun test src/<path>.test.ts` | all pass |
| Web unit tests | `bun run --cwd apps/web test` | all pass |
| One e2e spec | `bun run --cwd apps/web test:e2e -- e2e/time-range.spec.ts` | all pass |
| Presentation e2e | `bun run --cwd apps/web test:e2e -- e2e/dashboard-presentation.spec.ts e2e/visual-regression.spec.ts` | all pass |
| Regenerate snapshots | `bun run --cwd apps/web test:e2e -- e2e/visual-regression.spec.ts --update-snapshots` | PNGs rewritten |
| Bundle ceiling | `bun run test:web-bundle` | exit 0 |

On NixOS, if Playwright's downloaded chromium fails to launch, set
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to the system Chrome binary before
running e2e (`--channel chrome` does not work here).

## Scope

**In scope** (the only files you should modify):
- `apps/web/src/lib/features/report/range/activity-explorer.svelte`
- `apps/web/src/lib/features/report/range/range-brush.svelte`
- `apps/web/src/lib/features/report/range/report-range-model.ts` (append one
  helper after line 92 only)
- `apps/web/src/lib/features/report/range/report-range-model.test.ts`
- `apps/web/src/lib/features/report/overview/activity-timeline.svelte`
- `apps/web/src/lib/features/report/overview/activity-timeline.ssr.test.ts` (new)
- `apps/web/src/lib/features/report/overview/timeline-model.ts` (remove
  `executiveTimelineValue` / `ExecutiveTimelineValue` only)
- `apps/web/src/lib/features/report/overview/timeline-model.test.ts`
- `apps/web/src/lib/features/report/overview/timeline-window.ts`
- `apps/web/src/lib/features/report/overview/timeline-window.test.ts`
- `apps/web/src/lib/features/report/overview/executive-overview.svelte`
- `apps/web/src/lib/features/report/overview/overview-components.test.ts`
- `apps/web/src/lib/foundation/presentation/format.ts` and `format.test.ts`
- `apps/web/src/api-value.test.ts`
- `apps/web/src/lib/features/report/breakdown/model.test.ts` (the two pinned
  labels only)
- `packages/design-system/src/preset.ts` and `preset.test.ts` (hash)
- `packages/design-system/src/components/chart.ts` and `chart.test.ts`
- `packages/design-system/src/components/executive-overview.ts` and
  `executive-overview.test.ts`
- `apps/web/e2e/time-range.spec.ts`
- `apps/web/e2e/dashboard-presentation.spec.ts` (one added assertion)
- `apps/web/e2e/visual-regression.spec.ts-snapshots/overview-desktop-linux.png`
  and `overview-narrow-linux.png` (regenerated, inspected)

**Out of scope** (do NOT touch):
- `report-range-model.ts` lines 61–92 (`reportRangeProjection`, the `days`
  count and the summary string) — plan 089 owns the inclusive day count and
  the comparison caveat; this plan only appends a new exported helper below it.
- Auto-selecting Week/Month for long ranges (U19) — plan 089, even though it
  also touches `timeline-window.ts` and `activity-explorer.svelte`.
- `packages/report-core/src/focused-report-query.ts` — series ranking and the
  `Other` aggregation (plan 082, delivered) stay exactly as they are; the
  `Other` series remains non-filterable.
- `harnessFillFor`, `stableSeriesColor`, and the `campaign | machine | origin |
  project | provider` branches of `dimensionSwatch` — only the model branch
  changes colour assignment here (see Maintenance notes).
- `packages/report-core/src/csv.ts` money formatting (data export, not
  presentation).
- `apps/cli/**` rendering.
- `session-analysis.svelte` phase tones (`chart.c1..c6` keep their values).
- `plans/073-implementation-decisions.md` — D012's core (local metric, zero
  RPC) stands; record the supersession of its "only API value and Tokens"
  consequence in the commit message and in this plan's README status line,
  not by editing the decision log.

## Git workflow

- Work on the program branch `plan/086-ui-ux-audit-remediation` (worktree
  `.claude/worktrees/plan-086-ui-audit`), base `51815b70`.
- Stage by explicit path — peer sessions write to this repository; never
  `git add -A`.
- One commit for the whole plan, style from `git log`:
  `fix(web): one activity metric control, ranked model palette, grouped hero value`
  (body: name U17/U18/U34/U04-chart, and state that D012's consequence
  "executive control exposes only API value and Tokens" is superseded while
  its zero-RPC core is kept).
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Merge the metric toggle and the Metric chooser into one control (U17)

In `apps/web/src/lib/features/report/range/activity-explorer.svelte`:

1. Replace lines 218–227 with a single list and drop `valueLabels`'
   duplication of the short names where the control reads them:
   ```ts
   const metricItems = [
     { label: 'API value', value: 'cost' },
     { label: 'Tokens', value: 'tokens' },
     { label: 'Sessions', value: 'sessions' },
     { label: 'Share', value: 'share' },
   ] as const satisfies readonly { label: string; value: TimelineValue }[];
   ```
   Keep `valueLabels` (lines 228–233): `chartSummary` (line 263–267) still
   reads the long form and `time-range.spec.ts:152–154,427–429` pin
   `Harness · Day · Estimated API-equivalent value`.
2. Delete line 234 (`executiveValue`) and the `executiveTimelineValue` import
   at line 71.
3. Lines 438–450: iterate `metricItems`; change both comparisons to
   `value === item.value` (`aria-pressed={value === item.value}` and
   `data-active={value === item.value ? 'true' : 'false'}`). Keep the
   `<fieldset aria-label="Activity metric" …>` element, `presetButton`,
   `executiveMetricButton` (`minH: '44px'`) and the `order: { md: -1 }`
   placement so the control stays above the chart on md+ and each button keeps
   its 44 px target at 390 px. Rename `executiveMetricGroup` /
   `executiveMetricButton` to `metricGroup` / `metricButton` (local constants,
   no design-system export).
4. Line 456: change the summary hint to `Grouping, interval, exact dates`.
5. Lines 507–523: remove the `<SegmentedControl ariaLabel="Metric" …/>` at
   line 522. The two remaining controls fit `timeRangeViewControls`'
   `md: repeat(2, minmax(0, 1fr))` grid unchanged.

In `timeline-model.ts` delete lines 52–55 (`ExecutiveTimelineValue`,
`executiveTimelineValue`); in `timeline-model.test.ts` delete the import and
the test at lines 55–60.

In `report-range-model.test.ts` lines 140–158 rename the test to
`keeps one four-way activity metric control above advanced activity options`
and update the pinned strings: `{ label: 'Sessions', value: 'sessions' }` and
`{ label: 'Share', value: 'share' }` are present, `aria-pressed={value === item.value}`
and `data-active={value === item.value ? 'true' : 'false'}` replace the
`executiveValue` forms, and add
`expect(source).not.toContain('ariaLabel="Metric"')` and
`expect(source).not.toContain('executiveTimelineValue')`.

**Verify**: `cd apps/web && bun test src/lib/features/report/range/report-range-model.test.ts src/lib/features/report/overview/timeline-model.test.ts` → pass;
`grep -n "executiveTimelineValue\|ariaLabel=\"Metric\"" apps/web/src -r` → no matches;
`bun run typecheck` → exit 0.

### Step 2: Update the e2e specs that encoded the two-control behaviour

In `apps/web/e2e/time-range.spec.ts`:

- line 162: replace the `Metric` visibility assertion with
  `await expect(activityFor(page).getByRole('group', { name: 'Activity metric' }).getByRole('button')).toHaveCount(4);`
  (the metric lives outside the disclosure now).
- lines 182 and 238: `toHaveCount(2)` → `toHaveCount(4)`.
- lines 204–216: select Sessions through the merged control,
  `await metricControl.getByRole('button', { exact: true, name: 'Sessions' }).click();`,
  then assert `Sessions` is `aria-pressed="true"` and `API value` / `Tokens`
  are `"false"`; keep the keyboard `Space` re-selection of Tokens and the
  zero-RPC trace assertions exactly as they are (D012's core).
- lines 423–426: iterate `['Share', 'Sessions', 'Tokens', 'API value']` over
  `activityFor(page).getByRole('group', { name: 'Activity metric' }).getByRole('button', { exact: true, name })`
  and assert `aria-pressed` `'true'` after each click; the final
  `Harness · Day · Estimated API-equivalent value` assertion stays.
- lines 445–447, 456, 843, 847: replace `chartOptions.getByRole('radio', …)`
  for `Sessions` / `Share` / `Estimated API-equivalent value` with the metric
  group buttons (`'API value'` for the long name).

**Verify**: `bun run --cwd apps/web test:e2e -- e2e/time-range.spec.ts` → pass
(the brush-axis test of Step 3 is added before running the full spec, so run
this once now and once after Step 3).

### Step 3: Give the window slider ticks and dates (U17)

1. In `report-range-model.ts`, **after line 92**, add a pure helper (do not
   touch `reportRangeProjection`):
   ```ts
   export interface BrushAxisTick {
     readonly index: number;
     readonly label: string;
     readonly pct: number;
   }
   const SHORT_BRUSH_DOMAIN_DAYS = 14;
   const DEFAULT_BRUSH_AXIS_LABELS = 8;
   const brushMonthFormatter = new Intl.DateTimeFormat('en', { month: 'short' });
   const brushDayFormatter = new Intl.DateTimeFormat('en', { day: 'numeric', month: 'short' });
   /** Month boundaries across the brush domain; day numerals when the domain is shorter than two weeks. */
   export const brushAxisTicks = (domainFirst: Date, maxIndex: number, maxLabels = DEFAULT_BRUSH_AXIS_LABELS): BrushAxisTick[]
   ```
   Rules: `maxIndex <= 0` → `[]`. Short domain (`maxIndex < SHORT_BRUSH_DOMAIN_DAYS`):
   one tick per index `0..maxIndex`, label `String(date.getDate())`, except
   index 0 and any first-of-month which use `brushDayFormatter` (`Jun 4`).
   Otherwise: one tick per index `i ≥ 1` whose `dateFromIndex(domainFirst, i).getDate() === 1`,
   label `brushMonthFormatter.format(date)`, January stamped
   `` `${month} ’${String(date.getFullYear()).slice(-2)}` `` exactly like
   `timeline-window.ts:179–182`. In both modes `pct = (index / maxIndex) * 100`
   and, when there are more ticks than `maxLabels`, keep every
   `Math.ceil(count / maxLabels)`-th tick (same thinning as
   `visibleTimelineMonthTicks`, lines 185–189). Add unit cases in
   `report-range-model.test.ts` under `describe('report range projection'`:
   - `brushAxisTicks(new Date(2026, 3, 12), 60)` → labels `['May', 'Jun']`,
     indexes `[19, 50]`, `pct[0]` ≈ `(19 / 60) * 100`;
   - a 439-day domain starting 2025-06-10 → 14 month ticks thinned to ≤ 8,
     and a January label ending in `’26`;
   - `brushAxisTicks(new Date(2026, 5, 4), 7)` → 8 day ticks whose first
     label is `Jun 4` and whose second is `5`;
   - `brushAxisTicks(d, 0)` → `[]`.
2. In `activity-explorer.svelte`, under the track (still inside the
   `data-report-range-part="brush"` column, lines 463–506), render:
   - on the track, one hairline per tick:
     `<span aria-hidden="true" class={monthGridline} data-brush-tick-mark style:left={`${tick.pct}%`}></span>`
     (import `monthGridline` from `@ai-usage/design-system/svelte`; it is
     `position: absolute; top: 0; bottom: 0; w: 1px; z-index: 1`, below the
     selection at z 3, so it never covers the brush);
   - an axis row `<div class={brushAxis} data-report-range-part="brush-axis" bind:clientWidth={axisWidth}>`
     with one `<span class={brushTick} data-brush-tick data-brush-tick-index={tick.index} style:left={`${tick.pct}%`}>{tick.label}</span>`
     per tick. Local styles mirror the chart axis:
     `brushAxis = css({ position: 'relative', minH: '14px', color: 'muted', fontSize: '10px', lineHeight: 1 })` and
     `brushTick = css({ position: 'absolute', top: 0, transform: 'translateX(-50%)', whiteSpace: 'nowrap' })`.
   - `const ticks = $derived(brushAxisTicks(activeProjection.domainFirst, activeProjection.maxIndex, axisWidth ? Math.max(2, Math.floor(axisWidth / 44)) : undefined));`
     — `axisWidth` is `$state<number | undefined>()`; SSR uses the default 8
     labels, the browser thins to one label per ≥ 44 px after mount. Use
     `activeProjection` (not `projection`) so the axis pins with the handles
     during a drag (line 178–179 rationale).
3. Apply the same axis (same helper, same two local classes, same attribute
   names with the `period-` prefix: `data-report-range-part="period-brush-axis"`)
   to `range-brush.svelte` under its track (lines 226–269), so the custom
   period brush and the explorer brush read the same.
4. e2e (`time-range.spec.ts`): line 145 → append `'brush-axis'` after `'brush'`.
   Add a test `labels the report window brush with month ticks that stay inside the track`
   that opens the explorer and, for each `BRUSH_GEOMETRY_VIEWPORTS` entry:
   reads `[data-report-range-part="brush-axis"] [data-brush-tick]` and the
   track (`brush.locator('[aria-label="Selected report window"]').locator('..')`);
   asserts the labels are `['May', 'Jun']` in order; for every label,
   `left >= track.left - 1 && right <= track.right + 1`; every adjacent pair
   satisfies `next.left >= previous.right + 4`; and each label's horizontal
   centre is within 1 px of `track.left + (index / 60) * track.width`
   (indexes 19 and 50). Also assert one `[data-brush-tick-mark]` per label.
   The test must **fail** on the unfixed tree (no axis elements) and pass
   after; it runs at 361 px too, where two short month labels cannot collide.

**Verify**: `cd apps/web && bun test src/lib/features/report/range/report-range-model.test.ts` → pass;
`bun run --cwd apps/web test:e2e -- e2e/time-range.spec.ts` → pass including the
new test; `bun run lint` → exit 0 (`monthGridline` gains a consumer; no new
design-system export).

### Step 4: Add six validated categorical tokens and an ordered 12-slot series list (U18)

Design decision (explicit, so the executor does not re-derive it): model series
take their colour **by rank** in `timeline.series` from a fixed, ordered,
validated list, never from a hash. Rank order is also stack order
(`visibleTimelineBars` sorts segments by rank), so the pairs that touch on
screen are exactly the adjacent slots the list was validated for; the legend
renders in the same order and carries the name next to every swatch, which is
how identity survives when a filter re-ranks the survivors (the accepted
trade-off — see Maintenance notes). The `Other` aggregate takes a neutral,
never a slot.

1. `packages/design-system/src/preset.ts`, lines 137–144: append seven tokens
   after `c6` (values are OKLCH-stepped for the repo's surfaces; light on
   `#FFFFFF`, dark on `#18191C`, all ≥ 3:1, OKLCH chroma ≥ 0.10; the pre-existing `c2` light sits at 0.087 and stays):
   ```ts
   c7: dual('#588BE0', '#5590F3'),   // azure   — L .64 / .66
   c8: dual('#3B4FA5', '#A7B5FE'),   // indigo  — L .46 / .79
   c9: dual('#9B7300', '#C69612'),   // gold    — L .58 / .70
   c10: dual('#9250A0', '#DF99EF'),  // orchid  — L .54 / .78
   c11: dual('#853376', '#D37BC1'),  // magenta — L .46 / .70
   c12: dual('#0A6B1D', '#61B565'),  // green   — L .46 / .70
   c13: dual('#B8527E', '#FC90BC'),  // rose    — L .58 / .78
   ```
   Keep the existing comment block; extend it with one line: "c7–c13 exist
   for ranked series beyond the first five; `c4` is excluded from the ranked
   list because `c4 ↔ c6` measure ΔE ≈ 5 in OKLab." Then update
   `preset.test.ts:151` to the new SHA-256 (run the test, copy the reported
   hash — the test's message prints it). Do not change `c1..c6`.
2. `packages/design-system/src/components/chart.ts`:
   - add, next to `chartSwatchClasses`:
     ```ts
     /**
      * Ranked categorical fills for open-ended dimensions. Slot order is the
      * validation mechanism: adjacent slots were measured at ΔE ≥ 20 (OKLab ×100,
      * normal vision) and ≥ 11 under protan/deutan simulation in both schemes;
      * any pair ≥ 8. Never reorder without re-measuring (see chart.test.ts).
      */
     export const rankedSeriesSwatchClasses = [
       css({ bg: 'chart.c3' }),  // violet
       css({ bg: 'chart.c2' }),  // teal
       css({ bg: 'chart.c7' }),  // azure
       css({ bg: 'chart.c13' }), // rose
       css({ bg: 'chart.c12' }), // green
       css({ bg: 'chart.c11' }), // magenta
       css({ bg: 'chart.c5' }),  // olive
       css({ bg: 'chart.c8' }),  // indigo
       css({ bg: 'chart.c1' }),  // copper
       css({ bg: 'chart.c6' }),  // sky
       css({ bg: 'chart.c9' }),  // gold
       css({ bg: 'chart.c10' }), // orchid
     ] as const;
     export const RANKED_SERIES_SLOT_COUNT = rankedSeriesSwatchClasses.length; // 12 === MAX_TIMELINE_SERIES
     /** The collapsed tail is a neutral, not a slot: it must not compete with any ranked series. */
     export const aggregateSeriesFill = css({ bg: 'lineStrong' });
     ```
     and export the hex order the test measures (light/dark pairs in slot order)
     as `RANKED_SERIES_HEX` so the distance test does not re-read the preset:
     `['#6A47C8','#AC92F2'], ['#0E7569','#46C3AC'], ['#588BE0','#5590F3'], ['#B8527E','#FC90BC'], ['#0A6B1D','#61B565'], ['#853376','#D37BC1'], ['#647722','#A9BB5E'], ['#3B4FA5','#A7B5FE'], ['#9B4210','#F19A57'], ['#0F6FA8','#5FB5E2'], ['#9B7300','#C69612'], ['#9250A0','#DF99EF']`.
     (If you prefer reading the preset in the test, do that instead and drop
     `RANKED_SERIES_HEX`; either way the order under test must be the class
     order.)
   - extend `dimensionSwatch` with a third argument
     `position: { readonly aggregate?: boolean; readonly rank?: number } = {}`:
     `aggregate === true` → `{ className: aggregateSeriesFill }` for every
     dimension; the `model` branch becomes
     `const className = position.rank === undefined ? undefined : rankedSeriesSwatchClasses[position.rank]; return className ? { className } : {};`
     (an out-of-range rank yields `{}` and the caller's `accentFill` fallback,
     which the SSR test below proves never happens for 12 series). Keep
     `stableSeriesIndex` exported only if something still consumes it; if
     nothing does, delete it (the `check-design-export-consumers` guard will
     tell you — `chart.test.ts` does not count as a consumer).
   - `chart.test.ts`: replace the two model assertions with
     `dimensionSwatch('model', 'any', { rank: 0 })` ≠ `{ rank: 1 }`, twelve
     ranks yield twelve distinct `className`s, `{ aggregate: true }` yields
     `aggregateSeriesFill` for `'model'` and `'project'`, and an undefined rank
     yields `{}`. Add the **distance test** (this is the U18 presentation
     gate): implement sRGB → linear → OKLab in the test file (≈ 15 lines; the
     matrices are the standard Björn Ottosson ones — `preset.test.ts:42–57`
     already has the sRGB linearisation to copy), then for each scheme assert:
     - every adjacent pair of `RANKED_SERIES_HEX` has `ΔE ≥ 18` (×100);
     - every pair among all twelve has `ΔE ≥ 8`;
     - every slot's WCAG contrast against `#FFFFFF` (light) / `#18191C`
       (dark) is `≥ 3`;
     - the twelve light hexes are pairwise distinct and so are the dark ones.
     Planning-time measurements for the pinned order: adjacent normal-vision
     worst 20.0 light / 20.1 dark; adjacent protan/deutan worst 12.1 / 11.1;
     all-pairs worst 8.5 light (`c5 ↔ c9`) / 8.4 dark (`c13 ↔ c10`). The test
     fails if the order or a value drifts below the floors.
   - `preset.test.ts:107–125` keep passing untouched (`chart.c1` unchanged).

**Verify**: `bun test packages/design-system/src` → pass (hash updated, distance
test green); `bun run lint` → exit 0.

### Step 5: Colour by rank in the chart and put "N grouped" on the same line (U18)

In `apps/web/src/lib/features/report/overview/activity-timeline.svelte`:

1. Line 362: make the swatch position-aware:
   ```ts
   const rankByKey = $derived(new Map((timeline?.series ?? []).map((series, rank) => [series.key, rank])));
   const swatchFor = (key: string): DimensionSwatch => {
     if (!timeline) { return {}; }
     const series = timeline.series[rankByKey.get(key) ?? -1];
     return dimensionSwatch(timeline.dimension, key, {
       aggregate: (series?.memberKeys?.length ?? 0) > 0,
       rank: rankByKey.get(key),
     });
   };
   ```
   Both call sites (legend line 382, segments line 457) keep calling
   `swatchFor(key)`; the map is built once per timeline. Harness keeps its
   branded tokens (the `harness` branch ignores `rank`), so
   `time-range.spec.ts:853–875` is unaffected.
2. Legend entry (lines 378–419): give the `<li>` a local class
   `legendEntry = css({ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0 4px' })`
   and add `data-timeline-legend-entry={disclosure ? 'aggregate' : 'series'}`.
   The `<details data-timeline-other-members>` is then a flex child beside the
   button: collapsed, its summary ("N grouped") sits on the button's line;
   expanded, the member list wraps below inside the entry. No change to
   `timelineOtherDisclosure` or its copy.
3. New `apps/web/src/lib/features/report/overview/activity-timeline.ssr.test.ts`
   (copy the Vite SSR bootstrap from `overview-components.test.ts:1–57`, but
   load `activity-timeline.svelte` directly): build a `FocusedTimelineData`
   for `dimension: 'model'` with twelve series where the twelfth has
   `key: '__ai_usage_other__', label: 'Other', memberKeys: ['m13', 'm14'], memberSummaries: […]`
   and one bucket carrying every key; render with `{ timeline, value: 'cost' }`
   and assert on `body`:
   - twelve legend `data-series-key` swatches whose `class` attribute contains
     exactly one `bg_chart.c*` atom each, all twelve atoms distinct, and the
     `Other` swatch contains `bg_lineStrong` and no `bg_chart.`;
   - the legend `li` for `Other` carries `data-timeline-legend-entry="aggregate"`
     and a class containing `d_flex`, and `2 grouped` appears **after** the
     Other button's closing tag and **inside** the same `<li>` (index
     arithmetic on the body string);
   - the first and second series swatches (ranks 0 and 1) carry `bg_chart.c3`
     and `bg_chart.c2` respectively.
   On the unfixed tree the first assertion fails (hash collisions among
   twelve keys; the `Other` swatch carries a `bg_chart.c*` atom).
4. e2e (`time-range.spec.ts`): add
   `test('gives every model series its own colour and keeps the grouped tail on its legend line'`:
   `page.addInitScript` sets `FOCUSED_REPORT_E2E_ENABLED_KEY` and
   `FOCUSED_REPORT_E2E_MODEL_TAIL_KEY` to `true` (import the second from
   `../src/focused-report-e2e-fixture`, as line 2–6 import the others), open the
   report, `openActivityExplorer`, click the `Model` radio, wait for
   `waitForFocusedReportSettled`, then with the evaluate pattern of lines
   857–864: all legend swatch `backgroundColor`s are pairwise distinct and none
   transparent (expect 12 entries: 11 models + `Other`); and the `Other` entry's
   `details > summary` rect satisfies `|summary.top − button.top| < button.height`
   and `summary.left >= button.right − 1` (same line, to the right). Before the
   fix the first half fails (20 tail keys over 6 classes) and so does the
   geometry (`summary.top >= button.bottom`).

**Verify**: `cd apps/web && bun test src/lib/features/report/overview/activity-timeline.ssr.test.ts src/lib/features/report/overview/overview-components.test.ts` → pass
(`overview-components.test.ts:92` still finds `background: hsl(` — the campaign
dimension keeps its hash hue); `bun run --cwd apps/web test:e2e -- e2e/time-range.spec.ts` → pass.

### Step 6: Keep the timeline-model source assertions honest (U18 / U17)

`timeline-model.test.ts:213–234` pins source strings of
`activity-timeline.svelte`; none of them name `swatchFor` or the legend `li`,
so they keep passing. Add two lines to that test:
`expect(source).toContain('data-timeline-legend-entry=')` and
`expect(source).toContain('rank: rankByKey.get(key)')`.

**Verify**: `cd apps/web && bun test src/lib/features/report/overview/timeline-model.test.ts` → pass.

### Step 7: Thousands separators and a hero that shrinks before it wraps (U34)

1. `format.ts` line 17:
   ```ts
   // Groups the integer part only; `toFixed` keeps the rounding every existing label was pinned on
   // (`Intl` rounds 1.005 to 1.01 where `toFixed` gives 1.00, so it is not a drop-in here).
   const THOUSANDS_GROUP_PATTERN = /\B(?=(\d{3})+(?!\d))/g;
   export const fmtMoney = (value: number | null | undefined): string =>
     value == null ? '—' : `$${value.toFixed(2).replace(THOUSANDS_GROUP_PATTERN, ',')}`;
   ```
   (Ultracite: top-level regex literal, no `let`.) The fraction never has
   three digits, so the pattern cannot touch the cents.
   `format.test.ts:7`: add `expect(fmtMoney(14_134.47)).toBe('$14,134.47');`,
   `expect(fmtMoney(1_000)).toBe('$1,000.00');`, `expect(fmtMoney(-1_234.5)).toBe('$-1,234.50');`
   (sign placement unchanged from today), keep `fmtMoney(12.345) === '$12.35'`.
   `api-value.test.ts`: add one case each for `apiValuePresentation({ costApprox: 1234.5, costKnown: true })`
   → `label: '$1,234.50'` and `aggregateApiValuePresentation({ knownCost: 14_134.47, state: 'partially measured', unpricedFreshTokens: 1 })`
   → `label: '≥ $14,134.47'`.
   `breakdown/model.test.ts` lines 84 and 130: `'$100,000.00'` and `'≥ $30,000.00'`.
2. `packages/design-system/src/components/executive-overview.ts` lines 67–74:
   ```ts
   export const numericDisplay = css({
     textStyle: 'numeric',
     color: 'ink',
     // Shrink before wrapping: the mono face is ~0.6em per glyph, so 150cqi / chars is the largest
     // size whose label fits the KPI column; the breakpoint caps keep today's sizes when it fits.
     fontSize: {
       base: 'clamp(28px, calc(150cqi / var(--hero-chars, 8)), 40px)',
       md: 'clamp(28px, calc(150cqi / var(--hero-chars, 8)), 52px)',
     },
     fontWeight: 650,
     lineHeight: 0.98,
     whiteSpace: 'nowrap',
   });
   ```
   and in `executive-overview.svelte`: line 4 add `containerType: 'inline-size'`
   to `answer` (the `data-executive-kpi` section, the `cqi` reference), and
   line 148 add `style:--hero-chars={displayedValue.length}` to the `<strong>`.
   `executive-overview.test.ts:39–40`: replace the `fs_40px` / `md:fs_52px`
   expectations with the new atoms (print `numericDisplay` once to copy the
   exact Panda class text) and add `expect(numericDisplay).toContain('ws_nowrap')`
   and `expect(numericDisplay).not.toContain('ov-wrap_anywhere')`.
   Sanity numbers: 1024 px (column ≈ 340 px, 12 chars `≥ $14,134.47`) → 42.5 px,
   label ≈ 306 px, fits; 1280 px (≈ 377 px) → 47 px, which keeps
   `dashboard-presentation.spec.ts:62–75`'s `kpiSize >= 44` at ≥ 1280;
   the fixture's `$3.54` / `$68.09` stay at 52 px on md+ and 40 px at 390 px,
   so the visual snapshots do not move because of this step.
3. `overview-components.test.ts` (SSR): in the first test add
   `expect(body).toMatch(/<strong class="[^"]*ws_nowrap[^"]*"[^>]*style="[^"]*--hero-chars:\s*\d+/)` —
   Svelte emits `style:--hero-chars` as `style="--hero-chars: 6;"`; adjust the
   regex to the emitted attribute order after one run.
4. `dashboard-presentation.spec.ts`: in the first-read scenario loop (lines
   40–80) add, for every scenario, that the hero `strong` occupies one line:
   `expect(await kpi.locator('strong').first().evaluate((el) => el.getClientRects().length)).toBe(1);`
   and that its container does not overflow:
   `expect(await kpi.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);`.
   (The fixture value is short, so this guards the rule rather than reproducing
   the 1024 px wrap; the unit/SSR assertions above are the ones that fail on
   the unfixed tree.)

**Verify**: `cd apps/web && bun test src/lib/foundation/presentation/format.test.ts src/api-value.test.ts src/lib/features/report/breakdown/model.test.ts src/lib/features/report/overview/overview-components.test.ts` → pass;
`bun test packages/design-system/src/components/executive-overview.test.ts` → pass;
`bun run --cwd apps/web test` → pass (any other money label ≥ $1,000 that a test
pins will surface here — update the expectation, it is the intended change).

### Step 8: Keep a single-bucket window inside a narrow, centred bar (U04 chart part)

1. `timeline-window.ts` lines 23–26 and 144–154: extend the layout
   ```ts
   const SINGLE_BUCKET_MAX_WIDTH_PX = 64;
   export interface TimelineBucketLayout {
     bucketGap: string;
     bucketMaxWidth: string;
     bucketMinWidth: string;
     stackJustify: 'center' | 'flex-start';
   }
   ```
   returning `bucketMaxWidth: count === 1 ? `${SINGLE_BUCKET_MAX_WIDTH_PX}px` : 'none'`
   and `stackJustify: count === 1 ? 'center' : 'flex-start'`; the existing two
   fields are unchanged. Update `timeline-window.test.ts:297–307` to the four
   fields (`timelineBucketLayout(379)` → `bucketMaxWidth: 'none', stackJustify: 'flex-start'`;
   `timelineBucketLayout(1)` and `(0)` → `'64px'`, `'center'`).
2. `activity-timeline.svelte`: on the stack `<span class={seriesStack} …>`
   (line 438–442) add `style:justify-content={layout.stackJustify}`; on each
   bucket (449–455) add `style:max-width={layout.bucketMaxWidth}`; mirror both
   on the origin gap-band row (470) and its cells (473–480) so the hatch stays
   under its bar. Nothing else changes: with one bar `timelineBucketCenterPercent`
   already returns 50 % and pointer inspection maps the whole plot to that bar.
3. e2e (`time-range.spec.ts`): add
   `test('renders a one-day window as a centred bar the peak label does not touch'`:
   open the report, click the `Today` preset (as line 835), wait settled, then
   in `activityFor(page).locator('[data-report-range-part="chart"]')` assert
   exactly one `role="img"` bucket; its `width <= 65`; its horizontal centre is
   within 2 px of the plot's centre; and its rect does not intersect the
   `[data-timeline-peak-value]` rect. On the unfixed tree the bar spans the
   plot and intersects the label.

**Verify**: `cd apps/web && bun test src/lib/features/report/overview/timeline-window.test.ts` → pass;
`bun run --cwd apps/web test:e2e -- e2e/time-range.spec.ts` → pass.

### Step 9: Gates, snapshots, README

Run `bun x ultracite fix`, `bun run check`, `bun run lint`, `bun run typecheck`,
`bun test packages/design-system/src`, `bun run --cwd apps/web test`,
`bun run test:web-bundle`, then
`bun run --cwd apps/web test:e2e -- e2e/time-range.spec.ts e2e/dashboard-presentation.spec.ts e2e/dashboard.spec.ts e2e/visual-regression.spec.ts`.
`visual-regression.spec.ts` will fail on `overview-desktop.png` and
`overview-narrow.png` because the metric control now has four buttons:
regenerate with `--update-snapshots`, open both PNGs, and confirm the only
differences are the two extra buttons (and, at 390 px, the control wrapping to
a second row if it does) — the hero size, chart, legend and tiles must be
pixel-identical. Update the plan 093 row in `plans/README.md`.

**Verify**: full `bun run test:e2e` → pass.

## Test plan

- Unit/SSR (`bun test`): `report-range-model.test.ts` (merged-control source
  pins, `brushAxisTicks` cases), `timeline-model.test.ts` (removed
  `executiveTimelineValue` case, two new source pins),
  `timeline-window.test.ts` (four-field layout), `activity-timeline.ssr.test.ts`
  (rank-distinct swatches, neutral `Other`, inline disclosure),
  `overview-components.test.ts` (hero nowrap + `--hero-chars`),
  `format.test.ts` / `api-value.test.ts` / `model.test.ts` (grouped money),
  design-system `chart.test.ts` (rank API + OKLab distance/contrast floors),
  `executive-overview.test.ts` (nowrap + fluid size atoms), `preset.test.ts`
  (new hash).
- e2e: `time-range.spec.ts` — updated metric-control selectors (4 buttons,
  Sessions/Share pressed states), new brush-axis geometry test, new model
  palette + grouped-tail test (uses the dormant `FOCUSED_REPORT_E2E_MODEL_TAIL_KEY`),
  new single-bucket geometry test; `dashboard-presentation.spec.ts` — one-line
  hero + no KPI overflow per first-read scenario; `visual-regression.spec.ts`
  — two regenerated, inspected snapshots.

## Done criteria

- [ ] `grep -rn "executiveTimelineValue\|ariaLabel=\"Metric\"\|Grouping, interval, metric" apps/web/src` → no matches
- [ ] `grep -c "aria-pressed={value === item.value}" apps/web/src/lib/features/report/range/activity-explorer.svelte` → 1
- [ ] `grep -n "data-report-range-part=\"brush-axis\"" apps/web/src/lib/features/report/range/activity-explorer.svelte` → 1 hit, and `period-brush-axis` → 1 hit in `range-brush.svelte`
- [ ] `grep -n "c13: dual" packages/design-system/src/preset.ts` → 1 hit; `grep -n "rankedSeriesSwatchClasses\|aggregateSeriesFill" packages/design-system/src/components/chart.ts apps/web/src/lib/features/report/overview/activity-timeline.svelte` → definitions plus at least one consumer each
- [ ] `grep -n "stableSeriesIndex" packages/design-system/src/components/chart.ts` → 0 hits unless a consumer remains
- [ ] `grep -n "toFixed(2).replace" apps/web/src/lib/foundation/presentation/format.ts` → 1 hit
- [ ] `grep -n "whiteSpace: 'nowrap'" packages/design-system/src/components/executive-overview.ts` → 1 hit; `grep -n "containerType: 'inline-size'" apps/web/src/lib/features/report/overview/executive-overview.svelte` → 1 hit
- [ ] `grep -n "bucketMaxWidth" apps/web/src/lib/features/report/overview/timeline-window.ts apps/web/src/lib/features/report/overview/activity-timeline.svelte` → definition plus 2 template uses (bars and gap bands)
- [ ] `bun test packages/design-system/src` exits 0 with the OKLab distance test present (`grep -n "ΔE\|deltaE\|oklab" packages/design-system/src/components/chart.test.ts` → hits)
- [ ] `bun run typecheck`, `bun run lint`, `bun run check`, `bun run --cwd apps/web test`, `bun run test:web-bundle` all exit 0
- [ ] `bun run --cwd apps/web test:e2e -- e2e/time-range.spec.ts e2e/dashboard-presentation.spec.ts e2e/visual-regression.spec.ts` exits 0; the two regenerated PNGs differ from `51815b70` only at the metric control
- [ ] `git diff --stat 51815b70..HEAD -- apps/web/src/lib/features/report/range/report-range-model.ts` shows additions only below line 92 (no change to `reportRangeProjection`)
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The "Current state" excerpts do not match the working tree (plan 089 may
  have landed on `report-range-model.ts`, `timeline-window.ts`, or
  `activity-explorer.svelte`; re-read, and stop only if 089 changed the
  specific lines this plan edits — the metric control block, the brush markup,
  `timelineBucketLayout`).
- The OKLab distance test fails for the pinned hex order on the unfixed
  constants (would mean the planning-time measurement used a different OKLab
  implementation than yours — report both numbers; do not lower the floors).
- `bun run lint` reports an unconsumed design-system export after Step 4 that
  you cannot resolve by deleting `stableSeriesIndex` (report the name; do not
  add a fake consumer).
- Regenerated visual snapshots differ anywhere other than the metric control
  (hero size, chart geometry, legend) — report the diff; something other than
  this plan moved.
- `dashboard-presentation.spec.ts` reports `kpiSize < 44` at 1280 px after
  Step 7 (the KPI column is narrower than the ≈ 377 px estimated here; report
  the measured column width instead of tuning the `150cqi` constant blindly).
- Any e2e test outside the in-scope specs pins the two-button control or the
  unformatted money label (would mean another plan owns that surface).

## Maintenance notes

- Colour-by-rank is an explicit trade-off: a filter that removes the top model
  re-ranks and recolours the survivors. It was chosen because the series set
  is open-ended (no per-model brand token is possible), stack adjacency equals
  rank adjacency (so adjacent-pair validation is the right gate), and the
  legend names every swatch. If the repaint proves confusing in use, the
  follow-up is a per-key slot registry seeded from the all-time ranking,
  not a return to hashing.
- `campaign | machine | origin | project | provider` still use the hash hue
  (`stableSeriesColor`). Moving them onto `rankedSeriesSwatchClasses` is a
  one-branch change in `dimensionSwatch` now that rank and `aggregate` flow
  through; do it once the model dimension has proven out, and extend the e2e
  distinctness test to `Project`.
- When changing any `chart.c*` token or the slot order: re-run the OKLab test
  (normal vision) **and** re-measure protan/deutan separation with a CVD
  simulator (the dataviz validator used at planning time reports adjacent
  ΔE ≥ 11 for this order; the repo test does not simulate CVD). The dark
  tokens follow the repo's existing dark-chart convention (L ≈ 0.70–0.78,
  ≥ 3:1 on `#18191C`), which is lighter than generic dark-palette guidance —
  that is deliberate and matches `c1..c6`.
- `brushAxisTicks` is shared by both brushes; if plan 089's readable range URLs
  or inclusive day count change `reportRangeProjection`, the axis follows
  automatically because it reads `domainFirst` / `maxIndex`.
- Reviewer should scrutinise: the e2e selector updates in Step 2 (they must
  not weaken the zero-RPC trace assertions), the regenerated PNGs, and that
  the hero's `--hero-chars` reflects the *displayed* label (the brush preview
  label changes length while dragging; the `$derived` `displayedValue` covers
  it).
- Deferred: the `Other` series as a filter (never — settled), auto interval
  for long ranges (plan 089), the `0 days` count (plan 089).
