# Plan 014: Enforce Symmetric Portable-Transfer Limits and Add a Safe Import Preview

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: MEDIUM
- **Depends on**: plan 011
- **Category**: correctness / security / transfer UX
- **Based on**: commit `17bcf28`, 2026-07-13
- **Status**: DONE
- **Suggested branch**: `fix/014-portable-transfer-contracts`

## Executor instructions

Read this plan completely and compare current code with `17bcf28` and plan 011.
Implement the shared producer/consumer limits before the UI preview. Preserve
the explicit file-only, local-first transfer model; do not add listeners,
accounts, cloud storage, discovery, background sync, or unbounded server state.

Use reviewable commits for: shared limits/serializers, producers/consumers,
read-only store preview, and `/sync` review UI.

## Why this matters

Portable consumers enforce limits that producers do not consistently enforce.
Snapshot parsing rejects more than 50,000 rows, but snapshot creation can produce
such a file. Merge-bundle creation and parsing do not share the web upload's
50,000-row/64 MiB contract. A successful local export can therefore create a
file the supported importer refuses, and serialization size is often checked
only after data crosses a boundary.

The `/sync` workspace imports immediately after file selection. Users cannot
review machine identity, row counts, warnings, or insert/update/delete effects
before the durable usage store changes. A preview must use the exact same bytes
and store state as the confirmed import or it becomes misleading.

## Target outcome

1. Snapshot and merge producers and consumers share a 50,000-row and 64 MiB
   UTF-8 contract.
2. Creation fails before per-row mapping when row count is too high; serialization
   fails before writing or downloading when exact bytes are too large.
3. Every supported writer uses one canonical serializer, and every reader uses
   the same named limits.
4. CLI portable output is atomically written owner-only.
5. `/sync` first presents a mutation-free preview with provenance, warnings,
   counts, and exact effects.
6. Confirmation is bound to SHA-256 of the exact bytes plus the store generation
   and opaque store identity observed by preview; drift requires a new preview.
7. No truncation, implicit chunking, or partial import occurs.

## Current-state evidence

- `packages/report-core/src/snapshot.ts` defines
  `MAX_USAGE_SNAPSHOT_ROWS = 50_000` and enforces it while parsing, but
  `createUsageSnapshot` does not reject oversized input before mapping.
- `apps/cli/src/snapshot-file.ts` separately defines a 64 MiB read limit.
- `packages/report-core/src/merge-bundle.ts` creates/parses bundles without one
  shared row/serialized-byte budget.
- `apps/web/src/server/manual-merge-upload.server.ts` separately enforces
  50,000 rows and 64 MiB.
- `usage-store.exportLocalMergeBundle` can export all active rows.
- `packages/usage-merge` returns a bundle object for export, allowing callers to
  serialize it differently.
- `apps/web/src/routes/sync.tsx` calls import directly after selecting a file.

## Scope

### In scope

- shared portable row/byte constants and canonical serializers;
- snapshot/merge creation, parsing, CLI file I/O, usage-store export, usage-merge
  service, web upload/download, and associated tests;
- a read-only usage-store preview using the same classification logic as import;
- SHA-256 and store-generation preconditions;
- `/sync` preview/confirm/cancel/error UI and tests.

### Out of scope

- changing portable schemas or deleting `sourcePath`;
- chunked/multipart formats, compression, streaming merge protocols, LAN/cloud
  transfer, or automatic discovery;
- importing more than the bounded single-file contract;
- treating remote `sourcePath` as local, handled by plan 015;
- report-refresh generation semantics, handled by plan 017;
- HTML or another report export format.

## Commands

```sh
git status --short
git rev-parse --short HEAD
git diff --stat 17bcf28..HEAD -- \
  packages/report-core/src packages/usage-store/src packages/usage-merge/src \
  apps/cli/src apps/web/src apps/web/e2e
git status --short -- \
  packages/report-core/src packages/usage-store/src packages/usage-merge/src \
  apps/cli/src apps/web/src apps/web/e2e
bun test packages/report-core/src/snapshot.test.ts \
  packages/report-core/src/merge-bundle.test.ts \
  packages/usage-store/src/index.test.ts \
  packages/usage-merge/src/index.test.ts \
  apps/web/src/server/manual-merge-upload.server.test.ts
```

If either scoped drift command contains changes beyond completed plan 011,
STOP, preserve them, and re-read/rebase the affected format, store, CLI, or web
transfer path before editing.

## Canonical contract

Define the portable budgets in one report-core module with no platform I/O:

- `MAX_PORTABLE_USAGE_ROWS = 50_000`;
- `MAX_PORTABLE_USAGE_BYTES = 64 * 1024 * 1024`;
- exact UTF-8 size via `TextEncoder`, never JavaScript string length;
- limits include the complete document: schema/version, machine metadata,
  warnings, and rows;
- exact limit accepted, limit+1 rejected;
- rejection is explicit, never truncation.

Existing public names may remain as aliases temporarily only within the same
implementation commit; end with one canonical source and no duplicated numeric
literal in web/CLI consumers.

For uploads, retain the bounded raw `Uint8Array`. Compute byte length and SHA-256
from those exact received bytes **before** strict UTF-8 decoding or BOM/newline
handling. A BOM and no-BOM file must have different digests even if both are
accepted into the same parsed JSON value.

## Implementation steps

### Step 1 - Make row limits symmetric

1. In `createUsageSnapshot`, reject `input.rows.length` above the shared limit
   before mapping/serializing any row.
2. Keep snapshot parsing at the same limit and error category.
3. In `createUsageMergeBundle`, reject above the limit before mapping.
4. In `parseUsageMergeBundleValue`, reject the bundle row count before mapping
   each serialized row.
5. Update manual upload code to import the shared limit rather than maintaining
   its own 50,000 literal.
6. Add exact-limit and limit+1 tests to both formats. Use existing synthetic row
   factories; do not duplicate giant fixture files in Git.

### Step 2 - Add canonical exact-byte serializers

Add pure serializers beside the formats:

- `serializeUsageSnapshot(snapshot)`;
- `serializeUsageMergeBundle(bundle)`.

Each must:

1. validate the in-memory value with the same contract used by its parser;
2. produce the one canonical pretty/compact representation chosen for that
   format, including the repository's newline convention;
3. measure the exact returned UTF-8 bytes;
4. throw a typed/domain error before returning when over 64 MiB.

At public text parser entry points, `parseUsageSnapshot(text)` and
`parseUsageMergeBundle(text)` must measure exact UTF-8 bytes and reject above the
same limit **before** `JSON.parse`. Object-value validators retain the row limit
but cannot enforce a serialized-byte contract.

All supported writers must consume the returned exact text. Do not let a web
client receive an object and independently `JSON.stringify` it.

Test exact byte boundaries with injected small budgets plus at least one real
UTF-8 multi-byte case. Row and byte errors must state actual and maximum counts
without including data content.

### Step 3 - Route every producer/consumer through the contract

1. CLI `snapshot --out` uses the canonical snapshot text and an atomic owner-only
   (`0600` POSIX) replacement. It must fail before modifying the destination.
2. CLI snapshot/setup/merge readers use the shared byte constant while preserving
   the existing `apps/cli/src/snapshot-file.ts` bounded no-follow reader; do not
   replace it with an unbounded convenience API.
3. `usage-store.exportLocalMergeBundle` uses one read snapshot to run a
   `COUNT`/`LIMIT max+1` preflight for local-exportable active rows before loading,
   JSON-parsing, or deserializing row bodies. It then exports from that same
   coherent snapshot and fails explicitly above the row limit.
4. `usage-merge.exportManualMergeBundle` returns exact serialized text plus
   row/byte metadata, not an object that callers can reserialize.
5. The web download uses exactly that server-validated text.
6. Manual upload/import first bounds and hashes raw bytes, then strictly decodes
   UTF-8. Before `JSON.parse`, run a bounded structural scanner that locates the
   top-level `rows` array and counts its elements while honoring JSON strings,
   escapes, objects, and nested arrays. Reject above 50,000 without allocating
   the full object graph. Then call `JSON.parse` exactly once and let the
   canonical parser perform the authoritative post-parse count/shape check.
7. Confirm no writer truncates, samples, or silently splits data.

### Step 4 - Extract one usage-store classification engine

Refactor `importMergeRows` so one internal comparison engine classifies each row
as inserted, updated, unchanged, superseded, or deleted. It must support:

- mutation mode inside the existing transaction;
- preview mode inside a read transaction with zero writes;
- the same self-merge, row identity, precedence, and deletion rules;
- one consistent result-count shape.

Expose a narrow `previewPeerMergeBundle` operation through usage-store. Preview
also returns the current store generation/concurrency counter used as a
confirmation precondition. Preserve its current advancement behavior here;
plan 017 later makes that generation semantic. Do not duplicate SQL/precedence
rules in the web layer.

Preview must not call the current mutating `openUsageStoreDatabase`, which sets
WAL mode and runs migrations. Add a separate preview open policy:

- existing current-schema DB: strict read-only open, no migration or write
  PRAGMA, with DB/WAL visible; if reading a WAL would require creating a missing
  SHM/sidecar, return preview-unavailable rather than creating it;
- absent DB: classify against an explicit empty state/generation 0 without
  creating a file or directory, and include `absent` in the state token;
- existing outdated/corrupt schema: return a typed preview-unavailable error
  without migration;
- issue an opaque `storeStateToken` covering absence or current schema,
  generation, and stable main+WAL identity without exposing paths;
- confirmation first re-checks the exact token with a non-mutating probe while
  holding the lifecycle lock, then re-checks it inside its transaction before
  any store write.

Add one owner-only usage-store lifecycle lock used by **every usage-store
mutation**, including current-store imports, create/migrate openers, and manual
confirmation. Keep lock acquisition outside internal DB helpers so one operation
does not deadlock by reacquiring it. Preview remains lock-free/read-only.

After explicit user confirmation, the sequence is:

1. create/validate the private lock directory if needed and acquire the lock;
2. re-read the opaque token with the non-mutating preview probe before opening a
   connection that could set a PRAGMA, migrate, create a sidecar, or write;
3. on mismatch, return `preview-stale` immediately with no store opener/mutation;
4. for `absent`, re-check absence, initialize the private store, and import
   under the lock—the absence check is not described as a DB transaction;
5. for a current-schema store, use a dedicated current-schema mutation opener
   that does **not** run `PRAGMA journal_mode=WAL` or migrations before the
   precondition. Start the write transaction, re-check generation/state identity
   inside it before the first write, then import;
6. release the lock only after commit/rollback and connection cleanup.

An outdated/corrupt preview is unavailable and therefore has no confirm path.
Normal migration entry points take the same lifecycle lock. A competing creator,
migration, local import, or peer import therefore makes the token stale before
confirmation mutates. Add both a two-process absent-preview/confirm/create race
and a current-preview/concurrent-import/stale-confirm test. In the latter,
snapshot state after the competing import and prove stale confirmation neither
opens the mutating path nor changes DB/WAL/SHM entries, hashes, sizes, or mtimes.

Implement that lock privately in usage-store with the same hardened invariants
as plan 011's config lock (do not import local-collectors internals): a validated
non-symlink `0700` lock directory; exclusive no-follow `0600` regular lock file
with one link; owner UUID/PID/hostname and at most 1 KiB metadata; 10 s bounded
acquisition with 10 ms retry; 250 ms heartbeat, 2 s stale lease, 30 s malformed
or abandoned-metadata hard expiry, and dead-local-PID recovery. Never steal a
live owner with a fresh heartbeat and live local PID merely because an import
has run for 30 seconds; a valid large import may legitimately exceed that age.
Cleanup may unlink only the same
device/inode and owner token that the caller acquired, so a replaced lock is
never removed. Cover a live owner timeout, killed/orphaned owner recovery,
replacement-safe cleanup, symlink/hard-link rejection, and no leftover lock on
success/error.

Tests must prove that preview leaves rows, metadata generation, and active
results unchanged. Also snapshot directory entries plus main DB/WAL existence,
size, hash, and mtime before/after preview; an absent preview creates nothing,
and a current preview does not alter main/WAL or create a sidecar. A subsequent
unchanged-state import returns the same classification counts.

### Step 5 - Extend the usage-merge service with preview/confirm

Add explicit operations whose server boundary carries a validated document
containing raw-byte digest/length plus decoded text:

- preview bounded manual bundle bytes/text;
- confirm bounded manual bundle bytes/text with `expectedDigest` and
  `expectedStoreGeneration` plus `expectedStoreStateToken`.

Preview must return JSON-safe:

- exact SHA-256 digest of the received raw bytes;
- file bytes and row count;
- machine ID/label and generated timestamp;
- warnings summary with named limits:
  `MAX_MANUAL_MERGE_PREVIEW_WARNINGS = 20`, at most 512 characters per message,
  at most 16 KiB for serialized warning items, plus exact `warningCount` and
  `omittedWarningCount`; keep the first deterministic sanitized items and never
  include row/session raw content;
- inserted/updated/unchanged/superseded/deleted counts;
- observed store generation;
- opaque store-state token;
- self-merge/invalid-input error without mutation.

Confirmation must recompute digest from newly received raw bytes (never from
decoded/re-encoded text) and compare both store generation and state token
inside the import transaction before writes. A byte, generation, or identity
mismatch returns `preview-stale` and performs zero mutation. This catches an
absent-to-empty-DB transition or DB replacement at the same generation. Do not
retain file contents on the server between calls.

### Step 6 - Add a two-stage `/sync` workflow

Change `apps/web/src/routes/sync.tsx` and its server adapters:

1. Selecting a file uploads it for preview only.
2. Render a review panel with filename, machine, generated time, rows/bytes,
   bounded warnings, and each mutation count.
3. State clearly that peer provenance is preserved and local history is not
   replaced wholesale.
4. Provide explicit Confirm and Cancel actions. Do not auto-confirm.
5. Confirm re-uploads the same client-held `File` with digest and store-generation
   plus opaque store-state preconditions.
6. On `preview-stale`, discard the preview and require a new one.
7. On success, show actual counts returned by import and refresh report state
   through the existing supported mechanism.
8. Preserve Host/Origin/body trust checks and progress/error accessibility.

Add server tests for BOM/no-BOM digest distinction, invalid UTF-8, structural
row preflight with escaped/nested JSON, digest mismatch, absent/current/outdated
store preview, DB replacement at the same generation, absent-to-empty-store
drift, missing-SHM WAL policy, self merge, oversized bytes, too many rows,
preview no-op, and successful exact confirmation.

Add exact/+1 warning item, character, and UTF-8 byte tests, including deterministic
truncation/omission counts.

Create `apps/web/e2e/sync.spec.ts`; its browser test verifies no durable row
exists before Confirm and verifies Cancel leaves the store unchanged.

## Test plan

```sh
bun test packages/report-core/src/snapshot.test.ts \
  packages/report-core/src/merge-bundle.test.ts \
  packages/usage-store/src/index.test.ts \
  packages/usage-merge/src/index.test.ts \
  apps/cli/src/snapshot-file.test.ts \
  apps/web/src/server/manual-merge-upload.server.test.ts
CI=1 bun run --cwd apps/web test:e2e -- e2e/sync.spec.ts
bun x ultracite check
bun run lint
bun run typecheck
bun run test
bun run build
```

## Done criteria

- Producers cannot create a file that supported consumers reject solely for
  shared row/byte limits.
- All supported writers use canonical exact bytes.
- 50,000/exact-byte boundaries pass and +1 boundaries fail before mutation.
- CLI portable output is atomic and private.
- Preview uses the exact import classifier and performs no mutation.
- Confirm is bound to the exact raw-byte digest, store generation, and opaque
  store-state identity.
- Every store mutation uses the hardened lifecycle lock; stale absent/current
  confirmation fails at the non-mutating pre-check before a mutating opener.
- Preview never initializes/migrates a store, creates an absent DB/sidecar, or
  changes main DB/WAL content/metadata; any required pre-existing SHM read
  coordination is characterized separately.
- `/sync` requires an explicit accessible confirmation.
- No partial/truncated import, hidden server copy, or network sync appears.

## STOP conditions

- A supported producer requires silently truncating or chunking the current
  format to fit.
- Exact serialized bytes cannot be shared between validation and output.
- Preview duplicates precedence/merge logic outside usage-store.
- A confirm initializes/opens mutably before the lock plus non-mutating token
  pre-check, or any store mutation/create/migrate path bypasses that lock.
- Lifecycle lock acquisition is unbounded, uses age-only stealing, or cleanup
  can unlink a replacement owned by another process.
- Confirmation can mutate after digest or generation mismatch.
- A preview changes store rows or metadata generation.
- Preview uses the mutating store opener, changes main DB/WAL metadata, creates
  an absent store/sidecar, or migrates an old schema.
- The implementation stores unbounded file content between requests.
- Existing supported fixtures exceed the limits; document evidence and make an
  explicit format/product decision first.
- Upload row preflight allocates the complete object graph or calls `JSON.parse`
  before rejecting row 50,001.
- The plan expands into LAN/cloud/account synchronization.

## Maintenance note

Every portable format must have one schema validator, row budget, exact-byte
budget, canonical serializer, bounded reader, and symmetric producer/consumer
tests. Preview and mutation must share one classification engine and explicit
state preconditions.
