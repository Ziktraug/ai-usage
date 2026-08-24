# Plan 095: Make Provider Status and Quota History Legible

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 51815b70..HEAD -- apps/web/src/lib/features/report/overview/provider-status.svelte apps/web/src/provider-status-panel-model.ts apps/web/src/provider-status-panel-model.test.ts apps/web/src/provider-status-model.ts apps/web/src/lib/features/report/actions/quota-history-panel.svelte apps/web/src/lib/features/report/actions/quota-history-owner.svelte apps/web/src/provider-quota-history-model.ts apps/web/src/provider-quota-history-model.test.ts apps/web/src/provider-quota-e2e-fixture.ts apps/web/src/lib/features/sources/source-control-summary.svelte apps/web/src/lib/features/sources/source-controls.fixture.svelte apps/web/src/lib/features/sources/source-controls.ssr.test.ts apps/web/e2e/dashboard.spec.ts apps/web/src/lib/features/report/overview/overview-components.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW–MED (two e2e tests are rewritten; one drawer chart is redrawn)
- **Depends on**: none. Plan 074's renames and its `providerHistoryAvailable`
  gate are already in the tree at `51815b70` (verify:
  `grep -rn "providerHistoryAvailable" apps/web/src --include=*.svelte` → two
  call sites; `grep -rn "Codex quota history" apps/web/src` → none) even if
  `plans/README.md` still lists 074 as TODO — do not redo it.
- **Category**: UX remediation (2026-08-23 audit, umbrella plan 086)
- **Planned at**: commit `51815b70`, 2026-08-23
- **Audit findings**: U22, U23, U28 (only the "warning pill depends on the
  report filter" part — plan 097 owns the Sources page jargon)

## Why this matters

The Overview's Provider status panel is the one place the report says what it
knows about quota, and today it says it in the least legible way possible. On a
multi-machine install, most "Provider details" cards can say only "No quota
source" with a machine label and "No quota windows are available for this
provider." — the same sentence repeated across dead-end cards. Above them,
multiple counter chips partition providers by quota and issue state instead of
summarising what needs attention. The attention chips lose the space before
their separators (`<provider>· <machine>· partial`) because the pill is a flex
container and the separator lives inside the next flex item. The
badges "Partial", "Unsupported", "Ok" are never explained. And in a quota card
the 5H column's single window floats in the middle of its column, because the
grid that holds it stretches its tracks to match the taller Weekly column.

The quota history drawer has the opposite problem: it shows more than it says.
The recent range is selected, yet the first point can predate it by many hours,
because the store deliberately prepends one anchor observation from *before*
the requested range per stream and the drawer then stretches its x-axis to that
anchor. The CLI already diagnosed and fixed this for `quota --history`
(`withoutPreRangePoints`); the web drawer still renders the anchor as its first
point. The chart uses a fixed-width SVG squeezed into a narrower drawer with
`preserveAspectRatio="none"`, so its reset labels are horizontally squashed,
and the dashed reset/gap lines are drawn *after* the series, over the points.
The native `<select>`s size themselves to their longest option, so the filter
row has inconsistent control widths.

Finally, the header pill was observed flipping from a warning-count state to
"Sources ready" as the report was narrowed. This plan traces that pill and
records the finding: the pill reads a layout-scoped, event-stream-fed snapshot
with no input from the report filter (see "Current state"); the flip was a
genuine engine state change coincident with the click. Because a pill whose
change cannot be attributed will be read as filter-dependent again, the plan
makes the pill's derivation a pure function of the source-control state
(unit-tested), stamps the snapshot generation on the element so any change is
attributable, and adds an e2e guard that filters the report and asserts the
pill is untouched.

## Current state

### Provider status panel (U22)

- `apps/web/src/lib/features/report/overview/provider-status.svelte`
  - lines 60–65 — the window-group geometry that produces the "hole":
    ```ts
    const windowsGrid = css({
      display: 'grid',
      gap: '10px',
      gridTemplateColumns: { base: '1fr', lg: 'repeat(3, minmax(0, 1fr))' },
    });
    const windowGroup = css({ display: 'grid', gap: '8px', minW: 0 });
    ```
    `windowGroup` is a grid item (stretched to the row height by default) and
    a grid container with no `alignContent`; `normal` behaves as `stretch` for
    grid tracks, so the extra height is split between the label track and the
    rows track and a single window lands mid-column.
  - lines 162–181 — `issueList` (flex, `gap: '6px'`) and `issuePill`
    (`display: 'inline-flex'`, no gap). Flex containers drop whitespace-only
    text nodes between items, so the separator that lives inside the next
    `<span>` abuts the previous item.
  - lines 209–213 — props and the panel summary:
    `const summary = $derived(buildProviderStatusPanelSummary([...providers]));`
  - lines 216–218 — the state badge:
    `<span class={cx(badge, badgeTones[_view.tone])}>{_view.provider.state.replaceAll('-', ' ')}</span>`
  - lines 252–321 — `providerDetailCard`; lines 273–308 render
    `windowsGrid` → `windowGroup` → `groupLabel` + `windowRows`; lines 309–311:
    `<div class={contextLine}>No quota windows are available for this provider.</div>`
  - lines 354–372 — the attention chips whose separators lose their space:
    ```svelte
    <li class={issuePill}>
      <strong class={attentionProviderName}>{view.provider.label}</strong>
      {#if compactProviderContext(view)}
        <span>· {compactProviderContext(view)}</span>
      {/if}
      <span>· {view.provider.state.replaceAll('-', ' ')}</span>
    ```
  - lines 374–386 — the five counter chips, in a list whose accessible name is
    `Provider categories (${providerCountLabel(providers.length)})`; chip
    texts `Quota windows: …`, `Critical without quota windows: …`,
    `Attention without quota windows: …`, `Unsupported: …`,
    `No quota windows or issues: …`.
  - lines 389–396 — the details disclosure:
    `<summary class={detailSummary}>Provider details ({providerCountLabel(providers.length)})</summary>`
    followed by one `providerDetailCard` per provider (all of them).
- `apps/web/src/provider-status-panel-model.ts` (49 lines) — the partition
  behind the chips: `quotaProviders` (windows > 0), then
  `criticalProvidersWithoutQuota` (tone critical), then
  `unsupportedProvidersWithoutQuota` (state `unsupported`), then
  `attentionProvidersWithoutQuota` (tone warning OR any warning OR a credits
  summary), then `otherProvidersWithoutQuota`. Its test
  `apps/web/src/provider-status-panel-model.test.ts` (lines 52–107) builds five
  views (codex quota, claude unsupported, cursor partial + two warnings,
  opencode error/critical, gemini ok) and asserts the partition is complete and
  disjoint.
- `apps/web/src/provider-status-model.ts`
  - lines 58–72 — where "Partial"/"Unsupported" come from for providers that
    are *inferred* from usage rows (one per provider family × machine):
    `source: 'unsupported', state: key === 'claude' ? 'unsupported' : 'partial'`
    (line 66–67). Inferred statuses carry no `warnings`.
  - lines 140–159 `toneFor`: `partial`/`stale`/≥80 % → `warning`;
    `unsupported` → `muted`; `error`/`auth-required`/blocked → `critical`.
  - lines 161–174 `sourceLabelFor`: `'unsupported'` source → `'No quota source'`.
  - lines 220–237 `sortRankFor`: critical, quota/credits, stale, partial,
    unsupported, rest — `buildProviderStatusViews` returns views in this order;
    keep it as the order of detail cards.
- `apps/web/src/lib/features/report/overview/provider-presentation.ts` and
  `apps/web/src/provider-status-progress.ts` — read for context; the
  percent/aria labels and the determinate/indeterminate progress state are
  correct and stay untouched (their tests:
  `provider-presentation.test.ts`, `provider-status-progress.test.ts`).
- `apps/web/src/source-control-presentation-model.ts` lines 52–57 — the
  *other* "Unsupported": a **source** whose `availability === 'unsupported'`
  ("This source is unavailable on the current platform."). It is a different
  concept from the provider badge and is not changed by this plan; the glossary
  below lives in the provider panel only.
- Tests that pin today's panel:
  - `apps/web/e2e/dashboard.spec.ts` lines 19–23 define
    `PROVIDER_DETAILS_PATTERN = /^Provider details \(/`,
    `PROVIDER_CATEGORY_COUNT_PATTERN = /: (\d+) providers?$/`,
    `PROVIDER_CATEGORY_TOTAL_PATTERN = /\((\d+) providers?\)$/`,
    `PROVIDER_CATEGORIES_PATTERN = /^Provider categories/`; the test
    `keeps provider details collapsed until they are requested` (lines 372–417)
    asserts the chips sum to the total, that
    `page.getByRole('list', { name: 'Providers requiring attention' })` is
    visible, and that `'No quota windows are available for this provider.'`
    becomes visible once the disclosure is opened at 390 px.
  - `apps/web/src/lib/features/report/overview/overview-components.test.ts`
    lines 272–290 render the overview fixture with two providers that *have*
    windows and assert two `<progress>` elements, `value="75"`,
    `Unknown usage`, `Reset time unknown` — this must keep passing.
  - In e2e/demo mode (`apps/web/src/report-data.ts` has no `providerStatus`
    dataset) every provider is inferred: Codex/Claude/OpenCode on
    `Fixture Machine`, Cursor on `Fixture Machine Secondary` — all without
    windows, so the e2e panel has **no** provider that deserves a detail card.

### Quota history drawer (U23)

- `packages/usage-store/src/provider-quota-store.ts` lines 601–626 — why a
  "24h" request returns an older point: after the range rows, the reader runs
  `anchorSql` (line 601), which selects per stream the newest observation with
  `candidate.first_observed_at < ?` (the `from` bound, line 614) and merges it
  in front (`const rows = [...beforeRows, ...rangeRows]`, line 624). Each
  stored observation is a run of identical readings from `first_observed_at`
  to `last_observed_at` (coalesced on write: lines 356–357 extend
  `last_observed_at` when the content hash repeats within 30 minutes), so an
  anchor can start days before the window and still be "held" into it.
- `apps/cli/src/usage-read-model.ts` lines 339–347 — the CLI precedent:
  ```ts
  export const withoutPreRangePoints = (points: ProviderQuotaHistoryPoint[], from: string): ProviderQuotaHistoryPoint[] =>
    points.filter((point) => point.firstObservedAt >= from);
  ```
  with the comment "an anchor must never become an endpoint: it would print a
  days-old percentage as the start of 'last 24h'".
- `apps/web/src/provider-quota-history-model.ts`
  - line 10: `export type ProviderQuotaHistoryRange = '24h' | '7d' | '30d';`
  - lines 66–102 `buildSeries`: `firstObservedAt: first.firstObservedAt` /
    `lastObservedAt: last.lastObservedAt` from *all* points; segments, gap and
    reset counts from all points; line 100:
    `summary: \`${sorted.length} points · ${formatBoundaryCount(resetCount, 'reset')} · ${formatBoundaryCount(gapCount, 'collection gap')}\``
  - lines 104–120 `buildProviderQuotaHistoryModel(result)` — one argument,
    no notion of the requested window; `emptyMessage: 'No quota history yet.'`.
  - lines 122–138 `rangeDurationMs` and `providerQuotaHistoryRequest(range, now)`.
- `apps/web/src/lib/features/report/actions/quota-history-panel.svelte`
  - lines 13–19 chart css (`h: '180px'`), lines 25–41 chart constants
    (`CHART_WIDTH = 600`, `CHART_HEIGHT = 180`, `CHART_LEFT = 20`,
    `CHART_RIGHT = 580`, `CHART_TOP = 30`, `CHART_BOTTOM = 150`,
    `BREAK_LINE_TOP = 22`, `BREAK_LINE_BOTTOM = 158`, `BREAK_LABEL_Y = 18`).
  - line 70: `const model = $derived(result ? buildProviderQuotaHistoryModel(result) : null);`
  - lines 101–105 `seriesX` maps `observedAt` onto
    `[series.firstObservedAt, series.lastObservedAt]` — the series span, not
    the requested range.
  - lines 169–195 — three `<label>`s each wrapping a `<select class={field}>`
    (`field` from `../breakdown/styles` sets height and padding but no width);
    lines 156–168 the range `<fieldset>` with three `button` elements.
  - lines 219–258 — the SVG: `preserveAspectRatio="none"`, the series
    `<path>`s (line 233) and `<circle>`s (lines 235–242) are drawn first, then
    (lines 243–257) for every segment with a `breakReason` a dashed `<line>`
    from `BREAK_LINE_TOP` to `BREAK_LINE_BOTTOM` across the plot plus a
    `<text font-size="11">{segment.breakReason}</text>` at `BREAK_LABEL_Y`.
  - lines 259–262: `First {fmtDate(series.firstObservedAt)} · Last {fmtDate(series.lastObservedAt)} · Next reset …`
- `apps/web/src/lib/features/report/actions/quota-history-owner.svelte`
  - line 31 `let range: ProviderQuotaHistoryRange = $state('24h');`
  - lines 55–57 the unfiltered request (keep):
    `const request = $derived(providerQuotaHistoryRequest(range, requestedAt));`
  - lines 91–101 render the panel with `{range}` and `result={query.data ?? null}`.
- `packages/design-system/src/svelte/overlays/styles.ts` lines 3–23 — the
  drawer is `w: { base: '100%', md: '440px' }`; inside the series `panel`
  (14 px padding) the chart box is ≈ 380 px wide, so a 600-unit viewBox with
  `preserveAspectRatio="none"` renders text and circles at ≈ 0.63 horizontal
  scale.
- `apps/web/src/provider-quota-e2e-fixture.ts` — `fixtureQuotaPoint` sets
  `lastObservedAt: input.at` (line 20); `FIXTURE_POINT_INPUTS` (lines 40–68)
  are nine points between `2026-07-15T09:00` and `09:35`;
  `E2E_PROVIDER_QUOTA_FIXTURE_POINT_COUNT: (typeof FIXTURE_POINT_INPUTS)['length'] = 9`
  (line 78); `generatedAt: '2026-07-15T10:40:00.000Z'` (line 82).
  `apps/web/src/server/provider-quota-resolver.server.ts` lines 32–35 return
  this fixture for every e2e request regardless of its `from`/`to`, and the
  owner's `requestedAt` is the real clock — so **the requested window can not be
  used to bound the fixture in e2e**; the result's `generatedAt` can.
- `apps/web/e2e/dashboard.spec.ts` lines 419–452 — the quota drawer e2e
  (`RESET_COUNT_PATTERN = /1 reset/`, `GAP_COUNT_PATTERN = /1 collection gap/`,
  `CLAUDE_SERIES_PATTERN = /^Claude · /`); it opens the drawer, asserts the
  Provider combobox offers `codex` and `claude`, clicks `7d`, closes, reopens
  at 390 px.

### Sources header pill (U28, filter-dependence part)

- `apps/web/src/lib/features/sources/source-control-summary.svelte`
  - line 8 `const sourceControl = useSourceControl();` — the only input.
  - lines 11–14:
    ```ts
    const enabledSources = $derived(snapshot?.sources.filter((source) => source.policy === 'enabled') ?? []);
    const warningCount = $derived(
      enabledSources.filter((source) => ['danger', 'warning'].includes(presentSourceState(source).tone)).length,
    );
    ```
  - lines 30–50 `statusLabel`: `'Checking sources…'` / `'Incompatible'` /
    `'Unavailable'` / `'Reconnecting'` / `` `${warningCount} warning${…}` `` /
    `` `${snapshot.runningCount} running` `` / `'Sources ready'` (line 49);
    lines 51–59 `statusTone`.
  - lines 143–161 markup: `<section aria-label="Collection source status">`
    → `<a href="/sources">` → dot + `<span class={summaryLabel}>{statusLabel}</span>`;
    lines 162–195 the hover card.
- Where its state comes from: `apps/web/src/routes/+layout.svelte` lines
  19–28 define the `sourceControlSummary` snippet and mount
  `SourceControlProvider` once for the whole app;
  `apps/web/src/lib/features/sources/source-control-provider.svelte` lines
  36–58 derive `state` from the `sources/snapshot` query (fed only by the
  EventSource bridge, `apps/web/src/lib/query/options/source-control.ts`
  lines 14–27, `enabled: false`) and `provideSourceControl({ state })`.
  `apps/web/src/lib/features/shell/source-control-summary-context.ts` only
  passes the snippet down; `apps/web/src/lib/features/report/breakdown/filter-bar.svelte`
  line 22 / lines 106–108 render it inside the report toolbar.
- Traced and ruled out as couplings (state this in the commit message):
  - the report filter never issues an engine command (no
    `collect-fresh-report`/`run-*` call under `apps/web/src/lib/server` or
    `apps/web/src/server` on the read path; the only commands are
    `source-control-api.server.ts` lines 118–124 behind explicit user actions);
  - re-hydration on navigation (`apps/web/src/lib/query/provider.svelte`
    lines 37–43) touches only dehydrated report keys — nothing dehydrates
    `sourceControlStateKey()`;
  - the filter-bar's own `freshnessStatus` control (filter-bar.svelte lines
    85–104; `aria-label="Collection source status"` at lines 91 and 101)
    shares the accessible name with the pill but renders
    `'Freshness unavailable'`, never a warning count.
  The pill therefore changed because the engine pushed a newer snapshot
  (`acceptSnapshot`, `apps/web/src/source-control-client.ts` lines 99–120)
  whose enabled sources no longer had a `danger`/`warning` tone — e.g. a source
  whose `lastOutcome` went from `'warning'` to `'success'`. Nothing on the
  element lets a reader see that.
- `apps/web/src/lib/features/sources/source-controls.fixture.svelte` (lines
  13–67) provides a one-source `snapshot` (`generation: 1`, all ok) and renders
  `<SourceControlSummary />` inside `data-source-summary-fixture`;
  `source-controls.ssr.test.ts` renders it (pattern: `fixtureBlock(html, 'summary')`).
- `apps/web/src/lib/features/sources/model.ts` is also edited by plan 097
  (publication strings, lines 78–88) — put the new pure function in a new
  sibling file to avoid a merge collision.
- e2e helpers: `apps/web/e2e/browser-test.ts` exports `openHydratedReport`
  (line 84) and `waitForFocusedReportSettled` (line 90);
  `apps/web/e2e/machine-staleness.spec.ts` lines 15–22 show the MultiSelect
  pattern (`getByRole('combobox', { name: 'Filter by machine' }).click()` →
  `getByRole('option', { name })` → `waitForFocusedReportSettled`). The e2e
  report has a `Claude` harness option (`apps/web/src/report-data.ts` line 48).
- Vocabulary (`CONTEXT.md`): **Provider** = billing/subscription route of a
  usage row; **Quota snapshot** = a durable local usage-limit observation.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Prepare SvelteKit output (needed by the `*.ssr.test.ts` harness) | `bun run --cwd apps/web dev:prepare` | exit 0 |
| Typecheck | `bun run typecheck` | exit 0 |
| Format + lint | `bun x ultracite fix` then `bun run check` and `bun run lint` | exit 0 |
| One unit test file | `cd apps/web && bun test src/provider-quota-history-model.test.ts` | all pass |
| One SSR test file | `cd apps/web && bun test src/lib/features/report/overview/provider-status.ssr.test.ts` | all pass |
| All web unit tests | `bun run --cwd apps/web test` | all pass |
| One e2e spec | `bun run --cwd apps/web test:e2e -- e2e/dashboard.spec.ts` | all pass |
| Bundle guard | `bun run test:web-bundle` | all pass |
| Full e2e | `bun run test:e2e` | all pass |

On NixOS, if Playwright's chromium fails to launch, set
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to the system Chrome binary
(`--channel chrome` does not work here). If `bun --bun vite` never becomes
ready once, re-run before diagnosing (known intermittent startup hang).

## Scope

**In scope** (the only files you should modify or create):
- `apps/web/src/lib/features/report/overview/provider-status.svelte`
- `apps/web/src/provider-status-panel-model.ts`
- `apps/web/src/provider-status-panel-model.test.ts`
- `apps/web/src/lib/features/report/overview/provider-status.ssr.test.ts` (new)
- `apps/web/src/lib/features/report/actions/quota-history-panel.svelte`
- `apps/web/src/provider-quota-history-model.ts`
- `apps/web/src/provider-quota-history-model.test.ts`
- `apps/web/src/provider-quota-e2e-fixture.ts`
- `apps/web/src/lib/features/sources/source-control-summary.svelte`
- `apps/web/src/lib/features/sources/source-control-summary-model.ts` (new)
- `apps/web/src/lib/features/sources/source-control-summary-model.test.ts` (new)
- `apps/web/src/lib/features/sources/source-controls.ssr.test.ts`
- `apps/web/e2e/dashboard.spec.ts`
- `apps/web/e2e/visual-regression.spec.ts-snapshots/` (regenerated PNGs only, if a captured viewport changes — see Step 8)

**Out of scope** (do NOT touch):
- `apps/web/src/provider-status-model.ts`, `provider-presentation.ts`,
  `provider-status-progress.ts`, `source-control-presentation-model.ts` —
  read-only anchors; the states, tones, labels and progress semantics are
  correct. The "Unsupported" in `source-control-presentation-model.ts` is a
  *source* availability label, not the provider badge.
- `apps/web/src/lib/features/report/actions/quota-history-owner.svelte` —
  its unfiltered request and `'24h'` default are correct; the drawer derives
  its window from the result (Step 4 explains why).
- `packages/usage-store/**`, `packages/report-data/**`,
  `packages/report-core/src/provider-quota.ts` — the anchor row is a
  deliberate store contract; the CLI and the web bound it at the presentation
  layer.
- `apps/cli/**` (plan 081 delivered the CLI rule; do not hoist
  `withoutPreRangePoints` into report-core here — recorded as maintenance).
- The quota rail (`apps/web/src/lib/features/shell/provider-quota-rail*`) —
  plan 080.
- `apps/web/src/lib/features/sources/model.ts`, `sources-page.svelte`,
  `source-control-presentation.ts` — plan 097 (Sources jargon).
- `apps/web/src/lib/features/report/breakdown/filter-bar.svelte` — plan 092
  (dropdown mechanic); this plan only *uses* the harness MultiSelect in e2e.
- `apps/web/src/lib/features/report/actions/quota-history-owner.svelte`'s
  `providerHistoryAvailable` wiring in the destinations — plan 074, landed.

## Git workflow

- Work on the program branch `plan/086-ui-ux-audit-remediation` (worktree
  already checked out). One commit for this plan; stage by explicit path
  (never `git add -A` — peer sessions write to this repo).
- Commit style: `fix(web): make provider status and quota history legible`
  with a body that names U22/U23/U28 and states the U28 finding from "Current
  state" (no code path couples the pill to the report filter).
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Re-partition the provider panel model and add the sentence, the machine lines and the detailed-provider selection

In `apps/web/src/provider-status-panel-model.ts` replace the five-way
partition with a three-way one plus three pure helpers. Keep
`buildProviderStatusPanelSummary` as the entry point.

```ts
export interface ProviderStatusPanelSummary {
  criticalProvidersWithoutQuota: ProviderStatusView[]; // tone === 'critical', no windows
  providersWithoutQuotaSource: ProviderStatusView[];   // every other provider with no windows
  quotaProviders: ProviderStatusView[];                // windowGroups.length > 0
}

export interface ProviderMachineLine {
  readonly key: string;               // machineContext ?? '' (unique per line)
  readonly machineLabel: string | null;
  readonly providers: ProviderStatusView[];
  readonly text: string;              // the full rendered sentence, built here
}

/** Providers that carry something a reader can act on: windows, a critical
 *  tone, a warning, or a credits summary. Order = input order (the views are
 *  already ranked by buildProviderStatusViews). */
export const detailedProviders = (summary: ProviderStatusPanelSummary): ProviderStatusView[]

/** One line per machine, machines sorted by label with the unscoped group
 *  (machineContext === null) last and without a prefix. Within a line, group
 *  by state in the order partial, unsupported, then other states by
 *  compareProviderStatusStates; labels inside a group are unique and sorted
 *  with localeCompare. Format:
 *  `${machineLabel ? `${machineLabel} · ` : ''}${groups.map(g => `${g.labels.join(', ')} — ${g.state.replaceAll('-', ' ')}`).join(' · ')}` */
export const providerMachineLines = (providers: readonly ProviderStatusView[]): ProviderMachineLine[]

/** `${n} provider(s) · ${q} with quota windows · ${m} without a quota source` +
 *  (m > 0 ? ` (${breakdown})` : '') + (critical > 0 ? ` · ${critical} critical` : '') +
 *  (flagged > 0 ? ` · ${flagged} with warnings` : '')
 *  where breakdown lists the non-zero state counts inside
 *  providersWithoutQuotaSource in the same state order as the lines
 *  (e.g. "5 partial, 1 unsupported"), and flagged counts the members of
 *  providersWithoutQuotaSource that have warnings or a credits summary
 *  (a subset — it is NOT part of the n = q + m + critical identity). */
export const describeProviderStatusSummary = (summary: ProviderStatusPanelSummary): string
```

Pluralize `provider` only (`1 provider`, `2 providers`); the other nouns are
fixed. Import `compareProviderStatusStates` from
`@ai-usage/report-core/provider-status` (already used by
`provider-status-model.ts`).

Rewrite `apps/web/src/provider-status-panel-model.test.ts`:
- keep the five-view fixture; assert `quotaProviders = [codex]`,
  `criticalProvidersWithoutQuota = [opencode]`,
  `providersWithoutQuotaSource = [claude, cursor, gemini]` (input order), and
  the complete/disjoint reconciliation over the three arrays;
- `detailedProviders` → `[codex, opencode, cursor]` (cursor has warnings);
- `describeProviderStatusSummary` →
  `'5 providers · 1 with quota windows · 3 without a quota source (1 partial, 1 unsupported, 1 ok) · 1 critical · 1 with warnings'`;
- `providerMachineLines` with `machineContext` set to repository-owned
  synthetic labels: `'MacBook-Pro'` for codex-without-windows, cursor and
  claude, `'Workstation'` for a second cursor view, `null` for
  gemini → three lines, in order:
  `'MacBook-Pro · Codex, Cursor — partial · Claude — unsupported'`,
  `'Workstation · Cursor — partial'`, `'Gemini — ok'`; every
  `text` matches
  `/ · /` between clauses and never matches `/\S·|·\S/` (the separator
  spacing assertion that fails on today's chip rendering);
- a view with `state: 'auth-required'` renders `'auth required'` in its line.

**Verify**: `cd apps/web && bun test src/provider-status-panel-model.test.ts` → all pass.

### Step 2: Re-compose the panel: machine lines, one sentence, glossary, fewer detail cards, top-aligned window groups

In `apps/web/src/lib/features/report/overview/provider-status.svelte`:

1. Import `describeProviderStatusSummary`, `detailedProviders`,
   `providerMachineLines` next to `buildProviderStatusPanelSummary` (line 204)
   and derive `const details = $derived(detailedProviders(summary))`,
   `const machineLines = $derived(providerMachineLines(summary.providersWithoutQuotaSource))`.
2. Delete the attention chip list (lines 354–372) and the five counter chips
   (lines 374–386) together with the now-unused `issueList`, `issuePill`,
   `attentionProviderName` css (lines 162–182) — Biome flags unused consts.
   The critical list (lines 346–352) and the quota cards (lines 336–344) stay.
3. In their place, inside `compactOverview`, render in this order:
   ```svelte
   <p class={contextLine} data-provider-status-summary>{describeProviderStatusSummary(summary)}</p>
   {#if machineLines.length > 0}
     <ul aria-label="Providers without a quota source" class={machineLineList}>
       {#each machineLines as line (line.key)}
         <li class={contextLine} data-provider-no-quota-line>{line.text}</li>
       {/each}
     </ul>
   {/if}
   <p class={glossary} data-provider-state-glossary>
     Ok = quota windows were read · Partial = usage was collected, but no quota reading reached this machine for that provider · Unsupported = the provider publishes no quota ai-usage can read
   </p>
   ```
   `machineLineList = css({ display: 'grid', gap: '4px', listStyle: 'none', m: 0, p: 0 })`,
   `glossary = css({ color: 'muted', fontSize: '11px', overflowWrap: 'anywhere' })`.
   Render each line as the single `{line.text}` string — do not rebuild it
   from fragments in the template (that is what reintroduces the lost space
   inside flex containers).
4. Details: change the disclosure (lines 389–396) to iterate `details` and
   label it `Provider details ({providerCountLabel(details.length)})`; wrap
   the whole `<details>` in `{#if details.length > 0}`. The string
   `No quota windows are available for this provider.` stays for the cards
   that still render without windows (critical / warning providers).
5. Window columns: add `alignItems: 'start'` to `windowsGrid` and
   `alignContent: 'start'` to `windowGroup` (lines 60–65) and put
   `data-provider-window-group` on the `windowGroup` div (line 276) so the
   SSR test can find it.
6. Keep `compactProviderStatus`, `providerSummaryMetrics`,
   `providerStateBadge`, the history button and the
   `No provider exposes quota windows in this report.` empty state unchanged.

**Verify**: `bun run typecheck` → exit 0;
`grep -n "Provider categories\|Providers requiring attention\|issuePill" apps/web/src/lib/features/report/overview/provider-status.svelte` → no matches;
`grep -c "data-provider-no-quota-line\|data-provider-status-summary\|data-provider-state-glossary\|data-provider-window-group" apps/web/src/lib/features/report/overview/provider-status.svelte` → 4.

### Step 3: SSR-render the panel and pin the four presentation fixes

Create `apps/web/src/lib/features/report/overview/provider-status.ssr.test.ts`
using the Vite `createServer` + `svelte/server` harness from
`apps/web/src/lib/features/shell/provider-quota-rail.ssr.test.ts` (lines
1–44; adjust `repositoryDirectory` to `'../../../../../../../'` as
`overview-components.test.ts` line 30 does) and load
`/apps/web/src/lib/features/report/overview/provider-status.svelte`. Build
views with a local `providerView()` helper like the one in
`overview-components.test.ts` lines 185–208 (or reuse the test helper shape
from `provider-status-panel-model.test.ts` lines 5–49). Strip Svelte
comments with `/<!--[\s\S]*?-->/g` before text assertions. Cases:

1. *Top-aligned columns*: a Codex view with `windowGroups` `5h` (one window)
   and `weekly` (two windows) → every `data-provider-window-group` element's
   `class` contains `ac_start` (Panda atom for `alignContent: 'start'`) and the
   `windowsGrid` parent contains `ai_start`. Fails on today's markup.
2. *Separator spacing*: views for Codex (partial,
   `machineContext: 'MacBook-Pro'`), Claude (unsupported,
   `'MacBook-Pro'`), Cursor (partial, `'Workstation'`)
   → two `data-provider-no-quota-line` items whose text equals
   `providerMachineLines(...)[i].text` exactly and does not match `/\S·|·\S/`.
3. *One sentence*: `data-provider-status-summary` text equals
   `describeProviderStatusSummary(buildProviderStatusPanelSummary(views))`;
   no element text starts with `Quota windows:` / `Attention without`.
4. *Glossary*: `data-provider-state-glossary` contains `Ok =`, `Partial =`,
   `Unsupported =`.
5. *Fewer cards*: with views [Codex-with-windows, Claude-unsupported,
   Cursor-partial, OpenCode-critical-with-warning] the rendered HTML contains
   exactly `detailedProviders(summary).length` (= 2) occurrences of the
   `providerCard` class (find it by counting `<li` inside the `<details>`
   block) and the `No quota windows are available for this provider.` string
   once (the critical card); with views [Claude-unsupported, Cursor-partial]
   only, the HTML contains no `Provider details (`.

**Verify**: `bun run --cwd apps/web dev:prepare && cd apps/web && bun test src/lib/features/report/overview/provider-status.ssr.test.ts src/lib/features/report/overview/overview-components.test.ts` → all pass (the existing progress/aria case in `overview-components.test.ts` lines 272–290 must still pass untouched).

### Step 4: Bound the history model to the requested window (carry-in, not stretch)

In `apps/web/src/provider-quota-history-model.ts`:

1. Add
   ```ts
   export interface ProviderQuotaHistoryWindow { readonly from: string; readonly to: string }
   export const providerQuotaHistoryWindow = (range: ProviderQuotaHistoryRange, to: string): ProviderQuotaHistoryWindow =>
     ({ from: new Date(Date.parse(to) - rangeDurationMs[range]).toISOString(), to });
   ```
   (move `rangeDurationMs` above it).
2. Change the signature to
   `buildProviderQuotaHistoryModel(result: ProviderQuotaHistoryResult, window: ProviderQuotaHistoryWindow)`
   and add `window: ProviderQuotaHistoryWindow` to `ProviderQuotaHistoryModel`.
3. In `buildSeries(points, window)`, after `dedupePoints`:
   - `inRange = sorted.filter((p) => p.firstObservedAt >= window.from && p.firstObservedAt <= window.to)`;
   - `carriedIn = sorted.findLast((p) => p.firstObservedAt < window.from && p.lastObservedAt >= window.from) ?? null`
     — the store's anchor when its held run overlaps the window (at most one
     per series; `findLast` keeps the rule total);
   - if `inRange.length === 0 && carriedIn === null` return `null` and filter
     nulls out in `buildProviderQuotaHistoryModel` (mirrors the CLI: an
     anchor-only series says nothing about the window);
   - `points: inRange`; `segments`, `gapCount`, `resetCount`, `largestGapMs`,
     `summary` computed from `inRange` only (the existing `summary` format
     string stays byte-identical apart from the count source — the e2e
     `/1 reset/` and `/1 collection gap/` patterns depend on it);
   - `firstObservedAt`/`lastObservedAt`/`currentPercent`/`nextResetAt`/
     `sourceKey`/`sourceConfidence` from `inRange` when it has points, else
     from `carriedIn`;
   - add to `ProviderQuotaHistorySeries`: `carriedIn: ProviderQuotaHistoryPoint | null`.
4. `emptyMessage`: `'No quota history yet.'` when `result.points.length === 0`;
   `'No quota observations in this window.'` when points existed but no series
   survived bounding; `null` otherwise.

Keep `providerQuotaHistoryRequest` unchanged (the owner still asks the store
for the same window; the bounding is presentation-side, exactly like the CLI).

Update `apps/web/src/provider-quota-history-model.test.ts`: pass
`providerQuotaHistoryWindow('24h', result.generatedAt)` to the three existing
cases (their points already sit inside that window), and add:
- *bounds to the window*: points A `{ firstObservedAt: '2026-07-13T08:00:00.000Z', lastObservedAt: '2026-07-15T08:55:00.000Z', usedPercent: 48 }`
  plus the four in-range points from the first test, `generatedAt
  '2026-07-15T10:36:00.000Z'`, window `'24h'` → `series[0].points` has 4
  points, `carriedIn` is A, `summary` starts with `4 points`, `resetCount` 1,
  `gapCount` 1, `firstObservedAt` is the first in-range point;
- *held-only series survives*: only A → one series, `points: []`,
  `carriedIn: A`, `currentPercent: 48`, `summary` starts with `0 points`;
- *stale series is dropped*: a point whose `lastObservedAt` is before `from`
  → `series: []`, `emptyMessage: 'No quota observations in this window.'`;
- *window arithmetic*: `providerQuotaHistoryWindow('7d', '2026-07-15T10:40:00.000Z').from === '2026-07-08T10:40:00.000Z'`.

**Verify**: `cd apps/web && bun test src/provider-quota-history-model.test.ts` → all pass; `bun run typecheck` → fails only in `quota-history-panel.svelte` (fixed in Step 5).

### Step 5: Redraw the drawer: window-bounded axis, markers above the data, guides beneath, equal-width controls

In `apps/web/src/lib/features/report/actions/quota-history-panel.svelte`:

1. Window: `const window = $derived(result ? providerQuotaHistoryWindow(range, result.generatedAt) : null);`
   `const model = $derived(result && window ? buildProviderQuotaHistoryModel(result, window) : null);`
   Put `data-quota-window-from={model?.window.from}` and
   `data-quota-window-to={model?.window.to}` on the `data-quota-history`
   root `<div>` (line 136). The end of the window is the result's
   `generatedAt` — the server's query time — rather than the owner's
   `requestedAt`, because the e2e resolver returns a fixture whose timestamps
   are fixed while `requestedAt` is the live clock (see Current state); the
   two differ by request latency only.
2. Geometry: constants become `CHART_WIDTH = 600`, `CHART_HEIGHT = 200`,
   `CHART_LEFT = 20`, `CHART_RIGHT = 580`, `MARKER_BAND_TOP = 6`,
   `MARKER_BAND_BOTTOM = 22`, `PLOT_TOP = 30`, `PLOT_MIDDLE = 100`,
   `PLOT_BOTTOM = 170`; `seriesX(observedAt)` maps onto the **window**:
   `CHART_LEFT + clamp01((Date.parse(observedAt) - from) / (to - from)) * CHART_PLOT_WIDTH`
   (no per-series span); `seriesY` uses `PLOT_TOP/PLOT_BOTTOM`. Remove
   `preserveAspectRatio="none"`; chart css becomes
   `css({ w: 'full', h: 'auto', aspectRatio: '3 / 1', bg: 'surface', border: …, borderRadius: 'sm' })`
   so the SVG scales uniformly. Add `data-quota-chart` on the `<svg>`.
3. Draw order inside the SVG (this is the fix for "hatches over data"):
   (a) the three gridlines; (b) one `<line data-quota-break-guide data-break-reason={reason}>`
   per break segment from `PLOT_TOP` to `PLOT_BOTTOM`, `stroke-opacity="0.25"`,
   `stroke-dasharray="3 4"`; (c) if `series.carriedIn`: a dashed hold line
   from `CHART_LEFT` to `seriesX(min(carriedIn.lastObservedAt, to))` at
   `seriesY(carriedIn.usedPercent)` plus a hollow
   `<circle data-quota-carried-in cx={CHART_LEFT} fill="none" stroke="currentColor" r="3.5">`
   with a `<title>` `Held at {pct} since {fmtDate(carriedIn.firstObservedAt)}`;
   (d) the series `<path data-quota-series-path>`s; (e) the
   `<circle data-quota-point>`s; (f) the break markers: a small triangle
   `<path data-quota-break-marker data-break-reason={reason}>` with apex at
   `(x, MARKER_BAND_BOTTOM)` and base at `MARKER_BAND_TOP` (width 10 units),
   filled for `reset`, stroke-only for `gap`, each with a `<title>`
   (`Reset boundary at …` / `Collection gap before …`). **No `<text>` element
   inside the SVG** — at the drawer's scale it is illegible; words go to HTML.
4. Under each chart, an HTML axis row
   `<div class={axisRow} data-quota-axis>` with three muted spans:
   `fmtDate(window.from)`, `fmtDate(midpoint)`, `fmtDate(window.to)`
   (`axisRow = css({ display: 'flex', justifyContent: 'space-between', color: 'muted', fontSize: '11px' })`).
   Once per drawer (above the series list) a legend line
   `<p class={muted} data-quota-legend>▼ reset boundary · ▽ collection gap · ○ held from before the window</p>`.
   Replace the `First … · Last …` paragraph (lines 259–262) with
   `Latest observation {fmtDate(series.lastObservedAt)}{series.carriedIn ? ` · held at ${fmtPct(series.carriedIn.usedPercent ?? 0)} since ${fmtDate(series.carriedIn.firstObservedAt)}` : ''} · Next reset …`
   (when `usedPercent` is null print `Unknown` instead of a percent).
   In the table, render the carried-in point as the first row when present,
   its Observed cell reading `held since {fmtDate(carriedIn.firstObservedAt)}`.
5. Controls: give the three selects one class
   `historySelect = cx(field, css({ w: '168px', minW: '168px' }))` and wrap
   each label text + select in `historyControl = css({ display: 'grid', gap: '4px', fontSize: '12px' })`;
   give the range buttons `css({ minW: '56px', minH: { base: '44px', sm: '36px' } })`
   so they share the selects' height on ≥ sm.

**Verify**: `bun run typecheck` → exit 0; `bun x ultracite fix && bun run check` → exit 0;
`grep -c "<text" apps/web/src/lib/features/report/actions/quota-history-panel.svelte` → 0;
`grep -c "preserveAspectRatio" apps/web/src/lib/features/report/actions/quota-history-panel.svelte` → 0.

### Step 6: Extend the e2e quota fixture with a held pre-window observation and pin the drawer behaviour

In `apps/web/src/provider-quota-e2e-fixture.ts`: add `readonly heldUntil?: string`
to `FixtureQuotaPointInput`, set `lastObservedAt: input.heldUntil ?? input.at`,
and append to `FIXTURE_POINT_INPUTS` one Codex point
`{ at: '2026-07-13T08:00:00.000Z', heldUntil: '2026-07-15T08:55:00.000Z', resetAt: '2026-07-13T12:00:00.000Z', usedPercent: 48, window: '5h' }`.
Update `E2E_PROVIDER_QUOTA_FIXTURE_POINT_COUNT` to `10` (the literal type
annotation forces this). At `24h` (window `2026-07-14T10:40Z → 2026-07-15T10:40Z`)
this point is carried in; at `7d` it is an ordinary in-range point.

In `apps/web/e2e/dashboard.spec.ts`, inside
`Provider quota history shows reset and gap-aware ranges on desktop and mobile`
(after the existing `GAP_COUNT_PATTERN` assertion and before the provider
select block), add:
```ts
const historyRoot = history.locator('[data-quota-history]');
await expect(historyRoot).toHaveAttribute('data-quota-window-from', '2026-07-14T10:40:00.000Z');
await expect(historyRoot).toHaveAttribute('data-quota-window-to', '2026-07-15T10:40:00.000Z');
const carriedIn = history.locator('[data-quota-carried-in]');
await expect(carriedIn).toHaveCount(1);
await expect(carriedIn).toHaveAttribute('cx', '20');

const chart = history.locator('article', { hasText: RESET_COUNT_PATTERN }).first().locator('[data-quota-chart]');
await expect(chart.locator('css=text')).toHaveCount(0);
const geometry = await chart.evaluate((svg) => {
  const rects = (selector: string) => [...svg.querySelectorAll(selector)].map((el) => el.getBoundingClientRect());
  const guides = [...svg.querySelectorAll('[data-quota-break-guide]')];
  const paths = [...svg.querySelectorAll('[data-quota-series-path]')];
  return {
    guideCount: guides.length,
    guidesBeforePaths: guides.every((guide) => paths.every((path) => Boolean(guide.compareDocumentPosition(path) & Node.DOCUMENT_POSITION_FOLLOWING))),
    markerBottom: Math.max(...rects('[data-quota-break-marker]').map((r) => r.bottom)),
    pointTop: Math.min(...rects('[data-quota-point]').map((r) => r.top)),
  };
});
expect(geometry.guideCount).toBeGreaterThan(0);
expect(geometry.guidesBeforePaths).toBe(true);
expect(geometry.markerBottom).toBeLessThanOrEqual(geometry.pointTop);

const controlWidths = await Promise.all(
  ['Provider', 'Machine', 'Account scope'].map(async (name) => (await history.getByRole('combobox', { name }).boundingBox())?.width ?? 0),
);
expect(Math.max(...controlWidths) - Math.min(...controlWidths)).toBeLessThanOrEqual(1);
expect(Math.min(...controlWidths)).toBeGreaterThanOrEqual(120);
```
and, right after the existing `7d` click + `aria-pressed` assertion:
```ts
await expect(historyRoot).toHaveAttribute('data-quota-window-from', '2026-07-08T10:40:00.000Z');
await expect(carriedIn).toHaveCount(0);
```
The existing `RESET_COUNT_PATTERN`/`GAP_COUNT_PATTERN` assertions keep
passing because the carried-in point is excluded from segmentation at `24h`.

**Verify**: `bun run --cwd apps/web test:e2e -- e2e/dashboard.spec.ts -g "quota history"` → passes; `cd apps/web && bun test src/server/provider-quota-resolver.server.test.ts` → passes (it reads the count constant).

### Step 7: Rewrite the provider-panel e2e to the new structure

In `apps/web/e2e/dashboard.spec.ts`: delete `PROVIDER_CATEGORY_COUNT_PATTERN`,
`PROVIDER_CATEGORY_TOTAL_PATTERN`, `PROVIDER_CATEGORIES_PATTERN` (lines
21–23); add
`const PROVIDER_SUMMARY_PATTERN = /^(\d+) providers? · (\d+) with quota windows · (\d+) without a quota source(?: \([^)]*\))?(?: · (\d+) critical)?(?: · \d+ with warnings)?$/;`
and `const PROVIDER_LINE_PATTERN = / — (?:partial|unsupported|ok|stale|auth required|error)/;`.
Replace the body of `keeps provider details collapsed until they are requested`
(rename it `summarizes providers without a quota source per machine and shows details only when they exist`):
keep the first half verbatim (viewport, `openHydratedReport`, `providerPanel`,
`dateRange`, `activeFilters`, `overviewHero`, `executiveMetrics`, the
`toContainText('Quota usage and operational issues at a glance.')` check and
the four placement `expect`s plus the hero-above-panel box check), then:
```ts
const summary = providerPanel.locator('[data-provider-status-summary]');
const lines = providerPanel.getByRole('list', { name: 'Providers without a quota source' }).getByRole('listitem');
const glossary = providerPanel.locator('[data-provider-state-glossary]');
await expect(summary).toHaveText(PROVIDER_SUMMARY_PATTERN);
const [, total, withQuota, withoutSource, critical] = (await summary.textContent())?.match(PROVIDER_SUMMARY_PATTERN) ?? [];
expect(Number(withQuota) + Number(withoutSource) + Number(critical ?? 0)).toBe(Number(total));
const lineTexts = await lines.allTextContents();
expect(lineTexts.length).toBeGreaterThan(0);
for (const line of lineTexts) {
  expect(line).toMatch(PROVIDER_LINE_PATTERN);
  expect(line).not.toMatch(/\S·|·\S/);
}
await expect(glossary).toContainText('Partial =');
await expect(glossary).toContainText('Unsupported =');
await expect(page.getByText(PROVIDER_DETAILS_PATTERN)).toHaveCount(0);
await expect(page.getByText('No quota windows are available for this provider.')).toHaveCount(0);

await page.setViewportSize({ height: 844, width: 390 });
expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
expect(await providerPanel.evaluate((element) => element.scrollWidth)).toBeLessThanOrEqual(
  await providerPanel.evaluate((element) => element.clientWidth),
);
```
(The e2e providers are all inferred without windows or warnings — see Current
state — so zero detail cards is the expected, asserted outcome; the
"collapsed by default" behaviour is pinned by the SSR test in Step 3, which
renders a provider *with* windows.)

**Verify**: `bun run --cwd apps/web test:e2e -- e2e/dashboard.spec.ts` → all pass.

### Step 8: Make the Sources pill a pure function of the source-control state and attribute every change

1. Create `apps/web/src/lib/features/sources/source-control-summary-model.ts`:
   ```ts
   import type { SourceControlClientState } from '../../../source-control-client';
   import { presentSourceState } from '../../../source-control-presentation-model';
   import type { SourcePresentationTone } from '../../../source-control-presentation-model';

   export interface SourceControlSummaryStatus {
     readonly generation: number | null;   // snapshot.generation, null before the first snapshot
     readonly label: string;
     readonly tone: SourcePresentationTone;
     readonly warningSources: readonly string[]; // labels of enabled sources with danger/warning tone
   }

   export const summarizeSourceControlStatus = (state: SourceControlClientState): SourceControlSummaryStatus
   ```
   Move the logic of `statusLabel`/`statusTone`/`warningCount`/
   `awaitingFirstSnapshot` (source-control-summary.svelte lines 11–14 and
   27–59) into it verbatim — same strings, same branch order. The signature
   admits only `SourceControlClientState`: no report, filter, or route input can
   reach the label.
2. In `source-control-summary.svelte` replace those derivations with
   `const status = $derived(summarizeSourceControlStatus(controlState));` and
   use `status.label` / `status.tone`; add
   `data-source-summary` and `data-source-summary-generation={status.generation ?? ''}`
   on the `<section>` (line 143), `data-source-summary-status` on the label
   `<span>` (line 161), and one muted line at the end of the hover card (after
   the "Last success" paragraph, line 191):
   `<p class={cardMeta}>Engine state #{status.generation} · pushed {fmtDate(snapshot.generatedAt)}</p>`
   (import `fmtDate` from `../../foundation/presentation/format`). When
   `status.warningSources.length > 0`, set the link's `title` to
   `Warnings: ${status.warningSources.join(', ')}` so the pill names what it
   counts.
3. Create `apps/web/src/lib/features/sources/source-control-summary-model.test.ts`
   (pattern: `source-components.test.ts`) with a snapshot builder like the
   one in `source-controls.fixture.svelte` lines 30–50 and cases: stopped +
   no snapshot → `Checking sources…`/`info`; live + one enabled source with
   `lastOutcome: 'warning'` → `1 warning`/`danger`, `warningSources` =
   `[label]`; two such sources → `2 warnings`; a disabled source with a
   failed outcome does not count; `runningCount: 1` and no warnings →
   `1 running`/`ok`; all ok → `Sources ready`/`ok`; `generation` echoes
   `snapshot.generation`; `connection: 'disconnected'` with a snapshot →
   `Reconnecting`/`warning`.
4. In `source-controls.ssr.test.ts` add one case: the rendered summary block
   contains `data-source-summary-generation="1"` and
   `data-source-summary-status` wrapping `Sources ready`.
5. In `apps/web/e2e/dashboard.spec.ts` add (import
   `waitForFocusedReportSettled` from `./browser-test`):
   ```ts
   test('keeps the collection source pill independent of the report filter', async ({ page }) => {
     await openHydratedReport(page);
     const summary = page.locator('[data-source-summary]');
     const status = summary.locator('[data-source-summary-status]');
     await expect(status).toHaveText('Sources ready');
     const generation = await summary.getAttribute('data-source-summary-generation');
     expect(generation).not.toBe('');

     await page.getByRole('combobox', { name: 'Filter by harness' }).click();
     await page.getByRole('option', { name: 'Claude' }).click();
     await page.keyboard.press('Escape');
     await expect(page).toHaveURL(/harness=/);
     await waitForFocusedReportSettled(page);

     await expect(status).toHaveText('Sources ready');
     expect(await summary.getAttribute('data-source-summary-generation')).toBe(generation);
   });
   ```
   If the option's accessible name in the MultiSelect differs from `Claude`
   (check with `category-visibility.spec.ts` lines 28–45), use the exact
   option text; do not change the MultiSelect (plan 092).

**Verify**: `cd apps/web && bun test src/lib/features/sources/source-control-summary-model.test.ts src/lib/features/sources/source-controls.ssr.test.ts` → all pass; `bun run --cwd apps/web test:e2e -- e2e/dashboard.spec.ts -g "source pill"` → passes.

### Step 9: Gates and snapshots

Run `bun x ultracite fix`, `bun run check`, `bun run lint`,
`bun run typecheck`, `bun run --cwd apps/web test`, `bun run test:web-bundle`,
then `bun run --cwd apps/web test:e2e -- e2e/dashboard.spec.ts e2e/visual-regression.spec.ts`.
If `visual-regression.spec.ts` fails, inspect the diff: the Provider status
panel sits below the fold of both captured Overview viewports, so a failure
there means the change moved something above it — STOP. If the only
difference is inside the panel, regenerate with
`bun run --cwd apps/web test:e2e -- e2e/visual-regression.spec.ts --update-snapshots`
and eyeball the PNGs. Finally `bun run test:e2e` → all pass.

## Test plan

- Unit: `provider-status-panel-model.test.ts` (partition, sentence, lines,
  separator spacing, detailed selection); `provider-quota-history-model.test.ts`
  (window bounding, carry-in, held-only, dropped series, window arithmetic);
  `source-control-summary-model.test.ts` (pill label/tone/generation from
  state only).
- SSR: new `provider-status.ssr.test.ts` (`ac_start`/`ai_start` atoms on the
  window columns, exact line text, sentence, glossary, card count, no
  `<details>` without detailed providers); `source-controls.ssr.test.ts`
  (generation stamp); `overview-components.test.ts` unchanged and green.
- e2e `dashboard.spec.ts`: rewritten provider-panel test (sentence numbers
  reconcile, lines well-spaced, glossary, zero dead-end cards in the fixture,
  no horizontal overflow at 390); extended quota-history test (window ISO
  bounds per range, one carried-in marker at `cx=20` at 24h and none at 7d,
  no SVG text, guides under paths, markers above points, equal control
  widths); new pill-independence test.
- Presentation gate satisfied: every visual fix above has a DOM/geometry/
  token assertion that fails on `51815b70` and passes after the change.

## Done criteria

- [ ] `grep -n "Provider categories\|Attention without quota windows\|issuePill" apps/web/src/lib/features/report/overview/provider-status.svelte` → no matches
- [ ] `grep -c "<text\|preserveAspectRatio" apps/web/src/lib/features/report/actions/quota-history-panel.svelte` → 0
- [ ] `grep -n "E2E_PROVIDER_QUOTA_FIXTURE_POINT_COUNT.*= 10" apps/web/src/provider-quota-e2e-fixture.ts` → 1 hit
- [ ] `grep -rn "summarizeSourceControlStatus" apps/web/src --include=*.svelte` → 1 call site in `source-control-summary.svelte`
- [ ] `grep -n "withoutPreRangePoints" apps/cli/src/usage-read-model.ts` → still 1 definition (CLI untouched)
- [ ] `git diff --stat 51815b70..HEAD -- packages/ apps/cli/ apps/web/src/lib/features/sources/model.ts apps/web/src/lib/features/report/actions/quota-history-owner.svelte apps/web/src/provider-status-model.ts` → empty
- [ ] `bun run typecheck`, `bun run check`, `bun run lint` exit 0
- [ ] `bun run --cwd apps/web test` exits 0 with the new unit/SSR cases
- [ ] `bun run --cwd apps/web test:e2e -- e2e/dashboard.spec.ts` exits 0
- [ ] `bun run test:web-bundle` exits 0
- [ ] The program brief's PII grep (maintainer first name, real home path, real mail domain) over `plans/095-provider-status-and-quota-history-legibility.md` returns nothing
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The "Current state" excerpts do not match the working tree (plans 092/094/
  097 may land first and touch neighbouring files; `provider-status.svelte`
  and `quota-history-panel.svelte` are owned by this plan only).
- `buildProviderQuotaHistoryModel` has gained a second production caller
  (`grep -rn buildProviderQuotaHistoryModel apps/web/src --include=*.svelte --include=*.ts | grep -v test`
  shows more than `quota-history-panel.svelte`) — the signature change would
  ripple; report the caller.
- The e2e resolver no longer returns the fixed-timestamp fixture (someone
  rebased it onto the request clock): then switch the window source to the
  owner's request (`from`/`to` props) instead of `result.generatedAt` — but
  report first, because the fixture assumptions in Step 6 change.
- In e2e the pill-independence test fails with a *different* label or
  generation after filtering: that is a real coupling this plan could not
  find by reading — report the observed label/generation pair and the
  network/EventSource activity, do not patch around it.
- `visual-regression.spec.ts` diffs outside the Provider status panel.
- Svelte's server renderer cannot render `provider-status.svelte` directly
  (context/prop error): render through
  `overview-page.fixture.svelte` with `providers` instead, as
  `overview-components.test.ts` does, and keep the same assertions.

## Maintenance notes

- The window end is the result's `generatedAt`. If the e2e quota fixture is
  ever rebased onto the request clock, pass the owner's `request.from/to`
  into the panel and delete `providerQuotaHistoryWindow`'s reliance on
  `generatedAt` — one seam, one test (`data-quota-window-*`).
- `withoutPreRangePoints` (CLI) and the web model's in-range/carry-in rule
  implement the same store contract; hoisting a shared
  `providerQuotaPointsWithinWindow` into `@ai-usage/report-core/provider-quota`
  is a small follow-up once both are stable — do it in the next plan that
  touches report-core quota code, not here.
- `describeProviderStatusSummary` is the only place that turns the partition
  into prose; the e2e regex in Step 7 is its contract. Changing the grammar
  means changing both.
- Reviewer should scrutinize: the carry-in rule (`lastObservedAt >= from`)
  against a real store with an idle day (a held Weekly value must show as a
  hollow left-edge marker, not vanish); the marker band never overlapping a
  series that hits 100 % (`MARKER_BAND_BOTTOM = 22 < PLOT_TOP = 30`); and
  that the Sources pill strings are byte-identical before/after the extraction
  (the `source-control-summary-model.test.ts` cases pin them).
- Deferred on purpose: stacking/staggering marker glyphs when two breaks are
  closer than 10 units apart (rare: a reset and a gap at the same instant
  collapse into one `reset` segment by construction); showing the CLI-style
  `start% → end%` trend in the drawer (plan 081 owns that wording).
