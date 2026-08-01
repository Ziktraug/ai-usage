# Plan 045: Valorize the report dimensions and make the work unit honest

> **Status: DONE** — implemented and verified on 2026-07-26. Product framing,
> ten design decisions (*Decisions locked*) and
> the user-facing strings (*Copy*) were all settled with the maintainer on
> 2026-07-26. **Nothing in this plan is open.** Wave 0 and Wave 3b are
> measurement-only and produce no production diff.
>
> **Baseline**: commit `96b3dff`, **re-verified against `3406147`** (PR #21,
> "Harden second-pass runtime and storage boundaries") on 2026-07-26. That merge
> touches none of this plan's report, dimension, collector, or provenance files;
> all seven load-bearing code anchors were re-checked line by line and hold. Its
> one contact point is `/sync`'s confirmation protocol, noted in Wave 6.
>
> UI measurements were taken against the dev server
> on `:3000` on 2026-07-26 (headless Chrome, 1440x1000 and 390x844, both themes,
> keyboard sweep, DOM and computed-style instrumentation), then traced to source.
> Codex figures come from scanning `~/.codex/sessions` and `~/.codex/state_5.sqlite`.
> Report values drift as the report republishes every 60s; ratios are what matter.
>
> **Related**: plan 046 owns the presentational defect backlog. Plan 047 owns
> grouping as portable user data and is a hard dependency for renaming.

## Outcome

The report reads as an overview of **where the work went**. Switching between its
three principal views is an act of navigation rather than a small control lost
among actions. The dimensions worth reading carry structural weight instead of
being flattened into a prompt string, and work that cannot be priced is visible as
unmeasured rather than as zero.

## Product framing locked by this plan

ai-usage is a **dataviz app giving an overall view of usage**. "Estimated
API-equivalent value" is **a proxy for quantity of work, chosen for human
legibility**: raw token counts were the first candidate, but consumption varies too
much between models and harnesses, and cached/input/output tokens price
differently, so one dollar unit reads more clearly as a comparable measure.

Four rules bind every wave:

1. **Dollars are a unit, not a claim.** No ROI, break-even, projection, or budget
   features. Do not amplify a "value demonstration" reading.
2. **Token volume without a model price is a measurement hole, not zero work.**
3. **The valuable work is deciding which dimensions to valorize** — not inventing
   an identity format.
4. **Do not promote a dimension whose reliability is unmeasured.** Git awareness is
   days old and unproven cross-harness (Wave 0).

## Decisions locked

Settled with the maintainer on 2026-07-26. An executor must not relitigate these.

| # | Decision |
| --- | --- |
| 1 | A top-level row is **always a campaign**, including a campaign of one session. Row semantics are uniform. |
| 2 | A campaign's displayed count follows the **active filter** (existing `visibleCount` semantics), not a fixed total. |
| 3 | The default `origin` filter is **human + sub-agents**. This is a deliberately non-neutral default — the control must show its non-neutral state, because the two existing filters (`All harnesses`, `All machines`) default to "all". |
| 4 | A campaign's label is `override ?? derived`. **The override belongs to plan 047**; this plan ships the derived side only. |
| 5 | The derived label is a cleaned prefix **including the markdown rule** (see Wave 4). The markdown rule earns its place precisely because renaming is deferred to 047. |
| 6 | A "campaign shared across machines" is **a user-defined grouping layer above campaigns**, with its own identity, portable and mergeable. Not a widened campaign key. **Plan 047 owns it.** |
| 7 | Grouping becomes **portable user data for projects as well as campaigns**, superseding `docs/project-grouping-plan.md`. **Plan 047 owns it.** |
| 8 | The Report range card is **not compacted**. It is the maintainer's first indicator, and it filters the Sessions view, so its control stays operable on all three views. Its **internal order is reversed**: what you read moves up, what you adjust moves down (see Wave 5). |
| 9 | Navigation becomes a **left rail** covering all six destinations, split into *Report* and *Manage*. Below `48rem`, the three report views become a bottom bar and *Manage* moves to a menu. |
| 10 | `/sync` becomes a **machine-fleet page**: the machine is the primary object, carrying freshness, import/export, and plan 047's conflict resolution. |

## Copy

Settled 2026-07-26. **These are the strings. Do not invent alternatives, and do not
let a component introduce a synonym.** They were chosen together because the same
vocabulary appears as a filter label, a chart series name, a row badge, and a
provenance popover — a synonym in one place breaks the reading of the others.

| Surface | String |
| --- | --- |
| API metric (full) | `Estimated API-equivalent value` |
| API metric (compact) | `API value` |
| Origin filter | `Origin: human + delegated` |
| Origin series (chart legend) | `Human` · `Delegated` · `Automated review`; unclassified work renders outside the stack |
| Classifier roll-up on a campaign row | `+ 492 automated reviews` |
| Partially measured marker | `Partially measured` |
| Partially measured popover | `Partially measured — 57.5M tokens in this slice come from models with no published price. Their work is counted, their value is not.` |
| Unclassified origin popover | Provenance explains whether origin was unsupported, absent, or unavailable. |

Two rules follow from the wording:

- **`Partially measured` is the same term as Wave 1's aggregate state.** The code
  and the screen use one word, so there is nothing to translate at the boundary.
- The popover states *what is counted and what is not*, in that order. It is the
  clearest expression of this plan's second framing rule, and it must not be
  shortened into "estimate incomplete", which does not say what is incomplete.

Numbers in the strings above are illustrative; the real values come from the data.

Nothing else in this plan is open.

## The core defect: dimensions flattened into a prompt string

`packages/report-core/src/usage-row.ts:270-279`:

```ts
export const usageRowSessionLabel = (row: Row) => {
  const markers = usageRowMarkers(row);
  return (
    row.name +
    (markers.partial ? ' ~' : '') +
    (markers.subagent ? ' ↳' : '') +
    (markers.ambiguous ? ' ?' : '') +
    (markers.usageUnavailable ? ' (usage unavailable)' : '')
  );
};
```

Four structured dimensions are concatenated as punctuation suffixes onto
`row.name`, which is **the raw first prompt**. Because the suffix lands after
thousands of characters, it is truncated away in every list surface and survives
only in the drawer, as a dangling `~ ↳`.

Measured: top-session buttons carry 6,090 / 6,425 / 3,709 characters of text for
roughly 100 visible characters each, and **13,631 of 17,481 body characters (78%)
are session titles**.

**A proper channel already exists.** `packages/report-core/src/provenance.ts`
defines `UsageRowProvenance { kind, appliesTo: UsageMetricKey[], severity, label,
description }` with eight kinds, each declaring which metrics it qualifies —
`usage-unavailable` targets tokens/api-value/actual-cost/calls/tools,
`partial-session` targets counters (or `duration` for OpenCode),
`reconciliation-ambiguous` targets counters and aggregates. The UI already renders
it: `apps/web/src/session-columns.tsx` calls `provenanceForMetric(row, metric)` and
wraps cells in `CellWithProvenance`, including the title cell.

So three of the four markers are **already** expressed correctly per metric, and
`subagent` — the only one with no provenance entry — is absorbed by the campaign
hierarchy under decision 1. **Wave 4 designs no channel. It deletes a redundant
concatenation.**

## Dimension inventory and reading rank

| Dimension | Exists today as | Reliability | Rank |
| --- | --- | --- | --- |
| Time | timeline interval | solid | primary, unchanged |
| Harness | timeline dimension + filter | solid | primary, unchanged |
| Model | timeline dimension + breakdown | solid, unpriced models exist | primary, qualified by Wave 1 |
| Provider | timeline dimension + breakdown | solid | primary, unchanged |
| Campaign | row grouping, cannot group the chart, label truncated away | solid | **primary** (decisions 1, 2) |
| Origin (human / sub-agent / classifier / unknown) | `subagent?: boolean` + classifier titles | solid — Codex declares it | **primary** filter and dimension (decision 3) |
| Machine | filter only | solid | **promote to timeline dimension** |
| Project | filter, column, timeline dimension | **weak identity** (below) | primary, needs identity work |
| Data quality (`partial`, `ambiguous`, `usageUnavailable`) | glyph suffixes **and** a correct provenance channel | solid | keep the channel, drop the suffixes |
| Classifier parent link | full UUID extracted then truncated to 8 chars into a title | 733/733 resolvable, text-derived | **persist as a relation** |
| Branch / commit | drawer `Session source control` | **unmeasured cross-harness** | **stays a detail** until Wave 0 |
| Session | table row, prompt as title | title is a prompt | **demoted** — the atom, not the reading unit |

`TimelineDimension` today is `'harness' | 'model' | 'project' | 'provider'`
(`apps/web/src/overview-model.ts:138`). Campaign, machine, and origin are absent
while already existing in the data.

### Why project is called incoherent

`packages/report-core/src/session-query.ts:797-806` does
`const projectLabel = row.project || '(unknown)'` then `projectKey: projectLabel`.
The **filter key is the display string**, and the machine qualifier is baked
inconsistently into the upstream value rather than applied as a display rule.
Observed in one PROJECT column: `Exalibur` (bare) alongside `ai-usage · nixos` and
`svelte-news · nixos`. `/skills` compounds it — `Exalibur` is addressed by UUID
while every sibling uses a slug. The same repository seen from two machines becomes
two projects with no stable key to merge them.

## Commands you will need

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Report core tests | `bun test packages/report-core/src` | all pass |
| Report data tests | `bun test packages/report-data/src` | all pass |
| Collector tests | `bun test packages/local-collectors/src` | all pass |
| Web unit tests | `bun test apps/web/src` | all pass |
| Typecheck | `bun run typecheck` | all tasks pass |
| Lint and boundaries | `bun run lint` | exit 0, no boundary errors |
| Formatting | `bun run check` | Ultracite exits 0 |
| Full tests | `bun run test` | all pass |
| Browser tests | `bun run test:e2e` | all pass |
| Demo browser tests | `bun run test:e2e-demo` | all pass |
| Diff hygiene | `git diff --check` | no output, exit 0 |

Do not run `bun install`; the workspace already has its dependencies.

**Reproducing the UI evidence.** Drive `:3000` with headless Chrome over CDP at
1440x1000 and 390x844, and force the theme with
`document.documentElement.dataset.theme = 'light' | 'dark'`. `element.click()` does
**not** activate Ark UI tabs or radios — dispatch real pointer events
(`Input.dispatchMouseEvent`) or the interaction silently no-ops. Read comparative
values from **one** DOM snapshot.

**Reproducing the Codex evidence.** Scan every `*.jsonl` under `~/.codex/sessions`
**in full** — the discriminating fields can appear late in a file, and a head-only
scan produces wrong category counts. Session metadata lives in
`~/.codex/state_5.sqlite` (`threads`, `thread_spawn_edges`).

## Git workflow

- One branch for this plan. Waves 4 and 5 share a branch by design; every other
  wave commits independently.
- One commit per wave, only after that wave's verification passes.
- Imperative commit style, for example `Attribute classifier sessions to a parent`.
- Do not push or open a pull request unless the operator explicitly asks.
- Waves 0 and 3b produce no production diff; their artefact is the Execution log.

## Wave 0 — Measure git-awareness reliability before promoting it

Git awareness landed days ago and its cross-harness reliability is unknown. The
maintainer's counter-example is decisive: **the session that produced this plan ran
on `main` and would only move to a branch once the plan was actionable.** A
session's branch is not stable across its lifetime, so branch-as-identity would
misfile exactly that work.

1. Report resolution coverage per harness: share of sessions with a resolved
   repository, branch, and commit, and how often the branch changed mid-session.
2. Report how often a resolved branch disagrees with the branch the work landed on.
3. Publish the numbers in the Execution log.

STOP: do not add a branch dimension, filter, or derived label in this plan
regardless of what Wave 0 finds. Promotion is a separate decision.

**Files**: none in production. Scratch script; commit only the numbers.

**Verify**: the Execution log lets a reviewer decide branch promotion without
rerunning anything.

## Wave 1 — Make the work unit honest

**Evidence.** The hero prices `1,203 of 1,690 sessions`. `codex-auto-review` alone
accounts for `492 sessions · 57.5M fresh · 95% cache · 0/492 fully priced` and
contributes nothing — roughly **12% of the 469.3M fresh-token volume in range reads
as zero work**. `claude-opus-5` (`91,001 fresh · 0/1`) and `qwen3.7-plus`
(`81,570 fresh · 0/1`) fail identically. Two totals disagree for the same range,
read in one atomic snapshot and stable across three reads: timeline summary
`$8962.85`, hero `$8958.22` — a `$4.63` gap with nothing reconciling them.

1. Introduce an explicit three-state result for any priced aggregate: `measured`,
   `partially measured`, `zero`. Today `—`, `-`, `n/a` and `$0.00` are used
   interchangeably for at least three meanings. Note `provenance.ts` already has
   `partial-api-price` and `unknown-api-price` kinds — extend that vocabulary
   rather than inventing a parallel one.
2. Mark partially measured aggregates on their face, and put the **fresh-token
   fallback volume in the existing provenance popover**, not always-visible.
   Decided per the maintainer's standing rule: hierarchize, don't drown.
3. Reconcile the hero and timeline totals, or make the narrower one state why it
   differs. The hero already footnotes its coverage; the timeline row does not, and
   it is the larger number.
4. Every caveat stays attached to the metric it qualifies. No global badge.

**Files**: `packages/report-core/src/usage-row.ts` (`usageRowPricedCost`, line 261,
is the current binary answer), `packages/report-core/src/provenance.ts`, the
aggregation path in `packages/report-core/src/focused-report-query.ts`, and the hero
plus timeline summary in `apps/web/src/overview.tsx` and
`apps/web/src/time-range-control.tsx`.

**Verify**:

```sh
bun test packages/report-core/src && bun test apps/web/src
```

Expected: a slice with token volume and no model price reports `partially
measured`, never `zero`; the hero and timeline totals agree for one identical
range, or the narrower one carries its qualifier.

## Wave 2 — Give the timeline the dimensions the data already has

1. Extend `TimelineDimension` with `campaign`, `machine`, and `origin`. All three
   exist in the data; this is a projection change, not a collection change.
2. Do **not** add branch (Wave 0's STOP).
3. Do not add a new METRIC. `Share` and `Sessions` already cover the non-dollar
   readings.
4. The `origin` dimension must honour decision 3's non-neutral default and be able
   to state its own coverage per harness (Wave 3b).
5. Reconsider the default-collapsed `Chart options` disclosure: it will hold
   6 dimensions x 3 intervals x 3 metrics while its closed state reveals only
   `Harness · Day · Estimated API-equivalent value`. **If this turns into a layout question,
   it belongs with Wave 5, not here.**

**Files**: `apps/web/src/overview-model.ts:138`, `apps/web/src/dashboard.tsx:683`,
`apps/web/src/time-range-control.tsx:323,344`,
`apps/web/src/dashboard-report-lifecycle.ts:50`.

**Verify**:

```sh
bun run typecheck && bun test apps/web/src && bun run test:e2e
```

Expected: typecheck forces every `TimelineDimension` switch to handle the new
values with no default-case fallthrough; a browser test groups by campaign, by
machine, and by origin and asserts the legend changes.

## Wave 3 — Classify origin and re-parent classifiers

Three treatments, not two:

- **Sub-agent work stays visible.** It is real delegated work and the reason
  campaigns exist.
- **Classifiers get no row of their own**, but are never masked entirely.
- **A classifier is never an orphan.** It always resolves to a parent campaign.

### Codex declares the nature structurally — detection is settled

All 2,156 rollout files under `~/.codex/sessions`, whole-file scan, 2026-07-26:

| `thread_source` | `source.subagent` | Files | Share | Nature |
| --- | --- | --- | --- | --- |
| `subagent` | `thread_spawn`, role unset | 896 | 41.6% | delegated sub-agent |
| `subagent` | `{"other":"guardian"}` | 732 | 34.0% | guardian classifier |
| absent | absent | 291 | 13.5% | **nothing declared** |
| `user` | absent | 97 | 4.5% | human |
| `subagent` | `thread_spawn`, role `explorer` | 67 | 3.1% | delegated sub-agent |
| `subagent` | `thread_spawn`, role `worker` | 63 | 2.9% | delegated sub-agent |
| `subagent` | `"review"` | 10 | 0.5% | second classifier kind |

Classify from `thread_source` plus the `source.subagent.*` discriminator — never
from the model name, never from a title pattern.

Three facts shape the design:

- **Delegated sub-agents are the largest category** (`thread_spawn` totals 1,026,
  47.6%). Campaign roll-up is load-bearing, not cosmetic.
- **Only 4.5% of files positively declare a human origin**, which independently
  supports demoting the session as a reading unit.
- **`agent_role` is sparse** (130 of 1,026). Do **not** promote it to a dimension.

Collector consequences: `codex-history.ts:1198` stringifies `payload.source`
immediately and line 1499 detects guardians with
`session.source?.includes('"guardian"')` — a substring match over a serialised
blob. Parse the discriminator instead. The `thread_spawn` variant already carries a
structured `parent_thread_id`, `depth`, `agent_role` and `agent_nickname`, so
genuine sub-agents need no inference (`agent_nickname` is already the session name,
which is why some sessions are called `Fermat`).

### The parent link exists and is discarded

`codex-history.ts:1503-1505` extracts a 36-character parent UUID via
`REVIEWED_CODEX_SESSION_ID`, truncates it to 8 characters, and formats it into a
display string. It is never persisted as a relation.

- **733 / 733 sessions carrying the guardian marker have a resolvable parent id —
  100% coverage.** Systematic re-parenting needs no heuristic.
- 293 distinct parents collapse into 208 distinct 8-character prefixes, so
  **`.slice(0, 8)` merges 85 distinct parents** — the verified cause of nine
  consecutive identical `Codex guardian approval (019f9e7d)` rows.
- `campaignIdentityForRow` (`apps/web/src/dashboard-model.ts:101`) already requires
  a `rootSourceSessionId`. Classifiers have none, which is exactly why they surface
  as orphans. **Populating that existing field is the fix.**

Caveat to record: guardian parents come from a **regex over conversation text**,
because `source.subagent.other` carries no parent id and
`thread_spawn_edges` contains **zero** guardian children (1,034 edges, 842 guardian
threads, 0 present). Coverage is 100% today but the mechanism is textual, unlike
`thread_spawn`'s structured edge. Do not present the two as equally robust.

### Steps

1. Model `origin` with three declared values: `human`, `subagent`, and `classifier`; express absence through provenance.
   The 291 files declaring nothing land in `unknown` — never silently in `human`.
2. Persist the classifier parent relation instead of formatting it into a name.
3. Every top-level row is a campaign (decision 1), including a campaign of one.
4. Classifiers appear as an aggregate on their parent campaign — count and token
   volume — expandable on demand. A roll-up that attributes, not a filter that
   hides.
5. A campaign's count follows the active filter (decision 2).
6. The default `origin` filter is human + sub-agents, and the control shows its
   non-neutral state (decision 3).
7. Stop truncating any id used to distinguish rows.

**Files**: `packages/local-collectors/src/codex-history.ts` (lines 1198, 1499,
1503-1505, 1843, 2059), `packages/report-core/src/usage-row.ts`,
`packages/report-core/src/types.ts`, `apps/web/src/dashboard-model.ts`,
`apps/web/src/dashboard-search.ts` (the origin filter's default).

**Verify**:

```sh
bun test packages/local-collectors/src && bun test packages/report-core/src && bun run test:e2e
```

Expected: fixtures cover all five observed `source.subagent` shapes plus the absent
case; a `thread_spawn` session never classifies as `classifier`; an absent
`thread_source` yields `unknown`; every classifier fixture resolves to a parent; a
browser test asserts a campaign of one session still renders as a campaign, and
that the origin filter's default state is visibly non-neutral.

### Interaction with Wave 1

Re-parenting makes classifier token volume *attributed* but not *priced*. A parent
row will show volume it cannot express in dollars — precisely Wave 1's `partially
measured` state. Wave 1 lands first so both waves share one representation.

## Wave 3b — Extend origin honestly to the other harnesses

Wave 3's evidence is **Codex-only**. Claude, OpenCode and Cursor were not surveyed.

1. Survey each remaining harness's local history for a declared session nature,
   using the same whole-file method.
2. For any harness that declares nothing, its sessions stay `unknown`. Do not infer
   origin from titles, durations, or model names.
3. Record coverage per harness in the Execution log so the `origin` dimension can
   name what it can speak about instead of implying universality.

**Files**: the Claude, OpenCode and Cursor readers under
`packages/local-collectors/src/`. Survey scripts stay in scratch.

**Verify**: the Execution log states, per harness, whether a declared nature exists
and the share of sessions carrying one.

## Wave 4 — Derive a readable label and delete the suffix concatenation

This wave ships the **derived** side of decision 4 only. Renaming is plan 047.

### The derived label

Codex's own `title` is eliminated as a source: in `~/.codex/state_5.sqlite`, 2,050
of 2,190 titled threads have `title == first_user_message`, only 140 (6.4%) are
genuinely distinct, and some reach **45,886 characters**. It is a prompt echo.

Rules, in order:

1. Strip `<context>…</context>` blocks.
2. Strip pasted log blocks.
3. Reduce `[@file.md](file:///…)` to `@file.md`.
4. **If the prompt contains markdown headings, take the first line under the first
   heading rather than the preamble.** Otherwise take the first sentence.
5. Cap the result; cap the text that reaches the DOM at list level.

Rule 4 exists because the preamble of a structured prompt is decor: `"Tu travailles
dans le repository suivant : … # Mission Terminer en autonomie …"` must yield the
mission, not the preamble. This pattern occurs in the largest campaigns. Rule 4
earns its place *because* renaming is deferred to 047 — if 047 had landed first, the
simpler rule would have been enough.

Set `titleSource` accordingly. `provenance.ts` already emits a `title-derived`
entry when `titleSource !== 'ai'`, and `session-columns.tsx:77` already renders
title provenance, so "this name was derived" is already communicated.

### Delete the concatenation

Remove the marker suffixes from `usageRowSessionLabel`. `partial`, `ambiguous` and
`usageUnavailable` are already expressed per metric by `provenance.ts` and rendered
by `CellWithProvenance`; the suffixes are a worse duplicate. `subagent` is carried
by the campaign hierarchy.

### Project identity

Separate `projectKey` from `projectLabel`, stop baking the machine qualifier into
the upstream value, and apply machine qualification as a display rule only when it
disambiguates. Reconcile the `/skills` UUID-vs-slug split so one project is one
thing across routes. Plan 046 defers its row 25 to this step.

Out of scope here: any label built from branch or commit.

**Files**: `packages/report-core/src/usage-row.ts:263-279`,
`packages/report-core/src/session-query.ts:797-810`,
`apps/web/src/session-table.tsx:215-219`, `apps/web/src/overview.tsx`, and
`apps/web/src/routes/skills.projects.$projectKey.tsx`.

**Verify**:

```sh
bun test packages/report-core/src && bun run test:e2e
```

Expected: the returned label contains none of `~`, `↳`, `?`; fixtures drawn from
real prompt shapes cover each cleaning rule including the markdown case; markers
survive a narrow column; a DOM-weight assertion caps a session row's text content;
`projectKey` is stable when `projectLabel` changes.

## Wave 5 — Make the three principal views a navigation system

The Report range card is **not** the problem (decision 8): it is the maintainer's
first indicator, it filters the Sessions view, and its control stays operable
everywhere. The problem is that switching between Overview, Sessions and Breakdown
is small, does not call to action, and sits among other actions while being a
principal view of the app.

The state model is already sound: `DashboardSearch` carries `tab: DashboardTab`
validated by `validateSearch` with `stripSearchParams`, so the active view is
URL-addressable and survives reload. `primaryDashboardTabs` and `breakdownTabs` are
modelled separately with `primaryDashboardTabFor` deriving the primary. **The cost
of this wave is entirely presentational.**

1. Introduce a **left rail** carrying all six destinations, grouped as *Report*
   (Overview, Sessions, Breakdown) and *Manage* (Skills, Sync, Sources). The active
   view stays legible at any scroll depth — the property that motivated the choice.
2. Below `48rem`, the three report views become a **bottom bar** and *Manage* moves
   to a menu. Hook into the existing `SESSION_DESKTOP_MEDIA_QUERY`
   (`(min-width: 48rem)`) and `createSessionSurfaceModeController` rather than
   introducing a second breakpoint mechanism. A hamburger drawer is rejected: it
   would recreate the "does not call to action" defect on mobile.
3. The rail **replaces the per-route header navigation**, which resolves plan 046's
   row 16 structurally. That row is moved here; do not fix it in 046 first.
4. Differentiate the two tab levels. `Models / Providers / Harnesses / Projects /
   Cursor AI` are Breakdown's sub-views and must not read like the rail's peers.
5. Resolve the nested-scroll problem: the session table's inner scroll region
   (`max-h: calc(100dvh - 240px)`, `min-h: 320px`) must not sit below a full
   viewport of fixed chrome.
6. Fix the focus ring while in these components (below).
7. **Reverse the Report range card's internal order** (decision 8). The card keeps
   its size, its place, and every control it has today. Only the order changes:

   ```
   Jun 26 → Jul 26, 2026 · 30 days
   $8962.85   ■ Codex 96%  ■ OpenCode 0.6%  ■ Claude Code 3.4%
   [ the chart ]
    Jun 26                                            Jul 26
   ──────────────────────────────────────────────────────────
   [All] [Today] [7d] [30d]     From ──     To ──
   [―――――――――――――――――▬―]  brush
   ▸ Harness · Day · Estimated API-equivalent value
   ```

   What you read is on top, what you adjust is beneath a rule. This also removes
   three duplications that exist today and are the reason the card feels long: the
   range is currently stated **three** times (heading, `From`/`To`, summary row),
   the harness legend **twice** (above the chart and again in the summary row), and
   the scope **twice** (`Follows report range` and `Filters the entire report`).
   State each once. Expect roughly 90 px back without removing a single control.

**Files**: `packages/design-system/src/components/layout.ts` and
`packages/design-system/src/report.ts` (shared shell and header),
`apps/web/src/routes/__root.tsx`, all four route files, `apps/web/src/dashboard.tsx`
(tab levels and the panel scroll container), `apps/web/src/session-table.tsx`,
`apps/web/src/session-surface-mode.ts`, and
`packages/design-system/src/preset.ts` for the focus-ring token.

**Verify**:

```sh
bun run test:e2e && bun run test:e2e-demo
```

Expected: a browser test asserts the rail exposes all six destinations on every
route with one label per destination; the active view remains visible after
scrolling 3,000 px; at 390x844 the three report views are reachable from a bottom
bar and content is visible above the fold; a computed focus indicator has
non-transparent contrast against the page background on the `Inspect activity
timeline` button and the `[role=tabpanel]`, in both themes; the heatmap's cell size
and spacing are unchanged.

### The focus-ring defect carried here

The focus indicator is **invisible** on two focusable elements while the rest of the
app draws a clear 2 px orange ring: the `Inspect activity timeline` button and the
`[role=tabpanel]` container. Both compute to `outline: rgb(16, 16, 16) auto 1px`
with `box-shadow: none` and a transparent background, against a page background of
`rgb(17, 17, 19)`. That is a WCAG 2.4.7 failure and a regression against plan 029,
which is marked DONE and claims Playwright proof of keyboard navigation. Extend the
regression gate to assert a visible indicator.

For the record, plan 029's other requirement — a *labelled* equivalent
day-selection control — is correctly implemented at
`apps/web/src/overview.tsx:374-391` with an implicit label and `aria-describedby`.
Verified, not assumed.

## Wave 6 — Make `/sync` a machine-fleet page

For an overview app, an incomplete overview is a wrong overview. Today `/sync` is
one card with an unstyled native `<input type="file">` ("Choose FileNo file
chosen") on an otherwise empty 1141 px page, with no machine list, no per-machine
last-import time and no staleness signal — while the report's own filter
distinguishes `MacBook-Pro-de-Nathan` from `nixos`.

1. Make the **machine** the primary object: one card per known machine with its
   session count, the age of its newest session, and its last import.
2. Mark the current machine distinctly; export acts on it, import acts on the
   others.
3. Surface staleness where the incompleteness is consumed — on the machine filter
   and on any machine-grouped chart from Wave 2 — not only on `/sync`.
4. Replace the native file input with a designed control including a drop target,
   and give export visible feedback about what it wrote.
5. Leave room for plan 047's conflict resolution: this page is where an import
   reports grouping conflicts. Do not build that UI here, but do not adopt a layout
   that forecloses it.

**Files**: `apps/web/src/routes/sync.tsx`, the machine-identity read path
(`~/.config/ai-usage/machine.json`, written by the CLI snapshot command), and the
machine filter in `apps/web/src/dashboard.tsx`.

**Verify**:

```sh
bun run test:e2e && bun test apps/web/src
```

Expected: `/sync` lists more than one machine with a per-machine newest-session age;
a stale machine surfaces on the report's machine filter, not only on `/sync`.

**Prior art to respect**: plans 011, 014, 015 and **040** settled machine identity,
symmetric transfer limits, opaque source paths, and atomic peer confirmation. Read
them first; this wave is presentation over existing guarantees, not a new transfer
contract.

Note the import flow already has a preview-then-confirm protocol, reworked by plan
040: `apps/web/src/routes/sync.tsx` now sends a single
`X-Ai-Usage-Merge-Confirmation` header carrying a `confirmationToken`, replacing the
former `X-Ai-Usage-Store-Generation` and `X-Ai-Usage-Store-State` pair. Restyling
this page must not alter that handshake or drop the preview's warning list.

## Sequencing

1. **Wave 0** first and alone — measurement only, cheap, gates Wave 2's scope.
2. **Wave 1** next — independent, and it fixes the trust-breaking defect.
3. **Wave 3**, then **Wave 3b** immediately after. Origin must exist as data before
   Wave 4 can rely on it, and 3b establishes what it can speak about.
4. **Wave 4 and Wave 5 together**, in that order, as one branch. They touch the same
   components; Wave 4 also removes the DOM weight that makes Wave 5's surfaces feel
   slow.
5. **Wave 2** after Wave 0 and Wave 3b.
6. **Wave 6** last; least entangled.

Waves 0 and 3b produce no production diff and both gate later scope: an executor
with limited budget takes them first.

**Plan 046** can run in parallel with a different executor, minus its row 16 (now
Wave 5) and stopping on its rows 5 and 25, which depend on Wave 1 and Wave 4.
**Plan 047** is a hard dependency for campaign renaming and for any cross-machine
grouping; nothing in this plan may anticipate its storage model.

## Out of scope

- ROI, break-even, projections, budget alerts, or any framing treating the dollar
  figure as spend.
- Promoting branch or commit to a dimension, filter, or label.
- Campaign renaming, grouping, portability of grouping, and conflict resolution —
  all plan 047.
- Compacting the Report range card (decision 8).
- Changing collection semantics, pricing tables, or provider integrations.
- Redesigning `/skills` or `/sources` beyond adopting the rail.
- Plan 046's presentational backlog.

## Verification

- Wave 0 and Wave 3b publish their findings in the Execution log before any wave
  that depends on them starts.
- The three-state unit is covered by unit tests including a slice with token volume
  and no model price.
- One test asserts the hero and timeline totals agree for an identical range, or
  that the narrower one carries its qualifier.
- Origin classification is tested for all four values against real
  `thread_source` / `source.subagent.*` shapes.
- A test asserts every classifier resolves to a parent and cannot render as an
  orphan.
- A test asserts no row-distinguishing id is displayed truncated, using the
  known-colliding parent set as the fixture.
- Browser tests cover the rail on all six destinations and both surface modes, the
  campaign-of-one row, the non-neutral origin filter, grouping by campaign/machine/
  origin, and the focus ring in both themes.
- A DOM-weight assertion caps a session list row's text content.
- `bun run check`, `bun run lint`, `bun run typecheck`, `bun run test`,
  `bun run test:e2e`, `bun run test:e2e-demo` all pass.

## Done criteria

- [x] Git-awareness reliability is measured and published; branch stays a detail.
- [x] No aggregate renders unpriced token volume as `$0.00` or a bare `—`.
- [x] One range yields one total, or the narrower total states why it differs.
- [x] The timeline groups by campaign, machine, and origin.
- [x] Origin is classified from declared fields, with `unknown` for silence, and
      coverage stated per harness.
- [x] Every top-level row is a campaign; no classifier is an orphan; classifiers
      appear as an expandable aggregate on their parent.
- [x] The campaign count follows the active filter, and the default origin filter
      shows its non-neutral state.
- [x] `usageRowSessionLabel` no longer concatenates markers, and the derived label
      handles markdown-structured prompts.
- [x] `projectKey` is independent of `projectLabel`; one project is one thing across
      the report and `/skills`.
- [x] The rail exposes all six destinations on every route, stays visible at depth,
      and degrades to a bottom bar below `48rem`.
- [x] `/sync` reports per-machine freshness and staleness reaches the report.
- [x] The focus ring is visible on every focusable element in both themes.

## STOP conditions

Stop and report if:

- Wave 0 finds git resolution unreliable enough that the drawer's existing
  `Session source control` display is itself misleading;
- a classifier has **no resolvable parent**. Coverage is 100% on 2,156 surveyed
  Codex files, so a gap means a new Codex shape or a non-Codex classifier. Do not
  invent an orphan bucket and do not drop the session;
- another harness produces classifier-like sessions with no declared nature.
  Detection is Codex-specific by evidence; extending it is a separate decision;
- reconciling the two totals reveals a genuine aggregation bug in
  `packages/report-core` — that becomes its own plan, not a UI change;
- separating `projectKey` from `projectLabel` requires changing what collectors
  record rather than how the report projects it;
- the rail cannot cover all six destinations without changing what a route owns;
- Wave 5 would force a chart to lose meaning or the heatmap to lose its compact
  density (plan 029 fixed that as non-negotiable);
- any wave needs the campaign label override, the grouping layer, or their
  storage — that is plan 047, and anticipating it here creates the migration this
  plan's sequencing exists to avoid.

## Maintenance

Keep the unit's honesty in the aggregation that produces it: any future metric must
declare whether it is measured, partially measured, or zero. Keep dimension
semantics in `provenance.ts`'s per-metric channel — the next person tempted to
append a glyph to a label should find this plan first. Keep navigation in one owner;
a future route must not define its own header.

## Execution log

Append findings here as waves complete. Waves 0 and 3b have no other artefact, so
an empty section means neither has run.

### Wave 0 — git-awareness reliability

Measured 2026-07-26 from one read-only collector snapshot. Percentages use all
sessions for that harness as their denominator; the branch-change percentage in
parentheses uses branch-resolved sessions.

| Harness | Sessions | Repo resolved | Branch resolved | Commit resolved | Branch changed mid-session |
| --- | ---: | ---: | ---: | ---: | ---: |
| Claude | 148 | 104 (70.3%) | 111 (75.0%) | 0 (0.0%) | 9 (6.1%; 8.1% of resolved) |
| Codex | 2,300 | 2,223 (96.7%) | 2,246 (97.7%) | 2,251 (97.9%) | 0 (0.0%) |
| OpenCode | 634 | 538 (84.9%) | 0 (0.0%) | 0 (0.0%) | 0 (0.0%) |
| Cursor | 83 | 0 (0.0%) | 0 (0.0%) | 0 (0.0%) | 0 (0.0%) |

The local histories do not persist the branch on which later work landed, so there
were **0 comparable sessions** for a recorded-branch-versus-landed-branch rate.
The existing VCS context is still honest as an observed, per-session detail: absent
facts remain absent and each recorded fact carries provenance. It is not reliable
enough to become identity or a report dimension. Recommendation: keep branch and
commit in the drawer and do not promote them.

### Wave 3b — declared session nature per harness

Measured 2026-07-26 with whole-file reads for Claude and read-only database
snapshots for OpenCode and Cursor:

| Harness | Declared nature | Field | Coverage in report sessions |
| --- | --- | --- | ---: |
| Claude | Human or delegated | `isSidechain` (`agentId` corroborates delegated files) | 113/148 (76.4%): 66 human, 47 delegated; 35 history-only fallbacks remain unknown |
| OpenCode | Delegated only | `session.parent_id` | 252/634 (39.7%) delegated; root sessions do not declare human origin and remain unclassified |
| Cursor | None | `isAgentic` / `unifiedMode` describe interaction mode, not who started the session; observed `subagentComposerIds` sets were empty | 0/83 (0.0%); all remain unknown |

OpenCode's `session.agent` names an agent profile and occurs on both root and child
sessions, so it is not an origin discriminator. Cursor exposes no classifier-like
session shape in the surveyed data.

Codex, surveyed 2026-07-26 over all 2,156 files under `~/.codex/sessions`
(whole-file scan) plus `~/.codex/state_5.sqlite`: distribution in Wave 3;
733/733 guardian sessions with a resolvable parent id; `thread_spawn_edges` holds
1,034 edges and zero guardian children; `title` is a prompt echo in 2,050 of 2,190
titled threads.

### Implementation — waves 1 to 6

Implemented and verified on 2026-07-26 on `feat/implement-plans-045-047`.
The operator requested one dedicated branch for all changed plans, so this run
intentionally shares the branch with plan 046.

- Pricing and provenance now preserve measured, partially measured, and
  unmeasured states from aggregation through every value renderer.
- The report exposes campaign, machine, and declared-origin timelines; campaign
  rows are universal, including single-session campaigns, and delegated sessions
  remain attached to their resolvable parent.
- Derived session labels understand structured Markdown prompts. Project identity
  is separated from its display label across the report and Skills.
- One navigation owner exposes all six destinations as a persistent rail and a
  mobile bottom bar. Focus treatment is durable in both themes.
- Sync exposes per-machine fleet freshness, and stale authority propagates to the
  report rather than disappearing at the boundary.

The report campaign query now pre-aggregates visible counts and selects latest
rows with a windowed CTE. On a 5,000-campaign fixture, the prior query shape took
about 22 seconds; the replacement remained between 74 and 385 ms, with a durable
five-second regression guard.

### Verification

- `bun x ultracite fix`, `bun run check`, `bun run lint`, and
  `bun run typecheck` pass.
- `bun run test` passes all workspace and tool tests, including 497 web tests.
- `bun run test:e2e` passes 75/75 scenarios; `bun run test:e2e-demo` passes 1/1.
- The report scale and benchmark specifications pass 2/2 and 4/4 respectively.
- Mobile overflow, source scheduling, Skills ellipsis and draft-guard scenarios
  were repeated under load after their deterministic fixes.
