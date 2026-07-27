# Plan 048: Restore multi-harness visibility after the origin default

> **Status: DONE.** Implemented and verified on 2026-07-27. The settled
> arbitration is preserved: `unknown` joins the default until plan 049 removes the
> undeclared-origin category itself.
>
> **Baseline**: `2eb3b96`. All figures were measured against the running dev server
> on `:3000` on 2026-07-27, comparing the default filter against an all-origins URL.
>
> **Why this plan exists**: plan 045 shipped correctly against its own text, and the
> combination of two of its decisions produced a regression neither decision
> contains. The root cause is a defect in **how plan 045 was written**, recorded
> below so the next plan does not repeat it.

## Outcome

The default report shows every harness that has sessions in range. Classifier noise
stays folded, sub-agent work stays visible, and no harness disappears because its
history does not happen to declare how a session was started.

## The regression

Measured on 2026-07-27, same range, same machine, only the `origin` filter differing:

| | Sessions in range | Harnesses shown | Reported actual spend |
| --- | ---: | --- | ---: |
| `Origin: human + delegated` (default) | 953 / 5,581 | **Codex only, 100%** | `$0.00` |
| `Origin: all` | 2,144 / 5,581 | Codex 96% · Claude Code 3.3% · OpenCode 0.6% | non-zero |

Under `all`, the harness breakdown reads `Codex 2,067 sess`, `Claude Code 48 sess`,
`OpenCode 29 sess`. Under the default, **100% of Claude Code and 100% of OpenCode
sessions are hidden**, and the visible corpus drops by 56%.

The Codex reduction from 2,067 to 953 is intended — that is classifier noise being
folded, exactly as plan 045 decision 3 specified. The disappearance of two entire
harnesses is not.

### Causal chain

1. `packages/report-core/src/usage-row.ts:213` defaults an absent origin to
   `'unknown'`, which is correct and was specified.
2. Only Codex ever sets `origin`. There is no `origin` assignment anywhere in
   `packages/local-collectors/src/collectors/claude.ts`,
   `packages/local-collectors/src/claude-session-facts.ts`, or
   `packages/local-collectors/src/collectors/opencode.ts`.
3. `apps/web/src/dashboard-search.ts:69` sets
   `defaultDashboardOrigins = ['human', 'subagent']`, which excludes `unknown`.

Each step is individually correct. Together they hide two harnesses.

### The signals are already flowing — this is a mapping omission

The surveyed discriminators are not merely available, they are **already read and
already used for something else**:

| Harness | Signal | Already consumed at | Currently mapped to |
| --- | --- | --- | --- |
| Claude | `sidechain` (from `isAgentFile` / `record.isSidechain`, computed at `claude-session-facts.ts:590-645`) | `collectors/claude.ts:361` | `subagent: report.sidechain` — but **not** `origin` |
| OpenCode | `parent_id` | `collectors/opencode.ts:119` then `:268` | `parentSourceSessionId` — but **not** `origin` |

So Step 1 is a mapping, not new collection. No new file read, no new query, no new
schema.

### Root cause in plan 045's design, not in its execution

Plan 045 wave 3b was written as a **measurement-only** wave: "Record coverage per
harness in the Execution log so the `origin` dimension can name what it can speak
about." It named no step that consumes the finding, and it did not require
re-checking decision 3's non-neutral default against the coverage it was about to
measure.

The executor followed that text exactly. Wave 3b ran, and it ran well — it found
Claude's `sidechain`, OpenCode's `parent_id`, and correctly **refused** Cursor's
`isAgentic` on the grounds that it "describes interaction mode, not who started the
session". That judgement is right and must be preserved. The findings then stayed in
the log because nothing was mandated to act on them.

**Rule for future plans**: a step that produces a discovery must name the step that
consumes it. A survey whose only output is a log entry will not change behaviour.

## The principle this violated

Recorded by the maintainer on 2026-07-27. It is the app's data philosophy, and the
regression is a direct consequence of breaking its last clause:

> Collectors gather every piece of data they can. Normalisation and enrichment then do
> what they can with it — and at that stage we already know the columns will be
> **partial**, because the collected sources are heterogeneous. It is therefore the
> **consumer's** job to present that partial data as faithfully as possible.

The subtlety the maintainer named: **here we filter on partial data.** A consumer that
*presents* a partial column can be faithful — it shows what is known and marks what is
not, which is exactly what `provenance.ts` does per metric. A consumer that *filters*
on a partial column cannot: removing a row converts "we do not know" into "it does not
exist", and the absence leaves no trace to be faithful about.

### The invariant, verified

`origin` is the only filter in the app that has **both** properties at once:

| Filter | Default | Column |
| --- | --- | --- |
| `harness` | `[]` — neutral, means all | always known |
| `machine` | `[]` — neutral, means all | always known |
| `filters` (campaign/provider/model/project) | `{}` — neutral, user-initiated | `project` can be `(unknown)` |
| **`origin`** | **`['human','subagent']` — the only non-neutral default** | **`?? 'unknown'`, the only partial column exposed as a set filter** |

Neither property is a defect alone. A non-neutral default over a complete column is
merely opinionated. A partial column behind a neutral default is fine, because nothing
is dropped. The regression is the intersection, and today it exists nowhere else.

**Invariant to hold from now on**: a filter default must not exclude a value that
exists only because the underlying data is incomplete. If a category means "not
declared", it belongs in the default and, if it needs de-emphasising, that is the
presentation layer's job — not the filter's.

**Plan 049 makes this invariant structural rather than configured.** It removes
`unknown` from `sessionOrigins` entirely, making `origin` optional and expressing
absence through `provenance.ts` with one `kind` per cause. A filter that selects kinds
then has nothing to match on an unclassified row, so absence becomes **unfilterable by
construction** instead of protected by a default value someone could narrow again.

This plan's Step 2 is therefore **deliberately transitional**: one line that restores
visibility today, which plan 049 deletes. It is kept because Step 1 alone leaves
Cursor and OpenCode root sessions hidden, and a documented one-line stopgap is
preferable to a known blind spot waiting behind a model change of unknown size. Do
not defend it as the destination.

## The arbitration — settled

**Settled 2026-07-27: `unknown` is included in the default** (option 1 below).

The default becomes "everything except classifiers", which is the honest description
of what the filter is actually for. Cursor's 83 sessions and OpenCode's 382 root
sessions return to the default view. Nothing is inferred, so plan 045 wave 3's
prohibition on landing undeclared sessions in `human` stays intact.

Consequences for the steps:

- Step 2 sets `defaultDashboardOrigins = ['human', 'subagent', 'unknown']`.
- The filter's label must describe the exclusion it still makes. `Origin: human +
  delegated` no longer describes the default; it becomes something like
  `Origin: excluding automated reviews`. The exact string is part of Step 2 and must
  follow plan 045's *Copy* vocabulary — `Automated review` is the established term.
- Step 1 still matters, and matters more than before: including `unknown` restores the
  missing harnesses, but it does **not** make Claude's 113 and OpenCode's 252
  declarable sessions correctly classified. Without Step 1 the `origin` dimension is
  a near-uniform `unknown` and carries no information.
- Cursor stays entirely `unknown`, which is now visible rather than hidden. That is the
  faithful presentation the principle asks for.

### Rationale: the options considered

Wave 3b measured, over full local history:

| Harness | Declarable | Genuinely undeclared |
| --- | ---: | ---: |
| Claude | 113/148 (66 human, 47 delegated) | 35 history-only fallbacks |
| OpenCode | 252/634 delegated via `parent_id` | 382 root sessions |
| Cursor | 0/83 | 83 — no origin signal exists |

Step 1 recovers the declarable rows. **The remainder — roughly 500 sessions across
three harnesses — still resolves to `unknown` and is still excluded by the default.**
Cursor in particular would remain entirely invisible by default, which reproduces
the same defect at smaller scale.

Three ways to settle it, to be decided before Step 2:

1. **Include `unknown` in the default.** The default becomes "everything except
   classifiers", which is the honest reading of what the filter is for. Cursor and
   OpenCode roots return. Cost: the default is no longer a positive statement about
   origin, and a genuinely unclassifiable session sits beside classified ones.
2. **Treat an undeclared root session as human.** A session with no parent and no
   declared origin was almost certainly started by a person; only harness-spawned
   children are not. Recovers OpenCode's 382 roots and Cursor's 83 as `human`. Cost:
   it is an inference, and plan 045 wave 3 explicitly forbade landing undeclared
   sessions in `human`.
3. **Make the exclusion visible instead of changing it.** Keep the default, but state
   on the filter what it is hiding and from which harnesses, so the absence is
   legible rather than silent. Cost: the first screen still under-reports, and the
   maintainer must read a caveat to know it.

Option 1 was chosen. Option 2 was rejected because it converts a measurement gap into
a guess — the exact move plan 045 wave 3 forbade — and option 3 was rejected because a
caveat does not restore a harness to the first screen.

## Steps

### Step 1: Map the surveyed signals to `origin`

1. Claude: derive `origin` from the same `sidechain` fact already used for
   `subagent` — delegated when `sidechain`, human when the facts came from a real
   session read. A history-only fallback stays `unknown`; do not guess for it.
2. OpenCode: derive `origin` from `parent_id` — delegated when a parent exists. A
   root session's origin stays `unknown` — the settled arbitration keeps `unknown` in
   the default rather than inferring human origin for it.
3. Cursor: leave `unknown`. Preserve wave 3b's judgement that `isAgentic` and
   `unifiedMode` describe interaction mode, not who started the session. Do not use
   them.
4. Do not change `usage-row.ts:213`. Defaulting an absent origin to `unknown` is
   correct; the bug was never having anything to default from.

**Files**: `packages/local-collectors/src/collectors/claude.ts` (line 361 is where
`sidechain` is already consumed), `packages/local-collectors/src/collectors/opencode.ts`
(lines 119 and 268), and `packages/local-collectors/src/collector-cache.ts` if the
cached row shape needs the field.

**Verify**:

```sh
bun test packages/local-collectors/src && bun test packages/report-core/src
```

Expected: a Claude sidechain fixture yields `subagent`; a Claude non-sidechain read
yields `human`; a Claude history-only fallback yields `unknown`; an OpenCode session
with `parent_id` yields `subagent`; a Cursor fixture yields `unknown` regardless of
`isAgentic`.

### Step 2: Include `unknown` in the default (transitional — plan 049 removes this)

1. Set `defaultDashboardOrigins = ['human', 'subagent', 'unknown']` at
   `apps/web/src/dashboard-search.ts:69`. Comment the line with a pointer to plan 049,
   which deletes the `unknown` value rather than defaulting it in.
2. Re-label the filter so it describes the exclusion it still makes rather than the
   inclusion it no longer limits. `Origin: human + delegated` becomes false the moment
   `unknown` is in the default. Use plan 045's established term for what is excluded:
   `Automated review`.
3. Keep the non-neutral indication. The default still excludes something, so plan 045
   decision 3's requirement that the control show a non-neutral state still applies —
   it is honoured today and must survive.
4. Re-measure the default against `Origin: all` and record both figures in this plan's
   Execution log. After Step 1 and Step 2 the only remaining difference between them
   must be classifier sessions.

**Files**: `apps/web/src/dashboard-search.ts` (line 69 and the label), and the filter
control's copy.

**Verify**:

```sh
bun test apps/web/src && bun run test:e2e
```

Expected: the Step 5 gate passes with default filters; a test asserts the default
origin selection contains `unknown`; a test asserts the filter label does not claim an
inclusion the default does not make.

### Step 3: Remove the duplicated primary tab strip

The three principal views are now rendered twice on one screen, about 700 px apart:
by the rail and bottom bar in `apps/web/src/app-navigation.tsx` (lines 218-230 and
273-285), and again by `<Tabs ariaLabel="Dashboard sections">` in
`apps/web/src/dashboard.tsx:959-960`. Two controls, one piece of state.

Plan 045 wave 5 said the rail "replaces the per-route header navigation". It did not
say to remove the in-page strip, so the executor was right to leave it.

1. Render the active panel directly; drop the primary tab strip.
2. **Keep** the nested `<Tabs ariaLabel="Breakdown dimension">` at
   `dashboard.tsx:1037-1038`. Those are Breakdown's sub-views, not the rail's peers,
   and plan 045 wave 5 item 4 asked for exactly that distinction.
3. Preserve the URL contract: `tab` stays in `DashboardSearch`, and the rail already
   links `/`, `/?tab=sessions`, `/?tab=models`.
4. Preserve keyboard reachability of the panel and its heading order.

**Files**: `apps/web/src/dashboard.tsx:959-1035`,
`packages/design-system/src/components/tabs.tsx` only if the component becomes
unused by this call site.

**Verify**:

```sh
bun run test:e2e && bun run test:e2e-demo
```

Expected: exactly one control selects the primary view; a browser test asserts the
Breakdown sub-tabs still exist and still change the panel; deep links to
`/?tab=sessions` and `/?tab=models` still resolve.

### Step 4: Fix the spend-coverage bar

`Reported actual spend · $0.00` sits directly above a full-width bar
(`apps/web/src/overview.tsx:194`). The bar encodes spend **coverage**
(`953/953 sessions`, so 100%), not the amount, but the juxtaposition reads as if
`$0.00` fills the bar.

1. Make the bar's subject unmistakable, or do not draw a full bar next to a zero
   amount.
2. Do not remove the coverage information; it is per-metric provenance and plan 045
   framing rule 3 protects it.

**Files**: `apps/web/src/overview.tsx` around line 194.

**Verify**: manual comparison at 1440x1000 in both themes — a reader must not be able
to read the bar as the spend amount.

### Step 5: Add the regression gate this class of bug needs

The failure was not a wrong value; it was a **silently empty category**. Add a gate
that catches the shape, not the instance.

1. Assert that with default filters, every harness holding sessions in range appears
   in the harness breakdown. A harness may be absent only when it genuinely has no
   in-range sessions.
2. Assert the same for machines, since the machine filter has the same structure and
   could acquire the same defect.
3. **Assert the invariant directly, not just its symptom**: no filter default may
   exclude a value that exists only because the underlying data is incomplete. Today
   that means asserting `defaultDashboardOrigins` contains every `SessionOrigin` that
   represents absent data — currently `unknown`. Because `sessionOrigins` is a typed
   union, adding a future "we could not tell" value will fail this assertion until it
   is deliberately handled.
4. Keep the gate independent of any particular origin set beyond that: it asserts "no
   populated category silently disappears", not a fixed list.

**Files**: the frontend regression suite established by plan 030.

**Verify**:

```sh
bun run test:e2e
```

Expected: the gate fails if `origin`'s default is narrowed again without mapping a
harness, and passes for any arbitration that keeps every populated harness visible.

## Commands you will need

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Collector tests | `bun test packages/local-collectors/src` | all pass |
| Report core tests | `bun test packages/report-core/src` | all pass |
| Web unit tests | `bun test apps/web/src` | all pass |
| Typecheck | `bun run typecheck` | all tasks pass |
| Lint and boundaries | `bun run lint` | exit 0 |
| Formatting | `bun run check` | Ultracite exits 0 |
| Full tests | `bun run test` | all pass |
| Browser tests | `bun run test:e2e` | all pass |
| Demo browser tests | `bun run test:e2e-demo` | all pass |
| Diff hygiene | `git diff --check` | no output, exit 0 |

Do not run `bun install`.

**Reproducing the regression.** Load `:3000` and read the harness breakdown at
`/?tab=harnesses`, then again at
`/?tab=harnesses&origin=human&origin=subagent&origin=classifier&origin=unknown`.
Compare the harness count and the session totals. Use synthetic fixtures for tests;
do not assert against real local history.

## Git workflow

- One branch for this plan.
- One commit per step, only after its verification passes.
- Land Step 1 before Step 2. Including `unknown` in the default restores the missing
  harnesses, but until the mapping exists the `origin` dimension is a near-uniform
  `unknown` and carries no information — shipping Step 2 alone would look fixed while
  the dimension stayed useless.
- Imperative commit style, for example `Map Claude and OpenCode session origin`.
- Do not push or open a pull request unless the operator explicitly asks.

## Out of scope

- Changing what `origin` means, or adding a fifth value.
- Inferring Cursor's origin from interaction-mode fields. Wave 3b's refusal stands.
- Anything in plan 047; its STOP is unrelated to this regression.
- Re-litigating plan 045's decisions 1, 2 or 3 beyond the default's membership.
- New collection: every signal this plan needs is already read.

## Verification

- Origin mapping is covered per harness, including the undeclared fallbacks.
- The default view and the all-origins view are both recorded in the Execution log,
  before and after.
- Exactly one control selects the primary view; Breakdown sub-tabs are unaffected.
- The regression gate fails on a narrowed default that drops a populated harness.
- `bun run check`, `bun run lint`, `bun run typecheck`, `bun run test`,
  `bun run test:e2e`, `bun run test:e2e-demo` all pass.

## Done criteria

- [x] The arbitration is recorded (*The arbitration — settled*, 2026-07-27).
- [x] `unknown` is in the default origin selection.
- [x] The filter label describes the exclusion it makes, not an inclusion it does not.
- [x] Claude and OpenCode sessions carry a declared `origin` where their history
      declares one.
- [x] Cursor sessions remain `unknown`, with no inference from interaction mode.
- [x] The default report shows every harness that has sessions in range.
- [x] The origin filter still states its own non-neutral state.
- [x] One control selects the primary view; Breakdown sub-views are unchanged.
- [x] The spend bar cannot be read as the spend amount.
- [x] A regression gate fails if any populated harness disappears from the default.

## STOP conditions

Stop and report if:

- mapping Claude's or OpenCode's origin requires reading anything not already read.
  It does not today, and if it appears to, the mapping has been misunderstood;
- a filter default is proposed that excludes a value representing absent data. That is
  the invariant this plan exists to establish, and re-breaking it is not a trade-off;
- honouring the arbitration would require landing an undeclared session in `human`
  against plan 045 wave 3's prohibition, without that prohibition being explicitly
  amended here;
- removing the primary tab strip breaks a deep link, the URL contract, or the
  Breakdown sub-tabs;
- the regression gate cannot be written without asserting a specific origin set,
  which would make it fail on a legitimate future default.

## Maintenance

A non-neutral filter default is a claim about the data. Whenever one is introduced,
the same commit must prove that no populated category disappears because of it. And
any wave that surveys the data must name the wave that consumes the survey —
otherwise the finding lands in a log and the behaviour never changes.

## Execution log

### Before

Measured 2026-07-27 at `2eb3b96`, range Jun 27 → Jul 27, all machines:

| Filter | Sessions | Harnesses | Actual spend |
| --- | ---: | --- | ---: |
| `human + delegated` (default) | 953 / 5,581 | Codex 100% | `$0.00` |
| `all` | 2,144 / 5,581 | Codex 2,067 · Claude Code 48 · OpenCode 29 | non-zero |

### After

Measured 2026-07-27 from the isolated `VITE_AI_USAGE_E2E` fixture on `:3000`,
using the all-time range and all machines. Both variants were captured through
headless Chrome over CDP at 1440x1000 with a forced light theme. No real local
history was read. The fixture has no classifier session, so equality is the
expected result: any remaining difference may only come from classifiers.

| Filter | Sessions | Harnesses | Actual spend |
| --- | ---: | --- | ---: |
| `excluding automated reviews` (default) | 4 / 4 | Codex 1 · OpenCode 1 · Claude 1 · Cursor 1 | `$4.04` |
| `all` | 4 / 4 | Codex 1 · OpenCode 1 · Claude 1 · Cursor 1 | `$4.04` |

The category gate was also run as a cold negative control with `unknown` temporarily
removed from the default. It failed without a fixed category list: the live harness
options still contained Cursor while the default breakdown did not. The required
default was restored before the final verification gate.

### After, on real local history

The *Before* table above was measured against real local history, so the fixture table
alone does not make the two rows comparable. Re-measured on 2026-07-27 at `a65906c`,
same conditions as *Before* — range Jun 27 → Jul 27, all machines, headless Chrome over
CDP at 1440x1000, default filter versus an all-origins URL:

| Filter | Sessions | Harnesses | Codex total |
| --- | ---: | --- | ---: |
| `excluding automated reviews` (default) | 1,242 / 5,597 | Codex 1,165 · Claude Code 48 · OpenCode 29 | `$9186.70` measured |
| `all` | 2,155 / 5,597 | Codex 2,078 · Claude Code 48 · OpenCode 29 | `≥ $9203.20` partially measured |

The regression is closed: all three populated harnesses appear in the default, where
previously only Codex did.

The strongest confirmation is the shape of the delta rather than the totals. Claude Code
and OpenCode are **identical** in both views, and only Codex changes — by 913 sessions,
all of them classifiers. That is exactly the condition Step 2 required: after Steps 1 and
2, the only remaining difference between the default and all-origins must be classifier
sessions.

A secondary effect worth recording: excluding classifiers makes the Codex total *fully*
measured (`$9186.70`, no `≥`), because the unpriced sessions were the classifiers. Under
`all` it correctly reverts to `≥ $9203.20` with `Partially measured (1,172/2,078)`.

The session corpus grew from 5,581 to 5,597 between the two measurements; that is
ordinary accumulation, not an effect of the change.
