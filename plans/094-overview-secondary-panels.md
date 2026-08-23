# Plan 094: Calm the Overview Secondary Panels (Harness Disclosure, Session Shape, Punchcard Fit, KPI Baseline, Rhythm Axis, Record Tiles)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 51815b70..HEAD -- apps/web/src/lib/features/report/breakdown/harness-provider-model.ts apps/web/src/lib/features/report/breakdown/harness-provider-model.test.ts apps/web/src/lib/features/report/breakdown/harness-provider-panel.svelte apps/web/src/lib/features/report/breakdown/breakdown-row.svelte apps/web/src/lib/features/report/overview/session-shape.svelte apps/web/src/lib/features/report/overview/overview-page.svelte apps/web/src/lib/features/report/overview/overview-components.test.ts apps/web/src/lib/features/report/overview/executive-overview.svelte apps/web/src/lib/features/report/overview/records.svelte apps/web/src/lib/features/report/overview/activity-heatmap.svelte apps/web/src/lib/features/report/overview/punchcard.svelte apps/web/src/focused-report-e2e-fixture.ts apps/web/e2e/category-visibility.spec.ts apps/web/e2e/dashboard-presentation.spec.ts packages/design-system/src/components/overview.ts packages/design-system/src/components/chart.ts packages/design-system/src/components/chart.test.ts packages/design-system/src/svelte/passive/harness-fill.ts packages/design-system/src/svelte.ts packages/report-core/src/focused-report-query.ts packages/report-core/src/focused-report-query.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition. Plans 088 (`harness-provider-model.ts`),
> 093 (`executive-overview.svelte`, hero block) and 098 (`records.svelte`,
> "Busiest day" pluralisation) touch files in this list on the same program
> branch; if one of them has already landed, re-anchor the affected step on the
> new line numbers — every change here is additive and orthogonal to theirs.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW–MED
- **Depends on**: none (coordinate line numbers with 088, 093, 098 as noted above)
- **Category**: presentation
- **Planned at**: commit `51815b70`, 2026-08-23
- **Audit findings**: U16, U20, U21, U35, U38, U41

## Why this matters

The 2026-08-23 fresh-eyes audit of the running dev app (Chrome headless via CDP,
six routes, 1920/1280/1024/768/390, dark + light, keyboard, console clean) found
six defects in the Overview's secondary panels and the Analysis harness
breakdown. None is a data bug; each is a presentation habit that makes a
correct number harder to read:

- **U16** — "Harnesses & providers" renders an expander on every harness, but
  for Codex and Claude the only child is "Codex sub" / "Claude sub" with the
  exact same figures as the parent. Expanding reveals nothing; the reader
  learns to distrust the control. Only OpenCode has a real provider split.
- **U20** — "Session shape" draws every scatter dot in the same accent colour
  while a harness colour legend sits under the chart (inert `<li>` badges); the
  standout list beneath has no title; and the panel repeats the section
  header's sentence ("Duration/value patterns and weekly/hourly activity · N
  sessions") as its own subtitle.
- **U21** — At 1280 px the Punchcard needs a horizontal scroll (hours 16–23 are
  hidden) and its card is two thirds empty vertically because it is stretched
  to the height of the Session shape card beside it. The Punchcard's 24 px
  interactive target is the WCAG minimum and is pinned by a test, so the fix is
  the row layout, not the cell (see the arithmetic below).
- **U35** — The four KPI tiles under the hero are not baseline-aligned once one
  tile carries a qualification line ("Pricing coverage" with "Partially
  measured …"): the big numbers sit at different heights (observed y 145 / 139
  / 120). The tile grid stretches its rows to the tallest sibling.
- **U38** — Rhythm's month axis reads "Jun … Aug … Aug" across 15 months with
  no year; the legend says "scaled by sessions" while the readout leads with
  the dollar value.
- **U41** — The Investigate record tiles render 2 + 1 at 768 px (an orphan
  third tile) because the grid is two columns below `lg` regardless of how
  many tiles exist.

Each fix below lands with a deterministic DOM, computed-geometry, render or
token assertion (the repository's presentation gate), so the defect cannot be
marked done from a diff alone and cannot come back silently.

## Current state

All paths are relative to the worktree root; line numbers were read at
`51815b70`.

### U16 — harness/provider disclosure

- `apps/web/src/lib/features/report/breakdown/harness-provider-model.ts`
  - lines 15–20 — the parent view has no notion of a trivial child:
    ```ts
    export interface HarnessProviderParent {
      readonly children: readonly HarnessProviderChild[];
      readonly controlsId: string;
      readonly expanded: boolean;
      readonly group: AnalyticsGroup;
    }
    ```
  - lines 62–76 — every visible harness becomes a parent with children taken
    from `harnessProviderGroups` whenever the harness is expanded (or the
    search matches a provider label):
    ```ts
    const parents = visibleGroups.map((group): HarnessProviderParent => {
      const allChildren = childrenByHarness.get(group.key) ?? [];
      const matchingChildren = allChildren.filter((child) => breakdownLabelMatchesSearch(child.provider, query));
      pairCount += searchActive ? matchingChildren.length : allChildren.length;
      let visibleChildren: readonly AnalyticsGroup[] = matchingChildren;
      if (!searchActive) {
        visibleChildren = expandedHarnesses.includes(group.key) ? allChildren : [];
      }
      return {
        children: visibleChildren.map((child) => ({ group: child, label: child.provider })),
        controlsId: providerDisclosureId(group.key),
        expanded: visibleChildren.length > 0,
        group,
      };
    });
    ```
- `apps/web/src/lib/features/report/breakdown/harness-provider-panel.svelte`
  lines 103–126 — the toggle is offered for every parent whenever no search is
  active (`controlsId` is always passed, so `BreakdownRow` always renders the
  "+" button):
  ```svelte
  <BreakdownRow
    controlsId={parent.controlsId}
    expanded={parent.expanded}
    hierarchy
    onFilter={() => onHarnessFilter(parent.group.key)}
    {...(!view.searchActive ? { onToggle: () => toggleHarness(parent.group.key) } : {})}
    view={parentView}
  />
  {#if parent.children.length > 0}
    <fieldset aria-label={`Providers for ${parent.group.key}`} class={hierarchyChildren} id={parent.controlsId}>
  ```
- `apps/web/src/lib/features/report/breakdown/breakdown-row.svelte`
  lines 72–87 — the identity cell: the expander renders when
  `onToggle && controlsId`, with `aria-label={`${expanded ? 'Collapse' : 'Expand'} providers for ${view.group.harness}`}`
  (line 78), followed by `<button class={groupKeyButton} onclick={onFilter} type="button">{view.label}</button>`
  (line 86). Line 70 marks child rows with `data-provider-child={child ? view.group.provider : undefined}`.
- Why the sole child always mirrors the parent: both group lists are computed
  from the same visible rows in
  `packages/report-core/src/focused-report-query.ts` lines 1529–1530
  (`harnesses: groupAnalytics(visible, analyticsInput, (row) => row.harness, totalCost)` and
  `harnessProviders: groupAnalytics(visible, harnessProviderAnalyticsInput, harnessProviderKey, totalCost)`),
  so a harness with one provider pair has a child equal to itself by
  construction. The provider names come from the collectors
  (`packages/local-collectors/src/collectors/claude.ts:288` `'Claude sub'`,
  `codex-history.ts:646` `'Codex sub' : 'Codex API'`,
  `opencode.ts:215` `'OpenAI API' : 'Codex sub (OC)'`) — do not touch them.
- Pinned by tests today:
  - `apps/web/e2e/category-visibility.spec.ts` lines 59–64 search the panel
    for `claude sub` and expect the child row:
    ```ts
    await breakdownSearch.fill('claude sub');
    await expect(harnessPanel.locator('[data-harness-total]')).toHaveCount(1);
    await expect(harnessPanel.locator('[data-harness-total="Claude"]')).toBeVisible();
    await expect(harnessPanel.locator('[data-provider-child="Claude sub"]')).toBeVisible();
    await expect(harnessPanel.locator('[data-provider-child]')).toHaveCount(1);
    ```
    Lines 46–51 of the same spec collect **every** `button:not([aria-expanded])`
    inside `[data-price-state]` rows as a "category" and compare the set with
    the harness filter options — so the sole-provider annotation added below
    must be a `<span>`, never a `<button>`.
  - `apps/web/e2e/value-presentation.spec.ts` lines 45–56 read
    `[data-harness-total]` order and `[data-price-bar] > div` colours — untouched.
  - `apps/web/src/lib/features/report/breakdown/harness-provider-model.test.ts`
    (three cases) builds groups with `group(key, harness = key, provider = key, sessions = 1)`
    where `costSum`, `fresh`, `inp`, `priced` all equal `sessions` — convenient
    for a "mirrors the parent" case.
- In the synthetic e2e data (`apps/web/src/report-data.ts`) every harness has
  exactly one provider (`Codex`/`Codex API`, `Claude`/`Claude sub`,
  `OpenCode`/`OpenCode`, `Cursor`/`Cursor local`), so after this plan no
  fixture harness shows an expander; the expandable path is covered by the new
  SSR test (Step 4).

### U20 — Session shape

- `apps/web/src/lib/features/report/overview/session-shape.svelte`
  - line 8: `const point = css({ fill: 'accent', opacity: 0.78, stroke: 'surface', strokeWidth: 1 });`
    — one colour for every dot.
  - lines 59–62 — the panel subtitle plus the duplicated section sentence:
    ```svelte
    <p class={panelSub}>Duration × API value (log scales) — fixed-size marks show sessions or campaigns</p>
    {#if advancedSummary}
      <p class={summary} data-advanced-summary>{advancedSummary.summary}</p>
    {/if}
    ```
    The same `advancedSummary.summary` string is already printed by
    `overview-page.svelte` lines 107–109 in the "Advanced analysis" header
    (`{result.view.advancedSummary?.summary ?? 'Session shape and weekly/hourly activity'}`),
    and `overview-page.svelte` line 116 passes `advancedSummary={result.view.advancedSummary}`
    into this component for no other purpose.
  - lines 77–94 — the `<circle class={point} … data-session-shape-point r={SESSION_SHAPE_POINT_RADIUS}>` loop; each
    `item` carries `item.harness` (bins in `buildSessionShape` are keyed per
    harness — `packages/report-core/src/focused-report-query.ts` line 1235
    `const key = `${item.harness}:${column}:${row}`;` — so every point has one harness).
  - lines 119–136 — `<section aria-label="Standout sessions" class={outliers}>` with no visible title.
  - lines 137–141 — the inert legend, placed last in the panel:
    ```svelte
    <ul aria-label="Session Shape harness key" class={legend} data-session-shape-harness-key>
      {#each presented.harnesses as name (name)}
        <li><HarnessBadge {name} /></li>
      {/each}
    </ul>
    ```
- Colour sources. `HarnessBadge`
  (`packages/design-system/src/svelte/controls/harness-badge.svelte` lines 36–42)
  paints the badge with `color: 'harness.<family>.fg'` and its leading dot with
  `bg: currentColor`; the bar charts use
  `packages/design-system/src/svelte/passive/harness-fill.ts` (lines 5–18:
  `harnessFillTones` = `css({ bg: 'harness.<family>.fg' })` per family, `harnessFamily`
  resolves `claude|codex|cursor|opencode|gemini` from the first word) via
  `dimensionSwatch('harness', key)` in `packages/design-system/src/components/chart.ts`
  lines 39–48. Neither helper produces an SVG `fill` class, which is what a
  `<circle>` needs; `harnessFillFor` is not exported from
  `packages/design-system/src/svelte.ts` (lines 11–22 export `accentFill`,
  `dimensionSwatch`, `stableSeriesColor`, … from `./components/chart`).
  Panda generates `fill_*` atoms already (`fill_accent`, `fill_muted` exist in
  the built stylesheet) and token-valued `fill` works (`axis = css({ fill: 'muted' })`
  on line 7 of the same component).
- `packages/design-system/src/svelte/passive/passive-closure.test.ts` requires
  every passive module (including `components/chart.ts`) to import only
  `@ai-usage/design-system/css` transitively — `harness-fill.ts` already
  satisfies this.
- `apps/web/src/lib/features/report/overview/overview-components.test.ts`
  lines 296–337 ("renders Session Shape, advanced summary, and injected
  campaign language") injects a one-point shape with
  `advancedSummary: { hasPunchcard: true, hasSessionShape: true, summary: 'Shape and rhythm ready' }`
  and `harnesses: [seed.harness]` where `seed = baseResult.view.topSessions[0]`
  (the campaign root, harness `Codex`). Today the string `Shape and rhythm ready`
  appears twice in the rendered body (header + panel).

### U21 — Punchcard fit and the Advanced analysis row

- `packages/design-system/src/components/overview.ts`
  - lines 43–51 — the Advanced analysis row:
    ```ts
    export const twoColumns = css({
      display: 'grid',
      gridTemplateColumns: { base: '1fr', lg: 'repeat(2, minmax(0, 1fr))' },
      gap: '14px',
      alignItems: 'stretch',
      '& > :only-child': {
        gridColumn: '1 / -1',
      },
    });
    ```
  - lines 231–241 — the Punchcard geometry:
    ```ts
    export const PUNCHCARD_INTERACTIVE_TARGET_SIZE_PX = 24;
    …
    export const punchGrid = css({
      display: 'grid',
      gridTemplateColumns: `34px repeat(24, ${PUNCHCARD_INTERACTIVE_TARGET_SIZE})`,
      gap: '2px',
      alignItems: 'center',
      overflowX: 'auto',
      overflowY: 'hidden',
    });
    ```
    Natural width = 34 + 24 × 24 + 24 × 2 = **658 px**; inside `panel`
    (`p: '16px 18px'`, `packages/design-system/src/components/panel.ts` line 7)
    the card needs **694 px**.
- `apps/web/src/lib/features/report/overview/overview-page.svelte`
  lines 113–125 — `SessionShape` is rendered **before** `Punchcard` inside
  `<div class={twoColumns}>`; order matters for the asymmetric grid below.
- Why spacing cannot fix it: the target is pinned to the WCAG minimum
  (`packages/design-system/src/preset.test.ts` line 7 `WCAG_MINIMUM_TARGET_SIZE_PX = 24`,
  lines 154–156 `expect(PUNCHCARD_INTERACTIVE_TARGET_SIZE_PX).toBeGreaterThanOrEqual(…)`), and
  `apps/web/e2e/dashboard-presentation.spec.ts` lines 340–341 / 369–375 pin
  `column-gap: 2px`, `row-gap: 2px` and every target at 24 × 24. Even with zero
  gap the grid is 34 + 576 = 610 px. Content width of the shell: `apps/web/src/lib/features/shell/app-shell.svelte`
  line 37 `ml: { base: 0, md: '56px', xl: '216px' }` plus
  `packages/design-system/src/components/layout.ts` lines 22–27 (`shell`:
  `maxWidth: '1380px'`, `px: { base: '20px', md: '36px' }`) gives ≈ 977 px at
  1280 and 1308 px at 1920. A symmetric half column is therefore ≈ 445 px at
  1280 and 611 px at 1920 — the Punchcard overflows in **every** two-up width.
  ADR 0005/0009 forbid enlarging or shrinking the compact cells, so the fix is
  the row: stack below `2xl` (1536 px), and at `2xl`+ give the Punchcard its
  natural width and the Session shape the rest (1308 − 14 − 694 = 600 px at 1920).
- `apps/web/e2e/dashboard-presentation.spec.ts` lines 320–395 ("uses compact
  circular Punchcard marks …") runs at 1440 and ends with
  `expect(punchcardBox?.width ?? 0).toBeGreaterThanOrEqual((advancedBox?.width ?? 0) - 32);`
  — it passes because the synthetic data renders **no** Session shape (the
  shared rows form one campaign plus one priced session; `buildSessionShape`
  needs three timed, fully priced items), so the Punchcard is `:only-child`.
  There is currently no browser scenario with both panels — the fixture flag
  in Step 11 adds one.
- `apps/web/src/focused-report-e2e-fixture.ts`
  - line 35 `export const FOCUSED_REPORT_E2E_MODEL_TAIL_KEY = '__aiUsageE2EModelTail';`
    and lines 155–185 `withModelTail` (appends rows derived from `rows[0]`,
    all in one lineage) are the pattern for an opt-in row extension.
  - lines 188–207 `focusedOverviewRows()` applies the opt-ins in sequence:
    `const widened = Reflect.get(globalThis, FOCUSED_REPORT_E2E_MODEL_TAIL_KEY) === true ? withModelTail(rows) : rows;`
    (line 207) before the ninety-day branch.
  - `apps/web/e2e/time-range.spec.ts` lines 112–119 show how a spec arms a
    flag: `page.addInitScript(({ enabledKey, trendKey }) => { Reflect.set(globalThis, enabledKey, true); … })`.
- `apps/web/src/lib/features/report/overview/punchcard.svelte` — read-only in
  this plan (line 62 `<div class={punchGrid} data-punchcard-visual>`); its
  semantic table (lines 108–132) and geometry do not change.

### U35 — KPI tile baseline

- `apps/web/src/lib/features/report/overview/executive-overview.svelte`
  - lines 23–31 — the tile style has no `alignContent`, so the grid rows
    stretch to fill the tile height:
    ```ts
    const metric = css({
      borderTop: '1px solid token(colors.line)',
      display: 'grid',
      gap: '3px',
      m: 0,
      minW: 0,
      pt: '12px',
      '& dd, & dt': { m: 0 },
    });
    ```
  - lines 176–187 — the strip: `<dl class={metricStrip} data-executive-metrics>` →
    per tile `<dt>{label}</dt>`, `<dd class={metricValue}>{value}</dd>`,
    `<dd class={executiveCaption}>{detail}</dd>`, and
    `{#if supportMetric.qualification}<dd class={executiveCaption}>…</dd>{/if}`.
- `packages/design-system/src/components/executive-overview.ts` lines 44–57 —
  `metricStrip` has `alignItems: 'stretch'`, so every tile gets the height of
  the tallest one; a three-row tile then distributes the surplus across its
  three auto rows (≈ +7 px on the label row when a sibling carries one extra
  caption line), which is exactly the observed drift.
- `apps/web/src/lib/features/report/overview/executive-overview-model.ts`
  lines 142–175 — only `pricing-coverage` ever has a non-null `qualification`
  (`pricingQualification(summary.priceMeasurement)`), which appears when the
  selection is partially measured. In the synthetic data this is the "All
  time" range (the Cursor row is unpriced): `apps/web/e2e/dashboard-presentation.spec.ts`
  lines 168–182 already click "All time" and assert the coverage tile contains
  `Partially measured`.
- `apps/web/e2e/dashboard-presentation.spec.ts` lines 120–166 ("keeps the four
  executive metrics aligned below a visually dominant KPI", 1440 × 1000, opened
  with a bare `page.goto('/')`) measures
  `value.getBoundingClientRect().top - element.getBoundingClientRect().top`
  per tile (lines 142–150) and asserts `max − min ≤ MAX_ALIGNMENT_DRIFT_PX`
  (= 1, line 18) on line 151 —
  but only in the default 30-day state where no tile has a qualification, so it
  cannot see the defect.

### U38 — Rhythm month axis and readout/legend wording

- `packages/report-core/src/focused-report-query.ts` — the single production
  source of month labels (used by both the in-memory projection and the SQLite
  reader via `buildFocusedHeatmapFromAggregates`, see
  `packages/usage-store/src/focused-report-query-sqlite.ts:929`):
  - lines 1107–1108: `const monthLabels: string[] = []; let previousMonth = -1;`
  - lines 1129–1131:
    ```ts
    const month = cursor.getMonth();
    monthLabels.push(month === previousMonth ? '' : cursor.toLocaleDateString('en', { month: 'short' }));
    previousMonth = month;
    ```
  - validation (lines 2039–2045) only requires a bounded string array whose
    length equals `weeks.length` — any label text is accepted.
  - `apps/web/src/overview-model.ts` lines 137–160 hold a legacy copy
    (`buildCalendarHeatmapData`) with no production consumer (only
    `overview-model.test.ts`); leave it alone.
- `apps/web/src/lib/features/report/overview/activity-heatmap.svelte`
  - lines 66–71 — the readout leads with the value:
    ```ts
    const describeHeatDay = (item: FocusedHeatDay): string => {
      const value = aggregateApiValuePresentation(item.priceMeasurement).label;
      const provenance = aggregateApiPriceProvenance(item.priceMeasurement);
      const sessions = `${fmtNum(item.sessions)} ${item.sessions === 1 ? 'session' : 'sessions'}`;
      return `${fmtDateOnly(item.date)} — ${value} · ${sessions}${provenance ? ` · ${provenance.label}` : ''}`;
    };
    ```
    The same function feeds each day button's `title` and `aria-label`
    (lines 136–147) and the live readout (lines 161–165).
  - lines 121–125 — the month row: `<div aria-hidden="true" class={heatMonths}>{#each heatmap.monthLabels …}<span>{label}</span>{/each}</div>`.
  - lines 166–172 — the legend ends with `<span style="margin-left: auto">scaled by sessions</span>`.
  - The cell level really is session-scaled (`focused-report-query.ts`
    lines 1102–1105 quantile thresholds over `sessions`), so the legend is
    truthful and the readout is what changes.
- ADR 0009 (`docs/adr/0009-direct-rhythm-day-controls.md`) requires every day
  button to keep "a complete accessible name containing its date, session
  count, API-value presentation, provenance when applicable, and action" — it
  does not fix their order.
- Geometry is pinned and stays: `apps/web/e2e/dashboard.spec.ts` lines 692–710
  ("keeps compact heatmap geometry at narrow and desktop viewports") assert
  18 px cells / `column-gap: 3px` at 361 px and 12 px cells / `column-gap: 3px`
  at 1024 px.
- The synthetic rows span 2026-04-12 → 2026-06-11, so the e2e heatmap shows
  three labelled months (Apr, May, Jun) in one year.

### U41 — Investigate record tiles

- `packages/design-system/src/components/overview.ts` lines 311–315:
  ```ts
  export const recordsGrid = css({
    display: 'grid',
    gridTemplateColumns: { base: 'repeat(2, minmax(0, 1fr))', lg: 'repeat(4, minmax(0, 1fr))' },
    gap: '10px',
  });
  ```
- `apps/web/src/lib/features/report/overview/records.svelte` lines 72–121 —
  up to four `<button class={recordCard}>` children inside `<div class={recordsGrid}>`:
  "Top session" (only when `presentedRecords.topCost && !topCostRepeatsFirstSession`,
  line 74), "Longest session" (line 86), "Busiest day" (line 96), "Streak"
  (line 109, `streak > 0 && streakEnd`). In the synthetic data the top session
  is the first Top-sessions row, so the grid renders **three** cards (the SSR
  test `overview-components.test.ts` line 111 asserts the Top session card is
  absent), which is the 2 + 1 case the audit saw at 768 px.
- No test asserts the record grid's track count today.

### Shared conventions you will rely on

- `exactOptionalPropertyTypes` is on (`apps/web/tsconfig.json` line 5): pass
  optional props with the spread pattern already used in
  `harness-provider-panel.svelte` line 111, never as an explicit `undefined`.
- Panda atoms: `cx()` only joins class names; two atoms for the same property
  are resolved by stylesheet order, not call order (see the comment above
  `accentFill` in `packages/design-system/src/components/chart.ts` lines 26–32).
  Never stack `fill_accent` and `fill_harness.…` on one element — always choose
  one class.
- Generated class names you will assert on: `fill_harness.codex.fg`,
  `c_harness.codex.fg`, `ai_start`, `grid-tc_1fr`, `md:grid-tc_repeat(3,_minmax(0,_1fr))`,
  `2xl:grid-tc_minmax(0,_1fr)_max-content` (Panda's `2xl` breakpoint is
  1536 px from `@pandacss/preset-panda`; no other file uses it yet).
- `tools/check-design-export-consumers.ts` fails the lint when an
  `export const` in `packages/design-system/src/components/*.ts` has no
  consumer outside barrels — every new export below has a named consumer.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install | `bun install` | exit 0 |
| Design-system build (regenerates Panda buildinfo after `css()` additions) | `bun run --cwd packages/design-system build` | exit 0 |
| Typecheck | `bun run typecheck` | exit 0 |
| Format/lint | `bun x ultracite fix` then `bun run check` and `bun run lint` | exit 0 |
| Design-system unit tests | `cd packages/design-system && bun test` | all pass |
| Report-core unit tests | `cd packages/report-core && bun test src/focused-report-query.test.ts` | all pass |
| Web unit + SSR tests | `bun run --cwd apps/web test` | all pass |
| One SSR test file | `cd apps/web && bun run dev:prepare && bun test src/lib/features/report/overview/overview-components.test.ts` | all pass |
| One e2e spec | `cd apps/web && bun run test:e2e -- e2e/dashboard-presentation.spec.ts` | all pass |
| Full e2e | `bun run test:e2e` | all pass |

On NixOS, if Playwright's downloaded chromium fails to launch, set
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to the system Chrome binary before
running e2e (`--channel chrome` does not work here).

## Scope

**In scope** (the only files you should modify or create):

- `apps/web/src/lib/features/report/breakdown/harness-provider-model.ts`
- `apps/web/src/lib/features/report/breakdown/harness-provider-model.test.ts`
- `apps/web/src/lib/features/report/breakdown/harness-provider-panel.svelte`
- `apps/web/src/lib/features/report/breakdown/breakdown-row.svelte`
- `apps/web/src/lib/features/report/breakdown/harness-provider-panel.ssr.test.ts` (new)
- `apps/web/e2e/category-visibility.spec.ts`
- `packages/design-system/src/svelte/passive/harness-fill.ts`
- `packages/design-system/src/components/chart.ts`
- `packages/design-system/src/components/chart.test.ts`
- `packages/design-system/src/svelte.ts`
- `packages/design-system/src/components/overview.ts`
- `packages/design-system/src/components/overview.test.ts` (new)
- `apps/web/src/lib/features/report/overview/session-shape.svelte`
- `apps/web/src/lib/features/report/overview/overview-page.svelte` (one prop removal)
- `apps/web/src/lib/features/report/overview/overview-components.test.ts`
- `apps/web/src/lib/features/report/overview/executive-overview.svelte` (the `metric` css block only)
- `apps/web/src/lib/features/report/overview/records.svelte`
- `apps/web/src/lib/features/report/overview/activity-heatmap.svelte`
- `packages/report-core/src/focused-report-query.ts` (month-label loop only)
- `packages/report-core/src/focused-report-query.test.ts`
- `apps/web/src/focused-report-e2e-fixture.ts` (one opt-in flag)
- `apps/web/e2e/dashboard-presentation.spec.ts`
- `apps/web/e2e/visual-regression.spec.ts-snapshots/` (regenerated PNGs only if
  a diff is limited to the record-tile grid or KPI tile alignment)

**Out of scope** (do NOT touch):

- `apps/web/src/lib/features/report/overview/punchcard.svelte`,
  `punchGrid`, `punchCell`, `PUNCHCARD_INTERACTIVE_TARGET_SIZE_PX`, the
  heatmap cell/gap sizes (`heatGrid`, `heatCell`, `heatMonths`) — ADR 0005/0009
  compact geometry, pinned by `preset.test.ts` and
  `dashboard.spec.ts` "keeps compact heatmap geometry".
- Letting the Rhythm grid stretch to the card width (the "~970 of 1300 px
  used" part of U38). The grid's width is weeks × (12 px + 3 px); filling
  1300 px at 65 weeks means either 20 px cells or 8 px gaps, both of which the
  ADRs and the pinned geometry test reject, and a narrower gap makes it use
  *less* width. This plan records the decision and leaves the blank right
  margin; if the maintainer wants it used, it is a section-layout decision
  (for example pairing Rhythm with Token anatomy at `2xl`), not a heatmap
  change — see Maintenance notes.
- Provider naming (`' sub'`, `'API'`) in `packages/local-collectors/**` and
  the aggregation in `packages/report-core` beyond the month-label loop —
  plan 088 owns the harness-total vs overview-total discrepancy (U02).
- The hero value formatting and "≥" wrapping in `executive-overview.svelte`
  (plan 093, U34) and "Busiest day … 1 sessions" pluralisation in
  `records.svelte` (plan 098, U09) — same files, different lines.
- Making the Session shape legend interactive or the scatter accessible beyond
  its existing per-point `<title>`; the `HarnessBadge` component itself.
- `apps/web/src/overview-model.ts` `buildCalendarHeatmapData` (legacy, test-only).

## Git workflow

- Work on the program branch `plan/086-ui-ux-audit-remediation` in this
  worktree; one commit for this plan. Stage by explicit path (peer sessions
  may be writing other plans' files in the same worktree) — never `git add -A`.
- Commit style (from `git log`): `fix(web): calm the Overview secondary panels (plans 094)` or split
  into one commit per finding group if the diff is large; mention the U-numbers.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1 (U16): teach the model which harnesses have nothing to disclose

In `apps/web/src/lib/features/report/breakdown/harness-provider-model.ts`:

1. Extend the parent view (lines 15–20):
   ```ts
   export interface HarnessProviderParent {
     readonly children: readonly HarnessProviderChild[];
     readonly controlsId: string;
     /** False when the harness has no provider pairs or a single pair that repeats its own figures. */
     readonly expandable: boolean;
     readonly expanded: boolean;
     readonly group: AnalyticsGroup;
     /** The provider of a single mirroring pair, shown inline on the harness row instead of a child. */
     readonly soleProvider: string | null;
   }
   ```
2. Add the rule above `providerDisclosureId`:
   ```ts
   const MIRRORED_FIGURES = ['sessions', 'costSum', 'fresh', 'cache', 'priced'] as const;

   /**
    * A harness whose only provider pair repeats the harness figures has nothing to disclose: the
    * child row would print the parent's numbers under a second name. Both group lists are computed
    * from the same visible rows, so this holds by construction today; the figure check guards the
    * day an aggregation diverges, in which case the disclosure comes back on its own.
    */
   export const soleProviderMirroringHarness = (
     harness: AnalyticsGroup,
     children: readonly AnalyticsGroup[],
   ): string | null => {
     const [only] = children;
     if (children.length !== 1 || only === undefined) {
       return null;
     }
     return MIRRORED_FIGURES.every((figure) => only[figure] === harness[figure]) ? only.provider : null;
   };
   ```
3. Rewrite the `parents` mapping (lines 62–76) so a mirrored pair never
   becomes a child row, while the header pair count and the search behaviour
   stay as they are:
   ```ts
   const parents = visibleGroups.map((group): HarnessProviderParent => {
     const allChildren = childrenByHarness.get(group.key) ?? [];
     const soleProvider = soleProviderMirroringHarness(group, allChildren);
     const expandable = soleProvider === null && allChildren.length > 0;
     const matchingChildren = allChildren.filter((child) => breakdownLabelMatchesSearch(child.provider, query));
     pairCount += searchActive ? matchingChildren.length : allChildren.length;
     let visibleChildren: readonly AnalyticsGroup[] = expandable ? matchingChildren : [];
     if (!searchActive) {
       visibleChildren = expandable && expandedHarnesses.includes(group.key) ? allChildren : [];
     }
     return {
       children: visibleChildren.map((child) => ({ group: child, label: child.provider })),
       controlsId: providerDisclosureId(group.key),
       expandable,
       expanded: visibleChildren.length > 0,
       group,
       soleProvider,
     };
   });
   ```
   (`pairCount` still counts the mirrored pair — the header "N harnesses · M
   provider pairs" stays truthful; export rows stay "what is visible", so a
   folded pair exports the parent line only, which already carries its figures.)
4. In `harness-provider-model.test.ts` add three cases next to the existing
   ones (reuse the `group()` helper — `costSum`/`fresh`/`priced` equal
   `sessions`, so equal session counts mean mirrored figures):
   - `'folds a sole provider that mirrors its harness into the parent row'`:
     `harnessProviderView([group('codex', 'codex', 'codex', 3)], [group('Codex sub', 'codex', 'Codex sub', 3)], '', 'value', ['codex'])`
     → `parents[0]` has `expandable === false`, `expanded === false`,
     `soleProvider === 'Codex sub'`, `children` `[]`; `pairCount === 1`;
     `exportRows.map(({ label }) => label)` equals `['codex']`.
   - `'keeps the disclosure when the only provider diverges from its harness'`:
     parent `group('codex', 'codex', 'codex', 3)`, child
     `group('Codex sub', 'codex', 'Codex sub', 2)`, expanded `['codex']` →
     `expandable === true`, `soleProvider === null`, `children.length === 1`.
   - `'matches a sole provider by search without re-introducing a child row'`:
     same groups as the first case, query `'codex sub'`, expanded `[]` →
     `searchActive === true`, `parents.length === 1`, `children` `[]`,
     `soleProvider === 'Codex sub'`, `pairCount === 1`.

**Verify**: `cd apps/web && bun test src/lib/features/report/breakdown/harness-provider-model.test.ts` → 6 pass (3 existing + 3 new).

### Step 2 (U16): only offer the expander when there is something to expand

In `harness-provider-panel.svelte` lines 106–113 replace the parent row with:
```svelte
<BreakdownRow
  {...(parent.expandable ? { controlsId: parent.controlsId } : {})}
  expanded={parent.expanded}
  hierarchy
  onFilter={() => onHarnessFilter(parent.group.key)}
  {...(parent.expandable && !view.searchActive ? { onToggle: () => toggleHarness(parent.group.key) } : {})}
  {...(parent.soleProvider === null ? {} : { soleProvider: parent.soleProvider })}
  view={parentView}
/>
```
Leave the `{#if parent.children.length > 0}<fieldset …>` block as is (it is
already empty for folded parents).

**Verify**: `bun run typecheck` → exit 0 (the `soleProvider` prop does not exist yet — do Step 3 before running it).

### Step 3 (U16): render the sole provider inline, as text

In `breakdown-row.svelte`:

1. Add `soleProvider?: string;` to the props type and destructure it
   (`soleProvider` with no default).
2. Add a style next to `identity` (line 43):
   `const soleProviderNote = css({ color: 'muted', fontSize: '12px', whiteSpace: 'nowrap' });`
3. After the label button (line 86) render:
   ```svelte
   {#if soleProvider}
     <span
       class={soleProviderNote}
       data-sole-provider={soleProvider}
       title="Only provider recorded for this harness — its figures are the harness figures"
       >· {soleProvider}</span
     >
   {/if}
   ```
   It must stay a `<span>`: `category-visibility.spec.ts` lines 46–51 treat
   every non-expander `<button>` in the panel as a filter category.

**Verify**: `bun run typecheck` → exit 0;
`grep -n "data-sole-provider" apps/web/src/lib/features/report/breakdown/breakdown-row.svelte` → 1 hit.

### Step 4 (U16): SSR assertion for both branches

Create `apps/web/src/lib/features/report/breakdown/harness-provider-panel.ssr.test.ts`
by copying the Vite/svelte-server bootstrap from
`model-analysis-table.ssr.test.ts` lines 1–65 (component/renderer guards,
`group()` factory, `createServer`, `afterAll(closeViteServer)`), loading
`/apps/web/src/lib/features/report/breakdown/harness-provider-panel.svelte`
and `svelte/server`, then one test:

```ts
test('renders an expander only for harnesses with a real provider split', () => {
  const { body } = render(component, {
    props: {
      generatedAt: '2026-08-23T09:00:00.000Z',
      groups: [group('codex', { sessions: 3 }), group('opencode', { sessions: 4 })],
      harnessProviderGroups: [
        group('codex', { key: 'codex|Codex sub', provider: 'Codex sub', sessions: 3 }),
        group('opencode', { key: 'opencode|OpenAI API', provider: 'OpenAI API', sessions: 3 }),
        group('opencode', { key: 'opencode|Codex sub (OC)', provider: 'Codex sub (OC)', sessions: 1 }),
      ],
      onHarnessFilter: () => undefined,
      onProviderFilter: () => undefined,
      onSortChange: () => undefined,
      sort: 'value',
    },
  });
  expect(body).toContain('data-harness-total="codex"');
  expect(body).toContain('data-sole-provider="Codex sub"');
  expect(body).not.toContain('aria-label="Expand providers for codex"');
  expect(body).toContain('aria-label="Expand providers for opencode"');
  expect(body).not.toContain('data-provider-child=');
  expect(body).toContain('3 provider pairs');
});
```
(The `group(key, overrides)` factory copied from `model-analysis-table.ssr.test.ts`
lines 27–52 sets `harness: key`, `provider: key` and the defaults
`cache: 50`, `costSum: 12`, `fresh: 100`, `priced: 1`, `sessions: 1`. Overriding
only `sessions: 3` on the codex parent and on its pair keeps every other
mirrored figure equal, so `soleProviderMirroringHarness` folds the pair; the
opencode pairs differ from their parent in `sessions`, so opencode stays
expandable. The header text is asserted on its pair half only because Svelte
SSR may emit a line break between the harness count and the word.)

**Verify**: `cd apps/web && bun run dev:prepare && bun test src/lib/features/report/breakdown/harness-provider-panel.ssr.test.ts` → 1 pass.

### Step 5 (U16): re-pin the browser expectation

In `apps/web/e2e/category-visibility.spec.ts` replace lines 63–64 with:
```ts
await expect(harnessPanel.locator('[data-harness-total="Claude"] [data-sole-provider="Claude sub"]')).toBeVisible();
await expect(harnessPanel.locator('[data-provider-child]')).toHaveCount(0);
await expect(harnessPanel.getByRole('button', { name: /Expand providers for/ })).toHaveCount(0);
```
(Every synthetic harness has one provider, so no expander may remain.)

**Verify**: `cd apps/web && bun run test:e2e -- e2e/category-visibility.spec.ts` → pass.

### Step 6 (U20): an SVG fill helper that shares the badge tokens

1. `packages/design-system/src/svelte/passive/harness-fill.ts` — add beside
   `harnessFillTones`:
   ```ts
   const harnessMarkTones: Readonly<Record<string, string>> = {
     claude: css({ fill: 'harness.claude.fg' }),
     codex: css({ fill: 'harness.codex.fg' }),
     cursor: css({ fill: 'harness.cursor.fg' }),
     opencode: css({ fill: 'harness.opencode.fg' }),
     gemini: css({ fill: 'harness.gemini.fg' }),
   };

   /** SVG `fill` counterpart of `harnessFillFor`, for marks drawn with `<circle>`/`<rect>`. */
   export const harnessMarkFillFor = (name: string): string | undefined => harnessMarkTones[harnessFamily(name)];
   ```
2. `packages/design-system/src/components/chart.ts` — add
   `export { harnessMarkFillFor } from '../svelte/passive/harness-fill';`
   (keep the existing `import { harnessFillFor }`).
3. `packages/design-system/src/svelte.ts` lines 11–22 — add
   `harnessMarkFillFor,` to the `./components/chart` export list.
4. `packages/design-system/src/components/chart.test.ts` — add:
   ```ts
   test('maps harness marks to the same fg tokens the badges use', () => {
     expect(harnessMarkFillFor('Codex')).toContain('fill_harness.codex.fg');
     expect(harnessMarkFillFor('Claude Code')).toContain('fill_harness.claude.fg');
     expect(harnessMarkFillFor('Some new tool')).toBeUndefined();
   });
   ```
   (import it from `./chart`).

**Verify**: `bun run --cwd packages/design-system build && cd packages/design-system && bun test` → all pass (including `passive-closure.test.ts` and `design-entrypoints.test.ts`).

### Step 7 (U20): colour the dots, title the list, drop the echo

In `apps/web/src/lib/features/report/overview/session-shape.svelte`:

1. Module script: import `cx` alongside `css`; change line 8 to
   `const point = css({ opacity: 0.78, stroke: 'surface', strokeWidth: 1 });`
   (no `fill` — exactly one fill class is added per circle) and add
   `const neutralPoint = css({ fill: 'muted' });` (the neutral `HarnessBadge`
   paints its dot `muted`, so unknown families stay consistent) and
   `const listTitle = css({ textStyle: 'label', color: 'muted', m: 0 });`.
2. Instance script: add `harnessMarkFillFor` to the
   `@ai-usage/design-system/svelte` import; remove `advancedSummary` from
   `Props` and from the destructuring.
3. Template:
   - delete lines 60–62 (`{#if advancedSummary}<p … data-advanced-summary>…{/if}`);
     keep line 59's axis subtitle.
   - circle (lines 79–85): `class={cx(point, harnessMarkFillFor(item.harness) ?? neutralPoint)}`
     and add `data-session-shape-harness={item.harness}`.
   - move the legend `<ul aria-label="Session Shape harness key" …>` (lines
     137–141) to directly after the chart `</div>` (the `wrap` element, line
     96) so it precedes `data-session-shape-summary` — a key belongs next to
     the marks it explains.
   - standout list (lines 119–136):
     ```svelte
     <section aria-labelledby="session-shape-standouts-title" class={outliers}>
       <h5 class={listTitle} id="session-shape-standouts-title">Standout sessions</h5>
       {#each presented.outliers as item (item.row.rowId)}
     ```
     (replace the `aria-label` with `aria-labelledby`; the `h5` follows the
     panel's `h4`).
4. `overview-page.svelte` line 116: delete `advancedSummary={result.view.advancedSummary}`.

**Verify**: `bun run typecheck` → exit 0;
`grep -n "data-advanced-summary\|advancedSummary" apps/web/src/lib/features/report/overview/session-shape.svelte` → no matches.

### Step 8 (U20): SSR assertions

In `overview-components.test.ts`, test "renders Session Shape, advanced
summary, and injected campaign language" (line 296), append:
```ts
expect(body.split('Shape and rhythm ready').length - 1).toBe(1); // header only, no panel echo
expect(body).not.toContain('data-advanced-summary');
const shapeMarkup = body.slice(body.indexOf('data-session-shape'), body.indexOf('data-session-shape-summary'));
expect(shapeMarkup).toContain('data-session-shape-harness="Codex"');
expect(shapeMarkup).toContain('fill_harness.codex.fg');
expect(shapeMarkup).not.toContain('fill_accent');
expect(body.indexOf('data-session-shape-harness-key')).toBeLessThan(body.indexOf('data-session-shape-summary'));
expect(body).toContain('Standout sessions</h5>');
expect(body).toContain('c_harness.codex.fg'); // the legend badge uses the same token family
```

**Verify**: `cd apps/web && bun test src/lib/features/report/overview/overview-components.test.ts` → all pass.

### Step 9 (U21): let the Advanced analysis row respect the Punchcard's width

`packages/design-system/src/components/overview.ts` lines 43–51 become:
```ts
// Session shape (flexible) beside Punchcard (its natural width). The Punchcard grid is
// 34px + 24 × 24px targets + 24 × 2px gaps = 658px and the 24px target is the WCAG minimum
// (preset.test.ts), so it cannot share a symmetric half of any content width this shell offers
// (≈977px at 1280, 1308px at the 1380px shell maximum). It stacks under the shape until `2xl`;
// from there the shape takes what the Punchcard leaves. Keep the shape first in the DOM.
export const twoColumns = css({
  display: 'grid',
  gridTemplateColumns: { base: '1fr', '2xl': 'minmax(0, 1fr) max-content' },
  gap: '14px',
  // Natural heights: a stretched Punchcard card was two thirds empty next to the taller shape.
  alignItems: 'start',
  '& > :only-child': {
    gridColumn: '1 / -1',
  },
});
```

**Verify**: `bun run --cwd packages/design-system build` → exit 0.

### Step 10 (U21 + U41): token assertions for the layout rules

Create `packages/design-system/src/components/overview.test.ts` (pattern:
`executive-overview.test.ts`):
```ts
import { describe, expect, test } from 'bun:test';
import { recordsGrid, recordsGridTriple, twoColumns } from './overview';

describe('Overview secondary layouts', () => {
  test('stacks Session shape and Punchcard until 2xl, then gives Punchcard its natural width', () => {
    expect(twoColumns).toContain('grid-tc_1fr');
    expect(twoColumns).toContain('2xl:grid-tc_minmax(0,_1fr)_max-content');
    expect(twoColumns).not.toContain('lg:grid-tc_repeat(2');
    expect(twoColumns).toContain('ai_start');
  });

  test('lays three record tiles out 1-up, then 3-up from md', () => {
    expect(recordsGrid).toContain('grid-tc_repeat(2,_minmax(0,_1fr))');
    expect(recordsGridTriple).toContain('grid-tc_1fr');
    expect(recordsGridTriple).toContain('md:grid-tc_repeat(3,_minmax(0,_1fr))');
  });
});
```
(`recordsGridTriple` is created in Step 15; write this file now and run it
after Step 15. If Panda formats the `2xl` atom differently, print the class
string once and pin the exact text — do not loosen the assertion to a substring
that the old `lg:repeat(2, …)` rule would also satisfy.)

### Step 11 (U21): a browser scenario with both panels

1. `apps/web/src/focused-report-e2e-fixture.ts` — add after line 35:
   ```ts
   /**
    * Opt-in only. Session shape needs three timed, fully priced items with distinct lineages; the
    * shared rows form one campaign plus one priced session, so the Advanced analysis row renders
    * Punchcard alone. This appends three roots inside the default period and touches nothing else.
    */
   export const FOCUSED_REPORT_E2E_SESSION_SHAPE_KEY = '__aiUsageE2ESessionShape';
   ```
   and after `withModelTail`:
   ```ts
   const SESSION_SHAPE_ROWS = [
     { cost: 0.45, durationMs: 900_000, harness: 'Codex', harnessKey: 'codex', id: 'shape-fixture-01', provider: 'Codex API' },
     { cost: 2.1, durationMs: 5_400_000, harness: 'Claude', harnessKey: 'claude', id: 'shape-fixture-02', provider: 'Claude sub' },
     { cost: 6.3, durationMs: 14_400_000, harness: 'Codex', harnessKey: 'codex', id: 'shape-fixture-03', provider: 'Codex API' },
   ] as const;

   const withSessionShape = (rows: typeof demoReportPayload.rows): typeof demoReportPayload.rows => {
     const template = rows[0];
     if (!template) {
       return rows;
     }
     return [
       ...rows,
       ...SESSION_SHAPE_ROWS.map((entry, index) => ({
         ...template,
         activeDate: `2026-06-0${index + 2}T10:00:00.000Z`,
         costActual: entry.cost,
         costApprox: entry.cost,
         costKnown: true,
         date: `2026-06-0${index + 2}T08:00:00.000Z`,
         durationMs: entry.durationMs,
         endDate: `2026-06-0${index + 2}T10:00:00.000Z`,
         harness: entry.harness,
         name: entry.id,
         provider: entry.provider,
         sessionLabel: entry.id,
         source: {
           harnessKey: entry.harnessKey,
           machineId: 'fixture-machine',
           machineLabel: 'Fixture Machine',
           rootSourceSessionId: entry.id,
           sourceSessionId: entry.id,
         },
       })),
     ];
   };
   ```
   In `focusedOverviewRows()` (line 207) chain it after the model tail:
   `const shaped = Reflect.get(globalThis, FOCUSED_REPORT_E2E_SESSION_SHAPE_KEY) === true ? withSessionShape(widened) : widened;`
   and use `shaped` where `widened` was used below (the ninety-day branch and
   its early return). If `source.harnessKey`'s type rejects `'claude'`, look at
   the `Recover Claude history` row in `report-data.ts` (it uses
   `harnessKey: 'claude'`) and match its shape.
2. `apps/web/e2e/dashboard-presentation.spec.ts` — import
   `FOCUSED_REPORT_E2E_SESSION_SHAPE_KEY` from `'../src/focused-report-e2e-fixture'`
   and add:
   ```ts
   test('keeps every Punchcard hour visible beside Session shape across the desktop band', async ({ page }) => {
     await page.addInitScript(
       ({ enabledKey, shapeKey }) => {
         Reflect.set(globalThis, enabledKey, true);
         Reflect.set(globalThis, shapeKey, true);
       },
       { enabledKey: FOCUSED_REPORT_E2E_ENABLED_KEY, shapeKey: FOCUSED_REPORT_E2E_SESSION_SHAPE_KEY },
     );
     for (const { sideBySide, width } of [
       { sideBySide: false, width: 1024 },
       { sideBySide: false, width: 1280 },
       { sideBySide: true, width: 1920 },
     ]) {
       await page.setViewportSize({ height: 1000, width });
       await openHydratedReport(page);
       await waitForFocusedReportSettled(page);
       const shape = page.locator('[data-session-shape]');
       const punchcard = page
         .getByRole('heading', { level: 4, name: 'Punchcard' })
         .locator('xpath=ancestor::section[1]');
       const visual = page.locator('[data-punchcard-visual]');
       await expect(shape, `${width}px`).toBeVisible();
       await expect(punchcard, `${width}px`).toBeVisible();
       expect(
         await visual.evaluate((element) => element.scrollWidth - element.clientWidth),
         `${width}px: hidden Punchcard hours`,
       ).toBeLessThanOrEqual(0);
       const [shapeBox, punchcardBox] = await Promise.all([shape.boundingBox(), punchcard.boundingBox()]);
       const sameRow = Math.abs((shapeBox?.top ?? 0) - (punchcardBox?.top ?? Number.POSITIVE_INFINITY)) < 1;
       expect(sameRow, `${width}px: side by side`).toBe(sideBySide);
     }
   });
   ```
   Before this plan the 1280 iteration fails (`scrollWidth − clientWidth` ≈ 213)
   and the 1920 iteration fails too (≈ 47 px hidden in the symmetric half).

**Verify**: `cd apps/web && bun run test:e2e -- e2e/dashboard-presentation.spec.ts` → the new test passes and the existing "uses compact circular Punchcard marks …" test still passes (its 1440 run has no flag, so the Punchcard is still the only child).

### Step 12 (U35): stop stretching the KPI tile rows

1. `executive-overview.svelte` lines 23–31: add `alignContent: 'start',` to
   the `metric` css block (keep everything else).
2. `apps/web/e2e/dashboard-presentation.spec.ts`, test "keeps the four
   executive metrics aligned below a visually dominant KPI" (line 120): after
   the existing drift assertion (line 151) and before the font-size checks,
   re-measure in the state that has a qualified tile (the test opens the page
   with a bare `page.goto('/')`, so wait for hydration before clicking — a
   pre-hydration click is a full navigation):
   ```ts
   await waitForHydratedReport(page);
   await page
     .getByRole('region', { name: 'Report period' })
     .getByRole('button', { exact: true, name: 'All time' })
     .click();
   await waitForFocusedReportSettled(page);
   const coverage = metrics.filter({ hasText: 'Pricing coverage' });
   await expect(coverage).toContainText('Partially measured');
   expect(await coverage.locator('dd').count()).toBe(3); // value, caption, qualification
   expect(await metrics.first().locator('dd').count()).toBe(2); // a sibling without a qualification
   const qualifiedOffsets = await metrics.evaluateAll((elements) =>
     elements.map((element) => {
       const value = element.querySelector('dd');
       if (!(value instanceof HTMLElement)) {
         throw new Error('Executive metric value is missing');
       }
       return Math.round(value.getBoundingClientRect().top - element.getBoundingClientRect().top);
     }),
   );
   expect(Math.max(...qualifiedOffsets) - Math.min(...qualifiedOffsets)).toBeLessThanOrEqual(MAX_ALIGNMENT_DRIFT_PX);
   ```
   (Extract the offset measurement into a local `valueOffsetsOf(metrics)`
   helper to avoid duplicating the `evaluateAll` body.) Without Step 12.1 this
   fails with a drift of about 7 px.

**Verify**: `cd apps/web && bun run test:e2e -- e2e/dashboard-presentation.spec.ts` → pass.

### Step 13 (U38): year boundaries on the month axis

1. `packages/report-core/src/focused-report-query.ts` lines 1107–1108 and
   1129–1131:
   ```ts
   const monthLabels: string[] = [];
   let previousMonth = -1;
   let labelledYear: number | null = null;
   …
   const month = cursor.getMonth();
   if (month === previousMonth) {
     monthLabels.push('');
   } else {
     const year = cursor.getFullYear();
     const monthName = cursor.toLocaleDateString('en', { month: 'short' });
     // The first label and the first label of every new year carry the year: "Jun '25 … Jan '26".
     monthLabels.push(year === labelledYear ? monthName : `${monthName} '${String(year).slice(-2)}`);
     labelledYear = year;
   }
   previousMonth = month;
   ```
2. `packages/report-core/src/focused-report-query.test.ts` — add a case
   (import `buildFocusedHeatmapFromAggregates` from `./focused-report-query`
   and `apiPriceMeasurement` from `./provenance`):
   ```ts
   test('marks the heatmap month axis with the year at the start and at every January', () => {
     const aggregate = (iso: string) => ({
       cost: 1,
       priceMeasurement: apiPriceMeasurement({ costKnown: true, freshTokens: 0, knownCost: 1 }),
       sessions: 1,
       time: Date.parse(iso),
     });
     const heatmap = buildFocusedHeatmapFromAggregates(
       [aggregate('2025-06-15T12:00:00.000Z'), aggregate('2026-02-10T12:00:00.000Z')],
       new Date('2026-02-11T12:00:00.000Z'),
     );
     expect(heatmap?.monthLabels.filter(Boolean)).toEqual([
       "Jun '25", 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec', "Jan '26", 'Feb',
     ]);
     expect(heatmap?.monthLabels.length).toBe(heatmap?.weeks.length);
   });
   ```
   (Noon UTC keeps the local calendar day stable in any test time zone.)

**Verify**: `cd packages/report-core && bun test src/focused-report-query.test.ts` → all pass.

### Step 14 (U38): readout leads with what scales the cells

1. `activity-heatmap.svelte` line 70 — reorder so sessions come first:
   ```ts
   return `${fmtDateOnly(item.date)} — ${sessions} · ${value}${provenance ? ` · ${provenance.label}` : ''}`;
   ```
   Add `data-heatmap-months` to the month row `<div aria-hidden="true" class={heatMonths}>` (line 121).
   Leave the legend text "scaled by sessions" — it is now the same sentence the
   readout opens with.
2. `overview-components.test.ts`, test "renders all heatmap cells as one
   roving collection …" (line 210): add
   ```ts
   expect(todayButton).toMatch(/ — 1 session · /);
   const readout = body.slice(body.indexOf('data-heatmap-readout'));
   expect(readout.slice(0, readout.indexOf('</div>'))).toMatch(/ — [\d,]+ sessions? · /);
   ```
3. `apps/web/e2e/dashboard-presentation.spec.ts` — add:
   ```ts
   test('labels the Rhythm month axis with the year and leads the day readout with sessions', async ({ page }) => {
     await openHydratedReport(page);
     const calendar = page.getByRole('toolbar', { name: /Daily activity calendar/ });
     const rhythm = page.locator('section').filter({ has: calendar });
     const labels = (await rhythm.locator('[data-heatmap-months] > span').allTextContents()).filter(Boolean);
     expect(labels.length).toBeGreaterThan(0);
     expect(labels[0]).toMatch(/^[A-Z][a-z]{2} '\d{2}$/);
     for (const label of labels.slice(1)) {
       expect(label).toMatch(/^[A-Z][a-z]{2}( '\d{2})?$/);
     }
     expect(labels.filter((label) => label.includes("'"))).toHaveLength(1); // Apr–Jun 2026: one year mark
     await expect(rhythm.locator('[data-heatmap-readout]')).toHaveText(/ — [\d,]+ sessions? · /);
   });
   ```

**Verify**: `cd apps/web && bun test src/lib/features/report/overview/overview-components.test.ts` → pass; `bun run test:e2e -- e2e/dashboard-presentation.spec.ts` → pass.

### Step 15 (U41): three tiles go 1-up, then 3-up

1. `packages/design-system/src/components/overview.ts` — after `recordsGrid`
   (line 315) add a complete sibling (not a `cx` overlay — the two grid
   templates would collide on stylesheet order):
   ```ts
   // Three cards leave an orphan on a two-column row. Below `md` one column reads better than 2 + 1;
   // from `md` three equal columns fit the 768px content width.
   export const recordsGridTriple = css({
     display: 'grid',
     gridTemplateColumns: { base: '1fr', md: 'repeat(3, minmax(0, 1fr))' },
     gap: '10px',
   });
   ```
2. `records.svelte`:
   - import `recordsGridTriple` with the others from `@ai-usage/design-system/report`;
   - derive the card count from the same conditions the template uses:
     ```ts
     const recordCount = $derived(
       presentedRecords
         ? [
             presentedRecords.topCost !== null && !topCostRepeatsFirstSession,
             presentedRecords.longest !== null,
             presentedRecords.busiest !== null,
             presentedRecords.streak > 0 && presentedRecords.streakEnd !== null,
           ].filter(Boolean).length
         : 0,
     );
     ```
     (Keep these four conditions textually identical to the four `{#if}`
     guards on lines 74, 86, 96 and 109 — the attribute must never disagree
     with the rendered cards.)
   - line 73: `<div class={recordCount === 3 ? recordsGridTriple : recordsGrid} data-record-count={recordCount} data-records-grid>`.
3. `overview-components.test.ts`, first test (line 65): add
   `expect(body).toContain('data-record-count="3"');` next to the existing
   `not.toContain('>Top session</span>')` assertion (line 111).
4. `apps/web/e2e/dashboard-presentation.spec.ts` — add:
   ```ts
   test('never orphans a record tile: three tiles are 3-up from md and 1-up below', async ({ page }) => {
     await page.setViewportSize({ height: 1024, width: 768 });
     await openHydratedReport(page);
     const grid = page.locator('[data-records-grid]');
     await expect(grid).toHaveAttribute('data-record-count', '3');
     const trackCount = () =>
       grid.evaluate((element) => getComputedStyle(element).gridTemplateColumns.trim().split(' ').filter(Boolean).length);
     expect(await trackCount()).toBe(3);
     const tops = await grid.locator(':scope > button').evaluateAll((elements) =>
       elements.map((element) => Math.round(element.getBoundingClientRect().top)),
     );
     expect(new Set(tops).size).toBe(1); // one row, no orphan

     await page.setViewportSize({ height: 844, width: 390 });
     expect(await trackCount()).toBe(1);
     const widths = await grid.evaluate((element) => ({
       grid: element.getBoundingClientRect().width,
       cards: [...element.querySelectorAll(':scope > button')].map((card) => card.getBoundingClientRect().width),
     }));
     expect(widths.cards.every((width) => Math.abs(width - widths.grid) < 1)).toBe(true);
   });
   ```
   Before this plan the 768 iteration reports 2 tracks and two distinct
   `top` values.

**Verify**: `bun run --cwd packages/design-system build && cd packages/design-system && bun test src/components/overview.test.ts` → pass (Step 10 file);
`cd apps/web && bun test src/lib/features/report/overview/overview-components.test.ts && bun run test:e2e -- e2e/dashboard-presentation.spec.ts` → pass.

### Step 16: gates and snapshots

Run `bun x ultracite fix`, `bun run check`, `bun run lint` (includes
`check-design-export-consumers` and `check-svelte-style-shadowing`),
`bun run typecheck`, `bun run --cwd apps/web test`, `bun run test:packages`,
then `bun run test:e2e`. If `visual-regression.spec.ts` fails, open the diff
image: the only acceptable differences are the record-tile grid in
`overview-narrow.png` (three tiles now 1-up at 390 px) or a sub-pixel KPI tile
shift in `overview-desktop.png`; regenerate with
`cd apps/web && bun run test:e2e -- e2e/visual-regression.spec.ts --update-snapshots`
and re-inspect. Any other difference is a STOP condition.

**Verify**: every command above exits 0.

## Test plan

- Unit: `harness-provider-model.test.ts` (+3: mirrored fold, diverging pair
  keeps disclosure, search on a folded provider); `chart.test.ts` (+1:
  `harnessMarkFillFor` families); new `overview.test.ts` (token assertions for
  `twoColumns`, `recordsGridTriple`); `focused-report-query.test.ts` (+1: year
  marks at start and every January).
- SSR: new `harness-provider-panel.ssr.test.ts` (expander only for a real
  split, `data-sole-provider`, no child rows); `overview-components.test.ts`
  (section sentence appears once, dots carry `fill_harness.<family>.fg` and no
  `fill_accent`, legend precedes the summary, `Standout sessions</h5>`, readout
  and today button lead with sessions, `data-record-count="3"`).
- Browser (`dashboard-presentation.spec.ts`): Punchcard has no hidden hours at
  1024/1280/1920 with both panels present and sits beside the shape only at
  1920; KPI values drift ≤ 1 px with a qualified Pricing coverage tile; Rhythm
  first month label carries `'YY`, exactly one year mark for the fixture span,
  readout regex; record tiles 3 tracks / one row at 768 and 1 track at 390.
  `category-visibility.spec.ts`: sole provider shown inline, zero child rows,
  zero expanders.
- Existing pins that must keep passing untouched: Punchcard 24 × 24 targets,
  `column-gap: 2px`, 10 px dots, `punchcardBox.width ≥ advancedBox.width − 32`
  at 1440 (`dashboard-presentation.spec.ts` 320–395); heatmap 12 px / 3 px
  geometry (`dashboard.spec.ts` 692–710); `value-presentation.spec.ts` harness
  order and bar colours; `preset.test.ts` hash (no token changes).

## Done criteria

- [ ] `grep -n "soleProvider\|expandable" apps/web/src/lib/features/report/breakdown/harness-provider-model.ts | wc -l` ≥ 6
- [ ] `grep -n "data-sole-provider" apps/web/src/lib/features/report/breakdown/breakdown-row.svelte` → 1 hit, and it is on a `<span>`
- [ ] `grep -rn "data-advanced-summary" apps/web/src` → no matches
- [ ] `grep -n "harnessMarkFillFor" packages/design-system/src/svelte.ts apps/web/src/lib/features/report/overview/session-shape.svelte` → ≥ 2 hits
- [ ] `grep -n "fill: 'accent'" apps/web/src/lib/features/report/overview/session-shape.svelte` → no matches
- [ ] `grep -n "2xl" packages/design-system/src/components/overview.ts` → 1 hit in `twoColumns`; `grep -n "lg: 'repeat(2" packages/design-system/src/components/overview.ts` → no matches
- [ ] `grep -n "alignContent: 'start'" apps/web/src/lib/features/report/overview/executive-overview.svelte` → 1 hit (inside `metric`)
- [ ] `grep -n "labelledYear" packages/report-core/src/focused-report-query.ts` → ≥ 2 hits
- [ ] `grep -n "data-record-count" apps/web/src/lib/features/report/overview/records.svelte` → 1 hit
- [ ] `git diff --stat 51815b70..HEAD -- apps/web/src/lib/features/report/overview/punchcard.svelte` → empty; `PUNCHCARD_INTERACTIVE_TARGET_SIZE_PX` still `24`
- [ ] `bun run --cwd packages/design-system build && cd packages/design-system && bun test` exits 0
- [ ] `cd packages/report-core && bun test src/focused-report-query.test.ts` exits 0 with the new case
- [ ] `bun run typecheck`, `bun run lint`, `bun run check` exit 0
- [ ] `bun run --cwd apps/web test` exits 0 (new SSR file + extended cases)
- [ ] `cd apps/web && bun run test:e2e -- e2e/dashboard-presentation.spec.ts e2e/category-visibility.spec.ts e2e/value-presentation.spec.ts e2e/dashboard.spec.ts` exits 0
- [ ] `bun run test:e2e` exits 0 (snapshots regenerated only for the two documented diffs)
- [ ] `git status` shows no modified file outside the in-scope list
- [ ] `plans/README.md` status row for 094 updated

## STOP conditions

Stop and report back (do not improvise) if:

- The drift check shows changes in `harness-provider-model.ts`,
  `executive-overview.svelte` or `records.svelte` that conflict with the
  excerpts (plans 088/093/098 may have landed): re-anchor if the change is
  elsewhere in the file, stop if the quoted lines themselves moved semantics.
- `soleProviderMirroringHarness` returns `null` for a harness you can see has
  one provider with identical figures in the real app (the harness and
  harness-provider aggregations have diverged — that is plan 088's bug; report
  the two `AnalyticsGroup` objects, do not widen the tolerance).
- Panda refuses `'2xl'` as a breakpoint key or the generated class does not
  apply at 1536 px (check `packages/design-system/panda.config.ts` still uses
  `@pandacss/preset-panda`); do not hand-write a media query.
- The punchcard e2e at 1920 reports hidden hours even though the row is
  asymmetric (would mean the Punchcard panel's max-content width is larger than
  658 + 36 — inspect which child widened it; do not shrink the grid).
- The Session shape fixture flag changes any assertion in a spec that does not
  set it (the opt-in leaked into the shared rows).
- `visual-regression.spec.ts` diffs anything other than the record-tile grid
  at 390 px or a ≤ 1 px KPI tile shift.
- `check-design-export-consumers` reports a new unconsumed export you did not
  add (someone else's change landed in the same lint run).

## Maintenance notes

- The sole-provider fold is a presentation rule in
  `harness-provider-model.ts`; if a harness ever gains a second provider pair
  (or its pair diverges), the expander returns without code changes. Reviewers
  should scrutinise the `MIRRORED_FIGURES` set: it intentionally excludes
  percentages (`cacheHitPct`, `costPercent`) that are derived from the same
  inputs.
- `harnessMarkFillFor` is the SVG twin of `harnessFillFor`; when a harness
  family is added to `harness-badge.svelte`, add it to both tone maps in
  `harness-fill.ts` in the same change.
- `twoColumns` assumes "flexible panel first, natural-width panel second". If
  a third Advanced analysis panel ever appears, revisit the template rather
  than appending a column.
- Rhythm width (the remaining U38 sub-point): the grid is data-bounded
  (weeks × 15 px, capped at 730 days ≈ 1 560 px) and its cells are pinned. If
  the blank right margin at ≥ 1536 px is judged worth fixing, the compliant
  levers are section layout (Rhythm sharing a `2xl` row with Token anatomy) or
  a container-query-driven placement of the readout/legend beside the grid —
  both are maintainer layout decisions outside this plan.
- The `FOCUSED_REPORT_E2E_SESSION_SHAPE_KEY` flag is the first browser scenario
  with both Advanced analysis panels; reuse it for any future Session shape
  presentation test instead of adding rows to the shared fixture.
- Deferred: making the Session shape legend filter the scatter (it stays a
  key), and an exact provider filter for folded pairs (the harness filter
  yields the identical row set; the text search still matches provider names).
