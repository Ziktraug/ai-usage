# Plan 015: Treat Portable Source Paths as Opaque Provenance

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MEDIUM
- **Depends on**: plans 011, 013, and 014; plan 013 first establishes the
  report-data dataset/warning seam that overlaps source assembly
- **Category**: security / correctness / provenance architecture
- **Based on**: commit `17bcf28`, 2026-07-13
- **Status**: DONE
- **Suggested branch**: `fix/015-opaque-portable-paths`

## Executor instructions

Read this plan completely and compare current report-data/storage code with
`17bcf28` plus plans 011/014. The fix is capability/provenance based: a
serialized `machineId` or path string is never proof that a filesystem read is
allowed. Preserve portable path text for display and matching.

Write the filesystem-spy regression tests before changing canonicalization.

## Why this matters

Snapshot and merge formats legitimately carry `sourcePath` from another
machine. Report-data currently canonicalizes project paths and probes `.git`,
`gitdir`, and `commondir` while building project sources. A peer can provide a
path that happens to exist locally, causing ai-usage to read local repository
metadata and attach it to remote provenance.

Checking `row.machineId === localMachineId` is not a fix: a portable file can
forge that string. Filesystem authority must come only from the trusted local
collection/storage channel through which a row entered the operation.

## Target outcome

1. Rows collected locally in the current trusted channel may retain current
   path canonicalization and Git enrichment.
2. Rows originating from any portable snapshot/merge remain opaque even if
   their machine ID and path equal local values.
3. No filesystem callback receives a path sourced only from portable data.
4. Opaque paths remain present exactly for display, provenance, project
   grouping, and exact selector matching.
5. Worktree canonicalization and Git remote enrichment continue for genuinely
   observed local projects.

## Current-state evidence

- `packages/report-core/src/serialized-usage-validation.ts` correctly accepts
  textual `sourcePath` in a portable row.
- `packages/report-data/src/index.ts` has Git file reads, gitdir/commondir
  resolution, path canonicalization, worktree handling, and remote enrichment.
- Rows from local collection and supplied snapshots converge before parts of
  that source enrichment pipeline.
- `listProjectSourcesWithWarnings`, merged reports, setup, and stored reports can
  therefore expose portable paths to local filesystem callbacks.

## Scope

### In scope

- internal report-data provenance/capability representation;
- local, stored-local, and portable source assembly paths;
- Git/worktree enrichment/canonicalization gates;
- project-source/setup/reporting tests with filesystem spies;
- current architecture/domain documentation of source trust.

### Out of scope

- removing, redacting, normalizing, or rejecting portable `sourcePath`;
- changing the portable schema;
- sandboxing all local Git reads or protecting against a malicious same-UID
  process racing trusted local files;
- using machine ID as a trust signal;
- changing group selector semantics or project names.

## Commands

```sh
git status --short
git rev-parse --short HEAD
git diff --stat 17bcf28..HEAD -- \
  packages/report-data/src packages/report-core/src packages/usage-store/src \
  packages/usage-merge/src apps/cli/src apps/web/src docs
git status --short -- \
  packages/report-data/src packages/report-core/src packages/usage-store/src \
  packages/usage-merge/src apps/cli/src apps/web/src docs
bun test packages/report-data/src/reporting.test.ts \
  apps/cli/src/setup.test.ts
```

If either scoped drift command contains changes beyond completed plans
011/013/014,
STOP, preserve them, and rebase/re-read every overlapping source assembly path
before editing.

## Trust model

Define an internal, non-serialized distinction such as:

- `local-observed`: the path came from a local collector or the usage-store's
  guaranteed local namespace;
- `portable-opaque`: the path came from a caller-supplied snapshot or peer merge
  namespace.

Carry that distinction with each source candidate/row through enrichment. Do
not reduce it to a set of strings: a local and portable row can contain the same
path text but must retain different authority. Do not infer it from machine ID,
machine label, hostname, path prefix, existence, or equality with a local path.

## Implementation steps

### Step 1 - Add failing portable-path probe tests

Using injected `readGitFile`/filesystem callbacks and temporary repositories,
cover:

1. A peer snapshot path that exists as a real local Git repo: zero read calls,
   unchanged path text, and no local remote attached.
2. A snapshot declaring the actual local machine ID: still zero reads.
3. Local and portable rows with identical path text: only the local candidate
   permits Git/canonicalization work; the portable result remains opaque.
4. A portable worktree-looking path with `.git` indirection: no probe.
5. `setup <snapshot>` and `projects list --paths <snapshot>`: no local probe for
   supplied snapshot paths.
6. Existing genuinely local worktree/commondir cases retain current behavior.
7. A peer row colliding with an existing local-observed row is rejected without
   content/authority mutation; a genuine later local collection may safely
   upgrade an old opaque row and advances the current store generation. Plan 017
   must preserve that authority transition as a report-semantic change.

The first four should fail against the old behavior and pass only after the
authority distinction is carried end to end.

### Step 2 - Introduce an internal source-candidate authority

In report-data, define an internal wrapper for source-building inputs containing
the row/source fields and explicit authority. Keep it private; do not add the
flag to `UsageRow`, snapshots, merge bundles, public report payloads, or UI JSON.

Update `canonicalProjectSource`, source collection, projection building, and
Git enrichment to require the authority explicitly. There must be no permissive
default parameter.

Only `local-observed` candidates may call:

- `realpath`/filesystem canonicalization;
- `.git`, `gitdir`, or `commondir` readers;
- worktree collapse;
- Git remote enrichment.

Portable candidates pass through their existing textual project/source fields.

### Step 3 - Assign authority at trustworthy boundaries

1. In local-only report collection, mark rows directly returned by local
   collectors as `local-observed` before any merge/projection.
2. In `createMergedUsageReport` and `listProjectSourcesWithWarnings`, keep
   locally collected rows separate long enough to mark them. Mark all rows from
   caller-supplied snapshots `portable-opaque`, regardless of machine ID.
   Perform row deduplication on `(row, authority)` candidates with the exact
   current snapshot winner rule (same identity key, generated-time ordering and
   tie behavior). Authority travels only with the winning candidate; never
   union/upgrade it because a losing local duplicate existed, and never keep
   both rows. If needed, extract the pure key/comparator from report-core rather
   than merge rows first and guess provenance afterward.
3. In stored reports, derive authority from the usage-store's trusted namespace
   or source metadata: locally captured namespace is local-observed; imported
   peer namespace is portable-opaque.
4. The current store schema erases this channel. Add an ai-usage-owned
   `source_authority`/equivalent column populated only by the import API:
   `importLocalRows` writes `local-observed`; `importPeerMergeBundle` writes
   `portable-opaque`. A serialized row cannot set it.
5. Migrate every pre-existing row to the safe `portable-opaque` default. A later
   genuine local collection may re-establish `local-observed`; never infer it
   from an existing row's machine ID. Return rows plus this non-serialized tag
   through a narrow usage-store query contract consumed by report-data.
6. Define collision/update behavior explicitly: a peer import can never upgrade
   authority **or overwrite/downgrade an existing `local-observed` row**. Treat
   that row-key collision as an explicit invalid/conflict result with zero
   mutation for the bundle. Only `importLocalRows` may grant/restore
   `local-observed`; an opaque-to-local transition is a semantic update and must
   advance the current usage-store generation. When plan 017 redefines that
   counter, this transition remains in its reportable projection.
7. Ensure deduplication/grouping does not let a trusted duplicate transfer
   authority to an untrusted candidate. Define which output source retains each
   original provenance before aggregation.
8. Extend plan 014's shared preview/import classifier with the same authority
   collision rule so `/sync` previews the conflict and confirmation cannot
   partially mutate before discovering it.
9. Replace local-capability queries that currently filter only by
   `originMachineIds: [machine.id]`: `exportLocalMergeBundle`, known-local
   project-source discovery, and any equivalent path must require
   `source_authority = local-observed`. Machine ID remains provenance only.

Add migration/classifier tests for: legacy row becomes opaque; same-content
local re-import upgrades it to local-observed, reports one updated
classification, and advances the current generation (plan 017 later preserves
that transition as semantic);
peer collision with local-observed rolls back the entire bundle; preview and
confirm report the identical conflict with zero mutation; a legacy/peer opaque
row carrying the local machine ID is excluded from local export/discovery while
a genuinely local-observed row is included.

Add merged-report dedupe tests for the same machine/harness/session key with one
local-observed and one portable-opaque candidate: portable older/local newer,
local older/portable newer, and exact-tie order, with differing metrics/path.
Assert exact current winning-row parity, one counted row, and authority from the
winner only.

Perform filesystem enrichment per candidate **before** public source
aggregation. If local and portable candidates collide on the current public
source identity, preserve the current single public aggregate: numeric/session
facts may aggregate, while local-observed display/canonical/Git enrichment wins
only because that local candidate independently authorized the read. A portable
candidate never initiates or broadens a probe. Drop the authority tag only after
all filesystem-capable work is complete, and perform no filesystem reads on the
combined public object.

### Step 4 - Preserve opaque-path product behavior

For `portable-opaque`:

- keep `sourcePath` text unchanged;
- keep project name and machine provenance;
- allow existing exact/path selector matching against the text;
- leave Git remote empty unless it was explicitly serialized in a currently
  supported trusted field (do not add such a field in this plan);
- never emit a warning containing the full path merely because it is opaque.

Add regression tests for project grouping, selectors, report rows, and setup
display so the security fix does not make peer projects disappear.

### Step 5 - Document the boundary

Update `CONTEXT.md` and `docs/architecture.md`:

- portable paths are provenance labels, not local filesystem capabilities;
- only locally observed/store-local source candidates may be enriched;
- machine identity identifies provenance/deduplication but grants no authority;
- the original portable path remains displayable/matchable.

Add a code comment at the single authority-construction boundary, not scattered
comments at every `if`.

## Test plan

```sh
bun test packages/report-data/src/reporting.test.ts \
  packages/report-core/src/snapshot.test.ts \
  packages/report-core/src/merge-bundle.test.ts \
  packages/usage-store/src/index.test.ts \
  packages/usage-merge/src/index.test.ts \
  apps/web/src/server/manual-merge-upload.server.test.ts \
  apps/cli/src/setup.test.ts
bun x ultracite check
bun run lint
bun run typecheck
bun run test
bun run build
```

## Done criteria

- No filesystem callback receives a path from portable-only provenance.
- Forging/equaling the local machine ID grants no filesystem access.
- Equal path strings retain separate authority until enrichment/aggregation.
- Cross-authority duplicate usage rows preserve the current single winner and
  carry only that winner's authority, with no double count or local upgrade.
- A local/portable public-ID collision keeps one deterministic aggregate; only
  the local candidate can supply enrichment and the combined object is inert.
- Remote path text and selector behavior remain intact.
- Genuine local Git/worktree enrichment retains parity.
- The authority tag is an internal runtime/storage contract and cannot be
  supplied through a portable file or serialized into report/UI payloads.

## STOP conditions

- Trust is inferred from serialized machine ID, label, hostname, path text, or
  path existence.
- The proposed fix deletes/redacts/rejects portable paths instead of making them
  opaque.
- Exact project selectors stop matching portable path text.
- A filesystem callback is invoked with a path that came only from a portable
  snapshot/merge.
- Local worktree canonicalization regresses without an intentional product
  decision.
- The authority tag leaks into a portable, report, or browser-JSON contract.
- Existing stored rows are upgraded to local authority from machine ID/path
  heuristics instead of defaulting safely opaque.

## Maintenance note

Data provenance and local authority are separate concepts. Every new portable
field that resembles a local resource identifier must remain inert until a
trusted local channel explicitly grants a capability for that specific item.
