# Plan 011: Make Machine Identity Atomic and Protect Private Local State

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MEDIUM
- **Depends on**: plan 009
- **Category**: correctness / local security / storage
- **Based on**: commit `17bcf28`, 2026-07-13
- **Status**: DONE
- **Suggested branch**: `fix/011-private-local-state`

## Executor instructions

Read this plan completely and compare the current commit with `17bcf28`. Reuse
the repository's existing config lock and atomic-write patterns; do not invent a
second weaker protocol. Test only with temporary directories.

Split delivery into two commits: atomic machine identity, then permissions for
ai-usage-owned stores/caches. Never change permissions on a harness-owned file.

## Why this matters

`ensureMachineConfig` currently performs a check-then-write outside an
interprocess lock. Two first-start processes can generate and return different
UUIDs, breaking provenance before either process sees the other's file.
`writeMachineConfig` also writes directly.

Several ai-usage-owned files contain project paths, session titles, prompts or
usage provenance but inherit the user's umask: collector JSON caches, Claude
cache data, the Codex history cache SQLite database, and `usage-store.sqlite`.
The project already has an atomic `0600` JSON writer for config, so weaker
handling elsewhere is inconsistent and avoidable.

## Target outcome

1. Concurrent first launches all return the same persisted machine UUID.
2. Machine creation and label updates are serialized and atomically replaced.
3. ai-usage private directories are `0700` and private files are `0600` on
   POSIX, including existing files repaired on safe access.
4. ai-usage SQLite DB/WAL/SHM artifacts are inaccessible to group/other users.
5. No harness database, history file, user-selected export, or global umask is
   modified.

## Current-state evidence

- `packages/local-collectors/src/machine-config.ts:229` checks, generates, and
  writes machine identity without the lock used by config updates.
- The same module already has `withConfigFileLock` and
  `writeJsonAtomically`, including a `0600` replacement pattern.
- `collector-cache.ts` and `collectors/claude.ts` write JSON caches with default
  permissions.
- `codex-history.ts` creates an ai-usage-owned SQLite cache containing `cwd` and
  first-user text.
- `packages/usage-store/src/index.ts` creates the durable local database and its
  WAL sidecars without an explicit owner-only policy.

## Scope

### In scope

- `packages/local-collectors/src/machine-config.ts` and multiprocess tests;
- a small private local-collectors storage helper if extraction reduces
  duplication;
- collector cache, Claude cache, and Codex cache creation/repair;
- usage-store DB/directory/sidecar creation/repair with a package-private helper;
- POSIX permission tests and platform-aware skips.

### Out of scope

- harness-owned Cursor, OpenCode, Claude, or Codex source files/databases;
- user-selected snapshot/merge output permissions, handled by plan 014;
- changing `process.umask()` globally;
- encrypting local history or adding credentials;
- changing machine IDs already validly persisted;
- WAL read correctness and bounded history reads, handled by plan 012.

## Commands

```sh
git status --short
git rev-parse --short HEAD
git diff --stat 17bcf28..HEAD -- \
  packages/local-collectors/src packages/usage-store/src
git status --short -- packages/local-collectors/src packages/usage-store/src
bun test packages/local-collectors/src/machine-config.test.ts \
  packages/local-collectors/src/collector-cache.test.ts \
  packages/local-collectors/src/codex-history.test.ts \
  packages/usage-store/src/index.test.ts
```

If either scoped drift command shows work not produced by completed dependencies,
STOP, preserve it, and rebase/re-read the overlapping implementation before
editing. Never overwrite another worktree change.

Use the test platform's native mode semantics. Do not make POSIX numeric-mode
assertions mandatory on Windows.

## Implementation steps

### Step 1 - Characterize the first-start race

1. Add a dedicated subprocess fixture under
   `packages/local-collectors/src/test-fixtures/` that waits on a barrier, calls
   `ensureMachineConfig`, and writes the returned identity to a worker-specific
   result file.
2. Launch several workers against one empty temporary HOME.
3. Assert one distinct returned UUID and equality with the final `machine.json`.
4. Confirm that the test fails against the old check-then-write implementation.
5. Add cases for an existing valid file and an invalid file. Invalid state must
   retain the current explicit error rather than being silently replaced.

### Step 2 - Serialize and atomically persist machine identity

1. Generalize the existing private lock only as far as needed to lock a named
   config path. Keep it internal to local-collectors.
2. Execute read, re-check, UUID generation, and atomic write while holding the
   machine-file lock.
3. Every contender must re-read after acquiring the lock and return the
   persisted winner rather than its pre-lock candidate.
4. Route `writeMachineConfig` through the same lock and atomic replacement.
   Preserve explicit label update semantics; concurrent labels may remain
   serialized last-writer-wins.
5. Preserve existing validation and error tags.
6. Ensure the containing ai-usage directory is `0700` and the replacement file
   is `0600` before it becomes visible.

Verify:

```sh
bun test packages/local-collectors/src/machine-config.test.ts
```

The multiprocess case must pass repeatedly and leave no temporary/lock file.

### Step 3 - Define one local-collectors private-storage policy

If extraction is useful, create a package-private module such as
`packages/local-collectors/src/private-storage.ts` that owns:

- safe owner-directory creation/repair (`0700` on POSIX);
- no-follow regular-file permission repair (`0600` on POSIX);
- atomic JSON replacement whose read/write size budget is injected by each
  caller; plan 012 defines and characterizes the collector/cache budgets rather
  than this permissions plan inventing a new ceiling;
- cleanup of temporary files after failures.

Do not expose it in `package.json`, import it from other packages, follow a
symlink to chmod its target, or mutate global umask. Permission repair must use
the opened/lstat-verified ai-usage-owned path. Validate the ai-usage-owned leaf
directory itself with `lstat`; if it is a symlink, reject it before lock
realpathing, directory creation, chmod, or file I/O.

Hard links require a separate policy because `chmod` changes every alias:

- authoritative machine/config JSON with `nlink > 1`: reject explicitly;
- disposable JSON caches with `nlink > 1`: treat as cache miss, then replace
  the owned path atomically with a new `0600` inode on the next write; never
  chmod the linked inode;
- ai-usage SQLite main/WAL/SHM with `nlink > 1`: reject before open/chmod.

### Step 4 - Apply the policy to local-collectors artifacts

Migrate:

- generic collector cache writes/reads in `collector-cache.ts`;
- Claude's ai-usage cache;
- the Codex ai-usage SQLite history cache and its directory.

For each:

1. Create the parent privately before writing.
2. Use atomic `0600` JSON replacement where applicable.
3. Repair an existing single-link regular ai-usage-owned file that is `0644`;
   apply the hard-link policy above otherwise.
4. Pre-create SQLite main files as `0600`, then verify main/WAL/SHM modes after
   SQLite initializes or enables WAL.
5. Keep content, cache version, and cache-hit semantics unchanged.

Do not touch the original provider/harness DB or JSONL modes.

### Step 5 - Apply an independent policy to usage-store

`@ai-usage/usage-store` must not depend on local-collectors. Add a small private
helper within that package that:

1. creates the store directory `0700`;
   rejects an existing symlinked/non-directory ai-usage leaf rather than
   following it;
2. pre-creates/repairs only `usage-store.sqlite` as `0600`;
3. verifies/repairs its own `-wal` and `-shm` files after creation;
4. refuses symlink, non-regular, or multiply-linked main/sidecar files;
5. preserves migrations, transactions, and public error contracts.

Directory `0700` is the first confidentiality boundary, so sidecar creation is
never briefly exposed even before a post-open chmod.

### Step 6 - Add permission and atomicity tests

On POSIX, assert:

- `machine.json`, collector JSON caches, Claude cache, Codex cache DB, and usage
  store DB are `0600`;
- their owned directories are `0700`;
- SQLite WAL/SHM are `0600` when present;
- a pre-existing `0644` regular file is repaired;
- a symlink is rejected without changing its target;
- a symlinked ai-usage-owned directory is rejected before lock/file access;
- a hard-linked authoritative/SQLite file is rejected; a hard-linked cache is
  replaced with a new inode without changing the alias's mode/content;
- round trips and cache hits remain unchanged;
- failed atomic writes leave neither a partial destination nor temporary files.

Use the existing hard-link/atomic replacement tests as an exemplar. Skip only
numeric-mode assertions on platforms that do not implement POSIX modes.

## Test plan

```sh
bun test packages/local-collectors/src/machine-config.test.ts \
  packages/local-collectors/src/collector-cache.test.ts \
  packages/local-collectors/src/db-collectors.test.ts \
  packages/local-collectors/src/codex-history.test.ts \
  packages/usage-store/src/index.test.ts
bun x ultracite check
bun run lint
bun run typecheck
bun run test
```

Run the machine multiprocess test several times in one command/process to expose
timing sensitivity.

## Done criteria

- All first-start workers return one stable identity.
- Machine/config atomicity and error behavior are preserved.
- All mapped ai-usage-owned private artifacts are owner-only on POSIX.
- Existing permissive files are safely repaired.
- No harness-owned path or symlink target is chmodded.
- Package boundaries remain unchanged.
- Tests use only temporary HOME/state.

## STOP conditions

- A valid persisted machine identity would be regenerated or migrated.
- Two workers can still return different IDs.
- The solution changes global umask or requires a cross-package private helper.
- A harness-owned file/database would be chmodded, opened writable, or migrated.
- A symlink must be followed to repair permissions.
- A multiply-linked inode is chmodded or opened as authoritative/private state.
- SQLite sidecars remain group/world accessible inside a non-private directory.
- Windows is forced to emulate POSIX numeric modes.

## Maintenance note

Every new persistent ai-usage artifact must declare its sensitivity, owner,
directory mode, file mode, atomicity, symlink policy, and concurrency policy in
the module that writes it.
