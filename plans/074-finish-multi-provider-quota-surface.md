# Plan 074: Finish the Multi-Provider Quota History Surface

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 5e4cf954..HEAD -- apps/web/src/lib/features/report/actions/quota-history-panel.svelte apps/web/src/lib/features/report/overview/provider-status.svelte apps/web/src/provider-status-model.ts apps/web/src/provider-quota-e2e-fixture.ts apps/web/src/lib/features/report/composition/live-report-destination.svelte apps/web/e2e/dashboard.spec.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition. Note: `live-report-destination.svelte`
> already has uncommitted local edits on this branch — the excerpts below were
> taken from the working tree, not from the commit.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: direction
- **Planned at**: commit `5e4cf954`, 2026-08-20

## Why this matters

The quota pipeline (storage, engine refresh, RPC, read query, series grouping)
is fully provider-neutral and collects both Codex and experimental Claude
usage-limit observations. But the history drawer is still titled "Codex quota
history", its only entry point says "View Codex history", the e2e fixture has
never contained a second provider, and the availability gate written for the
history button (`providerHistoryAvailable`) is exported, unit-tested, and
never called from production code. A Claude-primary user opens a drawer whose
accessible name claims it is Codex-only and sees Claude series inside it; a
user with no stored observation gets a button that leads to an empty drawer.
This plan spends the last few hours needed to collect an investment that is
already paid for.

## Current state

- `apps/web/src/lib/features/report/actions/quota-history-panel.svelte` — the
  history drawer. Codex-specific strings:
  - line 124: `contentAriaLabel="Codex quota history"`
  - line 139: `<h2 class={title}>Codex quota history</h2>`
  - line 143: `aria-label="Close Codex quota history"`
  - The body is already provider-neutral: line 78 derives the provider
    `<select>` options from the returned series
    (`const providers = $derived([...new Set(model?.series.map(({ providerKey }) => providerKey) ?? [])]);`)
    and lines 84–91 filter `visibleSeries` by the selected provider.
- `apps/web/src/lib/features/report/overview/provider-status.svelte` — the
  only entry point:
  - line 209: `let { onOpenHistory, providers }: { onOpenHistory?: () => void; ... } = $props();`
  - lines 330–331: `{#if onOpenHistory}` →
    `<button class={historyButton} onclick={onOpenHistory} type="button">View Codex history</button>`
  - The button already hides when `onOpenHistory` is undefined — that is the
    seam the availability gate plugs into.
- `apps/web/src/provider-status-model.ts` — shared model:
  - lines 40–41: `export const providerHistoryAvailable = (fixturePointCount: number | undefined, sourceAvailable: boolean): boolean => fixturePointCount === undefined ? sourceAvailable : fixturePointCount > 0;`
  - This function has **zero production callers** (verify:
    `grep -rn "providerHistoryAvailable" apps/web/src --include="*.ts" --include="*.svelte" | grep -v test`
    returns only the definition). Its unit tests live in
    `apps/web/src/provider-status-model.test.ts`.
  - `ProviderStatusView` (lines 28–38) exposes `provider: ProviderStatus`
    whose `source` is `'live-api' | 'local-history' | 'manual' | 'unsupported'`
    (see `sourceLabelFor`, lines 161–174).
- `apps/web/src/lib/features/report/composition/live-report-destination.svelte`:
  - line 321–322: `const providers = $derived(buildProviderStatusViews(bootstrap.support, bootstrap.providerRows, bootstrap.support.generatedAt))`
  - line 659: `onOpenQuotaHistory: () => (quotaHistoryOpen = true),` — passed
    unconditionally inside the `overview` props object.
- `apps/web/src/lib/features/report/composition/synthetic-report-destination.svelte`:
  - line 543: `...(mode === 'e2e' ? { onOpenQuotaHistory: () => (quotaHistoryOpen = true) } : {}),`
  — the prop is optional, so conditionally omitting it in the live path is
  type-safe.
- `apps/web/src/provider-quota-e2e-fixture.ts` — the deterministic history
  fixture served in e2e mode. Every point is built by `fixtureQuotaPoint`
  which hardcodes `providerKey: 'codex'`, `providerLabel: 'Codex'`,
  `windowId: \`codex:${input.window}\`` (lines 17–22). Six points total, all
  Codex.
- `apps/web/e2e/dashboard.spec.ts` — pinned accessible names:
  - line 417: `test('Codex quota history shows reset and gap-aware ranges on desktop and mobile', ...)`
  - line 420: `page.getByRole('button', { name: 'View Codex history' })`
  - lines 423–424, 436, 438: `page.getByRole('dialog', { name: 'Codex quota history' })` and the matching heading.
- Vocabulary (from `CONTEXT.md`): **Provider** = "the billing or subscription
  route inferred for a usage row, such as Claude API, Claude sub, Codex API,
  Codex sub". **Quota snapshot** = a durable local usage-limit observation.
  Use "Provider quota history" as the neutral title.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install | `bun install` | exit 0 |
| Typecheck | `bun run typecheck` | exit 0 |
| Format/lint | `bun x ultracite fix` then `bun run check` | exit 0 |
| Web unit tests | `bun run --cwd apps/web test` | all pass |
| One e2e spec | `cd apps/web && bun run test:e2e -- e2e/dashboard.spec.ts` | all pass |
| Full e2e | `bun run test:e2e` | all pass |

On NixOS, if Playwright's downloaded chromium fails to launch, set
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to the system Chrome binary before
running e2e (this is the documented local workaround; `--channel chrome`
does not work here).

## Scope

**In scope** (the only files you should modify):
- `apps/web/src/lib/features/report/actions/quota-history-panel.svelte`
- `apps/web/src/lib/features/report/overview/provider-status.svelte`
- `apps/web/src/lib/features/report/composition/live-report-destination.svelte`
- `apps/web/src/lib/features/report/composition/synthetic-report-destination.svelte`
- `apps/web/src/provider-quota-e2e-fixture.ts`
- `apps/web/src/provider-quota-history-model.test.ts`
- `apps/web/e2e/dashboard.spec.ts`
- `apps/web/e2e/visual-regression.spec.ts-snapshots/` (regenerated snapshots only, if the button rename lands inside a captured viewport)

**Out of scope** (do NOT touch):
- `packages/report-core/src/provider-quota.ts` and every engine/store/RPC
  layer — the data path is already provider-neutral; no schema change.
- `apps/web/src/lib/features/report/actions/quota-history-owner.svelte` — its
  deliberately unfiltered request (naming one provider there would leave the
  selector permanently single-option) is correct; keep it.
- `apps/cli/**` — CLI quota rendering is a separate plan (081).
- The quota rail in `apps/web/src/lib/features/shell/` — separate plan (080).

## Git workflow

- Branch from the repo's current working branch (coordinate with the owner —
  `refactor/report-decision-first-ui-ux` has uncommitted work; do not commit
  files you did not change).
- Commit style (from `git log`): `fix(web): pluralize heatmap session labels` —
  use `fix(web): name provider quota history neutrally` or similar.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Rename the four Codex-specific strings

In `quota-history-panel.svelte`: change line 124 to
`contentAriaLabel="Provider quota history"`, line 139's heading text to
`Provider quota history`, line 143 to
`aria-label="Close provider quota history"`.
In `provider-status.svelte` line 331: change the button text to
`View quota history`.

**Verify**: `grep -rn "Codex quota history\|View Codex history" apps/web/src` → no matches.

### Step 2: Update the pinned e2e names

In `apps/web/e2e/dashboard.spec.ts` lines 417–438: rename the test to
`'Provider quota history shows reset and gap-aware ranges on desktop and mobile'`,
and update every `getByRole('button', { name: 'View Codex history' })` /
`getByRole('dialog', { name: 'Codex quota history' })` /
`getByRole('heading', { name: 'Codex quota history' })` to the new names from
Step 1.

**Verify**: `grep -n "Codex history" apps/web/e2e/dashboard.spec.ts` → no matches.

### Step 3: Add a Claude series to the e2e fixture

In `provider-quota-e2e-fixture.ts`, extend `fixtureQuotaPoint` so the caller
can pass `providerKey`/`providerLabel` (default `'codex'`/`'Codex'` to keep the
existing six points byte-identical), then append 2–3 points with
`providerKey: 'claude'`, `providerLabel: 'Claude'`,
`windowId: 'claude:<window>'`, its own `resetAt` values, and
`source: { confidence: 'authoritative', key: 'claude-agent-sdk', mode: 'poll' }`.
Keep timestamps inside the existing 2026-07-15 09:00–10:40 window so the
range presets still cover them.

**Verify**: `bun run --cwd apps/web test` → passes (fixture is type-checked by consumers).

### Step 4: Assert two-provider behavior

- In `apps/web/src/provider-quota-history-model.test.ts`, add one case feeding
  points with two distinct `providerKey` values through
  `buildProviderQuotaHistoryModel` and asserting the model yields series for
  both keys.
- In `dashboard.spec.ts`'s quota-history test, after opening the drawer,
  assert the Provider `<select>` (label "Provider") offers `codex` and
  `claude` options, select `codex`, and assert a Claude-only element is no
  longer visible (pick a stable anchor from the fixture, e.g. a series label
  containing `Claude`).

**Verify**: `bun run --cwd apps/web test` → all pass, including the new model case.

### Step 5: Wire the availability gate

- In `live-report-destination.svelte` line 659: pass `onOpenQuotaHistory` only
  when history can exist. Import `providerHistoryAvailable` from
  `../../../../provider-status-model` and compute
  `const quotaHistoryAvailable = $derived(providerHistoryAvailable(undefined, providers.some((view) => view.provider.source === 'live-api' || view.provider.source === 'local-history')));`
  then spread the prop conditionally, matching the synthetic pattern:
  `...(quotaHistoryAvailable ? { onOpenQuotaHistory: () => (quotaHistoryOpen = true) } : {})`.
- In `synthetic-report-destination.svelte` line 543: replace the bare
  `mode === 'e2e'` gate with
  `mode === 'e2e' && providerHistoryAvailable(fixture.points.length, true)`
  where `fixture` is the already-imported e2e quota fixture result (create it
  once via `createE2EProviderQuotaHistoryFixture()` if not already in scope;
  check imports at the top of the file first). Behavior in e2e mode is
  unchanged because the fixture has points.

**Verify**: `grep -rn "providerHistoryAvailable" apps/web/src --include="*.svelte"` → two call sites; `bun run typecheck` → exit 0.

### Step 6: Run gates and refresh snapshots if needed

Run `bun x ultracite fix`, `bun run typecheck`, `bun run --cwd apps/web test`,
then `cd apps/web && bun run test:e2e -- e2e/dashboard.spec.ts`. If
`visual-regression.spec.ts` fails because the renamed button is inside a
captured viewport, regenerate with
`bun run test:e2e -- e2e/visual-regression.spec.ts --update-snapshots`, then
visually inspect the changed PNGs (the only diff must be the button text).

**Verify**: `bun run test:e2e` → all pass.

## Test plan

- New model test: two-provider grouping in
  `provider-quota-history-model.test.ts` (pattern: the existing cases in that
  file).
- Extended e2e: provider selector offers both providers; filtering to one
  hides the other's series; renamed accessible names asserted (they already
  are, via the updated selectors).
- Existing `provider-status-model.test.ts` cases for
  `providerHistoryAvailable` keep passing untouched.

## Done criteria

- [ ] `grep -rn "Codex quota history\|View Codex history" apps/web` → no matches (snapshots excluded)
- [ ] `grep -rn "providerHistoryAvailable" apps/web/src --include="*.svelte" | wc -l` ≥ 2 (wired, not dead)
- [ ] `provider-quota-e2e-fixture.ts` contains `providerKey: 'claude'`
- [ ] `bun run typecheck` exits 0
- [ ] `bun run --cwd apps/web test` exits 0 with the new two-provider case
- [ ] `cd apps/web && bun run test:e2e -- e2e/dashboard.spec.ts` exits 0
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The excerpts above don't match the working tree (this branch has active
  uncommitted work on `live-report-destination.svelte`; if that file has
  gained conflicting quota logic, report instead of merging by guesswork).
- Adding the Claude fixture series makes `buildProviderQuotaHistoryModel`
  merge or mislabel series (that is a real grouping bug this plan exists to
  surface — report it with the failing output; do not patch the model here).
- Gating `onOpenQuotaHistory` hides the button in normal live operation on a
  machine with stored observations (would mean the `source` heuristic in
  Step 5 is wrong — report the observed `ProviderStatusView.provider.source`
  values).

## Maintenance notes

- When a third quota provider lands, only the fixture and e2e assertions need
  extending; every production string is now provider-neutral.
- Reviewer should scrutinize: the Step 5 availability heuristic (`live-api`
  or `local-history` sources ⇒ history plausible) and the updated snapshot
  PNGs.
- Deferred: CLI quota history (plan 081), quota rail presentation in the
  768–1279px band (plan 080).
