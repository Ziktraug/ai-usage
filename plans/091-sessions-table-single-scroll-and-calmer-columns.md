# Plan 091: Sessions Table — One Scroll Container and Calmer Columns

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` (plan 086 adds the 087–098 rows).
>
> **Drift check (run first)**:
> `git diff --stat 51815b70..HEAD -- apps/web/src/session-row-window.ts apps/web/src/session-row-window.test.ts apps/web/src/lib/features/sessions/table/ apps/web/src/lib/foundation/presentation/format.ts apps/web/src/lib/foundation/presentation/format.test.ts apps/web/src/dashboard-model.ts packages/report-core/src/session-query.ts packages/report-core/src/session-query.test.ts apps/web/e2e/session-viewport-geometry.spec.ts apps/web/e2e/origin-campaign.spec.ts apps/web/e2e/session-scroll.scale.ts packages/design-system/src/components/table.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition. Plan 088 (`session-drawer.svelte`,
> `records.svelte`) and plan 098 are expected to run on the same program branch;
> they do not touch the files above, but re-run the drift check after any merge.

## Status

- **Priority**: P1
- **Effort**: M (U11 is S–M on its own; U12, U13, U14, U36 are S each and share the same three table files, which is why they travel together)
- **Risk**: MED (U11 changes how the Sessions surface is sized; the ADR 0004 window model and the 5,000-session proof must keep passing unchanged)
- **Depends on**: none (plan 076's display-only title inheritance is already in the tree at `51815b70` — see Scope)
- **Category**: direction
- **Planned at**: commit `51815b70`, 2026-08-23
- **Audit findings**: U11, U12, U13, U14, U36

## Why this matters

The Sessions tab is the investigation surface, and on 2026-08-23 it read as
noisier than the data behind it:

- **U11** — two scroll containers side by side. At 1920×1080 the page scrolls
  372 px and then the table scrolls inside a surface that is itself
  1,056 px tall. Measured on the running app: the document is 1,452 px tall
  for a 1,080 px viewport; the surface starts 364 px down the document
  (32 px page padding + 101 px header + 115 px filter toolbar + 36 px active
  filters + 44 px export row and gap + 36 px table controls) and ends 32 px
  before the document bottom. The surface's inline height is exactly
  `innerHeight − 24`, so the page always has `chrome + 8 px` of scroll range
  left over. On a 390 px phone the same model puts the whole list below a
  ~500 px chrome when the tab is entered through the bottom navigation
  (which preserves page scroll), leaving a ~130 px peephole above the fixed
  bottom bar.
- **U12** — every top-level row is a campaign display row
  (`campaignTotalCount !== undefined`), so every Time cell reads
  `"2.3h root-session time"` and wraps to two lines in a 96 px column. The
  qualifier belongs to the column, not to each value.
- **U13** — ~80 % of rows are one-session campaigns, and each one carries a
  `Campaign · 1 session` annotation plus an expand chevron that loads nothing.
  The campaign qualifier should appear only when there is something to
  qualify (members > 1).
- **U14** — in the Tokens preset, a Claude Code row whose session is
  `partial` shows the same `!` marker on Input, Output, Cache and Fresh. Four
  identical buttons per row say less than one. Provenance stays per metric
  (settled); identical markers collapse into one per row whose tooltip names
  the cells.
- **U36** — `fmtCompact` prints `36,971`, `188k` and `10.9M` in the same token
  column. One column, one notation.

## Current state

### U11 — how the surface is sized today

- `packages/design-system/src/components/table.ts:75-101`:
  ```ts
  export const tableWrap = css({
    overflow: 'auto',
    maxH: 'var(--ai-usage-table-max-height, calc(100dvh - 240px))',
    minH: 'var(--ai-usage-table-min-height, 320px)',
    ...
  export const sessionViewportSurface = css({
    '--ai-usage-table-max-height': 'none',
    '--ai-usage-table-min-height': '0px',
    h: 'var(--session-surface-height, 100dvh)',
    minH: 0,
    overflowAnchor: 'none',
    _print: { h: 'auto' },
  });
  ```
  The `calc(100dvh - 240px)` the audit saw in DevTools is `tableWrap`'s
  fallback; `sessionViewportSurface` overrides the variable to `none`, so the
  real height is the inline `--session-surface-height` set by the component
  (fallback `100dvh` before hydration). No change is needed in this file.
- `apps/web/src/session-row-window.ts:17-48` — the pure sizing function:
  ```ts
  export interface SessionViewportHeightInput {
    bottomInset: number;
    minimumHeight: number;
    viewportHeight: number;
  }
  ...
  export const calculateSessionViewportHeight = (input: SessionViewportHeightInput): number => {
    const viewportHeight = Math.max(1, nonNegativeInteger(input.viewportHeight));
    const bottomInset = Math.min(viewportHeight - 1, nonNegativeInteger(input.bottomInset));
    const usableHeight = viewportHeight - bottomInset;
    return Math.max(Math.max(1, nonNegativeInteger(input.minimumHeight)), usableHeight);
  };
  ```
  Its doc comment (lines 25–40) explains the 2026-08-05 decision: sizing
  from the surface's own `getBoundingClientRect().top` was circular because
  the top was re-read on every scroll. The fix below uses the surface's
  *document* offset (`rect.top + window.scrollY`), which does not move when
  the page scrolls, so it is not circular.
- `apps/web/src/lib/features/sessions/table/session-table.svelte`:
  - lines 84–88: `SESSION_VIEWPORT_BOTTOM_INSET = 24`,
    `SESSION_VIEWPORT_FALLBACK_HEIGHT = 520`,
    `DESKTOP_MINIMUM_VIEWPORT_HEIGHT = sessionVirtualBudgets.desktop.rowHeight * 3` (129),
    `MOBILE_MINIMUM_VIEWPORT_HEIGHT = sessionVirtualBudgets.mobile.rowHeight` (188).
  - lines 196–212 `updateViewportFor(element, surfaceMode)`: computes
    `calculateSessionViewportHeight({ bottomInset: SESSION_VIEWPORT_BOTTOM_INSET, minimumHeight, viewportHeight: window.innerHeight })`,
    writes `--session-surface-height` inline only when it changed, then reads
    `scrollTop = element.scrollTop; viewportHeight = element.clientHeight || SESSION_VIEWPORT_FALLBACK_HEIGHT;`
    — those two reads are what the ADR 0004 window model consumes
    (`projectSessionVirtualRows`, line 170–172). They stay.
  - lines 235–253: `$effect` with a `ResizeObserver` on the surface plus a
    `window` `resize` listener; the comment says there is deliberately no
    window `scroll` listener.
  - lines 255–273: the one-shot window anchor effect:
    `regionStart?.scrollIntoView({ block: 'start' }); onInitialWindowAnchor();`
    inside `requestAnimationFrame`, gated by `initialWindowAnchor && !windowAnchorConsumed`.
  - lines 275–283: the `queryResetKey` effect resets `scrollTop` and scrolls
    the surface to 0.
  - line 355: keyboard navigation scrolls the surface to `targetIndex * (43 | 188)`.
  - lines 390–391: `<section aria-label="Sessions" data-session-mode={activeMode} data-session-table-owner>` and
    `<div class={tableControls} data-session-region-start bind:this={sessionRegionStartElement}>`.
  - lines 461–467 desktop surface `data-session-surface="desktop"` with `onscroll={updateViewport}`;
    lines 547–556 mobile `<ul data-session-surface="mobile" ...>`.
  - lines 678–695: the campaign "Load more sessions in …" buttons and the
    `Loading more sessions…` live region render **after** the surface, inside
    the owner section (they transiently extend the document by ≤ 48 px).
- Chrome around the surface (measured 2026-08-23 on the running app at
  1920×1080, document coordinates): page padding 32 (`shell` in
  `packages/design-system/src/components/layout.ts:21-26`, `py: { base: '24px', md: '32px' }`),
  header 101, `[data-report-toolbar]` 115, `[data-active-filters]` 36,
  `[data-sessions-export]` 30 + 14 gap, `[data-session-region-start]` 36 →
  surface top at 364; surface 1056; trailing page padding 32 → document 1452.
  The two `position: sticky; top: 0` toolbar children
  (`layout.ts:119-130`, `lib/features/report/breakdown/styles.ts:73`) sit in
  a 115 px grid wrapper, so they stick only within that wrapper and scroll
  away with it — in practice the toolbar is in-flow. `scrollPaddingTop`
  (`packages/design-system/src/preset.ts:25`, `{ base: '72px', md: '180px', lg: '132px' }`)
  is why the current `scrollIntoView` anchor lands the region start at
  y = 132 on desktop rather than 0.
- Mobile chrome: `apps/web/src/lib/features/shell/app-shell.svelte:35-40`
  reserves `pb: { base: '72px', md: 0 }` under `main` for the fixed bottom
  navigation (`app-navigation.svelte:130-143`: `position: fixed; bottom: 0; minH: 64px`).
  So the static space below the Sessions owner section is 32 px on desktop
  (`md+`) and 24 + 72 = 96 px on mobile. The mobile list also declares
  `overscrollBehavior: 'contain'` (`table.ts:271`), so swipes on the list never
  chain to the page.
- `apps/web/src/lib/features/shell/session-window-anchor-context.ts:19-46` —
  `available()` is false after a navigation that preserved report scroll
  (the report-tab links in `app-navigation.svelte:430, 466` pass
  `preserveScroll`; `beforeNavigate` at line 220–221 forwards
  `shouldPreserveReportScroll(...)` to `beginNavigation`). That is the 390 px
  case the audit saw: entering Sessions from the bottom bar keeps
  `scrollY = 0`, so the chrome fills the screen and the list peeks out below.
- Tests pinning the current sizing:
  - `apps/web/src/session-row-window.test.ts:16-35` — three cases asserting
    `876` for `{ bottomInset: 24, minimumHeight: 129, viewportHeight: 900 }`,
    `820` for mobile, and the minimum valve.
  - `apps/web/e2e/session-viewport-geometry.spec.ts:88-155` — asserts
    `fillsViewportHeight: Math.abs(clientHeight − (innerHeight − 24)) <= 2`,
    `surfaceStartsInViewport: rect.top < innerHeight * 0.25`,
    `windowScrolledPastChrome: window.scrollY > 0`, then at a 220/300 px
    viewport asserts `window.scrollY > 0` and that scrolling the surface does
    not move the window. Lines 157–191 assert the document height is
    unchanged while the window is scrolled to 120/320/560/800 at 1440×900.
  - `apps/web/e2e/session-scroll.scale.ts:79-82, 264-275` — the 5,000-session
    proof (1024×900 desktop, 390×844 mobile) requires the surface to be an
    `overflowY: auto|scroll` element with `scrollHeight > clientHeight`, drives
    `element.scrollTop` through `moveSessionSurface` in
    `e2e/session-scroll-driver.ts:16-45`, and caps DOM rows at 300/600. It
    does not depend on the surface height. **It must pass unchanged.**
  - `apps/web/src/lib/features/sessions/table/session-virtualization.ts` —
    budgets `desktop rowHeight 43 / maxRows 300`, `mobile rowHeight 188 / maxRows 600`;
    untouched.

### U12 — "root-session time" on every row

- `apps/web/src/lib/features/sessions/table/session-cell-projection.ts:189-198`:
  ```ts
  if (id === 'duration') {
    const rootSessionOnly = row.campaignTotalCount !== undefined;
    const semantics = sessionDurationSemantics(row.source?.harnessKey, rootSessionOnly);
    return {
      kind: 'value',
      label: `${sessionColumnById(id).meta.format(row)}${rootSessionOnly ? ' root-session time' : ''}`,
      provenanceFacts: provenanceFacts(row, 'duration'),
      title: semantics.metricHint,
    };
  }
  ```
  `sessionDurationSemantics(…, true)` (`apps/web/src/session-analysis-model.ts:124-137`)
  already prefixes the hint with `Campaign time uses the root session only.`
  — the tooltip carries the qualifier; the visible suffix is redundant.
- `apps/web/src/lib/features/sessions/table/session-columns.ts:140-146` — the
  column: `column('duration', 'Time', { align: 'right', format: (row) => fmtDuration(row.durationMs), label: 'Recorded time', title: 'Harness-specific recorded or derived time; this is not model runtime', widthPx: 96 })`.
  The `title` is rendered on the `<th>` (`session-table.svelte:480`).
- Mobile card footer (`session-table.svelte:660-666`) prints
  `<span title={mobileDuration.title}>{mobileDuration.label}</span>`, so the
  suffix also appears on every card.
- Pinned: `session-table-components.test.ts:99` `expect(body).toContain('root-session time');`
  and lines 100–102 assert the `Campaign time uses the root session only. Sum of recorded Codex task-open spans…` title — keep that one.

### U13 — "Campaign · 1 session" and the dead-end chevron

- `packages/report-core/src/session-query.ts:1391-1396`:
  ```ts
  export const campaignBadgeLabelForSessionRow = (row: SessionPresentationRow): string | null => {
    if (!row.campaignKey || row.campaignTotalCount == null || row.campaignVisibleCount == null) {
      return null;
    }
    return `Campaign · ${row.campaignVisibleCount} ${row.campaignVisibleCount === 1 ? 'session' : 'sessions'}`;
  };
  ```
  `totalCount = rows.length` (all members, root included, `session-query.ts:1198`),
  `visibleCount = matchedRows.length` (members matching the filter, line 1200).
  Its only production consumer is `session-cell-projection.ts:248`
  (`campaignLabel: campaignBadgeLabelForSessionRow(row)`), rendered by
  `session-cell.svelte:78-82` as `<span class={muted} data-session-campaign-annotation …>`.
  Pinned by `packages/report-core/src/session-query.test.ts:619, 658, 678`
  (`'Campaign · 2 sessions'`, twice `'Campaign · 1 session'`).
- `apps/web/src/dashboard-model.ts:371-376` — `campaignBadgeLabelForRow`, a
  byte-identical duplicate with **zero callers and zero tests**
  (`grep -rn campaignBadgeLabelForRow apps packages` → the definition only).
- `apps/web/src/lib/features/sessions/table/session-table-model.ts:32-33`:
  `getRowCanExpand: (row) => Boolean(row.original.children?.length || (row.original.campaignKey && input.canLoadCampaignChildren))`
  — every campaign row is expandable when the table can load children, so a
  singleton gets a `▸` that triggers `onLoadCampaignChildren` for nothing
  (`session-table.svelte:329-335`); on mobile it is the `Show children` button
  (`session-table.svelte:649-658`).
- Fixture: `session-table.fixtures.ts:48-57` `syntheticCampaignRow(index, children)`
  sets `campaignTotalCount: Math.max(1, children.length)` — the root is not
  counted, so the SSR fixture campaign (root + one child,
  `session-table.fixture.svelte:22-31`) reports 1/1 and the SSR test pins
  `CAMPAIGN_ANNOTATION_PATTERN = /data-session-campaign-annotation[^>]*>\s*Campaign · 1 session<\/span>/`
  (`session-table-components.test.ts:7, 67`).
- E2e: `apps/web/e2e/origin-campaign.spec.ts:17-18, 33-34`
  `await expect(page.getByText('Campaign · 3 sessions', { exact: true })).toBeVisible();`
  `await expect(page.getByText('Campaign · 1 session', { exact: true })).toHaveCount(2);`
  — the synthetic fixture (`apps/web/src/report-data.ts`) has one 3-session
  campaign (`Build report UI` + subagent + classifier) and singletons.
- `session-table-model.test.ts:120` pins `campaignLabel: 'Campaign · 3 sessions'`
  for a row with `campaignTotalCount: 4, campaignVisibleCount: 3`.
- Plan 076 (README row still says TODO) is **delivered in the tree** at
  `51815b70` (commit `c3de318a`, PR #32): `inheritedTitle`,
  `sessionTitleIsGeneric` (`session-cell-projection.ts:120-134`) and the
  `data-session-inherited-title` span (`session-cell.svelte:60-64`,
  `session-table.svelte:604-611`). This plan does not touch those paths; it
  only changes the `data-session-campaign-annotation` span and the expander.
- `apps/web/src/session-list-label.ts` (named in the audit anchors) only
  bounds/highlights labels; it is not involved.

### U14 — four identical markers per Tokens row

- `packages/report-core/src/provenance.ts:145-163, 225-237` — `partial-session`
  applies to `COUNTERS_AND_AGGREGATES = ['tokens','api-value','actual-cost','subscription-value','calls','turns','tools','lines']`
  (OpenCode: `['duration']`); `usage-unavailable` to
  `['tokens','api-value','actual-cost','subscription-value','calls','tools']`;
  `reconciliation-ambiguous` to the counters. One `tokens` fact therefore
  reaches every token column.
- `session-cell-projection.ts:136-140` `provenanceFacts(row, metric, excludeKinds)`;
  `142-168` `metricForColumn(id)` maps `tokIn/tokOut/cache/tokCw/fresh/total → 'tokens'`,
  `actual → 'actual-cost'`, `quota → 'subscription-value'`, `duration`, `calls`, `turns`, `tools`, `lines`;
  `177-206` `valueProjection` attaches `provenanceFacts` per cell (cost excludes
  `API_PRICE_PROVENANCE_KINDS` because the `≥` prefix already says it, line 71/185).
- `session-cell.svelte:101-105` renders every value cell as
  `<CellWithProvenance facts={projection.provenanceFacts}><span title={projection.title}>{projection.label}</span></CellWithProvenance>`;
  lines 72–74 render the Session cell's own marker
  `{#if projection.provenanceFacts.length > 0}{' '}<ProvenanceMarker facts={projection.provenanceFacts} />{/if}`.
- `packages/design-system/src/svelte/overlays/provenance.ts:37-41`:
  `provenanceTitle(facts) = facts.map(f => `${f.label}: ${f.description}`).join('\n')`,
  `provenanceMarkerGlyph(facts) = any warning ? '!' : 'i'`; the marker is a
  14 px bordered `<button aria-label={title}>` inside a `Tooltip`
  (`provenance-marker.svelte:15-30`, `styles.ts:145-168`). Exported from
  `@ai-usage/design-system/svelte` (`svelte.ts:127-135`). `apps/web/src/provenance-marker.test.ts`
  covers the glyph rule only.
- `session-table.svelte:515-529` renders `SessionCell` per visible column with
  no row-level context beyond `campaignRootLabel`; `visibleColumns` (line 168)
  is the ordered visible column list. The Tokens preset is
  `date, session, tokIn, tokOut, cache, fresh, rtkSaved`
  (`session-table-model.test.ts:42-50`).
- No e2e spec counts provenance markers (`grep -rn -i provenance apps/web/e2e` → nothing);
  `session-table-components.test.ts:72` pins `aria-label="Derived title:` on
  the Session cell marker — that prefix must survive.

### U36 — mixed compact notation

- `apps/web/src/lib/foundation/presentation/format.ts:25-36`:
  ```ts
  export const fmtCompact = (value: number): string => {
    if (Math.abs(value) >= 1e9) { return `${(value / 1e9).toFixed(2)}B`; }
    if (Math.abs(value) >= 1e6) { return `${(value / 1e6).toFixed(1)}M`; }
    if (Math.abs(value) >= 1e5) { return `${Math.round(value / 1e3)}k`; }
    return fmtNum(value);
  };
  ```
  Below 100,000 it falls back to `36,971`; above it switches to `188k`; so
  one token column mixes separators and suffixes. `fmtCompact` has 14
  consumer files (overview KPI tiles, drawer, analysis tables, prose) and
  pinned strings (`format.test.ts:12-13` `'1000k'`, `'1.0M'`;
  `e2e/drawer-value-presentation.spec.ts:12` `'204k'`), so this plan does not
  change it globally.
- `session-columns.ts:27-30` `token = (row, value) => unavailable(row, fmtCompact(value))`
  formats `tokIn`, `tokOut`, `cache`, `tokCw`, `fresh`, `total` (lines 72–110);
  `session-cell-projection.ts:252` formats the classifier rollup
  `… · ${fmtCompact(row.campaignClassifierFreshTokens ?? 0)} fresh` in the
  same table. The mobile card (`session-table.svelte:661-664`) reuses the
  `fresh`/`cache` projections, so it inherits whatever the column does.
- Precedent for compact label + exact tooltip:
  `lib/features/report/breakdown/project-summary.svelte:115-116`
  `<td class={numCell} title={fmtNum(project.fresh)}>{fmtCompact(project.fresh)}</td>`.
- Pinned: `session-table-components.test.ts:69` `'+ 1 automated review · 1,200 fresh'`;
  `session-table-model.test.ts:121` `'+ 2 automated reviews · 4,321 fresh'`.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Prepare SvelteKit/Panda output (needed by the SSR tests) | `bun run --cwd apps/web dev:prepare` | exit 0 |
| Typecheck | `bun run typecheck` | exit 0 |
| Format/lint | `bun x ultracite fix` then `bun run check` and `bun run lint` | exit 0 |
| Window model unit test | `cd apps/web && bun test src/session-row-window.test.ts` | all pass |
| Table unit tests | `cd apps/web && bun test src/lib/features/sessions/table/session-table-model.test.ts` | all pass |
| Table SSR tests | `cd apps/web && bun test src/lib/features/sessions/table/session-table-components.test.ts` | all pass |
| Format unit tests | `cd apps/web && bun test src/lib/foundation/presentation/format.test.ts` | all pass |
| Report-core tests | `cd packages/report-core && bun test src/session-query.test.ts` | all pass |
| Geometry e2e | `cd apps/web && bun run test:e2e -- e2e/session-viewport-geometry.spec.ts` | all pass |
| Campaign e2e | `cd apps/web && bun run test:e2e -- e2e/origin-campaign.spec.ts e2e/dashboard.spec.ts` | all pass |
| 5,000-session proof (unchanged file, must still pass) | `cd apps/web && bun --bun playwright test --config playwright.session-scroll.config.ts e2e/session-scroll.scale.ts` | 2 passed |
| Full e2e | `bun run test:e2e` | all pass |

On NixOS, if Playwright's downloaded chromium fails to launch, set
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to the system Chrome binary
(`--channel chrome` does not work here). If a Vite SSR test fails with a
bogus `node:module` resolve error, run `dev:prepare` first.

## Scope

**In scope** (the only files you should modify):
- `apps/web/src/session-row-window.ts`, `apps/web/src/session-row-window.test.ts`
- `apps/web/src/lib/features/sessions/table/session-table.svelte`
- `apps/web/src/lib/features/sessions/table/session-cell.svelte`
- `apps/web/src/lib/features/sessions/table/session-cell-projection.ts`
- `apps/web/src/lib/features/sessions/table/session-columns.ts`
- `apps/web/src/lib/features/sessions/table/session-table-model.ts`
- `apps/web/src/lib/features/sessions/table/session-table.fixtures.ts`
- `apps/web/src/lib/features/sessions/table/session-table.fixture.svelte`
- `apps/web/src/lib/features/sessions/table/session-table-components.test.ts`
- `apps/web/src/lib/features/sessions/table/session-table-model.test.ts`
- `apps/web/src/lib/foundation/presentation/format.ts`, `format.test.ts`
- `apps/web/src/dashboard-model.ts` (delete the dead duplicate only)
- `packages/report-core/src/session-query.ts` (`campaignBadgeLabelForSessionRow` only), `packages/report-core/src/session-query.test.ts`
- `apps/web/e2e/session-viewport-geometry.spec.ts`
- `apps/web/e2e/origin-campaign.spec.ts`
- `apps/web/src/lib/features/sessions/table/INTEGRATION.md` (one paragraph on the sizing contract)

**Out of scope** (do NOT touch):
- `apps/web/src/lib/features/sessions/table/session-virtualization.ts` and
  `calculateSessionRowWindow` in `session-row-window.ts` — the ADR 0004 window
  model. Only `calculateSessionViewportHeight` changes.
- `apps/web/e2e/session-scroll.scale.ts`, `session-scroll-driver.ts`,
  `session-scroll-fixture.ts` — the 5,000-session proof must pass as-is.
- `packages/design-system/src/components/table.ts` — `sessionViewportSurface`
  already reads `--session-surface-height`; nothing to change. Do not flip
  `overscrollBehavior` on the mobile list (see Maintenance notes).
- `app-shell.svelte` / `app-navigation.svelte` / `session-window-anchor-context.ts`
  — the preserve-scroll policy stays; the table measures its surroundings
  instead of importing shell constants.
- Global `fmtCompact` and its 14 consumers (overview tiles, drawer, analysis
  tables) — U36 is fixed inside the Sessions table; see Maintenance notes.
- `session-drawer.svelte`, `records.svelte`, campaign-vs-root naming in the
  drawer header — plan 088 (U06, U42). Filter bar / toolbar — plan 092.
  Generated-at and scrollbar gutter — plan 098 (U31, U33).
- Plan 076 paths (`inheritedTitle`, `data-session-inherited-title`) — already
  delivered; do not re-plan or rewrite.

## Git workflow

- Work on the program branch `plan/086-ui-ux-audit-remediation` in this
  worktree. One commit for this plan; stage by explicit path (other sessions
  may write to the repo); never `git add -A`.
- Commit style (from `git log`): `fix(web): …` — suggested
  `fix(web): size the Sessions surface to one scroll container and calm its columns`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Make the surface height a function of its document position (U11, pure model)

In `apps/web/src/session-row-window.ts` replace `SessionViewportHeightInput`
and `calculateSessionViewportHeight` (lines 17–48) with:

```ts
export interface SessionViewportHeightInput {
  /** Document-relative top of the element the page is anchored to: 0 when the page must not scroll (desktop), the session region start on mobile. */
  anchorTop: number;
  /** Static document space below the session table owner (page padding, mobile navigation reserve). */
  bottomInset: number;
  minimumHeight: number;
  /** Document-relative top of the scroll surface (`rect.top + window.scrollY`) — scroll-invariant, so not circular. */
  surfaceTop: number;
  viewportHeight: number;
}

export const calculateSessionViewportHeight = (input: SessionViewportHeightInput): number => {
  const viewportHeight = Math.max(1, nonNegativeInteger(input.viewportHeight));
  const chromeAboveSurface = Math.max(0, nonNegativeInteger(input.surfaceTop) - nonNegativeInteger(input.anchorTop));
  const bottomInset = nonNegativeInteger(input.bottomInset);
  const usableHeight = viewportHeight - chromeAboveSurface - bottomInset;
  // A viewport too short for the chrome plus the minimum keeps a usable surface
  // and lets the page scroll to it, rather than collapsing the table.
  return Math.max(Math.max(1, nonNegativeInteger(input.minimumHeight)), usableHeight);
};
```

Rewrite the doc comment (lines 25–40): keep the circularity warning, add
that `surfaceTop` is a document offset (does not change while scrolling) and
that with `anchorTop = 0` the document height equals the viewport height, so
the page has no scroll range and the surface is the only scroll container.

In `apps/web/src/session-row-window.test.ts` replace the three
`calculateSessionViewportHeight` cases (lines 16–35) with:

- desktop, no page scroll: `{ anchorTop: 0, bottomInset: 32, minimumHeight: 129, surfaceTop: 364, viewportHeight: 1080 }` → `684`;
- mobile, anchored at the region start: `{ anchorTop: 304, bottomInset: 96, minimumHeight: 188, surfaceTop: 364, viewportHeight: 844 }` → `688`;
- scroll invariance: the same input with `surfaceTop` and `anchorTop` both
  shifted by +500 yields the same height (document offsets do not depend on
  `scrollY`);
- minimum valve: `{ anchorTop: 0, bottomInset: 32, minimumHeight: 129, surfaceTop: 364, viewportHeight: 220 }` → `129`;
  `{ …, minimumHeight: 188, surfaceTop: 700, viewportHeight: 300 }` → `188`;
- garbage in: `NaN`/negative `surfaceTop`, `anchorTop > surfaceTop` → treated as 0 chrome.

**Verify**: `cd apps/web && bun test src/session-row-window.test.ts` → all pass; `bun run typecheck` fails only in `session-table.svelte` (the caller, fixed in Step 2).

### Step 2: Measure the surroundings and reflow when they change (U11, component)

In `apps/web/src/lib/features/sessions/table/session-table.svelte`:

1. Delete `SESSION_VIEWPORT_BOTTOM_INSET` (line 84). Add a helper near the
   other constants:
   ```ts
   const documentTop = (element: Element): number => element.getBoundingClientRect().top + window.scrollY;
   const documentBottom = (element: Element): number => element.getBoundingClientRect().bottom + window.scrollY;
   ```
2. Rewrite `updateViewportFor` (lines 196–212) so the height comes from the
   measured geometry:
   ```ts
   const owner = element.closest('[data-session-table-owner]');
   const regionStart = sessionRegionStartElement;
   const bottomInset = owner ? Math.max(0, Math.round(documentBottom(document.body) - documentBottom(owner))) : 0;
   const nextHeight = calculateSessionViewportHeight({
     anchorTop: surfaceMode === 'mobile' && regionStart ? documentTop(regionStart) : 0,
     bottomInset,
     minimumHeight,
     surfaceTop: documentTop(element),
     viewportHeight: window.innerHeight,
   });
   ```
   Keep the rest of the function byte-identical (`--session-surface-height`
   write-if-changed, `scrollTop`/`viewportHeight` reads). `document.body`'s
   bottom is the content bottom (the fixed mobile navigation is outside the
   flow; the shell's `pb: 72px` is inside it) — this is what makes the
   desktop document exactly one viewport tall and keeps the mobile surface
   above the bottom bar without importing shell constants. (Known
   interaction: `e2e/svelte-shell.spec.ts` forces `document.body.style.minHeight = '4000px'`
   in two scroll-restoration tests; there the measured inset is huge and the
   surface falls back to its minimum height — those tests only assert
   `window.scrollY`, so they keep passing.)
3. Extend the observer effect (lines 235–253): keep the surface
   `ResizeObserver` and the `window` `resize` listener; add a second
   `ResizeObserver` on `document.body` whose callback **does not write
   synchronously** — it schedules `synchronize` in `requestAnimationFrame`
   (cancel any pending frame first, cancel on cleanup). Comment why: a body
   observer that resizes the surface inside its own callback changes the
   body again at a shallower depth and Chrome reports
   `ResizeObserver loop completed with undelivered notifications` (a console
   error the audit counts); deferring the write one frame converges in two
   frames and keeps the console clean. This is what reflows the surface when
   the chrome above it changes height (active-filter row appearing,
   filter chips wrapping, provider pill text changing).
4. Anchor with `window.scrollTo` instead of `scrollIntoView` (lines 264–269),
   because `scrollPaddingTop` (132/180/72 px) would otherwise leave a gap
   above the region start and push the mobile surface under the bottom bar:
   ```ts
   activeSurface.style.removeProperty('--session-surface-height');
   // Size first, anchor second: with the document already one viewport tall the
   // desktop scroll is a no-op; document offsets make the order irrelevant on mobile.
   updateViewportFor(activeSurface, activeMode);
   const anchorTop = regionStart ? documentTop(regionStart) : 0;
   const mobileListBelowFold =
     activeMode === 'mobile' && regionStart !== undefined && regionStart.getBoundingClientRect().top > window.innerHeight * 0.5;
   if (shouldAnchorWindow || mobileListBelowFold) {
     window.scrollTo({ top: anchorTop });
   }
   if (shouldAnchorWindow) {
     windowAnchorConsumed = true;
     onInitialWindowAnchor();
   }
   ```
   (`regionStart` is the existing `sessionRegionStartElement`; keep the
   `--session-surface-height` variable name — `session-viewport-geometry.spec.ts:166`
   finds the surface by it.)
   `mobileListBelowFold` is the 390 px fix: when the Sessions tab is entered
   through the bottom bar (preserved page scroll) and the list would start in
   the lower half of the screen, the list is anchored anyway; it does not
   consume the history-entry anchor (so a remount re-anchors) and it never
   runs on desktop. On desktop the document is one viewport tall, so
   `scrollTo` is a no-op except in the minimum-height valve.
5. In the `queryResetKey` effect (lines 275–283) call `updateViewport()` inside
   a `requestAnimationFrame` after the reset (the active-filters row may have
   appeared or vanished with the query; the body observer also catches it,
   this just removes a one-frame delay).
6. Leave lines 678–695 (campaign load-more and `Loading more sessions…`) where
   they are; the document may grow by ≤ 48 px while a page loads and shrink
   back — measured at rest it is one viewport.

**Verify**: `bun run typecheck` → exit 0; `cd apps/web && bun test src/lib/features/sessions/table/` → all pass (SSR output is unchanged: the inline variable is only written in the browser).

### Step 3: Rewrite the geometry e2e contract (U11, presentation gate)

In `apps/web/e2e/session-viewport-geometry.spec.ts`:

- Test 1 (`anchors the virtual Session viewport inside the screen on desktop and mobile`, lines 88–155):
  drop the `SESSION_VIEWPORT_BOTTOM_INSET = 24` constant (line 5) and
  replace the `.toEqual({ … fillsViewportHeight … windowScrolledPastChrome … })`
  block with per-mode expectations evaluated in one `surface.evaluate`:
  - both modes: `maxHeight === 'none'`, `minHeight === '0px'`, `overflowAnchor === 'none'`,
    `clientHeight >= minimumRowHeight * (mode === 'desktop' ? 3 : 1)`,
    `rect.top >= 0`, `rect.top < innerHeight`, `activeElementInsideRegion === false`,
    `regionRect.top >= -1`;
  - desktop (1024×900): `document.documentElement.scrollHeight <= window.innerHeight + 1`
    (`singleScrollContainer: true`), `window.scrollY === 0`,
    `innerHeight - rect.bottom` between 24 and 48 (the 32 px page padding,
    with rounding slack);
  - mobile (390×844): `window.scrollY > 0`, `Math.abs(regionRect.top) <= 2`
    (anchored at the region start, not at `scroll-padding-top`),
    `rect.bottom <= navRect.top` where `navRect` is
    `document.querySelector('[data-app-navigation="mobile"]').getBoundingClientRect()`
    (the whole surface is above the bottom bar), and
    `Math.abs((document.documentElement.scrollHeight - window.innerHeight) - (regionRect.top + window.scrollY)) <= 2`
    (the page's scroll range ends exactly at the anchor — no overshoot).
- Add a **reflow** assertion on desktop before the short-viewport part:
  insert an 80 px probe `div` before `[data-sessions-export]` via
  `page.evaluate`, then `expect.poll` that `surface.clientHeight` dropped by
  80 ± 2 **and** `document.documentElement.scrollHeight <= innerHeight + 1`
  still holds; remove the probe and poll the height back. This is the
  deterministic assertion for "chrome changed, surface reflowed, page still
  does not scroll". Also assert that neither `page.on('console')` nor
  `page.on('pageerror')` saw a message containing `ResizeObserver loop`
  during the test (collect them like `captureLifecycleWarnings` does for
  `derived_inert`; Chrome reports the loop as a window error and mirrors it
  to the console).
- Short-viewport part (lines 140–153): after `setViewportSize` to 220/300,
  explicitly `await page.evaluate(() => document.querySelector('[data-session-region-start]')?.scrollIntoView({ block: 'start' }))`
  (desktop no longer has a page scroll at 900 px, so the valve must be
  entered deliberately), then keep the existing assertions: surface
  `scrollHeight > clientHeight`, `window.scrollY > 0`, and scrolling the
  surface 40 px leaves `window.scrollY` unchanged.
- Test 2 (`keeps the document height still…`, lines 157–191): keep it, and
  add `expect(initial.documentHeight).toBe(900)` right after `initial` — on
  a 1440×900 desktop the document is one viewport tall, so the loop's
  `Math.min(target, initial.documentHeight - 900)` is 0 for every target.
  Update the comment to say so.
- Tests 3–4 (drawers) need no change.

**Verify**: `cd apps/web && bun run test:e2e -- e2e/session-viewport-geometry.spec.ts` → 4 passed. Then run the unchanged proof: `bun --bun playwright test --config playwright.session-scroll.config.ts e2e/session-scroll.scale.ts` → 2 passed (desktop surface ≈ 488 px, mobile ≈ 688 px; both still `overflowY: auto` with `scrollHeight > clientHeight`).

### Step 4: Move "root-session time" out of the cells (U12)

- `session-cell-projection.ts:194`: `label: sessionColumnById(id).meta.format(row),`
  (drop the suffix; keep `title: semantics.metricHint`, which already starts
  with `Campaign time uses the root session only.` for campaign rows).
- `session-columns.ts:140-146`: change the column `title` to
  `'Recorded time of the root session on campaign rows (children show their own); harness-specific recorded or derived time, not model runtime'`.
  Header text stays `Time`; chooser label stays `Recorded time`.
- `session-table-components.test.ts:99`: replace
  `expect(body).toContain('root-session time');` with
  `expect(body).not.toContain('root-session time');` and keep lines 100–102
  (the hint survives in the `title`). Add to the desktop test:
  `expect(body).toContain('title="Recorded time of the root session on campaign rows')`.
- `session-table-model.test.ts`: add a case — a `syntheticCampaignRow(5)`
  projected with `'duration'` yields `label: '6m'` (60_000 × 6 → `fmtDuration` → `6m`) and a
  `title` starting with `Campaign time uses the root session only.`; a plain
  `syntheticSessionRow(5)` yields the same label and a title that does not
  start with it.

**Verify**: both table test files pass; `grep -rn "root-session time" apps/web/src --include=*.ts --include=*.svelte | grep -v test` → no matches.

### Step 5: Qualify campaigns only when there is more than one member (U13)

1. `packages/report-core/src/session-query.ts:1391-1396`:
   ```ts
   export const campaignBadgeLabelForSessionRow = (row: SessionPresentationRow): string | null => {
     if (!row.campaignKey || row.campaignTotalCount == null || row.campaignVisibleCount == null) {
       return null;
     }
     // A one-session campaign is just a session; the qualifier only earns its
     // place when there are members to qualify. A filtered campaign says how
     // many of its members the current filters show.
     if (row.campaignTotalCount <= 1) {
       return null;
     }
     const count =
       row.campaignVisibleCount < row.campaignTotalCount
         ? `${row.campaignVisibleCount} of ${row.campaignTotalCount}`
         : `${row.campaignVisibleCount}`;
     return `Campaign · ${count} sessions`;
   };
   ```
   (`campaignTotalCount > 1` past the guard, so the noun is always plural.)
   `session-query.test.ts`: line 619's fixture has
   `campaignTotalCount: 3, campaignVisibleCount: 2`, so its expectation
   becomes `'Campaign · 2 of 3 sessions'`; lines 658 and 678
   (`campaignTotalCount: 1`) become `toBeNull()`. Add one case with
   `campaignTotalCount: 3, campaignVisibleCount: 3` → `'Campaign · 3 sessions'`.
2. `apps/web/src/dashboard-model.ts:371-376`: delete `campaignBadgeLabelForRow`
   (dead duplicate carrying the old rule).
3. `session-table-model.ts:32-33`:
   ```ts
   getRowCanExpand: (row) =>
     Boolean(
       row.original.children?.length ||
         (row.original.campaignKey && input.canLoadCampaignChildren && (row.original.campaignTotalCount ?? 0) > 1),
     ),
   ```
   A singleton has no children to load; the `▸` / `Show children` affordance
   disappears from ~80 % of rows.
4. `session-table.fixtures.ts:54-55`: count the root —
   `campaignTotalCount: children.length + 1, campaignVisibleCount: children.length + 1`.
5. `session-table.fixture.svelte`: add a singleton campaign row and a filtered
   campaign row to the fixture so the SSR test can see all three states:
   ```ts
   const singleton = syntheticCampaignRow(3);                     // totalCount 1 → no annotation, no expander
   const filtered = { ...syntheticCampaignRow(4), campaignTotalCount: 3, campaignVisibleCount: 1 }; // members hidden by the filter
   const rows = $derived([campaign, singleton, filtered, ...syntheticSessionRows(4997, 10)]);
   ```
   and pass `onLoadCampaignChildren={noop}` to `SessionTable` so
   `canLoadCampaignChildren` is true and the expander gate is exercised
   (without it every row without loaded children is non-expandable and the
   SSR test cannot see the singleton rule). Keep `totalRows={5000}`; the
   row-id budget assertions `< 40` / `< 24` still hold.
6. `session-table-components.test.ts`: replace `CAMPAIGN_ANNOTATION_PATTERN`
   with `/data-session-campaign-annotation[^>]*>\s*Campaign · 2 sessions<\/span>/`;
   add `FILTERED_CAMPAIGN_ANNOTATION_PATTERN = /data-session-campaign-annotation[^>]*>\s*Campaign · 1 of 3 sessions<\/span>/`;
   in the desktop test assert both match, that
   `body.match(/data-session-campaign-annotation/g)?.length` is exactly 2
   (the singleton has none), that `Expand campaign Synthetic session 1` and
   `Expand campaign Synthetic session 4` (loadable on demand) are present
   while `Expand campaign Synthetic session 3` (singleton) is absent; in the
   mobile test assert `body.match(/title="Expand campaign"/g)?.length` is
   exactly 2 (campaign + filtered; the singleton renders no `Show children`
   button — line 98's `toContain` still holds).
7. `session-table-model.test.ts`: the `campaignTotalCount: 4, campaignVisibleCount: 3`
   row (line 84–96) now projects `campaignLabel: 'Campaign · 3 of 4 sessions'`
   (line 120); add `createSessionTableModel` cases: a singleton campaign row
   with `canLoadCampaignChildren: true` → `rows[0].getCanExpand() === false`;
   the same row with `campaignTotalCount: 2` → `true`.
8. `apps/web/e2e/origin-campaign.spec.ts:17-18, 33-34`: keep
   `'Campaign · 3 sessions'` visible; change both `'Campaign · 1 session'`
   expectations to `toHaveCount(0)`; rename test 1 to
   `'makes the neutral origin default and keeps singleton campaigns unqualified'`;
   add `await expect(page.locator('[data-session-row-id][data-depth="0"]').filter({ hasText: 'Recover Claude history' }).getByRole('button', { name: /Expand campaign/ })).toHaveCount(0);`
   (a singleton row without an expander) and keep the drawer assertion.
   Also assert that the drawer opened from the singleton still works (the
   existing `Subagent: No` check covers `Build report UI`; add one click on
   the singleton row and `await expect(drawer).toBeVisible()`).

**Verify**: `cd packages/report-core && bun test src/session-query.test.ts` → pass; table unit + SSR tests → pass; `cd apps/web && bun run test:e2e -- e2e/origin-campaign.spec.ts e2e/dashboard.spec.ts` → pass (`dashboard.spec.ts:755` clicks the only remaining `Show children` button); `grep -rn "campaignBadgeLabelForRow" apps packages` → no matches.

### Step 6: Collapse identical provenance markers into one per row (U14)

1. `session-cell-projection.ts` — add, next to `valueProjection`:
   ```ts
   export interface SessionRowProvenanceSummary {
     /** Facts that apply to two or more visible metric columns; rendered once on the Session cell. */
     readonly shared: readonly { readonly columns: readonly string[]; readonly fact: UsageRowProvenance }[];
     readonly sharedKinds: ReadonlySet<string>;
   }

   export const summarizeSessionRowProvenance = (
     row: SessionPresentationRow,
     visibleColumnIds: readonly SessionColumnId[],
   ): SessionRowProvenanceSummary
   ```
   Implementation: for each visible column with a metric (reuse
   `metricForColumn`; `cost` → `'api-value'` with `API_PRICE_PROVENANCE_KINDS`
   excluded, exactly as `valueProjection` does), collect its facts; group by
   `fact.kind`; every kind seen on ≥ 2 columns becomes a `shared` entry with
   the column labels in visible order (`sessionColumnById(id).meta.label`,
   e.g. `Input tokens, Output tokens, Cache read, Fresh tokens`). Export a
   helper `sharedProvenanceMarkerFacts(summary)` that returns
   `ProvenanceMarkerFact[]` (the type is exported from
   `@ai-usage/design-system/svelte`, `svelte.ts:130-134`; `UsageRowProvenance`
   is structurally compatible) with
   `description: `${fact.description} Applies to ${columns.join(', ')}.``
   so `provenanceTitle` reads
   `Partial session: This row may be missing part of the session data for counters and aggregate metrics. Applies to Input tokens, Output tokens, Cache read, Fresh tokens.`
2. `session-cell.svelte`: add an optional prop
   `rowProvenance?: SessionRowProvenanceSummary` (default: empty summary).
   - Session branch (lines 72–74): render one `ProvenanceMarker` with
     `[...projection.provenanceFacts, ...sharedProvenanceMarkerFacts(rowProvenance)]`
     when that list is non-empty (the `Derived title:` prefix survives
     because title facts come first; the glyph becomes `!` when a shared fact
     is a warning).
   - Value branch (lines 101–105): `const ownFacts = projection.provenanceFacts.filter((fact) => !rowProvenance.sharedKinds.has(fact.kind))`;
     `const suppressed = projection.provenanceFacts.filter((fact) => rowProvenance.sharedKinds.has(fact.kind))`;
     render `<CellWithProvenance facts={ownFacts}>` and on the inner value
     span set `data-provenance-shared={suppressed.map((f) => f.kind).join(' ')}`
     (only when non-empty) and
     `title={[projection.title, suppressed.length ? provenanceTitle(suppressed) : undefined].filter(Boolean).join('\n')}`.
     Per-metric provenance is still on the cell (native tooltip + attribute);
     only the repeated button is gone.
3. `session-table.svelte:504-531`: compute once per rendered desktop row
   `{@const rowProvenance = summarizeSessionRowProvenance(virtualRow.row.original, visibleColumnIds)}`
   (derive `visibleColumnIds = visibleColumns.map(({ id }) => id)` next to
   `visibleColumns`, line 168) and pass `{rowProvenance}` to every `SessionCell`.
   The mobile card already shows fresh/cache/duration with `title` only; no change.
4. `session-table.fixture.svelte`: add a `preset?: 'work' | 'tokens'` prop and
   pass `columnVisibility={columnVisibilityForSessionPreset(preset)}`
   (import from `session-table-schema`; default `'work'` keeps every
   existing assertion byte-identical).
5. `session-table-components.test.ts` — new test
   `'collapses identical metric provenance into one marker per row in the Tokens preset'`:
   render `{ preset: 'tokens' }`; the fixture campaign row has `partial: true`,
   so assert: `body.match(/aria-label="Derived title:[^"]*Partial session:[^"]*Applies to Input tokens, Output tokens, Cache read, Fresh tokens\./g)?.length` is 1
   (every fixture row carries `Derived title` because `baseRow` declares no
   `titleSource`; only the campaign row is `partial`);
   `body.match(/data-provenance-shared="partial-session"/g)?.length` is 4;
   and the campaign row's markup (slice the body from the `<tr` that
   contains `Expand campaign Synthetic session 1` to its closing `</tr>`)
   contains exactly one `data-part="trigger"` — the Session cell's marker;
   the four token cells render no tooltip trigger. Render `{ preset: 'work' }`
   and assert that row has no `data-provenance-shared` and two
   `data-part="trigger"` (title + cost) — the rule only collapses when
   ≥ 2 visible cells share a fact.
6. `session-table-model.test.ts` — unit cases for `summarizeSessionRowProvenance`:
   a `partial: true` row × Tokens preset ids → one shared entry, kind
   `partial-session`, columns `['Input tokens','Output tokens','Cache read','Fresh tokens']`;
   × Work preset ids → `shared` empty; a `usageUnavailable: true` row × Tokens →
   `usage-unavailable` shared over the four token columns; `title-derived`
   never appears in `shared`.

**Verify**: table SSR + unit tests pass; `cd apps/web && bun test src/provenance-marker.test.ts` still passes (untouched); `bun run test:e2e -- e2e/dashboard.spec.ts` → pass.

### Step 7: One notation per token column (U36)

1. `format.ts`: add below `fmtCompact`:
   ```ts
   const compactColumnFormatter = new Intl.NumberFormat('en', { maximumSignificantDigits: 3, notation: 'compact' });

   /**
    * One notation for values that are compared down a column: up to three
    * significant digits and a k/M/B suffix from 1,000 up (`999`, `1.23k`,
    * `37k`, `188k`, `10.9M`). `fmtCompact` keeps exact separators below
    * 100,000 for prose and single tiles, where nothing is compared.
    */
   export const fmtCompactColumn = (value: number): string => compactColumnFormatter.format(value).replace('K', 'k');
   ```
   `format.test.ts`: add `fmtCompactColumn(999) → '999'`, `1234 → '1.23k'`,
   `36_971 → '37k'`, `188_312 → '188k'`, `999_999 → '1M'`, `10_912_345 → '10.9M'`,
   `2_000 → '2k'`, `0 → '0'`. (ICU output is deterministic across Bun and
   Chrome for `en`; if a case differs, STOP and report the engine output.)
2. `session-columns.ts:29`: `const token = (row, value) => unavailable(row, fmtCompactColumn(value));`
   and export a `TOKEN_COLUMN_VALUE: Partial<Record<SessionColumnId, (row) => number>>`
   for `tokIn → row.tokIn`, `tokOut → row.tokOut`, `cache → row.tokCr`,
   `tokCw → row.tokCw`, `fresh → row.freshTokens`, `total → row.tokenTotal`.
3. `session-cell-projection.ts:170-175` `valueTitle`: when the column is a
   token column and the row is not `usageUnavailable`, return the exact count
   `fmtNum(TOKEN_COLUMN_VALUE[id](row))` (the project-summary precedent:
   compact label, exact tooltip). Line 252: use `fmtCompactColumn` for the
   classifier rollup so the row does not mix notations.
4. Pinned strings: `session-table-components.test.ts:69` → `'+ 1 automated review · 1.2k fresh'`;
   `session-table-model.test.ts:121` → `'+ 2 automated reviews · 4.32k fresh'`.
   Add to `session-table-model.test.ts`: `projectSessionCell({ ...syntheticSessionRow(1), tokIn: 36_971 }, 'tokIn', '')`
   → `{ label: '37k', title: '36,971' }`; with `usageUnavailable: true` →
   `{ label: '—', title: USAGE_UNAVAILABLE_HINT }` (unchanged).

**Verify**: `cd apps/web && bun test src/lib/foundation/presentation/format.test.ts src/lib/features/sessions/table/` → pass; `grep -n "fmtCompact(" apps/web/src/lib/features/sessions/table/*.ts` → no matches (only `fmtCompactColumn`).

### Step 8: Document the sizing contract and run the gates

- `apps/web/src/lib/features/sessions/table/INTEGRATION.md`: add a short
  "Surface sizing" paragraph: the surface is the only scroll container on
  desktop (document = viewport; height = viewport − surface document top −
  static space below the owner); on mobile the page anchors at the region
  start and the surface fills down to the fixed navigation; the minimum
  heights (3 rows / 1 card) are the only case where the page scrolls past
  the surface; `session-row-window.ts` is the pure model and
  `session-viewport-geometry.spec.ts` the contract.
- Run `bun x ultracite fix`, `bun run check`, `bun run lint`, `bun run typecheck`,
  `bun run --cwd apps/web test`, `cd packages/report-core && bun test`,
  then `bun run test:e2e` and the session-scroll proof command.

**Verify**: every command exits 0.

## Test plan

- Unit: `session-row-window.test.ts` (new sizing cases, Step 1);
  `session-table-model.test.ts` (duration label/title, campaign label
  `3 of 4`, singleton expander, provenance summary, token formats);
  `format.test.ts` (`fmtCompactColumn`); `report-core/session-query.test.ts`
  (badge null for singletons, `2 of 3`).
- SSR (presentation gate): `session-table-components.test.ts` — suffix gone,
  header title present, two annotations (`2 sessions`, `1 of 3 sessions`) and
  one expander across campaign/singleton/filtered rows, one collapsed marker
  with four `data-provenance-shared` cells in the Tokens preset, `1.2k fresh`.
- E2e (presentation gate): `session-viewport-geometry.spec.ts` — desktop
  document height ≤ viewport and `scrollY = 0`; reflow on a chrome change; no
  `ResizeObserver loop` console message; mobile anchored at the region start
  with the surface above the bottom bar and no overshoot; 1440×900 document
  height exactly 900. `origin-campaign.spec.ts` — no `Campaign · 1 session`
  text, no expander on a singleton. `dashboard.spec.ts` — unchanged, must pass.
- Unchanged, must pass: `session-scroll.scale.ts` (5,000 sessions, both
  viewports), `production-report.spec.ts` (scrolls the surface to load 205
  rows), `svelte-shell.spec.ts` (scroll restoration with a 4,000 px body).

## Done criteria

- [ ] `grep -n "anchorTop\|surfaceTop" apps/web/src/session-row-window.ts` → both present; `grep -n "SESSION_VIEWPORT_BOTTOM_INSET" apps/web/src/lib/features/sessions/table/session-table.svelte` → no matches
- [ ] `grep -c "ResizeObserver" apps/web/src/lib/features/sessions/table/session-table.svelte` ≥ 2 (surface + body)
- [ ] `grep -rn "root-session time" apps/web/src --include=*.ts --include=*.svelte | grep -v "\.test\."` → no matches
- [ ] `grep -rn "campaignBadgeLabelForRow" apps packages` → no matches
- [ ] `grep -n "campaignTotalCount ?? 0) > 1" apps/web/src/lib/features/sessions/table/session-table-model.ts` → 1 hit
- [ ] `grep -n "summarizeSessionRowProvenance" apps/web/src/lib/features/sessions/table/session-table.svelte apps/web/src/lib/features/sessions/table/session-cell-projection.ts` → ≥ 2 hits; `grep -n "data-provenance-shared" apps/web/src/lib/features/sessions/table/session-cell.svelte` → 1 hit
- [ ] `grep -n "fmtCompactColumn" apps/web/src/lib/foundation/presentation/format.ts apps/web/src/lib/features/sessions/table/session-columns.ts apps/web/src/lib/features/sessions/table/session-cell-projection.ts` → 3 files
- [ ] `git diff --stat 51815b70..HEAD -- apps/web/e2e/session-scroll.scale.ts apps/web/e2e/session-scroll-driver.ts apps/web/src/lib/features/sessions/table/session-virtualization.ts` → empty
- [ ] `bun run typecheck`, `bun run check`, `bun run lint` exit 0
- [ ] `bun run --cwd apps/web test` and `cd packages/report-core && bun test` exit 0
- [ ] `cd apps/web && bun run test:e2e -- e2e/session-viewport-geometry.spec.ts e2e/origin-campaign.spec.ts e2e/dashboard.spec.ts` exits 0
- [ ] `cd apps/web && bun --bun playwright test --config playwright.session-scroll.config.ts e2e/session-scroll.scale.ts` exits 0 (2 passed)
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The "Current state" excerpts do not match the working tree (another plan on
  the program branch touched `session-table.svelte`, `session-cell.svelte` or
  `session-cell-projection.ts` first — report the diff, do not merge by guess).
- The 5,000-session proof fails after Step 2/3 — report the failing
  assertion (row budget, stall, or `scrollHeight <= clientHeight`); do not
  edit `session-scroll.scale.ts` or `session-virtualization.ts` to make it pass.
- The geometry spec shows the document taller than the viewport on desktop
  by more than 2 px at rest (a body margin, a `min-height` on an ancestor, or
  an in-flow element below the owner you did not expect) — report the
  measured `document.body` / `main` / owner bottoms instead of hardcoding an
  inset.
- Any `ResizeObserver loop` console message appears in the geometry spec
  after Step 2 — report which observer fired; do not silence the console.
- `Intl.NumberFormat` compact output differs between Bun and Chrome for the
  Step 7 cases — report both outputs (the fallback is a hand-rolled
  three-significant-digit formatter, but decide that with the maintainer).
- `dashboard.spec.ts:755` (`Show children`) or `production-report.spec.ts:612-620`
  (scroll-to-load 205 rows) fails — both are consumers of behaviour this plan
  changes; report rather than widening scope.
- The maintainer has meanwhile decided to make the report toolbar truly
  sticky at page level (plan 092/098 territory) — the desktop "no page
  scroll" rule would then deserve re-discussion; report before Step 2.

## Maintenance notes

- Trade-off made explicit: on desktop the chrome (≈ 364 px at 1920, more in
  the 768–1279 band where the filter bar wraps) now stays on screen, so the
  table shows ~15 rows at 1080 p and ~11 at 1024×900 instead of ~24/~20.
  The rejected alternative — letting the page be the only scroller and
  windowing rows against `window.scrollY` — was ruled out because it
  rewrites the 5,000-session proof driver, breaks sticky `<th>` inside a
  horizontally scrolling wrapper, and is effort L; if the maintainer later
  wants more rows, the cheaper lever is a shorter chrome (plan 092) or a
  truly sticky toolbar.
- Known limitation: on mobile, a history traversal that restores a page
  scroll below the anchor can still land on the peephole state (SvelteKit
  restores scroll after our mount anchor); and the list's
  `overscrollBehavior: contain` means the filters are reached by swiping on
  the sort strip, not on the list. Flipping `contain` → `auto` is a one-line
  experiment worth a device check, deliberately not done blind here.
- The `scrollPaddingTop` global (`preset.ts:25`) and the two `position: sticky`
  toolbar children are leftovers of a page-sticky toolbar; they are inert
  today. Plan 092 should either make the toolbar wrapper sticky or drop the
  padding.
- `fmtCompactColumn` exists only in the Sessions table. If the maintainer
  prefers one compact notation everywhere, replace `fmtCompact`'s body with
  it and update the pinned strings (`format.test.ts:12-13`,
  `drawer-value-presentation.spec.ts:12` `204k` stays, overview snapshots) in
  one dedicated commit.
- `docs/session-scroll-benchmark.md` numbers were measured with a
  viewport-high surface; rows per viewport are lower now, so re-run
  `bun run --cwd apps/web benchmark:session-scroll` before quoting them.
- Reviewer should scrutinize: the body `ResizeObserver` + `requestAnimationFrame`
  deferral (console cleanliness), the `mobileListBelowFold` anchor rule (it
  bypasses the shell's preserve-scroll intent only for the mobile Sessions
  list), and that the collapsed provenance marker keeps every fact reachable
  per cell (`title` + `data-provenance-shared`) — provenance remains per
  metric; only the duplicate buttons are gone.
