# Plan 025: Make Session Analysis Verifiable from Source to UI

> **Coordinator instructions**: this master plan contains five deliverable work
> packages. Every agent must read the complete plan and implement only the
> assigned package. Only the coordinator may update status in
> `plans/README.md`. Every agent must run all package checks and hand back the
> commit, results, and any deviations. Do not push or open a PR unless the user
> explicitly requests it.
>
> **Run this drift check first**:
>
> `git diff --stat cb9bc22..HEAD -- packages/local-collectors/package.json packages/local-collectors/src packages/report-core/src/session-detail.ts packages/report-core/src/session-query.ts packages/report-data/src/revision-query-runner.ts packages/report-data/src/session-query-materialization.ts packages/report-data/src/session-query-sqlite.ts apps/web/src apps/web/e2e docs/architecture.md docs/public-package-interfaces.md docs/session-analysis-sources.md`
>
> If an in-scope file changed after `cb9bc22`, compare Current State with the
> live code. If an interface, privacy invariant, source format, or the
> exact-revision protocol changed, STOP and update this plan before coding.

## Status

- **Status**: DONE
- **Priority**: P1
- **Effort**: L, delivered in five packages
- **Risk**: HIGH
- **Depends on**: plans 016, 017, 018, and 024, all DONE
- **Category**: bug, tests, tech debt, UX, docs
- **Planned at**: commit `cb9bc22`, 2026-07-19
- **Suggested integration branch**: continue the current branch or create
  `fix/025-session-analysis-trust`; do not push without explicit instruction

## Why This Matters

The old UI presented three different facts with warning-like treatment: a
local trace read on demand, campaign-root analysis scope, and prompt privacy.
Only an observed divergence or a partial metric should affect trust. The old
“may be newer” message existed because the application could not prove that an
immutable report row and the current local trace described the same
projection.

Two architectural problems made this permanent:

1. The browser directly selected the local provenance to reread.
2. OpenCode independently derived the same tokens, models, costs, durations,
   and relationships for report rows and local detail.

The existing tests also did not follow real harness files through the complete
storage and exact-revision query path. This plan introduced deterministic proof
at each seam, then aligned UI severity with what the system actually knows.

## Diagnostic and Architectural Decision

The permanent warning was not evidence that data was wrong; it compensated for
a missing consistency interface. Changing copy alone would not solve it.

The adopted design is:

1. The browser sends only `{ revision, rowId }`.
2. The server resolves a report anchor from that revision’s `sessions.sqlite`.
3. The local adapter rereads the current source and returns both UI detail and
   the same projection facts used by reporting.
4. Pure comparison returns `matches-report`, `differs-from-report`, or
   `cannot-compare`.
5. The UI renders a consistency warning only for `differs-from-report`.

The state must never be called `source-newer`. A difference may come from new
source content, enrichment, a corrected parser, or an old report revision. The
system observes divergence but cannot prove causality.

## Non-Negotiable Invariants

1. Report revisions remain immutable and are read under an exact-revision
   lease.
2. Detailed prompts remain local, bounded, loaded on demand, and absent from
   revisions, snapshots, merge bundles, and exports.
3. The browser never sends machine id, local paths, harness provenance, or
   source session id; these come from the revision.
4. Private prompt text and local paths never enter the revision anchor or a
   fingerprint.
5. `matches-report` means that comparable projection facts are equal. It does
   not claim that local source data is universally complete.
6. `partial`, unavailable usage, unknown pricing, and truncated text remain
   metric-specific limitations. There is no global data-quality badge.
7. A campaign keeps visible totals separate from total count. A filtered
   campaign must not describe visible metrics as all rollouts.
8. Golden tests use independent literal expectations. Fixture builders never
   derive expected results through production code.
9. Real harness fixtures are synthetic and contain no retained user content.
10. Playwright proves wiring and visual semantics; deterministic calculations
    stay in unit and integration tests.

## Current State at `cb9bc22`

### The report was revisioned, but detail was not

- The report and Session queries already used exact immutable revisions.
- The detail request still contained browser-selected provenance.
- `session-query-materialization.ts` already stored `row_id` and
  `source_row_json` in every revision, so no second row copy or manifest was
  required.

### The exact-revision runner was the correct seam

- `revision-query-runner.server.ts` already owned the lease, bounded
  subprocess, strict parsing, and `RevisionExpired` distinction.
- Anchor lookup therefore needed one additional query kind in that protocol,
  not direct SQLite access from Nitro and not another runner.

### Campaign roots were flattened into fake sessions

- `SessionPageItem` was already discriminated in report-core.
- Web presentation flattened campaigns into a root-shaped row using visible
  totals while retaining root identity.
- The drawer described `campaignTotalCount` rollouts even when displayed
  metrics covered only `visibleCount`.
- Scope therefore needed an explicit selection target at the drawer/analysis
  seam.

### Notices did not express their semantics

- Matching local detail, campaign scope, and prompt privacy all looked like
  warnings.
- Documentation already reserved warning color for real quality problems and
  required per-metric limitations, so UI presentation lagged behind the domain
  contract.

### OpenCode had two owners for the same facts

- The collector parsed and aggregated report facts.
- The local-history reader separately reimplemented tokens,
  reasoning-as-output, models, intervals, costs, and parent semantics.
- SQL queries for all sessions and one bounded session could remain separate,
  but their semantic derivation needed one pure owner.

### Vertical tests were insufficient

- Most collector tests used prepared rows or in-memory storage rather than real
  OpenCode/Cursor SQLite schemas.
- Development E2E used a demo payload and bypassed collectors.
- Production E2E seeded real Codex JSONL but mostly asserted pagination and
  revision behavior, not report/detail parity.

## Target Architecture

~~~text
real fixtures
  └─ Claude/Codex/OpenCode/Cursor collectors
       └─ usage-store
            └─ stored payload
                 └─ immutable sessions.sqlite
                      └─ session-detail-anchor(revision, rowId)
                           ┐
                           ├─ compareSessionProjectionFacts ── consistency
current local source       │
  └─ read*SessionAnalysis ─┘
       ├─ local detail (prompts included, never persisted)
       └─ projection facts (no prompts or paths)

SessionAnalysisTarget(kind=session | campaign-root)
  + SessionDetailResponse(consistency)
  └─ typed presentation model
       └─ UI: neutral metadata or a real targeted warning
~~~

## Target Contracts

Names and discriminants below were prescriptive. Private implementation details
could vary, but their meaning could not.

In `packages/report-core/src/session-detail.ts`:

~~~ts
export interface SessionDetailRequest {
  revision: string;
  rowId: string;
}

export interface SessionProjectionModelFacts {
  model: string;
  tokens: SessionDetailTokenCounts;
}

export interface SessionProjectionFacts {
  calls: number;
  durationMs: number | null;
  modelSegments: SessionProjectionModelFacts[] | null;
  partial: boolean;
  tokens: SessionDetailTokenCounts | null;
  tools: number;
  turns: number;
}

export interface SessionDetailReportAnchor {
  harnessKey: string | null;
  machineId: string | null;
  projection: SessionProjectionFacts;
  sourceSessionId: string | null;
}

export interface SessionDetailAnchorResult {
  anchor: SessionDetailReportAnchor | null;
  requestFingerprint: string;
  revision: string;
}

export interface LocalSessionAnalysis {
  detail: SessionDetail;
  projection: SessionProjectionFacts;
}

export type SessionDetailComparableField =
  | 'calls'
  | 'duration'
  | 'model-attribution'
  | 'coverage'
  | 'tokens'
  | 'tools'
  | 'turns';

export type SessionDetailConsistency =
  | {
      checkedFields: SessionDetailComparableField[];
      status: 'matches-report';
    }
  | {
      checkedFields: SessionDetailComparableField[];
      differingFields: SessionDetailComparableField[];
      status: 'differs-from-report';
    }
  | {
      checkedFields: SessionDetailComparableField[];
      reason: 'insufficient-comparable-facts';
      status: 'cannot-compare';
    };

export type SessionDetailResponse =
  | {
      consistency: SessionDetailConsistency;
      detail: SessionDetail;
      revision: string;
      status: 'available';
    }
  | {
      message: string;
      reason:
        | 'history-unavailable'
        | 'not-found'
        | 'not-local'
        | 'report-provenance-unavailable'
        | 'report-row-not-found'
        | 'revision-expired'
        | 'unsupported';
      status: 'unavailable';
    };
~~~

`SessionProjectionFacts` rules:

- `tokens` is null only for an unavailable-usage row.
- `modelSegments` is canonically sorted by model and excludes cost.
- A multi-model row without reliable attribution uses null, never invented
  attribution to the dominant model.
- `durationMs` retains report active-duration semantics, not the wall-clock
  span displayed in detail.
- `calls`, `turns`, `tools`, and `partial` exactly reproduce the harness report
  projection.
- Cost, prompt timestamps, titles, paths, and labels are excluded from the
  consistency comparison. Cost remains covered by the vertical golden because
  pricing may change independently of source history.

Anchor presence rules:

- `anchor: null` exclusively means `row_id` is absent from the requested
  revision and maps to `report-row-not-found`.
- An existing row always produces an anchor, even without `source`; missing
  provenance fields are null.
- A null harness key, machine id, or source session id maps to
  `report-provenance-unavailable` and authorizes no local read.
- An unsupported non-null harness maps to `unsupported`; a different machine
  maps to `not-local`.

`compareSessionProjectionFacts(report, local)`:

- builds checked and differing fields in the fixed union order;
- never compares floating-point cost;
- never turns divergence into an exception.

Normative comparison matrix:

| Field | Included when | Equality |
| --- | --- | --- |
| `calls` | both token sets are non-null | strict integer equality |
| `duration` | unless both durations are null | null vs number differs; otherwise strict |
| `model-attribution` | both segment arrays are non-null | canonical deep equality |
| `coverage` | always | strict `(partial, tokens available)` tuple |
| `tokens` | both token sets are non-null | deep equality of all five counters |
| `tools` | both token sets are non-null | strict integer equality |
| `turns` | always | strict integer equality |

Normative status algorithm:

1. Any differing checked field returns `differs-from-report`.
2. Otherwise, if tokens were checked, return `matches-report`.
3. Otherwise return `cannot-compare` with
   `insufficient-comparable-facts`, preserving fields that were checked.

Thus two identical unavailable-usage projections never produce a false global
match. Duration, coverage, and turns may be checked, but status remains
`cannot-compare`. Asymmetric usage availability differs in coverage. Missing
legacy model attribution is omitted while available tokens can still support a
match on other facts.

In `apps/web/src/session-analysis-target.ts`:

~~~ts
export type SessionAnalysisTarget =
  | {
      kind: 'session';
      reportRowId: string;
      summaryRow: DashboardRow;
    }
  | {
      campaignKey: string;
      kind: 'campaign-root';
      reportRowId: string;
      summaryRow: DashboardRow;
      totalCount: number;
      visibleCount: number;
    };
~~~

`SessionDrawer` receives this target and a revision; it no longer infers scope
from an optional campaign count.

## Rejected Alternatives

- Sending provenance and a hash from the browser: the browser would still own
  data the server can resolve from the revision, and its hash proves nothing.
- Persisting the full timeline in revisions: artifact growth and prompt privacy
  risk.
- Adding a second opaque fingerprint beside `source_row_json`: the source row
  already exists, so deriving a small anchor avoids another truth and schema
  migration.
- Showing “source newer” on difference: divergence does not identify cause.
- Building a four-harness Playwright matrix: slow and redundant; one
  multi-harness golden plus a production UI smoke localizes failures better.
- Rewriting all presentation rows as a discriminated union: deferred; the
  critical seam was drawer/analysis selection.

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Install | `bun install --frozen-lockfile` | exit 0, unchanged lockfile |
| Core/detail | `bun test packages/report-core/src/session-detail.test.ts` | pass |
| Collectors | `bun test packages/local-collectors/src/codex-history.test.ts packages/local-collectors/src/opencode-history.test.ts packages/local-collectors/src/db-collectors.test.ts` | pass |
| Report integration | `bun test packages/report-data/src/source-adapters.test.ts packages/report-data/src/session-query-runner.test.ts` | pass |
| Web detail | `bun test apps/web/src/session-analysis.test.ts apps/web/src/session-analysis.render.test.tsx apps/web/src/session-detail-client.test.ts apps/web/src/server/session-detail.server.test.ts` | pass |
| Check | `bun run check` | exit 0 |
| Boundaries | `bun run lint` | exit 0 |
| Types | `bun run typecheck` | exit 0 |
| Tests | `bun run test` | exit 0 |
| Build | `bun run build` | exit 0 |
| Dev E2E | `bun run test:e2e` | pass |
| Production E2E | `bun run test:e2e-production` | pass |
| Production listener | `bun run test:web-production` | exit 0 |
| Whitespace | `git diff --check cb9bc22...HEAD` | no output |

Use targeted Ultracite fixes during each package. Run a global fix only after
checking that the worktree contains no unrelated user changes.

## Scope

In scope:

- harness-owned real-home fixture builder and tests;
- OpenCode collector/history, shared facts module, Codex history, and tests;
- report-core session detail and narrowly necessary session query changes;
- report-data revision runner, SQLite query path, and vertical integration test;
- web revision runner, detail server/client, analysis target/presentation,
  drawer/dashboard wiring, and tests;
- one production E2E wiring smoke;
- architecture, public-interface, and session-analysis documentation;
- execution log and plan index.

Out of scope:

- usage-store schema or row identity changes;
- prompts, timelines, or paths in snapshots, revisions, or exports;
- recalculating or migrating already-published revisions;
- pricing changes or new `costApprox` semantics;
- detailed Claude or Cursor drawer support;
- a global table/presentation/TanStack refactor;
- a new scheduler, global cache, or direct SQLite access from browser/Nitro;
- source cadence, SSE publication, or plan 018 coordinator changes;
- design-system changes while existing report styles suffice.

## Package Ownership and Integration Order

| Package | Subject | Exclusive ownership | Depends on | Parallel? |
| --- | --- | --- | --- | --- |
| A | Fixtures and vertical golden | fixture + report-data tests | baseline | no, first |
| B | Shared projection/OpenCode facts | report-core + local collectors | A | no |
| C | Exact-revision contract | consistency, runner, server/client | B | no |
| D | Target and UI presentation | dashboard/drawer/analysis | C | no |
| E | Final integration | production E2E, docs, gates, log/index | A–D | no |

Coordination rules:

1. A creates the fixture API and hands back a green commit.
2. B starts from A, adds pure projection types/functions first, then migrates
   Codex and OpenCode.
3. C starts from B and owns contract, runner, server, and client changes.
4. D starts only after C integrates and must not alter server protocol to make
   JSX easier.
5. E does not silently change business semantics when a golden fails; it sends
   the issue back to the owning package.

Suggested commits:

1. `Add vertical harness report fixtures`
2. `Unify OpenCode session projection facts`
3. `Bind session detail to report revisions`
4. `Clarify session analysis trust signals`
5. `Cover session analysis end to end`

Preserve unrelated changes. Do not mix global formatting or dependency
upgrades, and do not push or open a PR without explicit instruction.

## Work Package 0: Baseline and Execution Log

1. Record branch, HEAD, scoped drift, and pre-existing user changes.
2. Create the plan log with an A–E status table, starting SHA, package commands,
   durations/results, observed golden differences, and final gates.
3. Run the existing focused core, collector, report-data, and web tests. If the
   baseline fails, record it and STOP rather than attributing it to this plan.

## Work Package 1: Seed Real Harness Homes and Freeze the Vertical Result

### Step 1.1: add a harness-owned fixture builder

Create the test-only `harness-home` export with deterministic ids and paths,
fixed July 2026 timestamps, synthetic prompts, subset seeding, and a mutation
helper for Codex. The builder receives an existing temporary home and must not
create or delete the test root.

Fixtures must include:

- Claude JSONL with two models, two turns, one tool, cache read/write, and a
  derived title;
- linked Codex root/child sessions with tasks, model changes, cumulative
  snapshots, tool call, separate open/partial interval, and a private prompt
  sentinel never used as title;
- real OpenCode SQLite with minimal session/message/part tables, two models,
  reasoning, cache data, overlapping intervals, parent variants, and a tool;
- real Cursor `state.vscdb` with composer, user/assistant bubbles, and partial
  counters; add CSV only when needed for multi-model reconciliation.

Test file existence, SQLite integrity, stable ids, Codex-only subset behavior,
and exactly 205 Codex sessions when requested.

### Step 1.2: source → store → payload → SQLite golden

Create one integration test that seeds a temporary home, writes a fixed machine,
runs all four session sources in fixed order, reads stored rows, creates a
fixed-time payload, materializes private `sessions.sqlite`, and compares the
real SQLite page with the pure projection.

Literal per-harness expectations cover lineage, dates/duration, all token
counters, models/segments, cost, turns/tools, partial/unavailable states,
campaign totals, segment-sum invariants, secondary-model filters, and absence
of the private prompt sentinel from payload and `source_row_json`.

Run the golden twice. If source events contradict a current value, record the
factual difference and assign it to the relevant harness rather than blessing
the value.

### Step 1.3: prove real OpenCode/Cursor SQLite queries

Cover nominal multi-model OpenCode, isolated malformed JSON, partial Cursor
tokens, and Cursor DB+CSV reconciliation without double counting. Keep fast
in-memory tests; real SQLite tests are an additional contract layer.

## Work Package 2: Give OpenCode Facts One Owner

### Step 2.1: characterize the common interface

Before refactoring, freeze report and detail outputs from the same fixture:
output includes reasoning, cache read/write remain separate, model is
`providerID/modelID`, segments are canonically ordered, reported cost remains
distinct from API value, intervals union correctly, incomplete intervals are
partial, parent variants are preserved, tools/turns are counted, and invalid
metrics never create `NaN`.

### Step 2.2: extract the deep module

Create a pure internal OpenCode facts module that owns validation,
deduplication, token/model/tool derivation, interval union, parent semantics,
and projection construction. It must know nothing about Effect, filesystem,
SQLite connections, web code, or report payloads.

### Step 2.3: return detail and projection from one parse

The bounded local reader returns `LocalSessionAnalysis`; the collector consumes
the same session facts for report rows. Preserve prompt bounding and never cache
detailed prompt text. Add report/detail parity tests for nominal, partial,
multi-model, unavailable, parented, and malformed cases.

### Step 2.4: eliminate duplicate owners

Remove redundant OpenCode arithmetic and legacy detail wrappers after all
callers migrate. Increment the semantic cache version whenever serialized facts
change.

## Work Package 3: Bind Analysis to an Exact Revision

### Step 3.1: replace the public request contract

The client request becomes exactly `{ revision, rowId }`. Strict parsers reject
old provenance-bearing and unknown-key requests. Add pure projection and
consistency parsing/comparison tests for every matrix row, deterministic field
order, partial/unavailable coverage, and no cost comparison.

### Step 3.2: add `session-detail-anchor` to the runner

Resolve one row under the existing revision lease and return its canonical
fingerprint, revision, and nullable anchor. Zero rows, one row, duplicate rows,
invalid source JSON, wrong fingerprint, bounded output, and revision expiry all
have explicit outcomes. Do not change the SQLite schema.

### Step 3.3: orchestrate anchor then local read on the server

Validate local request trust, resolve the anchor, preserve exact revision
expiry, distinguish missing row from missing provenance, require the local
machine, dispatch only supported harnesses, read local analysis, compare facts,
and strictly parse the final response. Never invoke local reads before anchor
and machine validation. Remove old provenance compatibility wrappers after
migration.

### Step 3.4: simplify the client

The browser sends no path, machine, harness, or source id. It requires a served
revision, strictly parses every server response, rejects mismatched available
revisions, and preserves current loading/retry behavior.

## Work Package 4: Make Scope, Privacy, and Trust Explicit

### Step 4.1: introduce `SessionAnalysisTarget`

Every selection is explicitly a session or campaign root. A campaign carries
both visible and total counts; direct root/child/Overview/neighbor selections
remain sessions unless explicitly selected as campaign roots. The dashboard
stores this target rather than making the drawer infer scope from optional
fields.

### Step 4.2: create a pure presentation model

Return discriminated presentation items for matching/divergent consistency,
campaign scope, privacy, partial duration/turns, and prompt truncation. Matching,
scope, and privacy are neutral. Only observed divergence and metric-specific
limitations use warning tone and accessible status treatment.

Required wording covers full and filtered campaigns, exact checked fields,
cannot-compare limitations, and prompt privacy near the prompt section. The
model never claims why a divergence occurred.

### Step 4.3: render the model, not ad hoc conditions

Refactor Session Analysis to consume presentation items. Keep neutral metadata
compact, render targeted warnings only where appropriate, and place privacy by
prompts. SSR tests prove every tone, kind, and accessible role for matching,
divergence, partial metrics, truncation, full scope, and 6/15 filtered scope.
No new DOM testing dependency is permitted.

### Step 4.4: fix campaign counts permanently

Every sentence describing aggregated visible metrics uses `visibleCount`.
`totalCount` is only the true denominator/overall count. Cover 6/15 in target
and presentation tests.

## Work Package 5: Close the Parity, E2E, and Documentation Loop

### Step 5.1: publish → mutate → compare

Use real seeded Codex files to prove a published row initially matches local
analysis, source mutation creates deterministic differing fields, and explicit
recollection restores a match. The pipeline test owns semantic freshness; the
runner test separately owns lease/revision behavior.

### Step 5.2: extend one production Playwright smoke

Reuse the harness-home fixture. Keep 205 sessions and existing pagination.
Prove the prompt sentinel is absent from initial HTML, appears only after the
explicit detail request, consistency/scope/privacy tones are correct, the old
“may be newer” message is absent, and no neutral item receives warning tone.
Do not create a full browser matrix.

### Step 5.3: document the real contract

Update architecture, public interfaces, and the single harness source matrix
with independent local detail, revision-resolved provenance, exact consistency
states, divergence without causal claims, shared OpenCode facts, prompt privacy,
and current per-harness limitations. Do not duplicate the full matrix across
documents.

### Step 5.4: run final gates

Run frozen install, check, lint, typecheck, tests, build, production listener,
both E2E suites, whitespace check, and worktree inspection. Keep the lockfile
unchanged and limit changes to scope plus log/index. Update the log and mark 025
DONE only when every gate passes.

## Consolidated Test Plan

Pure unit tests:

- projection facts, canonical model attribution, comparison matrix, strict
  request/response parsers, target construction, and presentation notices.

Local integration:

- real Claude/Codex JSONL and OpenCode/Cursor SQLite;
- pure/SQLite projection parity;
- report facts/local analysis parity;
- deterministic match → differs → match after mutation/recollection.

Server:

- exact anchor lookup, missing/duplicate rows, nullable provenance, wrong
  machine, unsupported harness, expiry, bounded process failures, strict
  responses, and no local read before authority validation.

Browser:

- SSR coverage for every tone/role combination;
- neutral matching/privacy/scope metadata;
- one production wiring smoke;
- no pagination/revision regression;
- prompt sentinel absent initially and present only after requested local read.

## Done Criteria

- [x] The client sends only `revision` and `rowId`.
- [x] Local provenance is resolved from `source_row_json` under the requested
      revision lease.
- [x] Missing rows and rows without provenance have distinct typed outcomes and
      trigger no local read.
- [x] An expired revision never silently falls back to the latest revision.
- [x] Codex and OpenCode readers return detail and projection from the same
      parse.
- [x] OpenCode semantic rules have one owner.
- [x] All three consistency states are bounded, parsed, and tested.
- [x] The exact checked-field matrix covers unavailable and asymmetric usage.
- [x] Cost is excluded from freshness comparison but remains in the golden.
- [x] Filtered campaigns display visible count versus total count correctly.
- [x] Scope and privacy never use warning tone.
- [x] “may be newer” and the old provenance request are gone.
- [x] Real OpenCode and Cursor schemas execute in the suite.
- [x] The golden traverses source → store → payload → final SQLite.
- [x] The real mutation test obtains match → differs → match.
- [x] The production smoke opens Session Analysis.
- [x] Rendering tests prove divergence, scope, privacy, partial, and truncation
      roles and tones.
- [x] Detailed prompts are absent from revisions, exports, and initial HTML;
      the sentinel appears only after requested local reading.
- [x] Check, lint, typecheck, tests, build, and both E2E suites pass.
- [x] The log contains all five package results and records the consolidated
      post-execution commit.
- [x] The plan index marks 025 DONE.

## STOP Conditions

STOP without improvising if:

- in-scope files materially drift from `cb9bc22`;
- the fix requires prompts, paths, or full timelines in a revision;
- the browser must retain provenance authority;
- exact-revision lookup requires bypassing the existing runner/lease protocol;
- report/detail parity requires ignoring token, duration, model, turn, or tool
  divergence;
- a golden derives expectations through production code;
- cost requires a new pricing policy rather than a test correction;
- work requires a global table or design-system rewrite;
- a gate fails twice after a reasonable correction;
- an owner must edit files assigned to an unintegrated package.

## Maintenance Notes

- A new detail harness must implement `LocalSessionAnalysis`, define its
  projection facts, and add a golden case before entering
  `sessionDetailHarnessKeys`.
- Any cached parser change to serialized facts must increment its cache version.
- Add a comparable field only when report and local derivations share exactly
  the same semantics.
- Reviewers should focus on absence of browser-owned provenance, absence of
  private anchor data, OpenCode parity, filtered-campaign status, and wording
  that does not invent causality.
- A complete discriminated `SessionPresentationRow` refactor remains possible
  if other consumers still mix root identity and aggregate metrics. This plan
  secured the critical seam without broadening that refactor.
