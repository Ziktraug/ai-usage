# Plan 049: Make undeclared origin a gap, not a category

> **Status: DRAFT.** The design was settled with the maintainer on 2026-07-27.
> Nothing is open.
>
> **Baseline**: `2eb3b96`, on top of plan 048.
>
> **Depends on plan 048.** Plan 048 restores harness visibility with a transitional
> default; this plan removes the need for that default and deletes it.

## Outcome

`origin` classifies sessions with the three values that describe a session. When no
origin was declared, the session carries **no origin at all** and the reason is
expressed through per-metric provenance. Absence becomes unfilterable by construction,
and the report can say *why* a session is unclassified — which tells the maintainer
which collector to improve.

## Why

Plan 048 established the invariant: *a filter default must not exclude a value that
exists only because the underlying data is incomplete.* It honoured that invariant by
**configuration** — putting `unknown` into `defaultDashboardOrigins`. Configuration can
be narrowed again by anyone, and the regression it fixes was itself a one-line
configuration choice.

This plan makes the invariant **structural**. If absence is not a value, no filter can
select it, and therefore no filter can exclude it.

There is a second, independent reason. The maintainer's data philosophy says
normalisation produces knowingly partial columns and the **consumer** must present them
faithfully. `unknown` inside `sessionOrigins` breaks that split in three ways:

1. **It draws a series that is not a kind of work.** Grouping the timeline by `origin`
   stacks an `Undeclared` bar beside `Human` and `Delegated`. Its height measures the
   collectors' blind spot, not the work — a different question, answered on the same
   axis, in an app whose unit is quantity of work.
2. **It collapses unrelated gaps into one bucket.** Plan 045 wave 3b measured three
   distinct causes over full local history:

   | Sessions | Cause | Who can fix it |
   | ---: | --- | --- |
   | 83 (Cursor) | the harness exposes **no origin signal at all** | nobody locally; depends on Cursor |
   | 382 (OpenCode roots) | the signal exists and is **empty by construction** — a root has no parent | a product decision about roots |
   | 35 (Claude) | the signal exists but the row came from a **degraded, history-only read** | improve the Claude collector |

   Under one enum value these are indistinguishable, so the gap is not actionable.
3. **It makes the filter state something false.** `Origin: human + delegated + unknown`
   reads as selecting three kinds. It actually selects two kinds and adds "do not hide
   what could not be classified" — a different kind of statement.

`provenance.ts` already solves exactly this shape. Its `appliesTo` union begins with
`'title'` (`packages/report-core/src/provenance.ts:3-13`), so provenance already
qualifies a **non-numeric attribute**, and `title-derived` is the working precedent for
"this field was not stated the way you might assume". `origin` needs the same treatment,
not a fourth enum member.

## Current state

- `packages/report-core/src/types.ts:12` —
  `sessionOrigins = ['human', 'subagent', 'classifier', 'unknown']`.
- `packages/report-core/src/usage-row.ts:213` — `origin: input.origin ?? 'unknown'`,
  the coercion that manufactures the category.
- `packages/report-core/src/report-data.ts:363,392` and
  `packages/report-core/src/merge-bundle.ts:329` — the same `?? 'unknown'` coercion on
  the projection and transport paths.
- `apps/web/src/dashboard-search.ts:69` — `defaultDashboardOrigins`, transitional after
  plan 048.
- `packages/report-core/src/provenance.ts` — eight `kind`s, `appliesTo: UsageMetricKey[]`
  where the union already includes `'title'`.
- `packages/report-core/src/focused-report-query.ts:49` — `origin` is one of seven
  timeline dimensions, so it must keep working as a group-by after this change.

## Design

### `origin` becomes optional with three values

`sessionOrigins` drops `unknown` and becomes `['human', 'subagent', 'classifier']`.
`origin` is optional on the row. No coercion replaces an absent value.

Removing a member from a typed union is the mechanism that finds every site: typecheck
will fail wherever `'unknown'` was matched, defaulted, or listed. Work through those
failures rather than searching by hand.

### Absence carries a provenance kind per cause

Add three kinds with `appliesTo: ['origin']`, and add `'origin'` to `UsageMetricKey`:

| Kind | Meaning | Severity |
| --- | --- | --- |
| `origin-unsupported` | the harness exposes no origin signal | `info` |
| `origin-absent` | the signal exists; this session declared none | `info` |
| `origin-degraded` | the signal exists; this row came from a fallback read | `warning` |

`info` for the first two because nothing is wrong — the data simply does not exist, and
the philosophy says that is expected. `warning` for the third because it is a
collector-quality issue the maintainer can act on.

Copy follows plan 045's *Copy* discipline. Proposed strings, to be used verbatim:

- `origin-unsupported` — `Origin unsupported — this harness does not record how a session was started.`
- `origin-absent` — `Origin not declared — this session records no origin, and it has no parent to infer one from.`
- `origin-degraded` — `Origin unavailable — this row came from a reduced history read, so its origin could not be determined.`

### The consumer presents the gap as a gap

When grouping by `origin`, unclassified sessions are rendered **outside the stack** and
visually distinct — the reference sketch is a hatched or muted band labelled
`Not classified`, carrying the provenance marker. Its tooltip decomposes the causes with
their counts.

This is the point of the whole plan: the same 500 sessions stop reading as a fourth kind
of work and start reading as three measurable holes.

### The filter stops being able to exclude absence

An origin filter selects kinds. A session with no origin has no kind to match, so it is
never excluded by an origin selection. `defaultDashboardOrigins` returns to a neutral
default (`[]`, meaning "all kinds") like `harness` and `machine`, and plan 048's
transitional `unknown` entry is deleted along with the value.

The filter's label describes the exclusion it makes, which after this change is only
whatever kinds the user has actually deselected.

## Steps

### Step 1: Remove `unknown` from the union and let typecheck find the sites

1. `sessionOrigins` becomes `['human', 'subagent', 'classifier']`; `origin` optional.
2. Delete the `?? 'unknown'` coercions at `usage-row.ts:213`, `report-data.ts:363,392`,
   and `merge-bundle.ts:329`. An absent origin stays absent through normalisation,
   projection, and transport.
3. Fix every typecheck failure. Do not reintroduce a sentinel under another name.

**Files**: `packages/report-core/src/types.ts`, `usage-row.ts`, `report-data.ts`,
`merge-bundle.ts`, `snapshot.ts`, `session-query.ts`,
`packages/local-collectors/src/collector-cache.ts`, and whatever else typecheck names.

**Verify**:

```sh
bun run typecheck && bun test packages/report-core/src
```

Expected: no diagnostics; a row built without an origin has no `origin` property, and a
bundle round-trip preserves its absence rather than materialising a value.

### Step 2: Add the three provenance kinds

1. Add `'origin'` to `UsageMetricKey`.
2. Add `origin-unsupported`, `origin-absent`, `origin-degraded` with the severities and
   copy above.
3. Emit exactly one of them when `origin` is absent, chosen by the collector's own
   knowledge of *why*. The collector knows which case applies; the report must not
   guess.
4. Cursor emits `origin-unsupported`. Preserve plan 045 wave 3b's refusal to read
   `isAgentic` or `unifiedMode` as origin — this plan makes that refusal explicit and
   explained rather than silent.

**Files**: `packages/report-core/src/provenance.ts`, and the Claude, OpenCode and Cursor
collectors under `packages/local-collectors/src/`.

**Verify**:

```sh
bun test packages/report-core/src && bun test packages/local-collectors/src
```

Expected: a Cursor fixture yields `origin-unsupported`; an OpenCode root yields
`origin-absent`; a Claude history-only fallback yields `origin-degraded`; a classified
session yields none of them.

### Step 3: Make the origin dimension render the gap as a gap

1. Grouping by `origin` produces three real series plus an unclassified band rendered
   outside the stack and visually distinct.
2. The band carries the provenance marker, and its tooltip decomposes causes with
   counts.
3. Grouping by any other dimension is unaffected.

**Files**: `apps/web/src/overview-model.ts`, `apps/web/src/dashboard.tsx`, the timeline
renderer, and the chart legend.

**Verify**:

```sh
bun run test:e2e
```

Expected: a browser test asserts the unclassified band is not stacked with the three
kinds, is visually distinguishable in both themes, and exposes the per-cause counts.

### Step 4: Return the origin filter to a neutral default

1. `defaultDashboardOrigins` becomes `[]`, meaning all kinds, matching `harness` and
   `machine`.
2. Delete plan 048's transitional `unknown` entry and the test that asserted it.
3. Assert the structural property in its place: a session with no origin is returned by
   **every** origin selection, including a single-kind selection.
4. Update the filter's label to describe only what the user has deselected.

**Files**: `apps/web/src/dashboard-search.ts`, the origin filter control, and the plan
048 regression test being replaced.

**Verify**:

```sh
bun test apps/web/src && bun run test:e2e
```

Expected: with `origin` narrowed to a single kind, unclassified sessions are still
present; plan 048's harness-visibility gate still passes and no longer depends on a
default value.

### Step 5: Record the vocabulary

1. Add to `CONTEXT.md`: **Session origin** — the declared way a session was started,
   with three values; absent when the harness did not declare one. _Avoid_: unknown
   origin, origin unknown, undeclared as a category.
2. State the rule next to it: an absent attribute is expressed by provenance, never by a
   sentinel value in its own domain.

**Verify**: `bun run check && bun run lint` — and no document describes `unknown` as an
origin.

## Out of scope

- Inferring an origin for any session. Cursor stays unclassified; OpenCode roots stay
  unclassified. This plan makes the gap legible, not smaller.
- Changing how `human`, `subagent` or `classifier` are detected (plan 045 wave 3, plan
  048 step 1).
- Applying the same treatment to other partial columns. `project`'s `(unknown)` sentinel
  has the same smell, but it is not exposed as a set filter and is not this plan's
  subject — record it as a candidate, do not change it here.
- Plan 047's grouping model.

## Verification

- Typecheck drives the removal; no sentinel is reintroduced.
- Each of the three causes has a distinct kind, asserted per harness.
- The unclassified band is not stacked with real kinds and decomposes its causes.
- A session with no origin survives every origin selection, including a single-kind one.
- Plan 048's harness-visibility gate still passes without depending on a default value.
- `bun run check`, `bun run lint`, `bun run typecheck`, `bun run test`,
  `bun run test:e2e`, `bun run test:e2e-demo` all pass.

## Done criteria

- [ ] `sessionOrigins` has three values and `origin` is optional.
- [ ] No `?? 'unknown'` coercion remains on any origin path.
- [ ] Three provenance kinds exist, each emitted by the collector that knows the cause.
- [ ] Grouping by origin renders unclassified work outside the stack, with causes.
- [ ] No origin selection can exclude an unclassified session.
- [ ] `defaultDashboardOrigins` is neutral, and plan 048's transitional entry is gone.
- [ ] `CONTEXT.md` records the vocabulary and the sentinel prohibition.

## STOP conditions

Stop and report if:

- removing `unknown` from the union requires a sentinel somewhere else to keep a query,
  a sort, or a group-by working. That is the same defect relocated;
- a collector cannot say **why** an origin is absent. Emitting a generic
  "not classified" for an unknown reason defeats the plan; report the case instead;
- the timeline cannot render a non-stacked band without changing the meaning of the
  other series;
- making absence unfilterable breaks a saved URL that selected origins explicitly. Deep
  links are a compatibility constraint in this repository;
- this plan would need to change how any origin is *detected*. Detection belongs to
  plans 045 and 048.

## Maintenance

An attribute that the data may simply not have is optional, and its absence is explained
by provenance. It never gets a sentinel value in its own domain, because a sentinel is
indistinguishable from a real category to every consumer downstream — filters, group-by,
legends, and totals alike. `project`'s `(unknown)` is the remaining example in this
repository; it is out of scope here and should be treated the same way when it is
touched.

## Post-change origin distribution

A direct fresh full-history collection on 2026-07-27 produced the following
collector-owned absence provenance. Rows with a declared origin carry none of these
kinds.

| Harness | `origin-unsupported` | `origin-absent` | `origin-degraded` |
| --- | ---: | ---: | ---: |
| Claude Code | 0 | 0 | 37 |
| Codex | 0 | 291 | 0 |
| Cursor | 83 | 0 | 0 |
| OpenCode | 0 | 382 | 0 |

Cursor and OpenCode match plan 045 wave 3b exactly. Claude increased from 35 to 37,
which is consistent with two additional history-only sessions collected since that
measurement. The direct collector output had no absent origin without one of the three
causes. A durable-store export also retained two older Claude rows that are no longer
returned by the current collector and predate origin provenance; they remain
unexplained rather than being assigned a guessed cause.
