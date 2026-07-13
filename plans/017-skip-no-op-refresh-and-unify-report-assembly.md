# Plan 017: Skip Semantically Unchanged Refreshes and Unify Report Assembly

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: plans 010-016
- **Category**: performance / correctness / report architecture
- **Based on**: commit `17bcf28`, 2026-07-13
- **Status**: DONE
- **Suggested branch**: `perf/017-semantic-report-refresh`

## Executor instructions

Read this plan completely and compare current code with `17bcf28` plus all
dependency implementations. Implement it in three reviewable commits: semantic
store generation, pure report assembly, then changed/unchanged publication.
Instrument behavior before refactoring; wall-clock observations alone are not
acceptable proof.

Preserve immutable exact revisions, leases, expiry recovery, concurrent refresh
supersession, and last-good behavior. Never mutate a published revision in place.

## Why this matters

The dashboard schedules a forced refresh every 60 seconds. The server invalidates
its latest job and runs fresh collection/publication. The fresh report runner
builds a local complete payload, imports rows, then builds another complete
stored payload, retaining mostly the first pass's warnings. Revision publication
serializes and materializes Session SQLite even when reportable data is identical.

The usage-store generation also increments for a repeated identical import, so
the existing source fingerprint cannot identify a semantic no-op. Generated
timestamps then make byte comparison useless. This creates continuous CPU,
filesystem, and query churn while the visible report has not changed.

## Target outcome

1. Usage-store generation changes only when reportable active data changes.
2. One deep pure assembly module builds local, stored, merged, and fresh payloads
   consistently.
3. Fresh collection/import occurs once and report assembly occurs at most once
   for a changed capture, not twice.
4. A semantic fingerprint covers store generation, config, datasets, and
   warnings but excludes `generatedAt` and observation-only metadata.
5. A refresh returns `changed` or `unchanged` explicitly.
6. An unchanged refresh before expiry keeps the same revision and performs no
   payload serialization or Session SQLite materialization.
7. TTL renewal, when necessary, reuses validated immutable artifacts without
   rebuilding Session SQLite.
8. Fatal refresh failure and superseded work keep the last good revision.

## Current-state evidence

- `packages/usage-store/src/index.ts:importMergeRows` increments metadata
  generation for every non-empty import, including unchanged rows whose
  observation metadata is touched.
- A current test expects repeated identical import to advance generation.
- `packages/report-data/src/report-payload-runner.ts` fresh mode builds a local
  payload and then a stored payload, discarding most of the first payload.
- report-data repeats lineage/group/projection/payload assembly across local,
  stored, and merged paths.
- `apps/web/src/server/report-payload.server.ts` invalidates/forces a new job
  before it knows whether reportable state changed.
- `report-revision.server.ts` serializes artifacts, creates a revision directory,
  and materializes Session SQLite for every publication.
- `readStoredReportSourceFingerprint` already combines config fingerprint and
  store generation, but the generation is not semantic and datasets/warnings
  are not fully represented.

## Scope

### In scope

- usage-store generation semantics and tests;
- one pure internal report assembly module in report-data;
- fresh runner capture/result protocol and artifact validation;
- semantic capture fingerprint;
- server refresh job caching/supersession/publication;
- revision manifest metadata and safe artifact reuse for TTL renewal;
- deterministic counters/tests proving skipped work.

### Out of scope

- reducing the polling interval or adding filesystem watchers;
- changing report rows, analytics, grouping, pricing, URL, or query semantics;
- mutating/renewing published revision files in place;
- skipping fresh collection entirely without a trustworthy source signal;
- browser destination coordination, completed by plan 018;
- removing complete payloads needed by CLI/internal publication.

## Commands and baseline

```sh
git status --short
git rev-parse --short HEAD
git diff --stat 17bcf28..HEAD -- \
  packages/usage-store/src packages/report-data/src apps/web/src/server
git status --short -- \
  packages/usage-store/src packages/report-data/src apps/web/src/server
bun test packages/usage-store/src/index.test.ts \
  packages/report-data/src/reporting.test.ts \
  apps/web/src/server/report-payload.server.test.ts \
  apps/web/src/server/report-revision.server.test.ts
```

If either scoped drift command contains work beyond completed plans 010-016,
STOP, preserve it, and rerun the baseline characterization after rebasing all
overlapping storage/report/server changes.

Add deterministic test instrumentation before code changes. For two identical
refreshes, record:

- local collection calls;
- provider dataset/status calls;
- store import classifications and generation;
- assembly calls;
- serialized artifact writes/bytes;
- Session materializer calls;
- revision directories/manifests created.

The old behavior should demonstrate redundant generation/assembly/publication.

## Implementation steps

### Step 1 - Make usage-store generation semantic

Change `importMergeRows` so one transaction increments
`usage_store_metadata.generation` exactly once only when the transaction's
before/after **active report projection** differs. Keep result counters separate
from this boolean; `inserted + updated + deleted + superseded > 0` is not a
sufficient proxy because inserting or updating an already non-active tombstone
does not change the report.

At row-classification time, compute whether active membership, active content,
or active source authority (plan 015) changes. An empty import, unchanged row,
or non-active-to-non-active change may update private observation/tombstone
metadata but does not change report generation. Preserve transactional result
counters.

Add tests for:

- identical repeat: `unchanged === 1`, generation unchanged;
- insert and semantic update: +1 each;
- active to deleted/superseded transition: +1;
- absent to deleted/superseded tombstone and non-active-to-non-active update:
  generation unchanged;
- opaque-to-local authority change on an active row: +1;
- mixed unchanged/changed rows: exactly +1;
- empty import: unchanged;
- preview from plan 014: generation unchanged.

Search every generation consumer. STOP if a real consumer requires the number
of observations rather than reportable state; separate an observation counter
instead of overloading report generation.

### Step 2 - Extract one pure report assembly module

Create `packages/report-data/src/report-assembly.ts`. Its input is already-read
data and explicit context; it performs no filesystem, collector, config, clock,
or SQLite I/O. It owns:

- project/group projection after plan 015's authority decisions;
- lineage normalization;
- `prepareUsageReport`;
- datasets/facets integration;
- warning normalization;
- `createUsageReportPayload`.

Pass `generatedAt` explicitly. Make `createLocalReportPayload`,
`createStoredReportPayload`, and `createMergedUsageReport` delegate to this one
assembly while preserving their public signatures and outputs.

With a fixed clock/config/input, assert exact parity for rows, tableRows,
analytics, groups, datasets, facets, warnings, and ordering. A new module that
performs its own I/O is a failed extraction.

### Step 3 - Separate fresh capture/import from assembly

Refactor fresh mode so it:

1. collects local rows, warnings, and datasets once;
2. imports/updates the usage store once;
3. reads the coherent stored report rows/source metadata once;
4. constructs an explicit capture descriptor;
5. assembles a complete payload only if the descriptor is semantically changed.

Do not create a local payload merely to discard it. Ensure collector warnings
and provider/Cursor datasets enter the final stored payload exactly once.

Add call-count tests proving one dataset collection and one assembly for a
changed fresh run.

### Step 4 - Define and persist a semantic capture fingerprint

Create a canonical, versioned fingerprint input containing:

- semantic usage-store generation;
- semantic config fingerprint;
- local/peer source/provenance state that affects report output;
- normalized provider status/datasets/facets that affect output;
- normalized warning semantics/counts.

Define one explicit **report-affecting config projection** rather than hashing
the complete config file. Include every alias/group/source option consumed by
report assembly; exclude Skills-only/control-plane settings that cannot change
the report. The assembler and fingerprint must consume the same projection.

Exclude:

- `generatedAt` and polling time;
- observation-only `last_seen_at`;
- temp paths, PIDs, ordering artifacts, or cache mtimes;
- revision ID and lease expiry.

Canonicalize ordering and hash a strictly validated serialized form. Any field
excluded as volatile (temporary path, PID, observation timestamp) must also be
normalized/omitted identically from the payload/warning/dataset assembled for
clients. If it remains visible, include it exactly in the fingerprint. There may
be no visible payload field whose change is hidden from the fingerprint.

Store `captureFingerprint` in the immutable revision manifest and validate it on
read. Version the manifest if required; reject malformed old/new combinations
rather than guessing.

### Step 5 - Return a discriminated runner result

Change the fresh report runner protocol to receive the current validated
fingerprint (when any) and return one of:

- `unchanged`: small metadata containing fingerprint and capture outcome;
- `changed`: fingerprint plus one fully assembled, bounded payload artifact.

The server must parse/validate the discriminant and bounds before acting. The
unchanged branch must not serialize a full payload to stdout or a temp artifact.
Fatal collection errors are neither changed nor unchanged; preserve the current
last-good failure path.

Define `MAX_UNCHANGED_CAPTURE_RESULT_BYTES = 64 * 1024` beside the report runner
artifact budgets. Measure exact UTF-8 bytes and add exact/+1 parser/runner tests;
the unchanged result contains only version, discriminant, fingerprint, and
bounded capture metadata.

### Step 6 - Stop invalidating before change is known

Refactor `report-payload.server.ts` job orchestration:

1. keep request coalescing and supersession tokens;
2. start fresh capture without invalidating the current revision;
3. define an injectable/tested `REVISION_RENEWAL_WINDOW_MS = 60_000`; on
   `unchanged` with remaining TTL strictly greater than that window, retain
   exactly the current revision and data `generatedAt`;
4. on `changed`, publish one new immutable revision atomically;
5. on error or supersession, retain the last good current revision;
6. never let an older completion replace a newer one.

An unchanged refresh may update small in-memory/server registry timing metadata
only if that metadata is not part of immutable artifacts or client data.

### Step 7 - Renew expiry without rematerializing data

If a semantically unchanged current revision is too close to expiry:

1. renew when remaining TTL is less than or equal to the 60,000 ms window;
2. validate the current manifest, hashes, permissions, rows/support artifacts,
   and Session SQLite artifact;
3. create a new immutable revision directory/manifest atomically;
4. copy each validated artifact byte-for-byte through no-follow read handles and
   exclusive `0600` destination files, fsync, recompute hashes/bytes, and verify
   equality. Do not hard-link revisions or call the Session materializer;
5. recompute the new manifest/revision identity as required;
6. preserve the original data `generatedAt` and capture fingerprint.

If the artifact format embeds revision identity and cannot be safely reused,
STOP and document that fact. Do not mutate an artifact in place or lie about its
revision.

### Step 8 - Prove work is skipped and changes still publish

Add deterministic tests:

- two identical refreshes before TTL: one assembly/materialization/revision;
- identical refresh near expiry: new valid revision, same fingerprint/data time,
  zero new Session materialization;
- renewal threshold at 60,001 ms remaining: same revision; at 60,000 ms: copied
  renewal, with exact artifact byte/hash parity and private modes;
- usage row, config, dataset, provider status, or warning semantic change: one
  new assembly/publication;
- Skills-only/non-report config change: unchanged; report alias/group config
  change: changed;
- volatile warning/path/PID input normalized out of the fingerprint is also
  absent/normalized identically in the visible payload;
- repeated identical manual import: no generation/revision;
- concurrent older changed result resolves last: never current;
- fatal fresh failure: previous revision remains served;
- malformed fingerprint/result/artifact: rejected without current invalidation.

## Test plan

```sh
bun test packages/usage-store/src/index.test.ts \
  packages/report-data/src/report-assembly.test.ts \
  packages/report-data/src/reporting.test.ts \
  packages/report-data/src/report-payload-artifact.test.ts \
  apps/web/src/server/report-payload.server.test.ts \
  apps/web/src/server/report-revision.server.test.ts
bun x ultracite check
bun run lint
bun run typecheck
bun run test
bun run build
bun run test:web-production
bun run test:e2e-production
```

## Done criteria

- Store generation reflects reportable changes, not observations.
- All report construction paths delegate to one pure assembly owner.
- Changed fresh capture performs one assembly; unchanged performs none.
- Unchanged refresh before TTL creates no artifact, materialization, or revision.
- TTL renewal reuses validated immutable data without Session rematerialization.
- Unchanged runner results are capped at 64 KiB and TTL behavior uses the named
  injectable 60-second renewal window.
- Semantic changes publish exactly one new revision.
- Failures/superseded work preserve the last good revision.
- Fingerprints include every visible dataset/warning/config/store dependency and
  exclude time-only noise.
- Report assembly and fingerprint share the same report-config and volatile-field
  projections; no visible change can be fingerprint-invisible.

## STOP conditions

- A real generation consumer depends on observation count and no separate field
  has been designed.
- The assembly module reads filesystem, config, clock, collectors, or SQLite.
- Fixed-input parity changes report semantics unintentionally.
- The fingerprint omits provider status, Cursor attribution, warnings, config,
  or reportable source state.
- Unchanged handling invalidates or mutates the current revision.
- TTL renewal changes an artifact in place, lies about embedded revision, or
  weakens hashes/permissions.
- Concurrent stale work can become current.
- Skipping work requires trusting only mtimes or unchecked cache state.

## Maintenance note

New report-visible inputs must be added to the versioned semantic fingerprint
and pure assembly input together. Observation metadata must never masquerade as
a report generation, and published revisions remain immutable regardless of
optimization.
