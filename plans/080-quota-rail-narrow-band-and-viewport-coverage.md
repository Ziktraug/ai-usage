# Plan 080: Restore Glanceable Quota in the 768–1279px Band and Cover the Missing Viewports

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 5e4cf954..HEAD -- apps/web/src/lib/features/shell/provider-quota-rail.svelte apps/web/src/lib/features/shell/app-navigation.svelte apps/web/src/lib/features/shell/app-shell.svelte apps/web/e2e/dashboard-presentation.spec.ts apps/web/e2e/visual-regression.spec.ts`
> On any mismatch with the "Current state" excerpts, STOP.

## Status

- **Priority**: P2
- **Effort**: S (Part 1) + M (Part 2)
- **Risk**: MED (Part 2 touches a fixed-width shell element)
- **Depends on**: none
- **Category**: direction
- **Planned at**: commit `5e4cf954`, 2026-08-20

## Why this matters

The Panda breakpoints are the preset defaults (`md` = 768px, `xl` = 1280px),
so the 768–1279px window band — a real daily working viewport on the
maintainer's monitor setup, alongside a 1080×1920 portrait display — is
exactly "md-and-not-xl". In that band the quota rail collapses to four bare
rings: no "Quota used" heading, no provider name, and **no percentage** —
the product's most glanceable number is reachable only via hover/flyout.
Meanwhile no visual snapshot covers the band or any portrait-tall viewport,
so layout drift there ships unnoticed. Part 1 turns "unknown" into "known"
(snapshot coverage — costs nothing); Part 2 restores the percentage at `md`
without widening the rail.

## Current state

- `apps/web/panda.config.ts:16` — presets `['@pandacss/preset-panda', aiUsagePreset]`,
  no `breakpoints` override ⇒ `md` 768px, `lg` 1024px, `xl` 1280px.
- `apps/web/src/lib/features/shell/provider-quota-rail.svelte`:
  - `groupLabel` (line 34), `providerName` (line 52), `providerValue`
    (line 63): all `display: { md: 'none', xl: 'block' }`.
  - `providerRow` (lines 43–50): `display: 'flex'`, `justifyContent: { md: 'center', xl: 'flex-start' }`,
    `minH: '30px'`, `px: { md: 0, xl: '10px' }`.
  - Render (lines 253–269): `triggerBody` renders the group label, then per
    entry: `providerRing(entry, 26)`, `providerName`, `providerValue` with
    `headline(entry)` (`fmtPct(entry.usedPercent)` or `—`, line 211–212).
  - The flyout (lines 11–19, 88+) opens on hover or click and remains the
    detail surface — unchanged by this plan.
- `apps/web/src/lib/features/shell/app-navigation.svelte` lines 48–56: the
  rail `<aside>` is `display: { base: 'none', md: 'flex' }`,
  `w: { md: '56px', xl: '216px' }`.
- `apps/web/src/lib/features/shell/app-shell.svelte` lines 33–37: the
  content offset mirrors those widths —
  `ml: { base: 0, md: '56px', xl: '216px' }` with a comment saying it must
  stay in lockstep. **This plan does not change any width.**
- `apps/web/e2e/dashboard-presentation.spec.ts` lines 28–33:
  `FIRST_READ_SCENARIOS` = 1440×900-light, 1280×900-light, 390×844-light,
  390×844-dark. Nothing between 390 and 1280 wide; nothing portrait-tall.
- `apps/web/e2e/visual-regression.spec.ts` lines 6–8: `DESKTOP_VIEWPORT`
  1280×900, `OVERVIEW_DESKTOP_VIEWPORT` 1440×1000, `NARROW_VIEWPORT`
  390×844. The repo rule (plans/README.md "Presentation gate") allows
  **exactly four** visual-regression snapshots — do not add snapshots to
  *this* spec; new viewport coverage goes into `dashboard-presentation.spec.ts`,
  which asserts computed geometry/DOM rather than PNGs where possible.
- ADR to honor: `docs/adr/0005-compact-accessible-visualizations.md`
  (compact, accessible viz) — read it before Part 2.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `bun run typecheck` | exit 0 |
| Format/lint | `bun x ultracite fix` then `bun run check` | exit 0 |
| Presentation spec | `cd apps/web && bun run test:e2e -- e2e/dashboard-presentation.spec.ts` | all pass |
| Full e2e | `bun run test:e2e` | all pass |

On NixOS set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to the system Chrome
binary if the bundled chromium fails to launch.

## Scope

**In scope**:
- `apps/web/e2e/dashboard-presentation.spec.ts`
- `apps/web/src/lib/features/shell/provider-quota-rail.svelte`
- Shell component tests covering the rail (find:
  `grep -rln "provider-quota-rail\|data-provider-quota" apps/web/src --include="*.test.ts"`)

**Out of scope** (do NOT touch):
- Rail/content widths (`app-navigation.svelte`, `app-shell.svelte`) — the
  56px/216px lockstep is a deliberate contract; no `lg` tier in this plan.
- `apps/web/e2e/visual-regression.spec.ts` — the four-snapshot budget is a
  standing decision.
- `panda.config.ts` breakpoints — changing global breakpoints moves every
  responsive rule in the app.
- The flyout content and behavior.

## Git workflow

- Two commits: `test(web): cover the md band and portrait viewports`, then
  `fix(shell): show quota percentages in the compact rail`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1 (Part 1): Add the two missing viewport scenarios

In `dashboard-presentation.spec.ts`, extend `FIRST_READ_SCENARIOS` with:

```ts
{ colorScheme: 'light', name: '1080x900-light', viewport: { height: 900, width: 1080 } },
{ colorScheme: 'light', name: '1080x1920-light', viewport: { height: 1920, width: 1080 } },
```

Run the spec once to see which existing assertions the new scenarios
violate. Expected outcome: assertions about the executive metrics and
above-the-fold content pass as-is; if one fails, that is a *real finding* —
record it in the plan's README row note and adjust only genuinely
viewport-conditional assertions (mirror how the spec already branches
between desktop and `MOBILE_VIEWPORT`).

**Verify**: `cd apps/web && bun run test:e2e -- e2e/dashboard-presentation.spec.ts` → all pass on all six scenarios.

### Step 2 (Part 2): Show the percentage under each ring at `md`

In `provider-quota-rail.svelte`:

- Change `providerRow` to stack at `md` and stay horizontal at `xl`:
  `flexDirection: { md: 'column', xl: 'row' }`, keep
  `justifyContent: { md: 'center', xl: 'flex-start' }`, and add a small
  `gap` override for `md` (e.g. `gap: { md: '2px', xl: '9px' }`).
- Add a compact value class shown only in the band:

  ```ts
  const providerValueCompact = css({
    display: { md: 'block', xl: 'none' },
    color: 'ink',
    fontSize: '9px',
    fontWeight: 700,
    fontVariantNumeric: 'tabular-nums',
    textAlign: 'center',
  });
  ```

- In `triggerBody`, render after the ring:
  `<span class={cx(providerValueCompact, entry.stale ? providerValueStale : undefined)}>{headline(entry)}</span>`
  — reuse `headline`, so `—` renders for unmeasured entries exactly as at
  `xl`. Keep `aria-hidden="true"` semantics of the surrounding row (the
  accessible summary lives on the trigger; check how the current row hides
  itself from AT and match it).
- Do **not** show `groupLabel` or `providerName` at `md` — the 56px column
  cannot fit them; the ring mark + percentage is the glanceable unit, and
  the flyout stays the labeled detail.

**Verify**: `bun run typecheck` → exit 0; rail component tests pass.

### Step 3: Assert the band behavior

In `dashboard-presentation.spec.ts`, in the `1080x900-light` scenario, add:
the rail is visible, and for each `[data-provider-quota]` entry the compact
value element is visible with non-empty text (percentage or `—`). In the
1280+ scenarios assert the compact value is hidden (xl layout unchanged).

**Verify**: `cd apps/web && bun run test:e2e -- e2e/dashboard-presentation.spec.ts` → all pass.

### Step 4: Gates

**Verify**: `bun x ultracite fix && bun run check && bun run typecheck && bun run test:e2e` → all pass. If `visual-regression.spec.ts` snapshots differ (1280 viewport is `xl`, so they should not), treat a diff as a STOP — it means the `xl` layout changed.

## Test plan

- Presentation spec: six scenarios green; band scenario asserts compact
  percentages; ≥1280 scenarios assert they are absent.
- Rail component test: compact value renders `—` for a null percentage and
  the stale tone class when `entry.stale`.
- Accessibility: run the axe spec (`apps/web/e2e/accessibility.spec.ts`) —
  the new text is inside the existing `aria-hidden` trigger body, so the
  accessible tree must be unchanged; if axe flags it, STOP.

## Done criteria

- [ ] `dashboard-presentation.spec.ts` runs six scenarios including 1080×900 and 1080×1920
- [ ] `grep -n "providerValueCompact" apps/web/src/lib/features/shell/provider-quota-rail.svelte` → present and rendered
- [ ] `bun run test:e2e` exits 0 with unchanged visual-regression snapshots
- [ ] `apps/web/src/lib/features/shell/app-shell.svelte` and `app-navigation.svelte` unmodified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

- The 26px ring + 9px percentage does not fit the 56px column without
  overflow (check `overflow` clipping in the rendered band scenario) —
  report with a screenshot path rather than shrinking the ring below 26px.
- Any ≥1280px snapshot or geometry assertion changes — the `xl` layout is
  out of scope.
- The portrait scenario (1080×1920) surfaces a layout defect unrelated to
  the rail — record it as a finding in the README row note; do not fix it
  in this plan.

## Maintenance notes

- If a `lg` rail tier (wider column restoring names at ~1024px) is wanted
  later, it must change `app-navigation.svelte` widths and
  `app-shell.svelte` margins in lockstep — that is the deliberate reason it
  was kept out of this plan.
- Reviewer should scrutinize: the `aria-hidden` handling of the compact
  value and that the four-snapshot visual budget was not touched.
