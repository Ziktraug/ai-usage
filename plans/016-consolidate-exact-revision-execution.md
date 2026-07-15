# Plan 016: Consolidate Exact-Revision Runners and Localize the Session SQLite Schema

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: plan 009
- **Category**: architecture / subprocess safety / query storage
- **Based on**: commit `17bcf28`, 2026-07-13
- **Status**: DONE
- **Suggested branch**: `refactor/016-exact-revision-execution`

## Executor instructions

Read this plan completely and compare the current implementation with `17bcf28`
after HTML removal. First consolidate only the duplicated exact-revision query
protocol. The Session SQLite catalog phase is conditional: implement it only if
the characterization proves a smaller, more auditable ownership boundary.

Create `plans/016-consolidate-exact-revision-execution-log.md`. Record the
starting/final SHA, runner-family protocol table, parity commands/results,
duplicated schema/order/sort facts counted, 50,000-row artifact bytes before and
after with percentage change, catalog decision/rationale, commits, and final
gate durations. Mark only the optional schema phase `REJECTED` there when its
acceptance criteria fail; the runner consolidation can still complete.

Keep kind-specific request/result parsers strong and type-safe. Do not create a
generic subprocess framework for unrelated protocols.

## Why this matters

Focused and Session queries duplicate the same sensitive lifecycle twice on the
web side: acquire a revision lease, resolve private artifacts, spawn a bounded
child, parse output, verify request/revision fingerprint, map expiry/errors, and
clean up. Their Bun-side runners similarly duplicate argv validation, path
checks, immutable private SQLite opening, dispatch, bounded result output, and
error handling. Fixes can land in one family and not the other.

Session materialization and reads also duplicate knowledge of schema version,
dozens of columns, insert order, sortable columns, and row reconstruction.
That is a maintenance risk, but merely merging two large files would be worse;
the useful target is one small internal representation with separate writer and
reader modules.

## Target outcome

1. One web-server module owns the exact-revision query subprocess lifecycle for
   focused and Session query families.
2. One report-data runner entry owns common argv/path/DB/output handling, with
   typed per-kind codecs.
3. All final kinds retain their current pure parsers, fingerprints, leases,
   byte budgets, and error tags.
4. Unrelated runner protocols remain separate.
5. If justified by measurement, one internal Session SQLite catalog owns schema
   version, column/order mapping, and sort-column coverage without moving SQLite
   knowledge into report-core.

## Current-state evidence

- `apps/web/src/server/focused-report-query-runner.server.ts` and
  `session-query-runner.server.ts` implement parallel lease/spawn/parse flows.
- `packages/report-data/src/focused-report-query-runner.ts` and
  `session-query-runner.ts` implement parallel CLI runner shells and SQLite
  opening.
- After plan 009, the final query families are Support, Overview, Breakdown,
  Sessions, Campaign children, and Neighbors; `html-payload` is gone.
- `session-query-materialization.ts` and `session-query-sqlite.ts` both know the
  Session SQLite schema and mapping, including a large fixed column set.
- report-core owns pure query contracts and must remain SQLite-agnostic.

## Scope

### In scope

- focused/Session server query runners and their report-data child runners;
- one internal exact-revision execution protocol and typed codecs;
- existing runtime path/lease/artifact helpers and focused tests;
- conditional internal Session SQLite schema catalog and parity/size tests.

### Out of scope

- `known-project-sources-runner.server.ts`;
- `session-query-materializer.server.ts` as a separate publication process;
- fresh report payload collection/publication;
- changing public query wire shapes, sort semantics, budgets, or error tags;
- importing `bun:sqlite` into Nitro/client code;
- moving SQLite schema into `@ai-usage/report-core`;
- a universal subprocess abstraction.

## Commands and characterization

```sh
git status --short
git rev-parse --short HEAD
git diff --stat 17bcf28..HEAD -- packages/report-data/src apps/web/src/server
git status --short -- packages/report-data/src apps/web/src/server
bun test packages/report-data/src/focused-report-query-sqlite.test.ts \
  packages/report-data/src/session-query-runner.test.ts \
  apps/web/src/server/report-payload.server.test.ts \
  apps/web/src/server/report-runtime-paths.server.test.ts
```

If either scoped drift command shows changes beyond completed plan 009, STOP,
preserve them, and re-characterize both runner families on the rebased code
before editing.

Before refactoring, record for each runner family:

- accepted kinds and request/result parser;
- lease acquisition/release and expiry mapping;
- exact artifact paths and permission checks;
- stdout/stderr/result byte budgets;
- abort/timeout behavior and cleanup;
- Session SQLite column count, schema version, 50,000-row artifact bytes, and
  every supported sort field/direction.

## Implementation steps

### Step 1 - Freeze parity and failure behavior

Add table-driven tests for all six post-HTML kinds—`support`, `overview`,
`breakdown`, `sessions`, `campaign-children`, and `neighbors`:

- valid request and result;
- wrong revision;
- wrong canonical request fingerprint;
- expired/missing lease;
- child nonzero exit;
- malformed/extra stdout;
- bounded stderr tail;
- result artifact/output above its kind budget;
- abort and cleanup.

Also add a source-level/package-boundary assertion that web/Nitro modules do not
import `bun:sqlite`.

### Step 2 - Create one web exact-revision executor

Create `apps/web/src/server/revision-query-runner.server.ts` that owns:

1. validating the revision/request envelope;
2. acquiring and releasing the immutable revision lease;
3. resolving and no-follow validating private revision artifacts;
4. selecting the typed query codec/child kind;
5. spawning the owned Bun child with bounded stdout/stderr and abort support;
6. parsing exactly one JSON result;
7. verifying revision and canonical request fingerprint;
8. mapping `RevisionExpired` versus `QueryFailed` consistently;
9. cleanup on every path.

Keep a discriminated map from kind to request/result parser. TypeScript must
prove the pairing without `any` or broad `unknown as Result` at call sites.
Thin focused/Session adapter functions may remain only if they improve public
typing, but place them in `report-payload.ts` or a newly named codec/adapter
module with no lifecycle logic. Delete the old
`focused-report-query-runner.server.ts` and `session-query-runner.server.ts`
files; do not preserve them as wrappers.

### Step 3 - Create one report-data child entry

Create `packages/report-data/src/revision-query-runner.ts` that owns:

1. argv/kind/request/output-path parsing;
2. workspace/private path validation;
3. opening the leased immutable ai-usage Session SQLite artifact read-only;
4. dispatch to a typed focused/Session codec;
5. exact result serialization and per-kind byte enforcement;
6. atomic/private result output if a result artifact is used;
7. bounded error reporting and DB cleanup.

Keep the pure execution functions in their focused/Session SQLite modules. Do
not combine SQL or result parsers solely to reduce file count.

Update the server executor to use this one child entry and delete the duplicated
runner shells once all tests pass. Delete the old report-data
`focused-report-query-runner.ts` and `session-query-runner.ts` files; any thin
kind-specific argv/codec helper must use a new descriptive name and contain no
spawn/path/DB/output lifecycle.

### Step 4 - Verify query parity before optional schema work

Run the complete query matrix against the same materialized revision and compare
old characterized expected results for:

- Support, Overview, and all Breakdown groups;
- Session pages across every sort field and both directions;
- Campaign children and Neighbors;
- boundary page sizes, omitted metadata, and byte errors.

Commit the runner consolidation before beginning the conditional phase.

### Step 5 - Characterize the Session SQLite ownership seam

Inventory duplicated facts in:

- `packages/report-data/src/session-query-materialization.ts`;
- `packages/report-data/src/session-query-sqlite.ts`.

The acceptable extraction is a small internal
`session-query-storage-schema.ts` owning only:

- one schema version;
- one ordered column catalog;
- column affinity/nullability metadata needed by both sides;
- insert value projection/order;
- the mapping from every pure `sessionSortField` to an audited SQL column;
- reader reconstruction helpers where they remove duplicated positional
  knowledge without hiding SQL.

Writer and query modules remain separate. SQL remains explicit and reviewable.

### Step 6 - Implement or explicitly reject the schema catalog

Implement only if characterization shows the catalog removes duplicated facts
without dynamic-SQL opacity. Add compile/runtime assertions:

- every session sort field has exactly one column;
- insert placeholder count equals catalog/value count;
- writer and reader import one schema version;
- projected values and reconstruction round-trip representative nullable/full
  rows;
- no focused query falls back to `row_json`/`source_row_json` unexpectedly.

Measure the same 50,000-row artifact. It must not grow by more than 5% without
an explained contract change.

If the only result is merging two large files, making SQL harder to audit, or
increasing artifact size, record this phase as `REJECTED` in
`plans/016-consolidate-exact-revision-execution-log.md` and keep the successful
runner consolidation. Do not force an architectural change to satisfy the plan
title.

## Test plan

```sh
bun test apps/web/src/server/report-payload.server.test.ts \
  apps/web/src/server/report-runtime-paths.server.test.ts \
  packages/report-data/src/focused-report-query-sqlite.test.ts \
  packages/report-data/src/session-query-runner.test.ts
bun run --cwd apps/web test
bun x ultracite check
bun run lint
bun run typecheck
bun run test
bun run build
bun run test:e2e-production
```

## Done criteria

- One web exact-revision lifecycle serves both query families.
- One report-data child shell serves both query families.
- All six kinds retain canonical validation, budgets, lease/error semantics, and
  parity.
- Duplicated runner files/code are removed rather than wrapped indefinitely.
- The four legacy runner filenames asserted absent by plan 020 no longer exist;
  optional typed adapters use new names and delegate immediately to the single
  executor.
- No unrelated runner is generalized into this protocol.
- The Session schema phase is either demonstrably implemented with the listed
  invariants or explicitly rejected with measurements and rationale.

## STOP conditions

- Consolidation requires `any`, unlocalized unsafe casts, or weaker kind parsers.
- A result can be accepted without matching revision/fingerprint.
- Lease cleanup, abort, permission, stderr, or byte-budget behavior weakens.
- Nitro/client imports `bun:sqlite`.
- Unrelated subprocess protocols must be pulled into a generic framework.
- The schema catalog makes SQL dynamic/opaque, moves SQLite into report-core,
  merges two large modules without a deeper API, or grows the 50k artifact by
  more than 5% without approval.

## Maintenance note

New exact-revision query kinds must plug into the typed codec map and inherit one
lease/process/validation lifecycle. New storage columns must be represented once
at the narrow report-data storage boundary and remain invisible to pure report
contracts.
