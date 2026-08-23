# Plan 092: One Checkbox-Filter Mechanic, a Working `/` Shortcut, and a Filter Bar That Holds One Row

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 51815b70..HEAD -- apps/web/src/lib/features/report/breakdown/filter-bar.svelte apps/web/src/lib/features/report/breakdown/origin-filter.svelte apps/web/src/lib/features/report/breakdown/active-filters.svelte apps/web/src/lib/features/report/breakdown/styles.ts apps/web/src/lib/features/report/core/report-components.test.ts apps/web/src/lib/features/report/composition/live-report-destination.svelte apps/web/src/lib/features/report/composition/synthetic-report-destination.svelte packages/design-system/src/svelte.ts packages/design-system/src/svelte/compound/ packages/design-system/src/svelte/overlays/popover.svelte packages/design-system/src/svelte/overlays/styles.ts apps/web/e2e/dashboard.spec.ts apps/web/e2e/dashboard-presentation.spec.ts apps/web/e2e/category-visibility.spec.ts apps/web/e2e/machine-staleness.spec.ts apps/web/e2e/origin-campaign.spec.ts apps/web/bundle/client-bundle.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED (replaces a design-system primitive, rewrites selectors in four e2e specs, regenerates the Overview snapshots)
- **Depends on**: none (plan 080's extra presentation viewports already landed at `51815b70`; plans 095/097 own the source-status copy — this plan only moves its box)
- **Category**: presentation
- **Planned at**: commit `51815b70`, 2026-08-23
- **Audit findings**: U07, U15, U39, U40

## Why this matters

The filter bar is the first interactive row of every report view, and the
2026-08-23 fresh-eyes audit found four defects in it that all come down to
"two half-mechanics and a lost handler":

- **U07** — the search input advertises `( / )` in its placeholder, but
  pressing `/` from the page body never focuses it. There is no handler: the
  Solid `dashboard.tsx` had one (`document.addEventListener('keydown', …)` →
  `searchInputEl?.focus()`), it was dropped in `807b29af feat(web): cut over
  canonical runtime to SvelteKit`, and only the placeholder hint plus an
  unused `inputRef` prop were ported. `dashboard.spec.ts` still presses `/`
  and then calls `fill()` — which focuses on its own — so the regression was
  invisible.
- **U15** — Harness and Machines are Ark `Select` listboxes (bare option
  rows, nothing checked in the neutral state, no "All" affordance, menu
  same-width as a 180px trigger); Origin is an Ark `Popover` with checkboxes
  plus Default/All buttons, 560px wide and centred under its 220px trigger,
  so it opens ~170px to the left. Two mechanics for one row of filters.
- **U39** — at 1280px (`xl`: navigation rail 216px + 36px shell padding ⇒
  992px of toolbar) the flex bases sum to ~1,050px, so the source-status
  group ("1 warning" + "Run all") wraps alone to a second line. 1280 and the
  1080-wide portrait display are daily viewports.
- **U40** — the machine menu is `sameWidth` with its 180px trigger, so a
  label like `Fixture Machine Secondary · Freshness unavailable` wraps onto
  two lines.

One primitive for all three dropdowns fixes U15 and U40 together, frees the
row budget that fixes U39, and the `/` handler comes back with a test that
can fail. The partial-data rule is preserved structurally: the neutral state
stays `[]` for every filter, and checking every option collapses back to `[]`
so rows with no value (sessions without a machine id, sessions with an
undeclared origin) are never excluded by an "explicitly all" selection.

## Current state

### The filter bar and its three dropdowns

- `apps/web/src/lib/features/report/breakdown/filter-bar.svelte` (110 lines):
  - line 2: `import { MultiSelect, Tooltip } from '@ai-usage/design-system/svelte';`
  - lines 15/28/44–46: the `inputRef?: (element: HTMLInputElement) => void`
    prop and `const setInputElement = (element) => { inputRef?.(element); }`.
    **Zero callers**: `grep -rn "inputRef" apps/web/src --include=*.svelte --include=*.ts`
    returns only this file; neither `live-report-destination.svelte`
    (lines 628–639, the `filters={{ … }}` object) nor
    `synthetic-report-destination.svelte` (lines 501–512) passes it.
  - line 49: `<div class={toolbar} data-dashboard-filter-stack>`
  - lines 50–63: the `<input … placeholder="Filter by title, project, model…  ( / )" … use:setInputElement>`;
    its only key handling is lines 55–59 (`Enter` → `commitQuery()`).
  - line 64: `<div class={controls}>`
  - lines 65–72: `<MultiSelect label="Filter by harness" noun="harnesses" onValueChange={navigation.setHarness} options={harnessOptions} placeholder="All harnesses" value={search.harness} />`
  - line 73: `<OriginFilter onValueChange={(value: SessionOrigin[]) => navigation.setOrigin(value)} value={search.origin} />`
  - lines 74–84: the machine `<MultiSelect label="Filter by machine" noun="machines" … optionLabel={presentMachineLabel} placeholder="All machines" …>` inside `{#if machineOptions.length > 1 || machineAttention}`
  - lines 85–105: the freshness item (`<Tooltip>`-wrapped `<button>` when
    `freshnessUnavailable`, otherwise `<section aria-label="Collection source status" aria-live="polite" class={button}>`)
  - lines 106–108: `{#if !isDemo && sourceControlSummary}{@render sourceControlSummary()}{/if}` —
    the snippet is `apps/web/src/lib/features/sources/source-control-summary.svelte`,
    whose root is `<section aria-label="Collection source status" class={summary}>` (line 143) with
    `ml: { base: '0', md: 'auto' }` (line 88) and contains the `<a href="/sources">` status link
    (lines 144–196) and the `Run all` button (lines 197–205).
  - There is no `<svelte:window>`, no `onkeydown` for `/`, no `aria-keyshortcuts`:
    `grep -rn "key === '/'\|aria-keyshortcuts\|svelte:window" apps/web/src/lib/features/report` → no matches.
- `apps/web/src/lib/features/report/breakdown/origin-filter.svelte` (98 lines):
  - line 3: `import { Checkbox, Popover } from '@ai-usage/design-system/svelte';`
  - lines 11–24: `originTrigger = cx(field, css({ … minW: { base: 0, sm: '190px' }, flex: { base: '1 1 190px', sm: '0 1 220px' }, … }))`
  - line 25: `const narrowedOriginTrigger = css({ borderColor: 'accent', bg: 'accentTint' });`
  - lines 26–36: `popoverContent = css({ zIndex: 50, display: 'grid', gap: '10px', w: 'min(560px, calc(100vw - 32px))', … })`
  - lines 45–49: `popoverGrid` = `repeat(auto-fill, minmax(150px, 1fr))`
  - line 53: `const normalized = $derived(value.length === 0 ? sessionOrigins : value);`
  - lines 54–61: the trigger label — `'Origin: all'` when `isDefaultDashboardOriginSelection(value)`,
    else `` `Origin: excluding ${excluded.map(...).join(' + ')}` `` (the label describes the exclusion — plan 049, Step 4.4; keep this copy).
  - lines 62–71: `setChecked` — builds the next set and emits
    `selection.length === sessionOrigins.length ? [] : selection` (the collapse-to-neutral rule this plan generalises).
  - lines 78–83: `<Popover contentClass={popoverContent} {trigger} triggerAriaLabel="Filter by origin" triggerClass={…}>`
  - lines 87–88: `<button … onclick={() => onValueChange([...defaultDashboardOrigins])}>Default</button>` and `<button … onclick={() => onValueChange([])}>All</button>` —
    `defaultDashboardOrigins` is `[]` (`apps/web/src/dashboard-search.ts:90`), so both buttons do the same thing.
- `apps/web/src/lib/features/report/breakdown/active-filters.svelte`: pills for query (73–77),
  time cell (78–82), harness (83–87), machine (88–98), field filters (99–108); **no origin pill**.
  `navigation.clearOrigin` (`breakdown/navigation.ts:24`, implemented at line 82 as
  `update((search) => ({ ...search, origin: [] }))`) has no caller:
  `grep -rn "clearOrigin" apps/web/src --include=*.svelte --include=*.ts | grep -v navigation.ts` → nothing.
- `apps/web/src/lib/features/report/breakdown/styles.ts`:
  - lines 22–33: `field` (h 44/36, border `lineStrong`, px 12, font 13).
  - lines 72–91: `toolbar` — `display: 'flex'`, `flexDirection: { base: 'column', sm: 'row' }`,
    `flexWrap: { base: 'nowrap', sm: 'wrap' }`, `gap: { base: '8px', sm: '10px' }`,
    `'& > input': { flex: { base: 'none', sm: '1 1 240px' }, minH: …, minW: { base: 0, sm: '180px' }, w: … }`.
  - lines 92–109: `controls` — `display: { base: 'grid', sm: 'contents' }`,
    `gridTemplateColumns: 'minmax(0, 0.75fr) minmax(0, 1.25fr)'`,
    `'& > *': { minW: 0, w: { base: 'full', sm: 'auto' } }`,
    `'& button, & a': { minH: { base: '44px', sm: '36px' } }`,
    `'& > [aria-label="Collection source status"]': { gap…, '& > a, & > button': { px… }, '& > button': { whiteSpace: 'nowrap' } }`,
    `'& > :last-child:nth-child(odd)': { gridColumn: { base: '1 / -1', sm: 'auto' } }`.

### The two primitives behind the two mechanics

- `packages/design-system/src/svelte/compound/multi-select.svelte` (151 lines) — Ark `Select`:
  - lines 5–10: `selectRoot = css({ display: 'inline-flex', flexDirection: 'column', flex: { base: '1 1 120px', sm: '0 1 180px' }, minW: { base: 0, sm: '150px' } })`
  - lines 13–29: `selectTrigger = cx(field, css({ … '&[data-state=open]': { borderColor: 'accent', boxShadow: … } }))` with `field` imported from `'../../components/field'` (line 3).
  - line 47: `const selectPositioner = css({ zIndex: '50 !important' });` (comment: Zag writes an inline `--z-index`).
  - lines 120–128: `<Select.Root class={selectRoot} closeOnSelect={false} {collection} multiple {name} onValueChange={(details) => onValueChange(details.value)} positioning={{ sameWidth: true, gutter: 4 }} {value}>` — `sameWidth` is what pins the machine menu to 180px (U40).
  - lines 142–147: items render `<Select.ItemText>` + `<Select.ItemIndicator>✓</Select.ItemIndicator>` — the indicator only appears on checked items, so the neutral state shows nothing checked (U15).
  - Consumers: only `filter-bar.svelte`, `svelte.ts:118`, and the compound fixture/test
    (`grep -rln "MultiSelect" apps packages --include=*.svelte --include=*.ts`).
- `packages/design-system/src/svelte/compound/multi-select.ts`: `multiSelectSummary(value, placeholder, noun, optionLabel)` → placeholder / the single label / `` `${n} ${noun}` ``.
- `packages/design-system/src/svelte/overlays/popover.svelte` (the wrapper Origin uses):
  lines 38–45 `<Popover.Root lazyMount {onExitComplete} onOpenChange={handleOpenChange} {open} positioning={{ gutter: 4 }} unmountOnExit>` —
  no `placement`, so Zag's default applies: `node_modules/@zag-js/popover/dist/popover.machine.mjs` lines 24–27
  `positioning: { placement: "bottom", ...props.positioning }` = centred under the trigger. That is the 170px offset.
  Zag's popper sets `--reference-width` / `--available-width` on the positioner
  (`node_modules/@zag-js/popper/dist/get-placement.mjs` lines 96–104) and slides the
  floating element back inside the viewport with `overflowPadding: 8` (`slide: true`, defaults at lines 8–19).
- `packages/design-system/src/svelte/controls/checkbox.svelte` lines 5–22: the shared `Checkbox`
  row style `columnToggle` has `maxW: '180px'` and `gridTemplateColumns: '14px minmax(0, max-content)'` —
  reusing it inside a menu would clip long machine labels, so the new compound renders Ark
  `Checkbox` parts with its own row style.
- `packages/design-system/src/svelte/overlays/styles.ts`: line 108 `popoverPositionerClass = css({ zIndex: 70 })`;
  lines 110–120 `popoverContentClass` (`w: 'min(560px, calc(100vw - 32px))'`).
- `packages/design-system/src/svelte.ts` line 118: `export { default as MultiSelect } from './svelte/compound/multi-select.svelte';`
  (lines 121/129 export `Checkbox` and `Popover`).
- `packages/design-system/src/svelte/compound/compound.fixture.svelte` lines 2 and 30–47 mount
  `MultiSelect` (`label="Filter fixture machines"`, `name="fixture-machines"`, options alpha/beta plus
  a "Toggle dynamic option" button that adds gamma).
- `packages/design-system/src/svelte/compound/compound-components.test.ts`:
  - line 31: `const BROWSER_PROOF_INTERACTIONS = 41;` (documented sizing of the Chromium proof budget).
  - lines 84–125: the MultiSelect Chromium proof (ArrowDown highlight, Enter selects, hidden `<select>`
    state, positioner `zIndex === '50'`, positioner width ≈ trigger width, Home/Enter, Escape, dynamic option).
  - lines 197–217: the MultiSelect source-contract test (`closeOnSelect={false}`, `<Select.HiddenSelect />`, `positioning={{ sameWidth: true, gutter: 4 }}`, …).
  - lines 219–228: the `multiSelectSummary` unit test.
  - line 70: the proof requires `Bun.which('google-chrome')`.

### Data rules the new mechanic must keep

- `packages/report-core/src/session-query.ts`:
  - line 1408: `if (request.filters.harness.length && !request.filters.harness.includes(row.harness))`
  - line 1411: `if (request.filters.machine.length && !request.filters.machine.includes(row.source?.machineId ?? ''))` —
    an explicit machine list excludes rows without a machine id; only `[]` keeps them.
  - line 1417: `if (request.filters.origin?.length && row.origin !== undefined && !request.filters.origin.includes(row.origin))` —
    an undeclared origin is never excluded (plan 049). No change here.
- `apps/web/src/dashboard-search.ts`: line 90 `defaultDashboardOrigins = []`; lines 116–117
  `isDefaultDashboardOriginSelection`; lines 141–147 `hasActiveDashboardFilters` already counts a
  non-default origin (so "Clear all" appears for an origin narrowing).
- `packages/report-core/src/session-query.ts` lines 209–217: `sessionOriginLabels`
  (`human: 'Human'`, `subagent: 'Delegated'`, `classifier: 'Automated review'`) and `sessionOriginLabel`.

### Layout budget behind U39

- `apps/web/src/lib/features/shell/app-shell.svelte` lines 35–40: content `ml: { base: 0, md: '56px', xl: '216px' }`.
- `packages/design-system/src/components/layout.ts` lines 22–27: `shell` `px: { base: '20px', md: '36px' }`.
- Breakpoints are the Panda defaults (`sm` 640, `md` 768, `lg` 1024, `xl` 1280 —
  `node_modules/@pandacss/preset-panda/dist/index.mjs` lines 2–8).
- Toolbar width therefore: 1280 → 992px; 1080 → 952px; 1024 → 896px; 768 → 640px.
  Current `sm+` flex bases: input 240 + harness 180 + origin 220 + machine 180 + 4×10 gaps
  = 860, plus the source-status section (~200px: link ~126 + gap 8 + `Run all` ~70) = ~1,060
  > 992 ⇒ the section wraps at 1280 (U39). Flex lines break on *bases*, not on min-widths,
  so shrink values do not help; the bases must change.

### Tests that currently pin the old mechanic

- `apps/web/e2e/dashboard.spec.ts` lines 454–466 (`persists exploration state in the URL`):
  `await page.keyboard.press('/');` at line 457 is followed by `search.fill('ai-usage')` with no focus assertion.
- `apps/web/e2e/dashboard-presentation.spec.ts` lines 434–497 (`keeps the mobile filter stack coherent…`):
  line 442 `page.getByRole('combobox', { name: 'Filter by harness' })`, line 443 `getByRole('button', { name: 'Filter by origin' })`,
  line 444 `getByRole('combobox', { name: 'Filter by machine' })`, line 445 `getByRole('region', { name: 'Collection source status' })`;
  lines 487–497 `filterControlGeometry` over `'input:visible, button:visible, a:visible, [role="combobox"]:visible'` asserting `height >= 44`.
  The spec's grid expectations (harness/origin share a row; machine under harness with the same
  x/width; the source status aligned with origin) must keep passing.
- `apps/web/e2e/category-visibility.spec.ts` lines 28–57 and 80–117: `getByRole('combobox', { name: 'Filter by harness' | 'Filter by machine' })`,
  `getAttribute('aria-controls')`, `listbox.querySelectorAll('[role=option]')`, `[data-part=item-text]`.
- `apps/web/e2e/machine-staleness.spec.ts` lines 15–25: `getByRole('combobox', { name: 'Filter by machine' })`,
  `page.getByRole('option', { name: 'Fixture Machine · Stale' })`, then `expect(machineFilter).toContainText('Fixture Machine · Stale')`.
- `apps/web/e2e/origin-campaign.spec.ts` lines 9–15: `getByRole('button', { name: 'Filter by origin' })`,
  `toContainText('Origin: all')`, then `getByText('Human' | 'Delegated' | 'Automated review', { exact: true })`.
- `apps/web/src/lib/features/report/core/report-components.test.ts` line 154
  (`renders filters, period, active summary, then the Overview in decision order`) renders the
  demo report root server-side (`report-root.fixture.svelte`, which provides
  `sourceControlSummary = undefined`) and asserts `data-dashboard-filter-stack` precedes
  `data-report-period-control`.
- `apps/web/e2e/visual-regression.spec.ts` lines 195–216 and 218–262 capture the Overview at
  1440×1000 and 390×844 — both include the filter bar, so the snapshots will change.
- `apps/web/bundle/client-bundle.test.ts` line 41: `RECORDED_GZIP_CLOSURE_BYTES = 284_579;` —
  the drift guard is one-sided (lines 110–126: only growth fails). Removing Ark `Select` +
  `collection` from the first-load closure can only shrink it.

### E2E fixture facts used below

- Harness options: `Claude`, `Codex`, `Cursor`, `OpenCode` (`apps/web/src/report-data.ts` lines 12/48/90/126).
- Machines: `fixture-machine` → presented as `Fixture Machine · Stale`; `fixture-machine-secondary`
  → `Fixture Machine Secondary · Freshness unavailable` (`synthetic-report-destination.svelte`
  lines 165–177, 185–195, 206–211, 326–329; `apps/web/src/machine-freshness-presentation.ts` lines 73 and 94).
- In e2e mode `freshnessStatus` is `null` (`machineFreshnessStatusLabel` of an available snapshot),
  and the source-control summary region is present (`sources.spec.ts:143` reads it on the report page).
- Playwright's default viewport is 1280×720 (`apps/web/playwright.config.ts` line 28, `...devices['Desktop Chrome']`).

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `bun run typecheck` | exit 0 |
| Format + lint | `bun x ultracite fix && bun run check && bun run lint` | exit 0 (`lint` includes `tools/check-svelte-style-shadowing.ts` and `tools/check-design-export-consumers.ts`) |
| Design-system unit + Chromium proof | `bun run --cwd packages/design-system test` | all pass (needs `google-chrome` on `PATH`) |
| Web unit/SSR tests | `bun run --cwd apps/web test` | all pass (builds the design system and runs `dev:prepare` first) |
| One web test file | `cd apps/web && bun test src/lib/features/report/breakdown/filter-shortcut.test.ts` | pass |
| One e2e spec | `cd apps/web && bun run test:e2e -- e2e/filter-bar.spec.ts` | pass |
| Full e2e | `bun run test:e2e` | all pass |
| Snapshots | `cd apps/web && bun run test:e2e -- e2e/visual-regression.spec.ts --update-snapshots` | regenerates the two Overview PNGs |
| Bundle guard | `cd apps/web && bun run build && bun run test:bundle` | pass |

On NixOS, if Playwright's downloaded chromium fails to launch, set
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to the system Chrome binary before
running e2e (`--channel chrome` does not work here).

## Scope

**In scope** (the only files you should modify or create):
- `packages/design-system/src/svelte/compound/checkbox-filter.svelte` (new)
- `packages/design-system/src/svelte/compound/checkbox-filter.ts` (new; replaces `multi-select.ts`)
- `packages/design-system/src/svelte/compound/multi-select.svelte` (delete)
- `packages/design-system/src/svelte/compound/multi-select.ts` (delete)
- `packages/design-system/src/svelte/compound/compound.fixture.svelte`
- `packages/design-system/src/svelte/compound/compound-components.test.ts`
- `packages/design-system/src/svelte.ts`
- `apps/web/src/lib/features/report/breakdown/filter-bar.svelte`
- `apps/web/src/lib/features/report/breakdown/origin-filter.svelte`
- `apps/web/src/lib/features/report/breakdown/origin-filter.ts` (new) + `origin-filter.test.ts` (new)
- `apps/web/src/lib/features/report/breakdown/filter-shortcut.ts` (new) + `filter-shortcut.test.ts` (new)
- `apps/web/src/lib/features/report/breakdown/active-filters.svelte`
- `apps/web/src/lib/features/report/breakdown/styles.ts`
- `apps/web/src/lib/features/report/core/report-components.test.ts`
- `apps/web/e2e/filter-bar.spec.ts` (new)
- `apps/web/e2e/dashboard.spec.ts`, `apps/web/e2e/dashboard-presentation.spec.ts`,
  `apps/web/e2e/category-visibility.spec.ts`, `apps/web/e2e/machine-staleness.spec.ts`
- `apps/web/e2e/visual-regression.spec.ts-snapshots/` (regenerated PNGs only)
- `apps/web/bundle/client-bundle.test.ts` (only the `RECORDED_GZIP_CLOSURE_BYTES` number, Step 9)
- `plans/README.md` (status row)

**Out of scope** (do NOT touch):
- `packages/design-system/src/svelte/overlays/popover.svelte` and `checkbox.svelte` — the sessions
  "Advanced columns" chooser (`session-table.svelte:407–431`) and `app-navigation.svelte` keep using them.
- `apps/web/src/lib/features/sources/source-control-summary.svelte` and everything under `sources/` —
  the status copy ("Sources ready", "1 warning") belongs to plans 095/097; this plan only changes the
  box the snippet is rendered into.
- `packages/report-core/**` predicates and `apps/web/src/dashboard-search.ts` — the neutral `[]`
  semantics and the undeclared-origin rule are settled (plan 049).
- `apps/web/src/lib/features/report/breakdown/navigation.ts` — `clearOrigin` already exists; this plan only calls it.
- Any other finding of the 086 program (U22/U28 status chips and jargon → 095/097).

## Git workflow

- Work on the program branch `plan/086-ui-ux-audit-remediation` in this worktree; stage by explicit path
  (peer sessions write to the repository concurrently — never `git add -A`).
- One commit for this plan. Suggested message:
  `fix(web): one checkbox-filter mechanic for harness, origin and machines; restore the / shortcut`
  (matches the `fix(web): …` style in `git log`).
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Pure helpers first — `/` shortcut, origin summary, filter-selection rules

1. Create `apps/web/src/lib/features/report/breakdown/filter-shortcut.ts`:

   ```ts
   const textEntryTagPattern = /^(INPUT|SELECT|TEXTAREA)$/;

   export const FILTER_FOCUS_SHORTCUT = '/';

   /** Same target rule as the session drawer's j/k/Escape handler: never hijack keys typed into a form control. */
   export const shouldFocusFilterOnKeydown = (
     event: Pick<KeyboardEvent, 'altKey' | 'ctrlKey' | 'defaultPrevented' | 'isComposing' | 'key' | 'metaKey' | 'target'>,
   ): boolean => {
     if (event.key !== FILTER_FOCUS_SHORTCUT || event.altKey || event.ctrlKey || event.metaKey) return false;
     if (event.defaultPrevented || event.isComposing) return false;
     const target = event.target;
     const tagName: unknown = target ? Reflect.get(target, 'tagName') : undefined;
     const editable: unknown = target ? Reflect.get(target, 'isContentEditable') : undefined;
     return !((typeof tagName === 'string' && textEntryTagPattern.test(tagName)) || editable === true);
   };
   ```
   (Mirror of `session-detail-query-slot.svelte` lines 17 and 166–172.) Add
   `filter-shortcut.test.ts` with plain-object events: `/` on `{ tagName: 'BODY' }` → true;
   `/` on a `BUTTON` → true (a Tab-focused trigger must not block the shortcut); `/` on
   `INPUT`, `TEXTAREA`, `SELECT`, `isContentEditable: true` → false; `/` with `metaKey` /
   `ctrlKey` / `altKey` → false; `defaultPrevented` → false; `isComposing` → false; `?` → false;
   `target: null` → true.

2. Create `apps/web/src/lib/features/report/breakdown/origin-filter.ts` by moving the label logic out of
   `origin-filter.svelte` lines 54–61 unchanged:

   ```ts
   export const originFilterSummary = (value: readonly SessionOrigin[]): string => {
     if (isDefaultDashboardOriginSelection(value)) return 'Origin: all';
     const selected = new Set(value);
     const excluded = sessionOrigins.filter((origin) => !selected.has(origin));
     return `Origin: excluding ${excluded.map((origin) => sessionOriginLabel(origin).toLowerCase()).join(' + ')}`;
   };
   ```
   `origin-filter.test.ts`: `[]` → `'Origin: all'`; `['human','subagent']` → `'Origin: excluding automated review'`;
   `['human']` → `'Origin: excluding delegated + automated review'`.

3. Create `packages/design-system/src/svelte/compound/checkbox-filter.ts` (and delete
   `multi-select.ts` in Step 2) with:
   - `checkboxFilterSummary(value, placeholder, noun, optionLabel)` — byte-identical body to today's
     `multiSelectSummary`.
   - `toggleCheckboxFilterOption(value, options, option, checked): string[]` — add/remove `option`;
     keep known options in `options` order, keep values not present in `options` (a URL-preserved raw
     machine id) at the end; **return `[]` when every option is included and nothing unknown remains**
     (every option explicitly checked is the neutral state, so rows with no value are never excluded —
     `session-query.ts:1411`).
   - `checkboxFilterIncludedCount(value, options)` — `options.length` when `value` is empty, else the
     number of options present in `value`.
   Unit-test all three in `compound-components.test.ts` (Step 4), replacing the `multiSelectSummary` test:
   check one from neutral → `[option]`; uncheck the last → `[]`; check the last missing option → `[]`;
   unknown value survives a toggle and blocks the collapse (`['ghost']` + check `a` → `['a','ghost']`).

**Verify**: `cd apps/web && bun test src/lib/features/report/breakdown/filter-shortcut.test.ts src/lib/features/report/breakdown/origin-filter.test.ts` → all pass.

### Step 2: The one primitive — `CheckboxFilter` in the design system

Create `packages/design-system/src/svelte/compound/checkbox-filter.svelte`. It is the Origin
mechanic generalised, built from the **same two Ark primitives the repo already ships**:
`@ark-ui/svelte/popover` (`Popover.Root/Trigger/Positioner/Content/Title` + `Portal`) and
`@ark-ui/svelte/checkbox` (`Checkbox.Root/HiddenInput/Control/Indicator/Label`). Ark `Select`
(`@ark-ui/svelte/select`, `@ark-ui/svelte/collection`) leaves the codebase.

Props (module script, exported interface `CheckboxFilterProps`):
`label: string` (trigger `aria-label`, e.g. `Filter by harness`), `title: string` (dialog title, e.g. `Harness`),
`noun: string`, `placeholder: string` (trigger text when neutral *and* the text of the "All" row, e.g. `All harnesses`),
`options: string[]`, `optionLabel?: (value: string) => string`, `value: string[]`,
`onValueChange: (value: string[]) => void`, `summary?: (value: readonly string[]) => string`
(full override of the trigger text — Origin passes `originFilterSummary` so plan 049's exclusion wording stays).

Markup (keep attributes verbatim — tests and e2e key on them):
- `<Popover.Root lazyMount unmountOnExit positioning={{ placement: 'bottom-start', gutter: 4 }}>` —
  `bottom-start` is the fix for "opens 170px to the left"; Zag's default `slide` keeps it inside the viewport.
- `<Popover.Trigger aria-label={label} class={filterTrigger} data-filter-trigger data-narrowed={value.length > 0 || undefined} title={triggerText} type="button">`
  containing `<span class={filterTriggerText}>{triggerText}</span>` (add the muted placeholder class when neutral)
  and `<span aria-hidden="true" class={filterIndicator}>▾</span>`; `triggerText = summary?.(value) ?? checkboxFilterSummary(value, placeholder, noun, optionLabel)`.
- `<Portal><Popover.Positioner class={popoverPositionerClass}><Popover.Content class={filterContent}>`
  (`popoverPositionerClass` from `'../overlays/styles'`).
  - Header: `<div class={filterHeader}><Popover.Title class={filterTitle}>{title}</Popover.Title><span>{included} of {options.length}</span></div>`
    (`included = checkboxFilterIncludedCount(value, options)`; the title gives the dialog its accessible name).
  - The "All" row: `<button aria-pressed={value.length === 0} class={filterRow} data-filter-all onclick={() => onValueChange([])} type="button"><span class={filterRowBox} data-state={value.length === 0 ? 'checked' : 'unchecked'}>{value.length === 0 ? '✓' : ''}</span><span class={filterRowLabel}>{placeholder}</span></button>` —
    this is the "checked state for All" U15 asked for; pressing it when already neutral is a no-op.
  - `{#each options as option (option)}` → `<Checkbox.Root checked={value.includes(option)} class={filterRow} onCheckedChange={(details) => onValueChange(toggleCheckboxFilterOption(value, options, option, details.checked === true))}><Checkbox.HiddenInput /><Checkbox.Control class={filterRowBox}><Checkbox.Indicator>✓</Checkbox.Indicator></Checkbox.Control><Checkbox.Label class={filterRowLabel} title={optionLabel(option)}>{optionLabel(option)}</Checkbox.Label></Checkbox.Root>`.
    Checked ⇔ explicitly included (inclusion model: one click narrows to one value, exactly as the
    machine-staleness spec expects). Do **not** name any style constant `option` or `row` — the
    `{#each … as option}` binding would shadow it (`tools/check-svelte-style-shadowing.ts`).

Styles (one `css()` per constant; no `cx()` between constants that set the same property — atom
conflicts resolve by stylesheet order, not call order):
- `filterRoot`: `display: 'inline-flex', flexDirection: 'column', flex: { base: '1 1 120px', sm: '0 1 150px' }, minW: { base: 0, sm: '150px' }` (was 180 — part of the U39 budget).
- `filterTrigger = cx(field, css({ display: 'inline-flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', w: 'full', cursor: 'pointer', textAlign: 'left', _hover: { borderColor: 'lineStrong' }, '&[data-state=open]': { borderColor: 'accent', boxShadow: '0 0 0 3px token(colors.focusRing)' }, '&[data-narrowed]': { borderColor: 'accent', bg: 'accentTint' } }))`
  with `field` from `'../../components/field'` (same height/border/padding contract as the search input — the reason Origin composed `field` too).
- `filterTriggerText`: `overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'`; `filterTriggerPlaceholder`: `color: 'muted'`; `filterIndicator` as in `multi-select.svelte` lines 37–43.
- `filterContent`: `zIndex: 50, display: 'grid', gap: '2px', w: 'max-content', minW: 'var(--reference-width)', maxW: 'min(480px, calc(100vw - 16px))', maxH: '360px', overflowY: 'auto', p: '6px', border: '1px solid token(colors.lineStrong)', borderRadius: 'md', bg: 'surface', boxShadow: 'overlay', animation: 'fadeIn 0.12s ease-out'` —
  never narrower than its trigger, as wide as its longest label up to 480px (U40), never `sameWidth`.
- `filterHeader`: flex, `justifyContent: 'space-between'`, `px: '10px'`, `py: '4px'`, `color: 'muted'`, `fontSize: '12px'`; `filterTitle`: `color: 'ink', fontWeight: 700`.
- `filterRow` (used by the label rows **and** the All button, so include the button resets here rather than via `cx`):
  `appearance: 'none', display: 'grid', gridTemplateColumns: '14px minmax(0, 1fr)', alignItems: 'center', gap: '8px', w: 'full', minH: { base: '44px', sm: '32px' }, px: '10px', border: 0, borderRadius: 'sm', bg: 'transparent', color: 'ink', font: 'inherit', fontSize: '13px', textAlign: 'left', cursor: 'pointer', userSelect: 'none', _hover: { bg: 'surfaceMuted' }, '&[data-state=checked], &[aria-pressed=true]': { bg: 'accentTint' }, '&[data-focus-visible], &:focus-visible': { outline: '2px solid token(colors.accent)', outlineOffset: '-2px' }`.
- `filterRowBox`: the 14px box from `checkbox.svelte` lines 24–37 (`'&[data-state=checked]': { bg: 'accent', borderColor: 'accent' }`).
- `filterRowLabel`: `minW: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: { base: 'normal', sm: 'nowrap' }` — one line from `sm` up (U40), wrapping only on touch widths where there is no hover to reveal a `title`.

Then:
- `packages/design-system/src/svelte.ts` line 118 → `export { default as CheckboxFilter } from './svelte/compound/checkbox-filter.svelte';`
- Delete `multi-select.svelte` and `multi-select.ts`.
- `compound.fixture.svelte`: replace the `MultiSelect` block (lines 30–47) with `CheckboxFilter`
  (`label="Filter fixture machines"`, `title="Machines"`, `noun="machines"`, `placeholder="All machines"`, same
  `optionLabel`/`options`/`value`/`onValueChange`), keep `data-testid="multi-select-fixture"` renamed to
  `checkbox-filter-fixture` and `data-selection`, keep the "Toggle dynamic option" button, and change the
  dynamic label to `gamma: 'Gamma workstation with a deliberately long label'` so the proof can assert no wrapping.

**Verify**: `bun run --cwd packages/design-system build && bun run typecheck` → exit 0;
`grep -rn "MultiSelect\|multi-select" apps packages --include=*.svelte --include=*.ts | grep -v node_modules` → no matches.

### Step 3: Wire the filter bar — three `CheckboxFilter`s, the `/` shortcut, the actions group

`apps/web/src/lib/features/report/breakdown/filter-bar.svelte`:
1. Line 2: import `CheckboxFilter, Tooltip`; import `shouldFocusFilterOnKeydown` from `./filter-shortcut`
   and `actions` from `./styles`.
2. Remove the `inputRef` prop (lines 15, 28) and `setInputElement` (44–46, 62). Add
   `let inputElement = $state<HTMLInputElement | undefined>();` and on the `<input>`:
   `bind:this={inputElement}` and `aria-keyshortcuts="/"`. Keep the placeholder text.
3. Add, before the toolbar markup:
   ```svelte
   <svelte:window
     onkeydown={(event) => {
       if (!shouldFocusFilterOnKeydown(event)) return;
       event.preventDefault();
       inputElement?.focus();
     }}
   />
   ```
   The bar is mounted only on the report route, so the listener's lifetime is the bar's.
4. Replace the harness `MultiSelect` (65–72) with
   `<CheckboxFilter label="Filter by harness" noun="harnesses" onValueChange={navigation.setHarness} options={harnessOptions} placeholder="All harnesses" title="Harness" value={search.harness} />`
   and the machine one (75–83) with the same shape (`label="Filter by machine"`, `noun="machines"`, `optionLabel={presentMachineLabel}`, `placeholder="All machines"`, `title="Machine"`).
5. Wrap the trailing items in one group:
   ```svelte
   {#if freshnessStatus || (!isDemo && sourceControlSummary)}
     <div class={actions} data-filter-actions>
       …existing freshness block (85–105)…
       …existing summary render (106–108)…
     </div>
   {/if}
   ```

`apps/web/src/lib/features/report/breakdown/origin-filter.svelte` becomes a thin adapter:
```svelte
<CheckboxFilter
  label="Filter by origin"
  noun="origins"
  onValueChange={(selection) => onValueChange(sessionOrigins.filter((origin) => selection.includes(origin)))}
  optionLabel={(origin) => (isSessionOrigin(origin) ? sessionOriginLabel(origin) : origin)}
  options={[...sessionOrigins]}
  placeholder="All origins"
  summary={(selection) => originFilterSummary(sessionOrigins.filter((origin) => selection.includes(origin)))}
  title="Session origin"
  value={[...value]}
/>
```
Delete the local trigger/content styles, `normalized`, `label`, `setChecked`, and the Default/All
buttons (the shared All row replaces both; `defaultDashboardOrigins` is `[]`, so "Default" had no
distinct meaning). Props stay `{ onValueChange, value }`.

`apps/web/src/lib/features/report/breakdown/styles.ts`:
- `toolbar` `'& > input'`: `flex: { base: 'none', sm: '1 1 180px' }` (was `240px`; `minW` stays `180px`).
- `controls`: remove the `'& > [aria-label="Collection source status"]'` block (it moves into `actions`); keep everything else.
- Add:
  ```ts
  // U39: the freshness item and the source-control summary travel as one flex item. At `sm+` it is
  // pinned right and either fits on the filter row or wraps as a whole; at base it is an ordinary
  // grid child so the mobile two-column stack (and its geometry spec) is unchanged.
  export const actions = css({
    display: { base: 'grid', sm: 'inline-flex' },
    flex: { sm: '0 0 auto' },
    ml: { sm: 'auto' },
    gap: '8px',
    alignItems: 'center',
    minW: 0,
    w: { base: 'full', sm: 'auto' },
    '& > *': { minW: 0, w: { base: 'full', sm: 'auto' } },
    '& > [aria-label="Collection source status"]': {
      gap: { base: '4px', sm: '8px' },
      '& > a, & > button': { px: { base: '6px', sm: '10px' } },
      '& > button': { whiteSpace: 'nowrap' },
    },
  });
  ```
  Budget after this step at `sm+`: input 180 + 3 × 150 + 5 × 10 gaps + ~210 actions ≈ 890px
  ≤ 992 (1280) and ≤ 952 (1080) even with the longest status label ("Checking sources…", ~240px → ~920px).

`apps/web/src/lib/features/report/breakdown/active-filters.svelte`: after the machine pills (line 98) add
```svelte
{#if !isDefaultDashboardOriginSelection(search.origin)}
  <button class={pill} onclick={navigation.clearOrigin} title="Clear Origin filter" type="button">
    {originFilterSummary(search.origin)} ×
  </button>
{/if}
```
(import `isDefaultDashboardOriginSelection` from `dashboard-search` and `originFilterSummary` from
`./origin-filter`). A 150px trigger ellipsizes "Origin: excluding automated review"; the pill carries the
full text and makes origin removable like every other narrowing, using the orphan `clearOrigin` seam.

**Verify**: `bun run typecheck` → exit 0; `grep -rn "inputRef" apps/web/src` → no matches;
`grep -c "<CheckboxFilter" apps/web/src/lib/features/report/breakdown/filter-bar.svelte` → `2`;
`grep -n "aria-keyshortcuts=\"/\"\|<svelte:window\|data-filter-actions" apps/web/src/lib/features/report/breakdown/filter-bar.svelte` → three hits.

### Step 4: Design-system proof — replace the MultiSelect section of `compound-components.test.ts`

In the Chromium proof (lines 84–125) replace the MultiSelect block with a CheckboxFilter block (keep the
rest of the proof intact):
1. `const trigger = page.getByRole('button', { name: 'Filter fixture machines' }); await trigger.focus(); await trigger.press('Enter');`
2. `const dialog = page.getByRole('dialog', { name: 'Machines' }); await dialog.waitFor();`
3. Anchoring: `|dialogBox.x − triggerBox.x| ≤ POSITIONING_PIXEL_TOLERANCE`, `dialogBox.y ≥ triggerBox.y + triggerBox.height`,
   `dialogBox.width + 1 ≥ triggerBox.width`; computed `zIndex` of the content ≥ `50`.
4. `await expect(dialog.getByRole('button', { name: 'All machines' })).toHaveAttribute('aria-pressed', 'true')` (use `getAttribute` as the file does);
   `await dialog.getByText('Alpha workstation', { exact: true }).click()` → `data-selection === 'alpha'`, All row `aria-pressed="false"`, trigger `data-narrowed="true"`, trigger text `Alpha workstation`.
5. `await page.keyboard.press('Escape')` → dialog hidden, `document.activeElement` is the trigger.
6. Click "Toggle dynamic option", open again, assert the long gamma label renders on one line and unclipped:
   `label.evaluate((el) => el.getClientRects().length === 1 && el.scrollWidth <= el.clientWidth + 1)` → `true`
   (the `[data-scope="checkbox"][data-part="label"]` whose text is the long label).
7. Click Alpha again (uncheck) → `data-selection === ''`, All row pressed again. Close with Escape.
Recount the interactions and update `BROWSER_PROOF_INTERACTIONS` (line 31) with the new count; keep the comment's sizing logic.

Replace the source-contract test (197–217) with a `CheckboxFilter` one asserting these strings in
`checkbox-filter.svelte`: `import { field } from \x27../../components/field\x27`, `positioning={{ placement: 'bottom-start', gutter: 4 }}`,
`lazyMount`, `unmountOnExit`, `data-filter-trigger`, `data-filter-all`, `aria-pressed={value.length === 0}`,
`<Popover.Title`, `<Checkbox.HiddenInput />`, `'&[data-narrowed]'`, `minW: 'var(--reference-width)'`,
`{#each options as option (option)}`. Replace the summary test (219–228) with the three helper tests from Step 1.3.
Update the fixture-contract test (last `test` in the file) to `import CheckboxFilter from './checkbox-filter.svelte'` and `checkbox-filter-fixture`.

**Verify**: `bun run --cwd packages/design-system test` → all pass (including the Chromium proof).

### Step 5: SSR assertions

In `apps/web/src/lib/features/report/core/report-components.test.ts`, next to the test at line 154,
add `it('advertises the slash shortcut and renders one checkbox-filter trigger per dimension', …)`
rendering the same demo `data`:
`expect(body).toContain('aria-keyshortcuts="/"')`; `expect(body.match(/data-filter-trigger/g)?.length).toBe(3)`
(demo has two machines, so harness + origin + machine); `expect(body).toContain('data-filter-actions')`
(demo `freshnessStatus` is `'Synthetic data'`); `expect(body).not.toContain('role="listbox"')`.

**Verify**: `cd apps/web && bun test src/lib/features/report/core/report-components.test.ts` → pass.

### Step 6: New e2e spec `apps/web/e2e/filter-bar.spec.ts` (the presentation gate)

Use `expect, openHydratedReport, test, waitForFocusedReportSettled` from `./browser-test`. Constants:
`const SEARCH_NAME = 'Filter sessions by title, project, model, provider, or harness'; const ALIGNMENT_TOLERANCE_PX = 1; const ZAG_OVERFLOW_PADDING_PX = 8;`

Helper `expectAnchoredUnder(page, trigger, dialog)`: read both `boundingBox()`es and
`clientWidth = await page.evaluate(() => document.documentElement.clientWidth)`; assert
`dialog.y ≥ trigger.y + trigger.height` and `dialog.y − (trigger.y + trigger.height) ≤ ZAG_OVERFLOW_PADDING_PX`;
`dialog.width + 1 ≥ trigger.width`; then `const fitsToTheRight = trigger.x + dialog.width <= clientWidth − ZAG_OVERFLOW_PADDING_PX;`
`if (fitsToTheRight) expect(|dialog.x − trigger.x|) ≤ 1 else expect(|dialog.x + dialog.width − (clientWidth − ZAG_OVERFLOW_PADDING_PX)|) ≤ 1`.
(Fails on today's Origin — 560px centred, x = trigger.x − 170 while it fits to the right; passes on `bottom-start` with Zag's slide.)

Tests:
1. **`/ focuses the filter from the body and from a focused button, and types literally inside the input`** —
   `openHydratedReport(page)`; `await page.locator('body').click({ position: { x: 4, y: 4 } })` (or `page.keyboard.press('Escape')`) to park focus;
   `press('/')` → `expect(search).toBeFocused()` and `toHaveValue('')`; `await page.getByRole('button', { name: 'Filter by harness' }).focus(); await page.keyboard.press('/')` → search focused;
   `await search.press('/')` → `toHaveValue('/')`; `await search.fill('')`.
2. **`keeps the filter toolbar on one row at 1280 and 1080`** — for `{ width: 1280, height: 900 }` and `{ width: 1080, height: 900 }`:
   `setViewportSize`, `openHydratedReport`, `waitForFocusedReportSettled`; collect boxes of `search`, the three `[data-filter-trigger]`
   buttons, and `[data-filter-actions]`; assert every vertical centre is within 1px of the search input's centre, and
   `|actions.right − stack.right| ≤ 1` where `stack` is `[data-dashboard-filter-stack]`. (Fails today at 1280: the summary wraps.)
3. **`wraps the status actions as one group at 768`** — viewport 768×1024: `[data-filter-actions]`'s `a` and `button` share one vertical centre (±1),
   and `|actions.right − stack.right| ≤ 1` whether or not the group wrapped.
4. **`anchors every filter menu under its trigger and checks "All" in the neutral state`** — at the default viewport, for each of
   `Filter by harness` / `Filter by origin` / `Filter by machine`: click the trigger, `const dialog = page.getByRole('dialog', { name: 'Harness' | 'Session origin' | 'Machine' })`,
   `expectAnchoredUnder`, `expect(dialog.getByRole('button', { name: /^All / })).toHaveAttribute('aria-pressed', 'true')`,
   `expect(dialog.getByRole('checkbox')).toHaveCount(N)` (4 / 3 / 2), `press('Escape')`, `expect(dialog).toHaveCount(0)`.
   Repeat for origin and machine at 390×844 (the mobile grid cells) — same helper, no code path differences.
5. **`narrows, tints, pills and resets harness from the menu`** — open harness, `dialog.getByText('Codex', { exact: true }).click()`;
   `expect(page.getByRole('button', { name: 'Harness: Codex ×' })).toBeVisible()`; trigger `toHaveAttribute('data-narrowed', 'true')` and `toContainText('Codex')`;
   All row `aria-pressed="false"`; click the All row → pill gone, trigger has no `data-narrowed`, URL has no `harness` param.
6. **`shows an origin narrowing as a removable pill`** — open origin, click `Human` then `Delegated`
   (two explicit inclusions = excluding automated review); `expect(page.getByRole('button', { name: 'Origin: excluding automated review ×' })).toBeVisible()`;
   origin trigger `data-narrowed="true"`; click the pill → trigger reads `Origin: all`.
7. **`renders long machine labels on one line without clipping`** — open machine; for every
   `[data-scope="checkbox"][data-part="label"]` inside the dialog: `getClientRects().length === 1` and `scrollWidth <= clientWidth + 1`
   (fails today: `Fixture Machine Secondary · Freshness unavailable` wraps inside the 180px `sameWidth` listbox).

**Verify**: `cd apps/web && bun run test:e2e -- e2e/filter-bar.spec.ts` → 7 passed.

### Step 7: Update the four specs that pinned the listbox mechanic

- `dashboard.spec.ts` line 457: after `await page.keyboard.press('/');` add
  `await expect(search).toBeFocused(); await expect(search).toHaveValue('');` (move the `search` declaration above the press).
- `dashboard-presentation.spec.ts` lines 442/444: `getByRole('button', { name: 'Filter by harness' })` / `getByRole('button', { name: 'Filter by machine' })`;
  line 489: drop `, [role="combobox"]:visible` from the selector (triggers are buttons now). All geometry expectations stay.
- `category-visibility.spec.ts` lines 28–44 and 80–97: `getByRole('button', …)` for the triggers; keep `aria-controls` (Ark's popover
  trigger sets it to the content id); replace `listbox.querySelectorAll('[role=option]')` + `[data-part=item-text]` with
  `content.querySelectorAll('[data-scope="checkbox"][data-part="label"]')` reading `textContent` (the All row is a button, so it is not counted — the
  category/option equality must still hold). Rename `listbox` variables to `content`.
- `machine-staleness.spec.ts` lines 15–24: `getByRole('button', { name: 'Filter by machine' })`; replace the option click with
  `await page.getByRole('dialog', { name: 'Machine' }).getByText('Fixture Machine · Stale', { exact: true }).click();` (scoped — the Activity legend
  also contains that text); the remaining assertions (`fixture-machine` in the URL, trigger text, `Stale` absent from the URL) stay.
- `origin-campaign.spec.ts` needs no change (`button` role, `Origin: all`, label texts) — run it to confirm.

**Verify**: `cd apps/web && bun run test:e2e -- e2e/dashboard.spec.ts e2e/dashboard-presentation.spec.ts e2e/category-visibility.spec.ts e2e/machine-staleness.spec.ts e2e/origin-campaign.spec.ts` → all pass.

### Step 8: Snapshots

`cd apps/web && bun run test:e2e -- e2e/visual-regression.spec.ts`. Expect `overview-desktop` and `overview-narrow`
to differ (trigger width 180→150, input basis, indicator). Regenerate with `--update-snapshots` and **inspect the PNG
diffs**: only the filter-bar row may change; the KPI/chart/metrics areas and the session drawer/skills PNGs must be pixel-identical.

**Verify**: `cd apps/web && bun run test:e2e -- e2e/visual-regression.spec.ts` → pass with the new PNGs.

### Step 9: Gates and the bundle number

`bun x ultracite fix && bun run check && bun run lint && bun run typecheck && bun run --cwd packages/design-system test && bun run --cwd apps/web test && bun run test:e2e`.
Then `cd apps/web && bun run build && bun run test:bundle`: the guard must pass (it only fails on growth). Read the measured
closure from the test output; if it dropped, lower `RECORDED_GZIP_CLOSURE_BYTES` (line 41) to the new measurement in this same commit — the
file's own contract is "the last measurement taken on main".

**Verify**: every command above exits 0; `grep -rn "@ark-ui/svelte/select\|@ark-ui/svelte/collection" apps packages --include=*.ts --include=*.svelte` → no matches.

## Test plan

- Unit (bun): `filter-shortcut.test.ts` (11 cases), `origin-filter.test.ts` (3), the three `checkbox-filter.ts`
  helper tests inside `compound-components.test.ts` (collapse-to-neutral, unknown-value preservation, counts).
- Design-system Chromium proof: keyboard open, anchoring (x-equality, below, ≥ trigger width), All row
  state, toggle → `data-selection`, Escape restores focus, long label single-line/unclipped.
- SSR: `aria-keyshortcuts="/"`, three `data-filter-trigger`s, `data-filter-actions`, no listbox.
- E2E `filter-bar.spec.ts`: the seven tests of Step 6 — each one fails on the current code for its
  finding (U07: no focus; U15: origin x offset / no All state; U39: wrapped centre at 1280; U40: two client rects).
- Existing e2e updated in Step 7; snapshots regenerated in Step 8.

## Done criteria

- [ ] `grep -rn "MultiSelect\|multi-select\|@ark-ui/svelte/select\|@ark-ui/svelte/collection" apps packages --include=*.svelte --include=*.ts | grep -v node_modules` → no matches
- [ ] `grep -c "<CheckboxFilter" apps/web/src/lib/features/report/breakdown/filter-bar.svelte` → `2`; `grep -c "<CheckboxFilter" apps/web/src/lib/features/report/breakdown/origin-filter.svelte` → `1`
- [ ] `grep -n "placement: 'bottom-start'" packages/design-system/src/svelte/compound/checkbox-filter.svelte` → 1 hit; `grep -n "sameWidth" packages/design-system/src/svelte/compound/checkbox-filter.svelte` → none
- [ ] `grep -n "aria-keyshortcuts=\"/\"\|<svelte:window\|data-filter-actions" apps/web/src/lib/features/report/breakdown/filter-bar.svelte` → 3 hits; `grep -rn "inputRef" apps/web/src` → none
- [ ] `grep -n "export const actions" apps/web/src/lib/features/report/breakdown/styles.ts` → 1 hit; `grep -n "sm: '1 1 180px'" apps/web/src/lib/features/report/breakdown/styles.ts` → 1 hit
- [ ] `grep -n "clearOrigin" apps/web/src/lib/features/report/breakdown/active-filters.svelte` → 1 hit
- [ ] `grep -n "toBeFocused" apps/web/e2e/dashboard.spec.ts` → ≥ 1 hit; `grep -n "combobox" apps/web/e2e/category-visibility.spec.ts apps/web/e2e/machine-staleness.spec.ts apps/web/e2e/dashboard-presentation.spec.ts` → none
- [ ] `apps/web/e2e/filter-bar.spec.ts` exists with 7 tests and passes
- [ ] `bun run typecheck`, `bun run lint`, `bun run --cwd packages/design-system test`, `bun run --cwd apps/web test`, `bun run test:e2e` exit 0
- [ ] `cd apps/web && bun run build && bun run test:bundle` exits 0 (closure did not grow)
- [ ] Regenerated PNGs differ only in the filter-bar row
- [ ] The program brief's PII grep (maintainer first name, real home path, real hostname, mail alias) over this plan file and over every file you touched returns nothing
- [ ] No files outside the in-scope list are modified (`git status`); `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The "Current state" excerpts do not match the working tree (another 086 sub-plan may have touched
  `filter-bar.svelte`, `styles.ts`, or the e2e specs first).
- Ark's `Popover.Trigger` does not expose `aria-controls`, or `Popover.Content` is not `role="dialog"`
  named by `Popover.Title` — the `category-visibility` rewrite and the `getByRole('dialog', …)` locators
  depend on it; report the rendered attributes instead of falling back to CSS-only selectors.
- The positioner does not carry `--reference-width` at runtime (menu narrower than its trigger in the
  Chromium proof) — report; do not hardcode trigger widths into the content.
- `dashboard-presentation.spec.ts`'s mobile grid expectations fail after Step 3 (the `actions` group is
  meant to be a transparent grid child at base; if the two-column stack moved, report the measured boxes
  rather than tuning widths).
- Any spec other than the four named in Step 7 pins `combobox`/`option` roles for these filters.
- The bundle closure **grows** — it should shrink; growth means Ark `Select` is still in the first-load
  closure or popover code was duplicated.
- `google-chrome` is not on `PATH` for the design-system proof — run everything else and say so.

## Maintenance notes

- The sessions "Advanced columns" chooser (`session-table.svelte:407–431`) and `app-navigation.svelte`
  still use the design-system `Popover` wrapper with Zag's centred default; if a second consumer wants
  `bottom-start`, add an optional `positioning` prop to the wrapper rather than forking it.
- If `defaultDashboardOrigins` ever becomes non-empty again (plan 049 context), re-add a "Default"
  action to `CheckboxFilter` behind a `defaultValue` prop — the All row only encodes neutral = `[]`.
- The freshness item and the source-control summary share the accessible name "Collection source
  status"; renaming the freshness one (e.g. "Machine freshness status") is a one-liner best done with
  the 095/097 status copy work.
- Arrow-key roving between menu rows is deferred (Tab/Shift+Tab, Space, Escape work via Ark); the
  trigger's accessible name is still its `aria-label` only — appending the summary text is a follow-up.
- Reviewer should scrutinise: the collapse-to-`[]` rule in `toggleCheckboxFilterOption` (it is what
  keeps machine-less and undeclared-origin rows visible after an "explicitly all" selection), the
  `/` handler's target rule (BUTTON targets must pass, form controls must not), the anchoring helper's
  two branches, and that the regenerated PNGs changed only in the filter-bar row.
