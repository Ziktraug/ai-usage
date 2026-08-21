# Plan 081: Add `quota --history` to the CLI

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 5e4cf954..HEAD -- apps/cli/src/quota.ts apps/cli/src/cli.ts apps/cli/src/app.ts packages/report-data/src/provider-quota-history.ts packages/report-core/src/provider-quota.ts`
> On any mismatch with the "Current state" excerpts, STOP.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: direction
- **Planned at**: commit `5e4cf954`, 2026-08-20

## Why this matters

"Am I about to hit my weekly limit, and how fast am I burning it?" is
answerable today only by opening the web dashboard — in a tool whose primary
daily surface is the terminal. The CLI's `quota` renders only the newest
durable observation per provider; the web has 24h/7d/30d ranges with
gap-aware segmentation. The query and the segmentation are both already in
shared packages; this plan adds a read-only `--history` mode to the CLI that
reuses them, so the terminal answer matches the web's semantics exactly.

## Current state

- `apps/cli/src/quota.ts` — `renderQuota(providers: readonly ProviderStatus[])`:
  20-char block bars per window, explicit loop over **every** stored
  provider (lines 16–18 comment: "the command is 'show my quota', and
  answering with only the first stored provider hides the rest"), footer
  "Percentages are consumed usage, from the newest durable observation".
  Color helpers `clr.*` from `./render/colors`, `fmtDate`/`pad` from
  `./render/format`.
- `apps/cli/src/cli.ts` lines 212–229 — `parseQuotaArgs` accepts only
  `--color`/`--no-color`; anything else fails with
  `Unknown option for quota: <arg>`. Help text at lines 126–127 lists
  `quota   subscription quota per provider (Claude, Codex)`.
- `apps/cli/src/app.ts` lines 199–235 — the quota command: wide-event
  boundary `cli.quota`, issues engine command `collect-fresh-quota` over
  `providerUsageSourceIds`, then reads and renders the durable statuses
  (`dbPath: runtime.paths.databasePath` is the read-only database path used
  at lines 251/276/319).
- `packages/report-data/src/provider-quota-history.ts` lines 63–110 —
  `queryProviderQuotaHistory({ dbPath, from, to, machineId?, maximumPoints?, providerKey?, now? })`
  → Effect of `ProviderQuotaHistoryResult` with `points` (flattened per
  window), downsampling, `coverage`, `latest`. This is the exact query the
  web server uses (`apps/web/src/server/provider-quota.server.ts:6,19`).
- `packages/report-core/src/provider-quota.ts` line 629 —
  `segmentProviderQuotaHistoryPoints(points, gapMs)` → segments split on
  gaps/breaks; the web model calls it with `PROVIDER_QUOTA_LIVE_GAP_MS`
  (`apps/web/src/provider-quota-history-model.ts:70`) — reuse the same
  constant if exported from report-core; if it lives only in the web app,
  define the CLI's gap from the same value and note the duplication.
- Boundary rule (`docs/future-work.md` "Report Data Architecture"): "Keep
  quota refresh on the usage-engine command seam and quota reads/rendering
  on the read-only durable-observation seam." `--history` therefore does
  **not** trigger `collect-fresh-quota` — it is a pure read.
- CLI wide events: every CLI command runs inside an Effect boundary with an
  outcome classifier (`app.ts:199`, `classifyCliQuotaOutcome`). The history
  read should run inside the existing `cli.quota` boundary (same command,
  new mode), not a new boundary.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `bun run typecheck` | exit 0 |
| Format/lint | `bun x ultracite fix` then `bun run check` | exit 0 |
| CLI tests | `bun test apps/cli` | all pass |
| Manual smoke | `bun run cli -- quota --history 7d` | renders or explains absence |

## Scope

**In scope**:
- `apps/cli/src/quota.ts` (add the history renderer; keep `renderQuota`)
- `apps/cli/src/cli.ts` (`parseQuotaArgs`, help text)
- `apps/cli/src/app.ts` (quota command: branch on history mode)
- CLI test files covering quota parsing/rendering (find:
  `grep -rln "parseQuotaArgs\|renderQuota" apps/cli --include="*.test.ts"`)

**Out of scope** (do NOT touch):
- `packages/report-data`, `packages/report-core` — the query and
  segmentation are consumed, not modified (exception: exporting an existing
  gap constant from report-core is allowed if it is currently web-local).
- The engine and its refresh cadence.
- The web history drawer.

## Git workflow

- Commit style: `feat(cli): render provider quota history`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Parse the flag

Extend `parseQuotaArgs` to return
`{ color: boolean | null; history: '24h' | '7d' | '30d' | null }`:
`--history` takes an optional value (default `'7d'` when the next token is
absent or another flag); invalid values fail with
`Unknown quota history range: <value> (expected 24h, 7d, or 30d)`. Update
both help texts in `cli.ts` (short list line 126–127 area and the detailed
help) with `quota --history [24h|7d|30d]`.

Add parser tests: bare `--history` → `7d`; each explicit value; invalid
value fails; `--history --color` treats `--color` as the next flag.

**Verify**: `bun test apps/cli` → parser tests pass.

### Step 2: Read-only history query in the command

In `app.ts`, inside the existing `cli.quota` boundary: when
`history !== null`, **skip** the `collect-fresh-quota` engine command and
instead call `queryProviderQuotaHistory` from
`@ai-usage/report-data/provider-quota-history` with
`dbPath: runtime.paths.databasePath`, `to = now`, `from = now - range`,
default `maximumPoints`. Render with the new `renderQuotaHistory` (Step 3).
When the result has zero points, print
`No stored provider quota history in the last <range>.` and exit 0.
Check how the CLI resolves `runtime` for read-only commands (`--stored`
path) — the history mode must work without starting an engine, exactly like
`--stored` reads; if the quota command's runtime acquisition always spawns
a foreground engine, follow the `--stored` acquisition used at
`app.ts:400` instead.

**Verify**: `bun run cli -- quota --history 7d` on this machine → renders history or the explicit absence message; no engine collection is triggered (no `collect-fresh-quota` in the output/logs).

### Step 3: Terminal rendering

In `quota.ts`, add:

```ts
export const renderQuotaHistory = (result: ProviderQuotaHistoryResult, range: '24h' | '7d' | '30d'): string
```

Layout, per provider (group points by `providerKey` + `windowId`, ordered
by provider label then window label — mirror the grouping in
`apps/web/src/provider-quota-history-model.ts`):

```
═══ Claude subscription quota — last 7d ═══
  5h      ▂▄▆▇▅▃▁▂▄▆  22% → 68%   resets 14:00
  Weekly  ▅▅▆▆▆▇▇▇▇▇  61% → 63%   resets Mon 00:00
```

- Sparkline: 10–30 block glyphs (`▁▂▃▄▅▆▇█`) from the segment points'
  `usedPercent`, gap-aware: run
  `segmentProviderQuotaHistoryPoints(points, gapMs)` and render a space
  between segments plus a dim `·gap·` marker when more than one segment
  exists. Reuse `quotaColor` for the start→end percentages.
- `start% → end%` from the first and last points of the range; `resets`
  from the newest point's `resetAt` via `fmtDate`.
- Footer: `Read from stored observations only. Run 'ai-usage quota' for a fresh reading.`
- Respect `--no-color` exactly as `renderQuota` does (the `clr` helpers
  already no-op without color; verify by reading `./render/colors`).

Add renderer tests with a fixed fixture (two providers × two windows, one
gap): assert grouping order, the gap marker, the start→end numbers, and the
zero-point message. Model after the existing `renderQuota` tests.

**Verify**: `bun test apps/cli` → all pass including the new renderer cases.

### Step 4: Gates

**Verify**: `bun x ultracite fix && bun run check && bun run typecheck && bun run test` → all pass.

## Test plan

Covered in Steps 1 and 3. Plus one integration-shaped case if the CLI has a
stateful command test harness (plan 010 built one — find it via
`grep -rln "quota" apps/cli --include="*.test.ts"` and follow its pattern)
asserting `quota --history` never issues an engine command.

## Done criteria

- [ ] `bun run cli -- quota --history` works on a store with observations and without
- [ ] `grep -n "renderQuotaHistory" apps/cli/src/quota.ts` → exported
- [ ] History mode issues no `collect-fresh-quota` (assert in test or by boundary event inspection)
- [ ] `bun run typecheck` and `bun run test` exit 0
- [ ] `plans/README.md` status row updated

## STOP conditions

- The quota command's runtime acquisition cannot run without starting an
  engine and the `--stored`-style read path cannot be reused — report the
  actual acquisition seam.
- `queryProviderQuotaHistory` requires web-only context (it should not — the
  web server calls it with just dbPath+range).
- The gap constant (`PROVIDER_QUOTA_LIVE_GAP_MS`) is web-local and moving it
  to report-core violates `docs/public-package-interfaces.md` — report and
  duplicate the literal with a comment instead.

## Maintenance notes

- The renderer intentionally shows trend + endpoints, not a full chart; if
  users want per-day resolution, that is the web drawer's job — resist
  growing the terminal chart.
- Reviewer should scrutinize: the read-only guarantee (no engine command in
  history mode) and grouping parity with the web model.
- Deferred: `--machine` filtering (the query supports `machineId`; add the
  flag only when a real multi-machine terminal need appears).
