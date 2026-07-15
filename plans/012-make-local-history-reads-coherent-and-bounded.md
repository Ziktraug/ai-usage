# Plan 012: Make Local-History Reads WAL-Coherent, Bounded, and No-Follow

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: MEDIUM
- **Depends on**: plans 010 and 011; plan 010 first freezes Cursor-import CLI
  behavior before this plan extracts it
- **Category**: correctness / security / performance / collector architecture
- **Based on**: commit `17bcf28`, 2026-07-13
- **Status**: DONE
- **Suggested branch**: `fix/012-local-history-io`

## Post-implementation capacity amendment — 2026-07-14

The initial 2 GiB aggregate discovery budget was removed after a real Codex
history reached 2.55 GiB across roughly one thousand sessions. Aggregate bytes
on disk are not resident memory now that JSONL parsing is incremental, and the
limit excluded exactly the long-running sessions the product exists to report.

Traversal remains bounded by depth and file count. JSONL files are visited one
at a time with fatal UTF-8 decoding, an 8 MiB decoded-line ceiling, and a 1 GiB
per-session file ceiling. Small JSON, caches, and Cursor CSV retain their own
smaller explicit limits. Callers that need a task-specific aggregate byte limit
may still inject `walkFiles(..., { maxBytes })`; such failures remain typed and
recoverable.

## Post-implementation config-symlink amendment — 2026-07-15

The no-follow contract applies to harness-owned history, databases, caches, and
scan roots. User-owned configuration files are an explicit, narrow exception
because dotfile managers commonly install them as symbolic links. The config
reader inspects each link with `lstat`/`readlink`, rejects cycles and excessive
depth, and only then applies the same bounded `O_NOFOLLOW` regular-file read to
the final target. Configuration paths never enter history traversal.

## Executor instructions

Read this plan completely. Compare the current commit with `17bcf28` and plan
011's implementation. Characterize WAL behavior with a real temporary SQLite
writer before changing the reader. Keep pure in-memory fixtures for parser unit
tests, but use real files for filesystem, cache, symlink, and WAL assertions.

Deliver in two commits: WAL/cache coherence first, bounded/no-follow streaming
I/O second. No collector may silently return a partial result as complete.

## Why this matters

The shared SQLite reader opens Cursor/OpenCode databases with `immutable=1`.
Immutable mode ignores live WAL state, so sessions committed only to `-wal` can
be absent. The collector cache fingerprints only the main DB, allowing a stale
cache hit while the WAL changes.

File collectors also read entire JSON/JSONL/CSV files and walk directories with
no depth, file-count, per-file, or aggregate-byte limit. Symlink/non-regular
handling is not an explicit contract. A corrupted, adversarial, or simply huge
local history can cause memory exhaustion, excessive traversal, or reads outside
the intended history tree.

## Target outcome

1. Cursor and OpenCode see committed rows still present only in WAL.
2. One collection reads a coherent SQLite snapshot with no DB/WAL data write or
   checkpoint; SQLite's read-coordination SHM mutation is permitted only where
   the runtime requires it and is explicitly characterized.
3. Cache keys include stable main+WAL identity, and cache writes occur only when
   the source fingerprint is unchanged across collection.
4. All local-history text/line and directory traversal is explicitly bounded.
5. Harness-history file and directory symlinks, FIFOs, devices, and other
   non-regular inputs are rejected without following them; explicitly selected
   user configuration files follow only the validated exception above.
6. JSONL/CSV parsing streams incrementally rather than reconstructing a complete
   file or all lines in memory.
7. Limit failures become structured harness/import failures, never silent
   truncation.

## Current-state evidence

- `packages/local-collectors/src/local-history.ts` implements `readText` with
  full `readFileSync`, opens SQLite with `immutable=1`, and has an unbounded
  recursive `walkFiles`.
- `collector-cache.ts` fingerprints only main-file mtime/size.
- Cursor and OpenCode use that cache around SQLite collection.
- Claude and Codex read JSONL histories in full; Cursor CSV collection and the
  CLI Cursor importer read complete CSV buffers.
- `TestMemoryStorage` proves parsing but bypasses real WAL, file identity,
  symlink, descriptor, and growth behavior.

## Scope

### In scope

- `local-history.ts`, `collector-cache.ts`, and focused new helpers/tests;
- Cursor/OpenCode SQLite collection and cache versions;
- Claude/Codex JSONL, quota/index, and Cursor CSV reads;
- the CLI Cursor import reader/copy path;
- memory-storage adaptations needed to preserve pure parser tests;
- structured warnings and failure propagation for exceeded budgets.

### Out of scope

- modifying, checkpointing, copying, chmodding, or migrating a harness DB;
- parsing metric values, handled by plan 013;
- portable snapshot/merge upload budgets, handled by plan 014;
- changing provider business semantics or row shape;
- an abstract filesystem framework exposed across packages.

## Commands

```sh
git status --short
git rev-parse --short HEAD
git diff --stat 17bcf28..HEAD -- \
  packages/local-collectors/src apps/cli/src
git status --short -- packages/local-collectors/src apps/cli/src
bun test packages/local-collectors/src/collector-cache.test.ts \
  packages/local-collectors/src/db-collectors.test.ts \
  packages/local-collectors/src/codex-history.test.ts
```

If either scoped drift command contains changes beyond completed plans 010-011,
STOP, preserve them, and re-read/rebase the affected storage/collector path
before editing.

## Required budgets

Define named constants in a focused `history-budgets.ts` (or equivalent) and
inject smaller limits in tests. Initial production budgets:

| Purpose | Limit |
| --- | ---: |
| Small config/index JSON | 1 MiB |
| Collector/Claude row cache JSON | Candidate 128 MiB; freeze after characterization |
| One JSONL history file | 128 MiB |
| One decoded line | 8 MiB |
| Cursor CSV file/import | 64 MiB |
| Directory depth | 64 |
| Files per harness scan | 50,000 |
| Aggregate bytes per harness scan | 2 GiB |

These are maximum supported inputs, not truncation points. If a current
deterministic supported fixture exceeds one, STOP and document the real size and
access pattern before changing a value. Tests must use injected small budgets or
sparse files, not allocate multi-GiB data.

Before fixing the row-cache budget, serialize the deterministic supported
50,000-row workload and record bytes for generic collector and Claude caches.
The chosen cache limit must admit that workload with documented headroom and
remain no larger than necessary. Cache read and write use the same limit; an
oversized/invalid cache is a non-fatal cache miss, and an oversized new cache is
not written.

## Implementation steps

### Step 1 - Prove live-WAL behavior with a real database

Add `packages/local-collectors/src/local-history.test.ts` with a temporary Bun
SQLite database that:

1. enables `journal_mode=WAL` and `wal_autocheckpoint=0`;
2. keeps a writer open;
3. commits a row known to remain in WAL;
4. demonstrates that the old immutable reader misses it;
5. asserts the replacement reader sees it;
6. leaves main DB/WAL content hash, size, and modification time unchanged except
   reader-managed SHM behavior; do not assert access time, which a read may
   legitimately update.

Add Cursor and OpenCode integration fixtures that assemble a real session from
such a DB. Do not accept a mocked `openDb` as proof.

### Step 2 - Open a coherent read-only SQLite snapshot

1. Remove `immutable=1` for live harness DBs.
2. Open in strict read-only mode using the supported Bun SQLite API/URI so WAL
   is visible. Do not use a writable fallback.
3. Enclose all queries needed for one Cursor/OpenCode collection in one read
   transaction/snapshot so session components cannot span different commits.
4. Close statements, transaction, and DB on every success/error path.
5. If a platform cannot read an active supported WAL without writes, return a
   structured collector warning/failure. Never silently retry immutable mode.
6. Keep the storage interface focused on a coherent domain read; do not expand
   it into dozens of shallow SQLite primitives.

Verify:

```sh
bun test packages/local-collectors/src/local-history.test.ts \
  packages/local-collectors/src/db-collectors.test.ts
```

### Step 3 - Make cache identity WAL-aware and race-safe

1. Replace the single `DbStat` cache key with stable identity for the main DB
   and `dbPath-wal`: existence, regular-file identity, size, and high-resolution
   modification metadata available on the platform.
2. Do not include `-shm` in the cache key; a read connection can change it and
   destroy every cache hit.
3. Capture the main+WAL fingerprint before opening/reading and again after the
   read transaction closes.
4. Reuse a cache only when its stored fingerprint matches the pre-read source.
5. Write a newly collected cache only when before and after fingerprints are
   equal. A concurrent writer therefore cannot associate old results with its
   newer fingerprint.
6. Bump Cursor/OpenCode cache versions.
7. Reject symlink/non-regular main/WAL paths for fingerprint purposes.

Tests must cover WAL-only changes, unchanged SHM, a source mutation during
collection, cache invalidation, cache hit, and DB closure on error.

### Step 4 - Add bounded no-follow regular-file primitives

Implement package-private operations that:

1. open with `O_NOFOLLOW` and `O_NONBLOCK` where supported;
2. `fstat` the opened handle and require a regular file;
3. read at most `limit + 1` bytes in bounded chunks;
4. detect growth after initial stat rather than trusting only pre-open size;
5. close the descriptor in every path;
6. return typed outcomes for missing, unsupported, oversized, and I/O failure;
7. avoid including file contents in errors/warnings.

On a platform lacking `O_NOFOLLOW`, use a pre-open `lstat`, then open/fstat and
require the same regular-file device/inode identity before reading; re-check the
path identity after open. If stable identity is unavailable, return a typed
unsupported result rather than reading. If a regular file cannot be opened
nonblocking safely on that platform, reject the candidate before open. Add
adapter tests for the native-flag and fallback paths.

Use the small budget for config/index JSON and the measured row-cache budget for
collector/Claude caches. Enforce the same limit before cache write. Oversized or
invalid cache input is a non-fatal miss; the source history is reparsed, and an
oversized regenerated cache is skipped rather than creating a reject-on-next-run
loop. Preserve plan 011's no-follow/hard-link permissions policy.

### Step 5 - Replace unbounded traversal

1. Make directory enumeration report regular file, directory, symlink, and
   unsupported entry types distinctly.
2. `lstat` the configured scan root itself and reject a symlink/non-directory;
   never descend through a symlink at the root or any child.
3. Make `walkFiles` iterative or explicitly depth-tracked with maximum depth,
   file count, and aggregate candidate-byte budget.
4. Keep deterministic ordering where collectors/tests currently rely on it.
5. Abort the affected harness when a completeness budget is exceeded. Emit one
   bounded structured warning, not thousands of per-file warnings.
6. Keep harness-specific discovery/translation in its collector module rather
   than moving all business meaning into `LocalHistoryStorage`.

### Step 6 - Stream JSONL and CSV parsing

Create a line visitor/async iterator that uses incremental `TextDecoder`
decoding and enforces file, line, and aggregate budgets. Migrate:

- Claude history JSONL;
- Codex history JSONL plus bounded index/quota reads;
- Cursor CSV collection;
- any collector-cache read that still loads unbounded text.

Use `TextDecoder('utf-8', { fatal: true })`: invalid UTF-8 fails the affected
history file/harness with one structured warning; never replace invalid bytes
and continue parsing JSON/CSV. Cache JSON with invalid UTF-8 is instead a
non-fatal cache miss because source history can be reparsed.

The parser may retain only current session aggregation state, not the whole file
or all decoded lines. Exact-limit is accepted; limit+1 fails. An overlong line,
invalid UTF-8, or aggregate exhaustion must not produce a partial successful
harness.

### Step 7 - Stream and atomically store CLI Cursor imports

Extract the import logic from `apps/cli/src/main.ts` into a focused module with
tests. It must:

1. open the source no-follow and require a regular file;
2. validate the header from the bounded initial stream;
3. compute SHA-256 while copying at most the CSV limit to an owner-only temporary
   file;
4. validate/create the ai-usage-owned `.ai-usage/cursor-exports` directory as a
   non-symlink owner-only `0700` directory using plan 011's private-state policy;
5. accept an existing destination artifact only when it is a no-follow regular
   file with one link; repair a single-link legacy mode to `0600`, but reject a
   symlink or hard-linked artifact without chmoding or reading through its alias;
6. compare against existing bounded regular imported files without full-buffer
   reads;
7. atomically rename the already-`0600` temporary file on success and clean it
   on failure;
8. preserve current safe filename and idempotent duplicate behavior.

The user-selected source CSV remains harness/user-owned: never chmod, rename,
delete, or otherwise repair it. Tests record its bytes, mode, and identity before
and after success/failure. Add cases for a permissive legacy single-link import,
a symlinked import directory/artifact, and a hard-linked existing artifact whose
alias bytes and mode must remain unchanged.

### Step 8 - Replace fake-only confidence with filesystem integration tests

Retain `TestMemoryStorage` for pure event-to-row parsing. Add temporary
filesystem tests for:

- normal, exact-limit, and limit+1 reads;
- growth after stat/open;
- an 8 MiB-test-equivalent injected line limit;
- maximum depth/file count/aggregate bytes;
- file and directory symlinks;
- symlinked configured scan root;
- FIFO/non-regular entries where supported;
- descriptor cleanup after errors;
- streaming output parity with current deterministic fixtures;
- row-cache exact-limit/limit+1 reads and writes, invalid/oversized cache miss,
  and no write-then-reject loop at the measured 50k workload;
- Cursor import hashing/deduplication;
- Cursor import private-directory/artifact modes, symlink/hard-link rejection,
  and unchanged user-source metadata.

## Test plan

```sh
bun test packages/local-collectors/src/local-history.test.ts \
  packages/local-collectors/src/collector-cache.test.ts \
  packages/local-collectors/src/db-collectors.test.ts \
  packages/local-collectors/src/codex-history.test.ts \
  apps/cli/src/cursor-import-file.test.ts
bun x ultracite check
bun run lint
bun run typecheck
bun run test
bun run build
```

## Done criteria

- Real Cursor/OpenCode WAL commits are visible.
- A collection is one coherent read snapshot, performs no DB/WAL write or
  checkpoint, and allows only characterized SQLite SHM coordination.
- Main+WAL changes invalidate caches; SHM-only churn does not.
- A source changed during collection is not cached under the new identity.
- All mapped local-history reads and walks have named limits and no-follow
  regular-file checks.
- JSONL/CSV is incrementally parsed.
- Oversize/unsupported input fails the affected operation explicitly, with no
  content leak and no partial-success claim.
- Cache read/write budgets are symmetric and oversized/invalid cache artifacts
  are non-fatal misses, not harness failures.
- Pure and real-filesystem tests both remain present for their appropriate seam.

## STOP conditions

- The reader checkpoints, copies, opens writable, locks for writing, chmods, or
  migrates a harness DB.
- `immutable=1` remains as a silent fallback.
- The supported platform still cannot see committed WAL data.
- SHM is added to the cache key and eliminates useful cache hits.
- Streaming code reconstructs the entire file/all lines in memory.
- A history symlink is followed, or a configuration symlink is resolved before
  each link and its final target are validated.
- An exceeded budget returns incomplete rows marked successful.
- A supported real fixture exceeds a budget without an evidence-based policy.
- A platform fallback follows a path or may block on a non-regular file before
  proving stable regular-file identity.
- Tests allocate actual multi-GiB files.

## Maintenance note

Every new collector read must declare its root, allowed file type, symlink
policy, per-file/line/scan budget, completeness behavior, and cache identity.
Memory fakes are never sufficient evidence for a filesystem or SQLite contract.
