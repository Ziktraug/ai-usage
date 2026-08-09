# Plan 073: Make the Report a Decision-First Executive and Investigation Workspace

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. Keep each red presentation assertion and its fix in the same green
> commit. If anything in the "STOP conditions" section occurs, stop and report;
> do not improvise. When done, update this plan's status row in
> `plans/README.md` unless a reviewer explicitly owns the index.
>
> **READY — merged foundation.** Plans 069 and 072 are DONE and their reviewed
> SvelteKit/oRPC/Query work is merged into `main` at commit `1868b108`. This
> plan was rebased onto that clean checkpoint on 2026-08-09; the excerpts,
> paths, scripts, and composition seams below were rechecked against the merged
> code. Begin implementation only from a clean worktree containing this plan
> commit. If `main` advances first, run the drift check and review every changed
> in-scope seam before editing code.
>
> **Drift check (run first)**:
>
> ```sh
> git status --short
> git diff --stat 1868b108..HEAD -- \
>   README.md plans/README.md plans/073-make-report-decision-first.md \
>   packages/report-core/src/analytics.ts \
>   packages/report-core/src/analytics.test.ts \
>   packages/report-core/src/focused-report-query.ts \
>   packages/report-core/src/focused-report-query.test.ts \
>   packages/usage-store/src/focused-report-query-sqlite.ts \
>   packages/usage-store/src/focused-report-query-sqlite.test.ts \
>   packages/design-system/src/components/button.ts \
>   packages/design-system/src/components/executive-overview.ts \
>   packages/design-system/src/components/overview.ts \
>   packages/design-system/src/components/time-slider.ts \
>   packages/design-system/src/design-entrypoints.test.ts \
>   packages/design-system/src/preset.ts \
>   packages/design-system/src/preset.test.ts \
>   packages/design-system/src/report.ts \
>   packages/design-system/src/svelte/overlays/drawer.svelte \
>   packages/design-system/src/svelte/overlays/overlay-fixture.svelte \
>   packages/design-system/src/svelte/overlays/overlay-components.test.ts \
>   packages/design-system/src/svelte/overlays/overlays.browser.ts \
>   packages/design-system/src/svelte/overlays/styles.ts \
>   packages/design-system/src/svelte/overlays/styles.test.ts \
>   apps/web/src/css-bundle.test.ts \
>   apps/web/src/dashboard-metric-model.ts \
>   apps/web/src/dashboard-search.ts apps/web/src/dashboard-search.test.ts \
>   apps/web/src/date-range.ts apps/web/src/date-range.test.ts \
>   apps/web/src/focused-report-e2e-fixture.ts \
>   apps/web/src/overview-model.ts apps/web/src/overview-model.test.ts \
>   apps/web/src/report-data.ts \
>   apps/web/src/time-range-control-state.ts apps/web/src/time-range-control-state.test.ts \
>   apps/web/src/lib/features/report \
>   apps/web/src/lib/features/sessions/detail/components.ssr.test.ts \
>   apps/web/src/lib/features/sessions/detail/composition.test.ts \
>   apps/web/src/lib/features/sessions/detail/session-drawer.svelte \
>   apps/web/src/lib/features/shell/app-navigation.svelte \
>   apps/web/e2e/accessibility.spec.ts \
>   apps/web/e2e/audit-performance.spec.ts \
>   apps/web/e2e/dashboard-presentation.spec.ts \
>   apps/web/e2e/dashboard.spec.ts \
>   apps/web/e2e/production-report.spec.ts \
>   apps/web/e2e/session-viewport-geometry.spec.ts \
>   apps/web/e2e/time-range.spec.ts \
>   apps/web/e2e/value-presentation.spec.ts \
>   apps/web/e2e/visual-regression.spec.ts \
>   apps/web/e2e/visual-regression.spec.ts-snapshots
> ```
>
> `git status --short` must print nothing before implementation begins. Before
> the first implementation edit, the diff from `1868b108` should contain only
> this plan and its index entry. Compare every later in-scope change with the
> excerpts in "Current state". If `main` has advanced and the composition seam,
> Query ownership, focused-result shape, or overlay API no longer matches, STOP
> and rebase this plan before implementation.

## Status

- **Priority**: P1
- **Status**: TODO
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: completed plans
  `plans/069-centralize-web-server-state-ownership.md` and
  `plans/072-evaluate-deferred-web-session-optimizations.md`, merged at
  `1868b108`; a clean implementation worktree
- **Category**: direction
- **Planned at**: commit `1868b108`, 2026-08-09

## Why this matters

The Report already explains usage more deeply than the T3 Code reference: it
has actionable sessions, anomaly context, cache/input/output anatomy, temporal
rhythms, and pricing provenance. Its first read is weaker because the large
range/activity surface precedes the answer, passive sections are framed like
equally important widgets, and detailed analyses arrive without progressive
hierarchy. A maintainer should understand the period's API-equivalent value,
change, harness split, and daily shape in seconds, then move into Sessions or
Analysis to explain and act on it.

This plan preserves the product's investigative advantage while changing the
editorial order to **answer -> evidence -> investigation**. It also removes an
untrustworthy “actual spend” claim, keeps essential pricing caveats visible,
and makes every presentation outcome deterministic and machine-verifiable
before snapshots are updated.

## Locked product and UX decisions

These decisions are inputs, not questions for the executor.

| Area | Locked decision |
| --- | --- |
| Primary metric | Use the full label **Estimated API-equivalent value** and compact label **API value**. It is a hypothetical standard-API-price comparison value, not a bill, actual spend, saving, ROI, or budget. |
| First read | Overview opens with one executive composition: primary value and equal-period comparison, harness split, activity chart, four support metrics, and at most one high-confidence period insight. |
| Navigation | Keep the three existing destinations. Display labels become **Overview**, **Sessions**, and **Analysis**; internal `breakdown` route/search keys and all existing deep links remain unchanged. Do not add an Overview/Analysis mode inside Overview. |
| Harness vs provider | Codex, Claude Code, Cursor, OpenCode, and Gemini are **harnesses**. Provider remains the billing/subscription route. Never label a Codex/Claude split “Providers”. |
| Period control | The period selector remains globally operable on all three destinations but becomes compact. Show `7d`, `30d`, and `90d` directly; keep Today, All time, and Custom in the same accessible control. Default remains `30d`. |
| Activity exploration | The Overview chart exposes a simple API value/Tokens toggle. Dimension, granularity, custom dates, and brush remain available through an “Explore activity” disclosure attached to the same chart; do not render the full activity card before the executive answer. |
| Support metrics | Exactly four: **Processed tokens** (`cacheRead + cacheWrite + tokIn + tokOut`), **Cache volume** (`cacheRead + cacheWrite`, with read/write detail), **Output tokens** (`tokOut`), and **Pricing coverage** (`pricedSessions / sessionCount`, shown as a count and percentage, plus visible `unpricedFreshTokens` qualification when partial). Do not promote “savings”. |
| Period insight | Render zero or one insight. It may state equal-period change and current-period concentration; it must never claim that a session/provider/model “caused” the change without previous-period attribution. Omit the surface when eligibility fails. |
| Model detail | Overview shows at most five models plus a link to Analysis. Analysis -> Models owns the complete responsive table: Model, API value, share, processed tokens, pricing coverage, and API value per 1M processed tokens. |
| Value per million | Define it as `known API-equivalent value / processed tokens * 1_000_000`. A partially measured row displays a qualified `>=` lower bound; a zero-token row displays an em dash. Never call it a published model price. |
| Session action | Reuse the existing clickable records, selection, drawer, chronology, and session analysis. Improve affordance, touch geometry, and mobile overlay behavior; do not rebuild the flow. |
| Visual hierarchy | Passive reading sections use whitespace and hairlines, not repeated card borders/shadows. Containment remains for interactive charts, tables, forms, alerts, and overlays. |
| Color | Copper `accent` remains brand/interaction/focus only. Categorical chart/harness tokens identify series. `status.warn` and `status.danger` identify genuine anomalies/data-quality states, always with text or icon—not color alone. Turquoise is categorical, never a semantic “good” signal. |
| Explanations | Definitions may move to tooltips. Estimate status, pricing coverage, partial/unpriced usage, and other decision-changing caveats remain visible text. |
| Empty states | Distinguish no local data from “filters returned zero”. The former links to Sources; the latter offers Clear filters. Retained Query data remains visible during refresh. |

### Explicit supersessions and preserved decisions

- This plan supersedes **only** plan 045 decision 8's size/placement clause:
  the Report range control remains operable everywhere, but the former large
  card is no longer the first indicator. Its semantic range, URL ownership,
  keyboard behavior, and all other plan-045 decisions remain authoritative.
- This plan supersedes plan 062 `HIER-3` only where it requires a standalone
  “Value bases” card. The same trustworthy information is re-edited into the
  executive composition and later investigation surfaces.
- Preserve plan 062 `VIZ-1` through `VIZ-3`: four-row token anatomy, fixed
  Punchcard encoding, and the established Session Shape encoding.
- Preserve plan 063's canonical metric names, neutral default controls,
  interaction-only accent, categorical palette, and partial-pricing signal.
- Preserve plan 064's rule that presentation cannot drop, rewrite, or infer
  missing data.
- Preserve ADR 0005's compact visualization geometry, ADR 0009's direct
  Rhythm-day controls, ADR 0006's single Playwright stack and exactly four
  high-value screenshots, and ADR 0012's TanStack Query ownership.

## Current state

### Composition and hierarchy

The merged SvelteKit implementation exposes the intended presentation boundary:

```svelte
<!-- apps/web/src/lib/features/report/composition/report-destination-presentation.svelte:64-83 -->
<FilterBar {...filters} />
{#if range}
  <div class={rangePlacement} hidden={range.hidden}>
    <ReportRangeControl {...range.props} />
  </div>
{/if}
{@render summary()}
<ReportWorkspace {...workspaceProps}>
  {#if activeView === 'overview' && overview}
    <OverviewPage {...overview} />
  {:else if activeView === 'breakdown' && breakdown}
    ...
```

This is the seam to keep: live and synthetic composition owners prepare props;
the presentation component orders them; it must not fetch or copy server state.
Today it puts the full range/activity card before the destination output.

Overview itself currently renders every analysis at one level:

```svelte
<!-- apps/web/src/lib/features/report/overview/overview-page.svelte:89-127 -->
<OverviewHero ... />
<ActivityHeatmap ... />
<TokenAnatomy ... />
<Records ... />
<section ... data-overview-advanced-analysis>
  <SessionShape ... />
  <Punchcard ... />
</section>
```

`OverviewStatus` renders the legacy “More report metrics” and Provider status
*after* `ReportWorkspace` (`report-workspace.svelte:57-60`), which further
separates the most decision-relevant metrics from the hero.

### Trust vocabulary mismatch

`CONTEXT.md:123-125` defines cost approximation as:

> A hypothetical API-rate cost calculated from local token counters and the
> editable pricing table. Subscription products bill differently, and unknown
> public rates remain unpriced. Avoid: bill, invoice, actual spend.

Collectors correctly identify approximation inputs:

- `packages/local-collectors/src/collectors/claude.ts:354` uses
  `approximateApiCost` for Claude API rows.
- `packages/local-collectors/src/codex-history.ts:655` uses
  `approximateApiCost` for non-subscription Codex rows.
- `packages/report-core/src/usage-row.ts:182-187` can currently map an
  `ApproximateApiCost` into `costActual` when a public rate is known.

The hero then says:

```svelte
<!-- apps/web/src/lib/features/report/overview/overview-hero.svelte:101-109 -->
Standard API-price estimate ... This is a comparison value, not savings or ROI.
...
Reported actual spend · {fmtMoney(summary.actualCost)}
```

For this UI plan, remove the “actual spend” presentation rather than inventing
new collector provenance. Keep the underlying contract field for compatibility;
a future domain plan may introduce explicit reported/estimated/subscription-zero/
unknown spend provenance.

### Range and timeline coupling

`report-range-control.svelte` currently owns presets, custom inputs, timeline,
brush, dimension, granularity, and metric. The visible metric choices are only:

```ts
// apps/web/src/lib/features/report/range/report-range-control.svelte:245-254
const valueItems = [
  { label: 'Estimated API-equivalent value', value: 'cost' },
  { label: 'Sessions', value: 'sessions' },
  { label: 'Share', value: 'share' },
] as const;
```

`apps/web/src/date-range.ts:3-13` supports All, Today, 7d, 30d, and Custom; no
90-day mode exists. `apps/web/src/dashboard-search.ts:149` validates the same
set. Invalid custom dates currently return without an inline error.

The focused timeline carries cost and sessions but no token total:

```ts
// packages/report-core/src/focused-report-query.ts:142-190
export interface FocusedTimelineBucketEntry {
  cost: number;
  priceMeasurement: ApiPriceMeasurement;
  sessions: number;
}
export interface FocusedTimelineData {
  buckets: FocusedTimelineBucket[];
  ...
  grandSessions: number;
  grandTotal: number;
  maxBucketSessions: number;
  maxBucketTotal: number;
  ...
}
```

Both the memory projection and
`packages/usage-store/src/focused-report-query-sqlite.ts` build that contract.
Token mode therefore requires a real bounded-contract/SQLite change, not a
presentation-only toggle.

### Existing data and investigation seams

- `FocusedReportSummary` already contains `cacheRead`, `cacheWrite`, `tokIn`,
  `tokOut`, `pricedSessions`, `priceMeasurement`, `sessionCount`, and
  `totalCost` (`focused-report-query.ts:120-140`).
- `FocusedOverviewView` already contains `previousSummary`, `records`, and at
  most five `topSessions`, but no bounded harness/model executive groups
  (`focused-report-query.ts:297-305`).
- `projectFocusedOverviewFromPresentationRows` builds the current and previous
  summaries atomically at one revision (`focused-report-query.ts:1304-1355`).
- Breakdown already computes model/harness/provider analytics, including known
  API value, fresh/cache/input tokens, priced/unpriced counts, and sessions
  (`packages/report-core/src/analytics.ts:13-37`). Extend/reuse those formulas;
  do not reimplement them in Svelte.
- The SQLite focused projection must remain semantically equal to the memory
  projection; its timeline query starts near
  `packages/usage-store/src/focused-report-query-sqlite.ts:275` and Overview
  assembly near line 800.
- Overview records and top-session rows are already buttons
  (`overview/records.svelte:53-110`). The drawer already renders the detailed
  `SessionAnalysis` (`session-drawer.svelte:310-320`).

### Navigation, visual tokens, and mobile drawer

`app-navigation.svelte:177-181` currently exposes Overview, Sessions, and
Breakdown. Keep the `tab: 'breakdown'` identifier and change only its visible
label to Analysis.

The design system already separates roles:

```ts
// packages/design-system/src/preset.ts:119-164
accent: ...                 // single copper brand color
chart: { c1, c2, ... c6 }   // categorical series
brand: { claude, codex }
status: { ok, warn, danger, ... }
```

Do not globally change `panel`. Add Report-specific editorial styles in
`packages/design-system/src/components/overview.ts` (or a dedicated
`components/executive-overview.ts` exported from `report.ts`). Current hero and
advanced-analysis styles both impose border, surface, and shadow
(`components/overview.ts:8-14` and `:52-62`).

Three Report fallback surfaces currently reference the nonexistent token
`colors.border`:

- `report-workspace.svelte:32`
- `report-pending-surface.svelte:4`
- `report-bootstrap-overview.svelte:19`

Use `colors.line`; do not hand-edit generated `apps/web/styled-system` output.

On mobile, the navigation is fixed at `z-index: 50` with a minimum 64px height
(`app-navigation.svelte:130-143`), while the drawer is `z-index: 40`, bottom 0,
and at most 78dvh (`overlays/styles.ts:3-20`). Its navigation buttons use the
30px `drawerClose` style (`components/button.ts:229-244`). This can hide the
sheet's bottom and misses ordinary 44px touch geometry.

### Browser regression contract

`apps/web/e2e/visual-regression.spec.ts:115-153` currently calls
`scrollOverviewValueIntoView` before all three Overview screenshots. The new
hierarchy must remove that helper: the initial viewport is the product being
tested.

`plans/README.md`'s Presentation gate is binding: a visual change is not DONE
from a diff or snapshot alone. Add deterministic DOM, computed-geometry,
render, or token assertions first. Update settled snapshots only afterward.

## Commands you will need

Do not run `bun install`; the workspace already owns its lockfile and
dependencies.

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Working-tree preflight | `git status --short` | no output before implementation |
| Focused report contract | `bun test packages/report-core/src/focused-report-query.test.ts packages/usage-store/src/focused-report-query-sqlite.test.ts` | all tests pass; memory/SQLite parity cases pass |
| Web report unit tests | `bun test apps/web/src/date-range.test.ts apps/web/src/dashboard-search.test.ts apps/web/src/overview-model.test.ts apps/web/src/time-range-control-state.test.ts apps/web/src/lib/features/report/overview apps/web/src/lib/features/report/range apps/web/src/lib/features/report/composition/synthetic-report-destination.test.ts` | all tests pass |
| Design-system tests | `bun --filter @ai-usage/design-system test` | all tests pass |
| Focused browser tests | `bun run --cwd apps/web test:e2e -- e2e/dashboard-presentation.spec.ts e2e/dashboard.spec.ts e2e/time-range.spec.ts e2e/value-presentation.spec.ts e2e/accessibility.spec.ts e2e/session-viewport-geometry.spec.ts` | no functional, Axe, console, page, request, or geometry failures |
| Production report/SSR | `bun run test:e2e-production` | production config executes `production-report.spec.ts` plus the scale suite; SSR and operation-count assertions pass |
| Destination/bundle measurement | `bun run --cwd apps/web build && AI_USAGE_PLAN072_OUTPUT_JSON=/tmp/ai-usage-plan073-bundle-map.json AI_USAGE_PLAN072_OUTPUT_MD=/tmp/ai-usage-plan073-bundle-map.md bun tools/plan072-bundle-map.ts && AI_USAGE_PLAN072_OUTPUT=/tmp/ai-usage-plan073-destination-render.json bun --cwd apps/web --bun playwright test --config playwright.plan072.config.ts --reporter=null e2e/plan072-destination-render.benchmark.ts` | build exits 0 and writes the three named `/tmp` artifacts without dirtying the workspace; do not use the package benchmark wrapper because it pins the destination artifact under `docs/` |
| Update four snapshots | `bun run --cwd apps/web test:e2e -- e2e/visual-regression.spec.ts --update-snapshots` | exactly four settled screenshots update |
| Verify snapshots | `bun run --cwd apps/web test:e2e -- e2e/visual-regression.spec.ts` | four screenshots pass without programmatic scroll to the hero |
| Format | `bun x ultracite fix` | exit 0; only intentional files changed |
| Static gates | `bun run check && bun run lint && bun run typecheck` | all exit 0 |
| Test/build gates | `bun run test && bun run build` | all exit 0 |
| Browser boundaries | `bun run test:web-client-manifest && bun run test:web-production && bun run test:web-dev-build-isolation && bun run test:setup-loopback` | all exit 0; no server module in client, production/dev lifecycle and loopback gates pass |
| Full browser matrix | `bun run test:e2e-demo && bun run test:e2e-production && bun run test:e2e` | all exit 0 |
| Session performance | `AI_USAGE_SESSION_BENCHMARK_OUTPUT=/tmp/ai-usage-plan073-session-scroll.json bun run --cwd apps/web benchmark:session-scroll` | 5,000 unique session identities across 4,999 root campaigns, 25 desktop pages, no gaps/duplicates; same-machine medians do not regress more than 10% from Gate 0 |
| Diff hygiene | `git diff --check` | no output, exit 0 |

## Scope

**In scope — production files that may be modified:**

- Report contract/projections:
  - `packages/report-core/src/focused-report-query.ts`
  - `packages/report-core/src/analytics.ts` only to expose/reuse one canonical
    processed-token/group projection; do not change existing analytics meanings
  - `packages/usage-store/src/focused-report-query-sqlite.ts`
- Report URL/range/presentation models:
  - `apps/web/src/date-range.ts`
  - `apps/web/src/dashboard-search.ts`
  - `apps/web/src/overview-model.ts`
  - `apps/web/src/time-range-control-state.ts` only if the new `tokens` metric
    must be represented by the existing control state
  - `apps/web/src/dashboard-metric-model.ts` only to remove the obsolete actual-
    cost executive grouping and retain canonical comparison states
- Report composition:
  - `apps/web/src/lib/features/report/composition/report-destination-presentation.svelte`
  - `apps/web/src/lib/features/report/composition/live-report-destination.svelte`
  - `apps/web/src/lib/features/report/composition/synthetic-report-destination.svelte`
  - `apps/web/src/lib/features/report/core/report-workspace.svelte`
  - `apps/web/src/lib/features/report/core/report-pending-surface.svelte`
  - `apps/web/src/lib/features/report/core/report-bootstrap-overview.svelte`
- Range/activity:
  - replace `apps/web/src/lib/features/report/range/report-range-control.svelte`
    with `report-period-control.svelte` plus `activity-explorer.svelte`; keep
    pure behavior in `report-range-model.ts`
  - `apps/web/src/lib/features/report/overview/activity-timeline.svelte`
  - `apps/web/src/lib/features/report/overview/timeline-model.ts`
  - `apps/web/src/lib/features/report/overview/timeline-window.ts`
- Executive Overview:
  - `apps/web/src/lib/features/report/overview/overview-page.svelte`
  - `overview-hero.svelte`
  - `view-model.ts`
  - `overview-status.svelte`
  - `dashboard-metrics.svelte`
  - `dashboard-metric-tile.svelte`
  - `dashboard-metric-hint.svelte`
  - `provider-status.svelte`
  - `records.svelte`
  - create `executive-overview.svelte`
  - create `executive-overview-model.ts`
  - create focused subcomponents only when they keep `overview-page.svelte` a
    composition owner; do not create one-file wrappers with no behavior
  - preserve existing `activity-heatmap.svelte`, `token-anatomy.svelte`,
    `session-shape.svelte`, and `punchcard.svelte` except wrapper/heading changes
    required by the new composition
- Analysis:
  - `apps/web/src/lib/features/report/breakdown/dashboard-breakdown.svelte`
  - `breakdown-panel.svelte`
  - `breakdown-row.svelte`
  - `model.ts`
  - `styles.ts`
  - create `model-analysis-table.svelte`
- Session investigation:
  - `apps/web/src/lib/features/sessions/detail/session-drawer.svelte`
  - `packages/design-system/src/svelte/overlays/drawer.svelte`
  - `packages/design-system/src/svelte/overlays/styles.ts`
  - `packages/design-system/src/components/button.ts`
- Report visual language and visible navigation label:
  - `packages/design-system/src/components/overview.ts`, or one new
    Report-specific component style module exported by
    `packages/design-system/src/report.ts`
  - `packages/design-system/src/components/time-slider.ts` only if a new
    semantic translucent brush token is required
  - `packages/design-system/src/preset.ts` and `preset.test.ts` only for named
    semantic tokens/assertions; do not recolor the established palette
  - `apps/web/src/lib/features/shell/app-navigation.svelte` for the visible
    Analysis label only
- Deterministic fixture data:
  - `apps/web/src/report-data.ts`
  - `apps/web/src/focused-report-e2e-fixture.ts`
- Documentation:
  - `README.md` for the visible Overview/Sessions/Analysis wording
  - this plan's Execution log and `plans/README.md` status row

**In scope — tests that must be created or updated:**

- `packages/report-core/src/focused-report-query.test.ts`
- `packages/report-core/src/analytics.test.ts`
- `packages/usage-store/src/focused-report-query-sqlite.test.ts`
- `apps/web/src/date-range.test.ts`
- `apps/web/src/dashboard-search.test.ts`
- `apps/web/src/overview-model.test.ts`
- `apps/web/src/time-range-control-state.test.ts`
- `apps/web/src/lib/features/report/range/report-range-model.test.ts`
- `apps/web/src/lib/features/report/overview/view-model.test.ts`
- `apps/web/src/lib/features/report/overview/overview-components.test.ts`
- `apps/web/src/lib/features/report/overview/overview-page.fixture.svelte`
- create `apps/web/src/lib/features/report/overview/executive-overview-model.test.ts`
- `apps/web/src/lib/features/report/overview/timeline-model.test.ts`
- `apps/web/src/lib/features/report/overview/timeline-window.test.ts`
- `apps/web/src/lib/features/report/composition/synthetic-report-destination.test.ts`
- `apps/web/src/lib/features/report/composition/report-destination.test.ts`
- `apps/web/src/lib/features/report/core/report-bootstrap.test.ts`
- `apps/web/src/lib/features/report/core/report-components.test.ts`
- `apps/web/src/lib/features/report/breakdown/model.test.ts`
- focused component tests beside newly created files above
- `apps/web/src/lib/features/sessions/detail/components.ssr.test.ts`
- `apps/web/src/lib/features/sessions/detail/composition.test.ts`
- `packages/design-system/src/design-entrypoints.test.ts`
- `packages/design-system/src/svelte/overlays/overlay-fixture.svelte`
- `packages/design-system/src/svelte/overlays/overlays.browser.ts`
- `packages/design-system/src/svelte/overlays/styles.test.ts`
- `packages/design-system/src/svelte/overlays/overlay-components.test.ts`
- `apps/web/src/css-bundle.test.ts`
- `apps/web/e2e/dashboard-presentation.spec.ts`
- `apps/web/e2e/dashboard.spec.ts`
- `apps/web/e2e/time-range.spec.ts`
- `apps/web/e2e/value-presentation.spec.ts`
- `apps/web/e2e/accessibility.spec.ts`
- `apps/web/e2e/audit-performance.spec.ts` if its measured Overview DOM record
  changes; retain it as measurement rather than converting it to a permissive
  budget
- `apps/web/e2e/session-viewport-geometry.spec.ts`
- `apps/web/e2e/production-report.spec.ts`
- `apps/web/e2e/visual-regression.spec.ts` and exactly its four existing
  screenshot files

**Out of scope — do not touch:**

- Collector/storage redesign for actual-spend provenance. This plan hides the
  unsupported claim; it does not invent new billing truth.
- Pricing tables, budget alerts, invoices, ROI, break-even, or “cache savings”.
- Skills, Sources, Sync, CLI, quota collection, source lifecycle, campaign
  persistence, transfer, or management-route redesign. The no-data CTA may
  navigate to existing Sources; it does not redesign Sources.
- Query ownership, route prefetch, SSR strategy, keyset paging, exact-revision
  identity, session-window virtualization, or any rejected plan-072 experiment.
- New report URLs or renaming the internal `breakdown` domain/contract key.
- New chart libraries, Storybook, a DOM-emulator test stack, a fifth screenshot,
  or another visual manifest.
- Global `Panel`, global shell breakpoints, the Skills 1280px workspace cliff,
  source action labels, Sync transfer presentation, or unrelated invalid tokens.
- Heatmap cell enlargement, a duplicate Rhythm date input, Punchcard geometry,
  or removal of semantic equivalent controls.
- Campaign “load more”, merge/snapshot consistency, and unrelated audit findings.
- Generated `apps/web/styled-system/**`; regenerate through normal build commands.
- Real local usage histories, private paths, or credentials. Use deterministic
  synthetic fixtures only.

## Git workflow

- Start only after Gate 0 from a clean checkpoint. The assigned implementation
  branch is `refactor/report-decision-first-ui-ux`.
- Use conventional commit style observed in recent history, for example
  `style(design-system): format popover props` and
  `test(web): refresh final overlay evidence`.
- One green commit per vertical wave. A failing assertion may exist while a
  wave is being implemented, but do not commit a red tree.
- Suggested commits:
  1. `test(report): characterize the executive presentation contract`
  2. `feat(report-core): add bounded executive report aggregates`
  3. `refactor(web): separate report period and activity controls`
  4. `style(design-system): add report editorial hierarchy`
  5. `feat(web): compose the decision-first overview`
  6. `feat(web): turn breakdown into responsive analysis`
  7. `fix(web): harden session investigation on mobile`
  8. `feat(report): add token activity and ninety-day range`
  9. `test(web): lock the decision-first report regressions`
  10. `docs(web): document the report navigation`
- Do not push or open a PR unless the operator explicitly asks.

## Steps

### Step 0: Verify the merged foundation and capture a clean baseline

1. Confirm the `plans/README.md` and individual plan-069/072 statuses still
   agree at DONE and that `1868b108` remains an ancestor of the branch.
2. Confirm `git status --short` is empty. If it is not, STOP; do not stash or
   absorb another session's changes.
3. Run the drift command and compare the current code with all excerpts above.
   In particular, confirm:
   - `report-destination-presentation.svelte` is committed and remains the
     presentation-only composition seam;
   - live/synthetic destination owners still provide one atomic exact-revision
     commit through the existing TanStack Query owner;
   - `FocusedOverviewView` and the strict validator still match the excerpt;
   - the design-system Drawer still accepts `modal`, `trapFocus`,
     `initialFocusEl`, and `finalFocusEl`.
4. Record the new clean baseline SHA and same-machine measurements in this
   plan's Execution log:
   - from `/tmp/ai-usage-plan073-destination-render.json`, select the
     `plan072DestinationRender.medians` entry whose `url` is `/` and record
     `rawClosureBytes`, `gzipClosureBytes`, `brotliClosureBytes`,
     `hydrationTotalBytes`, `firstUsefulContentMs`, `firstUsableRenderMs`,
     `ttfbMs`, and `layoutShift`;
   - from every `/` entry in `plan072DestinationRender.samples`, confirm and
     record `businessRpcCountBeforeHydration` and
     `businessRpcCountAfterHydration`;
   - retain `/tmp/ai-usage-plan073-bundle-map.json` as the exact initial/
     destination closure inventory for the final same-machine comparison;
   - run `production-report.spec.ts` through `test:e2e-production` to retain its
     exact range/filter/navigation operation-count assertions;
   - session-scroll benchmark medians and identity/page counts, written to the
     named baseline artifact under `/tmp` for the final same-machine comparison.

**Verify**:

```sh
git status --short
bun run --cwd apps/web build
bun run test:web-client-manifest
AI_USAGE_PLAN072_OUTPUT_JSON=/tmp/ai-usage-plan073-bundle-map.json \
  AI_USAGE_PLAN072_OUTPUT_MD=/tmp/ai-usage-plan073-bundle-map.md \
  bun tools/plan072-bundle-map.ts
AI_USAGE_PLAN072_OUTPUT=/tmp/ai-usage-plan073-destination-render.json \
  bun --cwd apps/web --bun playwright test \
  --config playwright.plan072.config.ts --reporter=null \
  e2e/plan072-destination-render.benchmark.ts
bun run test:e2e-production
AI_USAGE_SESSION_BENCHMARK_OUTPUT=/tmp/ai-usage-plan073-session-scroll-baseline.json \
  bun run --cwd apps/web benchmark:session-scroll
```

Expected: empty status before implementation begins; all commands exit 0;
benchmark reports 5,000 unique session identities across 4,999 root campaigns
with no gap/duplicate. If the plan-072 final tooling or composition seam
differs, STOP and rebase this plan.

### Step 1: Add bounded executive groups to the existing Overview result

Extend the focused-result contract instead of loading Breakdown from Overview.

1. In `focused-report-query.ts`, add a strict bounded group shape with:
   `key`, `label`, `sessions`, `processedTokens`, `priceMeasurement`, and
   `total` (known API-equivalent value/lower bound). Add
   `view.executive.harnesses` and `view.executive.models`.
2. Define `processedTokens` once as cache read + cache write + input + output.
   Reuse the canonical analytics inputs (`cache + fresh`) for groups; model
   groups must continue to use model-segment attribution.
3. Sort by known/lower-bound API value descending with the existing stable
   analytics-key tie-break. Harnesses are bounded to five entries: when there
   are more than five groups, retain the top four and combine every remainder
   into one labelled `Other` entry using the canonical measurement combiner.
   Models are top five only. The validator rejects more than five rendered
   entries, negative values, invalid measurements, unstable/duplicate keys, or
   totals that do not match their measurement.
4. Implement semantically identical memory and SQLite projections. Do not call
   the Breakdown endpoint/Query and do not add an RPC. The SQLite path may use
   bounded aggregate CTEs but must stay within the same exact-revision Overview
   query and result validation.
5. Update request/result validators, serialization fixtures, fingerprints only
   where the result shape requires it, and memory-vs-SQLite parity tests for
   harness, segmented model, partial pricing, ties, Other aggregation, and
   maximum bounds.

**Verify**:

```sh
bun test packages/report-core/src/analytics.test.ts \
  packages/report-core/src/focused-report-query.test.ts \
  packages/usage-store/src/focused-report-query-sqlite.test.ts
```

Expected: all pass; identical fixtures yield identical memory/SQLite executive
groups; Overview still commits at one revision and no test observes a new
business request.

### Step 2: Lock trust, executive metrics, insight, and empty-state behavior in pure tests

Create `executive-overview-model.ts` and its test after the Step-1 focused
contract exists, but before recomposing Svelte. Keep all arithmetic/copy
eligibility out of markup.

The model must expose:

- the primary API-value presentation and existing price provenance;
- equal-period delta using `previousSummary`; bounded/all-time ranges follow
  the existing comparison states from plan 056 and never fabricate a previous
  interval;
- the four locked support metrics and exact token formula;
- a harness distribution and top-five models from the Step-1 bounded contract;
- value-per-million presentation with measured/partial/zero cases;
- one optional insight using these named initial thresholds:
  - current and previous `priceMeasurement.state === 'measured'`;
  - previous `totalCost > 0`;
  - at least two current priced session/campaign items;
  - absolute equal-period change >= 20%;
  - the top two known-cost current items together represent >= 40% of current
    `totalCost`.

Eligible copy has two factual sentences only: “API-equivalent value is X%
higher/lower than the previous equal-length period.” and “The two leading
sessions/campaigns/items represent Y% of this period's measured value.” Choose
the noun from the two items' `kind`; use “items” when mixed. Never use “caused”,
“driven by”, “spend”, “saving”, or a green all-clear fallback.

Add deterministic fixture variants for:

1. fully priced 30-day current/previous periods with an eligible increase;
2. a decrease;
3. partial pricing (insight omitted, caveat visible);
4. all-time/no previous period (comparison omitted with the existing boundary
   explanation);
5. no local sessions;
6. sessions exist but current filters return zero;
7. zero processed tokens;
8. mixed session/campaign top items.

Remove the `actual-cost` and `subscription-value` entries from the executive
metric array. Keep legitimate RTK token reduction in `TokenAnatomy`, and keep
qualified quota/subscription context in Provider status; do not relabel either
as financial savings. Do not delete underlying core fields in this plan.

**Verify**:

```sh
bun test apps/web/src/lib/features/report/overview/executive-overview-model.test.ts \
  apps/web/src/lib/features/report/overview/view-model.test.ts
```

Expected: all cases above pass; repository assertions contain no expectation
that the Svelte hero says “Reported actual spend”.

### Step 3: Split compact period selection from activity exploration

Refactor the current monolithic `ReportRangeControl` without changing URL
ownership.

1. Create `report-period-control.svelte`. It owns only preset/custom selection,
   the readable selected period, and validation feedback. The URL remains the
   source of requested range intent. Display 7d/30d/90d directly; Today, All
   time, and Custom remain keyboard-accessible in the same control. Add `90d`
   to `DateRangeMode`, preset bounds, dashboard-search validation/serialization,
   and tests; keep 30d as default.
2. For Custom, show labelled From/To fields in a popover/disclosure. Invalid or
   reversed dates set `aria-invalid`, render a linked inline error, do not
   navigate, and retain the draft so it can be fixed. Escape restores the
   committed range. Preserve pointer/keyboard navigation semantics.
3. Create `activity-explorer.svelte` from the current timeline/brush/options.
   Render it only inside Overview's executive composition. The chart is visible;
   dimension, granularity, exact dates, and brush live under a labelled
   “Explore activity” disclosure. Preserve the brush's local preview/commit
   behavior and exact URL update rules. Do not render a disabled or fake Tokens
   toggle before Step 8 adds the data contract.
4. `report-destination-presentation.svelte` renders FilterBar and the compact
   period control as one report toolbar, followed immediately by active-filter
   count/summary and destination output. Sessions and Analysis never import or
   mount Activity Explorer.
5. Replace the invalid `colors.border` tokens in the three Report fallback
   surfaces with `colors.line` while these wrappers are touched.

The first implementation may keep Cost/Sessions/Share in the advanced
explorer; Step 8 adds the locked top-level Tokens mode after the data contract
exists. Do not fake token values from cost or sessions.

**Verify**:

```sh
bun test apps/web/src/date-range.test.ts apps/web/src/dashboard-search.test.ts \
  apps/web/src/time-range-control-state.test.ts \
  apps/web/src/lib/features/report/range/report-range-model.test.ts \
  apps/web/src/lib/features/report/composition/synthetic-report-destination.test.ts
bun run --cwd apps/web test:e2e -- e2e/time-range.spec.ts e2e/dashboard.spec.ts
```

Expected: 90d round-trips through URL/search and equal-period logic; invalid
custom dates announce an inline error and perform zero business/navigation
request; the compact control works on all three destinations; only Overview
contains Activity Explorer.

### Step 4: Add a Report-specific editorial visual hierarchy

Implement reusable Report styles, not a global rebrand.

1. Add Report-specific primitives/exports for:
   - `executiveGrid`: KPI/evidence and chart columns on desktop, one column on
     mobile;
   - `editorialSection`: whitespace and heading rhythm, no card shadow;
   - `sectionDivider`: a hairline between passive sections;
   - `metricStrip`: four equal desktop columns, two columns at medium width,
     one readable horizontal/stacked layout at 390px;
   - `containedInteractive`: border/surface for chart/table/control regions;
   - `numericDisplay`: 44-56px desktop and 36-44px mobile;
   - captions/essential labels at no less than 11px.
2. Keep existing panel styles for unrelated features. Remove borders/shadows
   only from passive Report wrappers. Interactive rows retain focus, hover,
   selected, disabled, and pending states.
3. Use `chart.*`/harness tokens for series. Use `status.warn`/`danger` plus text
   for eligible warning states. Keep default controls neutral and copper for
   active interaction/focus only.
4. If the brush needs translucent color, add a named dual-theme interaction
   token rather than a raw copper RGBA. Update `preset.test.ts` to assert role
   separation and contrast. Do not change categorical identities.
5. Add a static/token assertion that the Report source and generated CSS
   contain neither `token(colors.border)` nor an unknown Report token. Never
   edit generated styled-system files by hand.

**Verify**:

```sh
bun --filter @ai-usage/design-system test
bun test apps/web/src/css-bundle.test.ts
```

Expected: all pass; token-role tests remain green; no Report source references
`colors.border`; measured initial gzip growth remains within the Gate-0 budget
(STOP above +10 KiB rather than simply raising the assertion).

### Step 5: Compose the decision-first Overview

Build the executive surface with existing chart/tooltip primitives and the
Step-2 result—no new chart library and no second Query.

Target desktop reading order inside `OverviewPage`:

1. `ExecutiveOverview`
   - left: primary API value, visible estimate/pricing qualification,
     equal-period delta, harness distribution;
   - right: Activity chart, existing legend, and “Explore activity” disclosure;
     Step 8 adds the final API value/Tokens toggle once both values are real;
   - below: four-metric strip;
   - optional single period insight;
   - compact top-five models with “Open Analysis -> Models”.
2. “Investigate” section
   - Records/top sessions (remove the duplicate top-cost card if it repeats the
     first top-session row; keep busiest/streak/longest when distinct);
   - Rhythm heatmap;
   - token anatomy;
   - Session Shape and Punchcard under the existing Advanced analysis heading.
3. Provider status at the end, retaining quota-history action and all data-
   quality qualification. Remove the old `DashboardMetrics`/Value bases surface
   instead of rendering the same metrics twice.

Requirements:

- `OverviewHero` contains no “actual spend”, “bill”, “invoice”, “saving”, or
  ROI claim. The API-estimate sentence and pricing coverage stay visible.
- Harness distribution is labelled exactly “By harness”, never Providers.
- All partial values preserve existing `>=`/provenance behavior.
- Top models are not a second full table. The link navigates through the
  existing dashboard search intent to the existing `tab=models` deep state;
  do not invent a `/breakdown/models` path.
- Clicking a top session still uses the existing selection/Query/detail owner.
- The insight is absent—not replaced by a generic success card—when its pure
  model returns null.
- Loading/retained/refresh behavior preserves complete prior output and
  `aria-busy`; do not flash a false empty state.
- Use composition-provided total-session count to distinguish:
  - zero total: “No local usage yet” plus existing Sources link;
  - filtered zero: “No sessions match these filters” plus Clear filters;
  - destination load failure: a Retry action that retries the lazy module/query
    path without a full-page reload.

Add data attributes only as stable test seams (`data-executive-kpi`,
`data-executive-chart`, `data-executive-metrics`, `data-period-insight`); do not
style through them.

**Verify**:

```sh
bun test apps/web/src/lib/features/report/overview \
  apps/web/src/lib/features/report/composition/synthetic-report-destination.test.ts
bun run --cwd apps/web test:e2e -- \
  e2e/dashboard-presentation.spec.ts e2e/value-presentation.spec.ts \
  e2e/dashboard.spec.ts
bun run test:e2e-production
```

Expected: all pass; first-read DOM order is KPI -> chart/evidence -> metrics ->
optional insight -> investigation; no extra business RPC; direct Sessions and
Analysis SSR/deep links remain intact.

### Step 6: Turn Breakdown into responsive Analysis without changing its route

1. Change only visible navigation/title copy from Breakdown to Analysis. Keep
   `activeView === 'breakdown'`, `DashboardTab`, URL serialization, deep links,
   SSR destination kind, and existing subtab keys.
2. Specialize the Models panel into a semantic desktop table and compact mobile
   cards. Columns are exactly: Model, API value, Share, Processed tokens,
   Pricing coverage, API value / 1M tokens. Reuse the existing sort/search/filter
   behavior and price-state presentation.
3. Derive processed tokens as `group.cache + group.fresh`. Derive the per-million
   value in the pure Breakdown model, not Svelte. Fully measured rows show the
   value, partially measured rows show a qualified lower bound, and zero-token
   rows show an em dash with a definition available to assistive technology.
4. On desktop use `<table>`, `<thead>`, scoped headers, numeric alignment, and
   a caption/description. On mobile use one article/list item per model with the
   same accessible name and information; do not render two focusable copies at
   one viewport.
5. Keep Harnesses & providers, Projects, and Cursor AI behavior unchanged except
   for shared spacing/heading styles. Preserve CSV export and local search if
   present after plan 072.

**Verify**:

```sh
bun test apps/web/src/lib/features/report/breakdown
bun run --cwd apps/web test:e2e -- \
  e2e/dashboard.spec.ts e2e/dashboard-presentation.spec.ts e2e/accessibility.spec.ts
```

Expected: Analysis links retain the old URLs/search serialization; desktop
Models is a semantic table; mobile has one accessible representation with no
horizontal page overflow; partial/zero-token calculations pass exact tests.

### Step 7: Improve session affordance and make the mobile drawer safe

1. Keep Records/top-session buttons but give each an explicit visual disclosure
   affordance and an accessible action such as “Open details for <label>”. Do
   not turn the row into nested controls.
2. Make ordinary drawer header actions at least 44x44 CSS pixels. This does not
   apply to compact heatmap/Punchcard marks governed by ADRs 0005/0009.
3. On mobile, the Session drawer is a modal sheet above the bottom navigation:
   backdrop, `aria-modal`, focus trap, Escape close, focus restoration, safe-area
   bottom padding, and computed z-index greater than navigation. On desktop it
   remains a non-modal side drawer so the table can remain visible. Use the
   existing Drawer API and one responsive instance; never mount separate mobile
   and desktop drawers.
4. Ensure analysis-open state remains scrollable and the sheet header/actions
   do not wrap into an unusable strip at 390px. Chronology, neighbor navigation,
   campaign editor, and Session Analysis Query ownership remain unchanged.

**Verify**:

```sh
bun --filter @ai-usage/design-system test
bun run --cwd apps/web test:e2e -- \
  e2e/session-viewport-geometry.spec.ts e2e/dashboard.spec.ts e2e/accessibility.spec.ts
```

Expected at 390x844: drawer z-index exceeds navigation, no content is hidden by
navigation/safe area, header actions are at least 44x44, Tab/Shift+Tab remain in
the modal sheet, Escape closes, and focus returns to the selected record. At
1280x900: drawer remains non-modal and does not trap focus.

### Step 8: Add real token activity and finish the 90-day control

This is a contract wave, not a label-only edit.

1. Extend timeline aggregate/bucket/series/gap/data types with processed-token
   totals: entry `tokens`, bucket `tokens`, series `tokens`, gap `tokens`,
   `grandTokens`, and `maxBucketTokens`. Use the same token formula as the
   executive metrics.
2. Update memory aggregation, SQLite CTE/record decoding, strict exact-key
   validators, focused fixtures, and parity tests. Token totals must include
   classified and unclassified rows and must equal the summary formula over the
   selected visible range.
3. Add `'tokens'` to `TimelineValue`, control state, chart value selection,
   summaries, axis formatting, tooltips, accessible labels, preview/window
   calculations, and tests. `share` remains an advanced-only option; the
   executive toggle shows API value and Tokens only.
4. Do not alter request identity merely because the displayed metric changes if
   the same committed result contains both values. Metric toggle is local
   interaction intent; range/dimension/granularity remain URL/request intent as
   currently documented.
5. Complete 90d E2E coverage: direct URL, button selection, reload, back/forward,
   equal-period comparison, empty boundary, and mobile access.

**Verify**:

```sh
bun test packages/report-core/src/focused-report-query.test.ts \
  packages/usage-store/src/focused-report-query-sqlite.test.ts \
  apps/web/src/overview-model.test.ts \
  apps/web/src/time-range-control-state.test.ts \
  apps/web/src/lib/features/report/range/report-range-model.test.ts
bun run --cwd apps/web test:e2e -- e2e/time-range.spec.ts e2e/dashboard.spec.ts
```

Expected: memory and SQLite token timelines match exactly; API value/Tokens
toggle changes no business-request count; 90d survives URL history/reload; all
accessible chart labels state the selected metric and exact value.

### Step 9: Lock responsive, accessibility, performance, and visual outcomes

Add assertions before refreshing snapshots.

#### DOM and geometry assertions

At 1440x900 and 1280x900, with the deterministic eligible fixture:

- `data-executive-kpi`, the full chart plot, and all four support metrics have
  `bottom <= window.innerHeight` without scrolling;
- the primary numeric display computes to at least 44px and is larger than any
  secondary metric value;
- executive KPI precedes chart/metrics and every investigation section in DOM;
- no helper scroll is called before the initial Overview assertion/capture;
- the optional insight count is exactly one for the eligible fixture and zero
  for partial/all-time/ineligible fixtures.

At 390x844:

- period presets and the primary KPI are fully visible above the 64px mobile
  navigation without scroll, and the chart begins above that navigation;
- `document.documentElement.scrollWidth <= clientWidth` on Overview, Sessions,
  and Analysis;
- no action text is clipped; ordinary actions/fields are at least 44px tall;
- chart, table/cards, and drawer expose the same information without relying on
  color or hover.

Across both themes:

- essential estimate/pricing copy remains visible;
- text and non-text contrast tests pass;
- `prefers-reduced-motion: reduce` removes new nonessential motion;
- Axe reports zero violations on Overview, Sessions, and Analysis;
- heatmap geometry/roving focus/direct activation and Punchcard semantic table
  remain unchanged and green.

#### Query/performance assertions

- Initial Overview and filter/range/metric interactions perform no more business
  RPCs than the clean Gate-0 baseline. API value/Tokens toggling performs zero.
- No local component stores copied remote result/loading/error state; retained
  Query output remains visible during refresh.
- Executive groups stay bounded at five harness entries and five model entries.
- Compare `/tmp/ai-usage-plan073-final-destination-render.json` with the
  Gate-0 `/tmp/ai-usage-plan073-destination-render.json`. In the final `/`
  median, `gzipClosureBytes` grows by no more than 10 KiB;
  `hydrationTotalBytes`, `firstUsefulContentMs`, `firstUsableRenderMs`, and
  `ttfbMs` each regress by no more than 10%; initial RPC counts do not increase.
  CSS also passes `apps/web/src/css-bundle.test.ts`. Do not raise a budget to
  hide a miss.
- Same-machine session-scroll medians do not regress by more than 10%; identity,
  page, gap, and duplicate counts remain exact.

#### Four screenshots only

Keep exactly four Playwright screenshots under ADR 0006:

1. Overview desktop light at 1440x1000, initial viewport, no scroll;
2. Overview narrow dark at 390x844, initial viewport;
3. Session drawer mobile light at 390x844;
4. hydrated Skills desktop snapshot unchanged except unavoidable shared-font/
   token effects (there should be none in this report-scoped plan).

Remove `scrollOverviewValueIntoView`. Update snapshots only after all DOM,
geometry, token, Axe, request-count, and render assertions pass.

**Verify**:

```sh
bun run --cwd apps/web test:e2e -- \
  e2e/dashboard-presentation.spec.ts e2e/dashboard.spec.ts \
  e2e/time-range.spec.ts e2e/value-presentation.spec.ts \
  e2e/accessibility.spec.ts e2e/session-viewport-geometry.spec.ts \
  e2e/audit-performance.spec.ts
bun run test:e2e-production
bun run --cwd apps/web test:e2e -- e2e/visual-regression.spec.ts --update-snapshots
bun run --cwd apps/web test:e2e -- e2e/visual-regression.spec.ts
```

Expected: all assertions pass before snapshot update; then exactly four settled
snapshots pass. No Overview screenshot scrolls the hero into view.

### Step 10: Run the complete gate and document the delivered contract

1. Update `README.md`'s visible navigation copy to Overview, Sessions, and
   Analysis, while noting that Analysis uses existing breakdown dimensions.
2. Update this plan's Execution log with final clean SHA, measured bundle/CSS/
   RPC/benchmark deltas, snapshot names, and any retained threshold decisions.
3. Run formatter, inspect its diff, then run the full matrix from a clean build.
4. Update `plans/README.md` to DONE only when every machine-checkable criterion
   below passes. Do not claim completion from screenshots alone.

**Verify**:

```sh
bun x ultracite fix
git diff --check
bun run check
bun run lint
bun run typecheck
bun run test
bun run build
bun run test:web-client-manifest
bun run test:web-production
bun run test:web-dev-build-isolation
bun run test:setup-loopback
bun run test:e2e-demo
bun run test:e2e-production
bun run test:e2e
AI_USAGE_PLAN072_OUTPUT_JSON=/tmp/ai-usage-plan073-final-bundle-map.json \
  AI_USAGE_PLAN072_OUTPUT_MD=/tmp/ai-usage-plan073-final-bundle-map.md \
  bun tools/plan072-bundle-map.ts
AI_USAGE_PLAN072_OUTPUT=/tmp/ai-usage-plan073-final-destination-render.json \
  bun --cwd apps/web --bun playwright test \
  --config playwright.plan072.config.ts --reporter=null \
  e2e/plan072-destination-render.benchmark.ts
AI_USAGE_SESSION_BENCHMARK_OUTPUT=/tmp/ai-usage-plan073-session-scroll-final.json \
  bun run --cwd apps/web benchmark:session-scroll
git diff --check
```

Expected: every command exits 0; benchmark invariants and same-machine retention
gate pass; no unexpected file appears in the final diff.

## Test plan

### Unit/contract coverage

- Memory and SQLite parity for bounded harness/model groups: normal, partial
  pricing, segmented model, tie ordering, `Other`, empty, and maximum bounds.
- Timeline token totals: classified, unclassified-origin gap, segmented model,
  cache read/write, empty, partial pricing, and selected window.
- `90d`: bounds, URL parse/serialize, default preservation, history, previous
  equal-period range, and report-range projection.
- Executive model: all four metric formulas; measured/partial/zero provenance;
  positive/negative/no delta; every insight eligibility boundary (19.99/20%,
  39.99/40%, one/two items); campaign/session/mixed nouns; no causal language.
- Value per million: fully measured, partial lower bound, zero tokens, stable
  locale formatting.
- Empty-state classification: total zero, filtered zero, retained refresh,
  first failure, lazy-module retry.
- Drawer style/API: z-index layer, 44px action style, mobile modality flags,
  reduced motion, focus restoration.
- Design tokens: accent/status/chart roles remain distinct; no unknown Report
  token; generated exports remain available from public Report/Svelte entrypoints.

### Browser coverage

- First-read DOM/geometry at 1440x900, 1280x900, and 390x844.
- Period presets/custom errors, activity disclosure, brush, metric toggle,
  back/forward/reload, and zero additional RPC for local metric changes.
- Direct Overview/Sessions/Analysis navigation and existing deep links.
- Desktop semantic model table and mobile single-representation cards.
- Record -> drawer -> analysis chronology; mobile trap/Escape/focus return;
  desktop non-modal navigation.
- Axe, keyboard-only, reduced motion, light/dark, no horizontal overflow, shared
  console/page/critical-request failure gate.
- Existing Rhythm and Punchcard accessibility interaction tests unchanged.
- Exactly four high-value screenshots, refreshed last.

Use existing deterministic report fixtures as the pattern. Never point tests at
the operator's personal histories.

## Done criteria

ALL must hold:

- [ ] Plans 069/072 are reconciled and the implementation began from a clean,
  recorded checkpoint.
- [ ] Overview's initial DOM reads answer -> evidence -> investigation.
- [ ] At 1440x900 and 1280x900, KPI, chart, and four metrics are fully above the
  fold without a helper scroll; at 390x844 the KPI and period control are fully
  visible and the chart begins above mobile navigation.
- [ ] The primary metric is “Estimated API-equivalent value”; no executive
  Overview surface calls it actual spend, a bill, an invoice, savings, or ROI.
- [ ] Pricing/estimate qualifications remain visible; definitions alone may be
  tooltip content.
- [ ] Harness and provider vocabulary is correct.
- [ ] Period control works on Overview, Sessions, and Analysis; 90d and Custom
  round-trip through URL/history/reload; invalid dates announce an inline error.
- [ ] API value/Tokens chart toggle uses real memory/SQLite token aggregates and
  performs zero extra business requests.
- [ ] Executive harness/model arrays are bounded; Overview does not fetch
  Breakdown or create another Query owner.
- [ ] Exactly four support metrics and zero-or-one eligible insight render; no
  causal claim appears.
- [ ] Analysis keeps existing URLs and exposes the responsive model table with
  all six locked columns and correct partial/zero behavior.
- [ ] Records remain actionable through the existing session-detail owner;
  mobile drawer is above navigation, modal/trapped, safe-area-aware, and 44px;
  desktop drawer remains non-modal.
- [ ] Passive Report sections no longer repeat card border/shadow treatment;
  interactive containment and focus states remain clear.
- [ ] Accent/status/chart token roles, partial-pricing signals, light/dark
  contrast, and no-color-only rules pass.
- [ ] Rhythm/Punchcard compact geometry and direct/equivalent controls pass their
  unchanged tests.
- [ ] DOM/geometry/token/Axe/request-count tests pass before exactly four
  snapshots are refreshed; `scrollOverviewValueIntoView` no longer exists.
- [ ] Client manifest, production/dev/loopback, demo, production E2E, ordinary
  E2E, bundle/CSS, and session benchmark gates pass within recorded budgets.
- [ ] `bun x ultracite fix`, `bun run check`, `bun run lint`, `bun run typecheck`,
  `bun run test`, `bun run build`, and `git diff --check` all exit 0.
- [ ] No files outside Scope are modified; `plans/README.md` is updated only
  after the gate is green.

## STOP conditions

Stop and report back; do not improvise if:

- Plan 069 or 072 remains active/inconsistent, the preflight tree is dirty, or
  another session still owns an in-scope file.
- The live code no longer matches the presentation seam, focused-result shape,
  Query owner, or Drawer API described above.
- Overview needs a second Query/RPC, a Breakdown fetch, a local copy of remote
  result state, or a second SSR acquisition to render executive groups.
- Memory and SQLite projections cannot be made exactly equivalent and bounded.
- A KPI/table/insight would require inferring missing data, mixing harness with
  provider, or claiming causality not present in the contract.
- “Processed tokens” cannot retain the exact four-counter definition everywhere
  or token mode would omit unclassified/partial rows.
- The visible estimate/pricing/data-quality qualification must be hidden to fit
  the layout.
- A design change repurposes copper accent as anomaly/success, uses turquoise as
  semantic good, or communicates state by color alone.
- Heatmap/Punchcard geometry, roving focus, direct day activation, semantic
  equivalent representation, or reduced-motion behavior regresses.
- Mobile drawer requires a second mounted instance, loses focus restoration, or
  cannot sit above navigation with 44px ordinary actions.
- A fifth screenshot, Storybook, another browser runner, a chart dependency, or
  hand-edited generated CSS appears necessary.
- Client closure/CSS or same-machine session benchmark regresses beyond the
  locked limit; do not widen a budget without measured review.
- A test/gate fails twice after one focused correction attempt.
- Completion would require touching an out-of-scope management route, collector,
  storage schema, query-ownership program, or unrelated dirty file.

## Maintenance notes

- The executive insight thresholds are named product constants with boundary
  tests. Future changes must update copy/fixture/tests together and still avoid
  causal language unless previous-period attribution is added to the contract.
- If true spend is introduced later, create a separate domain plan carrying
  explicit reported/estimated/subscription-zero/unknown provenance from
  collectors through strict validation. Do not revive `actualCost` UI merely
  because the field exists.
- `API value / 1M tokens` is an observed aggregate comparison value, not a model
  rate card. Keep the definition beside the table.
- If another consumer needs executive groups, deepen the report-core interface
  rather than exporting Svelte presentation models or fetching Breakdown.
- Reviewers should scrutinize memory/SQLite parity, Query operation counts,
  partial-pricing lower bounds, initial viewport geometry, and mobile focus
  behavior before visual taste.
- Provider status, advanced analytics, and top sessions remain deliberate
  investigation surfaces. Do not promote every future metric above the fold;
  the executive contract is intentionally small.
- Exactly four Playwright screenshots remain the ADR-0006 visual set. Add new
  behavior assertions, not more snapshots.

## Execution log

Fill this during implementation; do not pre-claim results.

- **Clean merged foundation SHA**: `1868b108`
- **Plan 069/072 reconciliation evidence**: both plan documents and
  `plans/README.md` are DONE in `1868b108`
- **Clean implementation start SHA**: pending
- **Gate-0 bundle/CSS/RPC measurements**: pending
- **Gate-0 session benchmark**: pending
- **Final measurement deltas**: pending
- **Final snapshot names and viewports**: pending
- **Final green SHA**: pending
