# Plan 041: Validate stable SQLite history identity

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update this plan's row in
> `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 96b3dff..HEAD -- packages/local-collectors/src/local-history.ts packages/local-collectors/src/local-history.test.ts packages/local-collectors/src/collector-cache.ts packages/local-collectors/src/db-collectors.integration.test.ts packages/local-collectors/src/collectors/cursor.ts packages/local-collectors/src/collectors/opencode.ts`
> If an in-scope file changed, compare the current-state excerpts below with the
> live code. Any semantic mismatch is a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `96b3dff`, 2026-07-26

## Why this matters

Text/JSONL history readers reject symlinks and verify the opened file identity,
but SQLite history is passed directly to Bun's pathname-based database opener.
The cache fingerprint rejects a symlink only by disabling cache reuse; Cursor
and OpenCode still open it. A local history path should reject static redirection and detect ordinary identity changes around collection.

## Current state

- `packages/local-collectors/src/local-history.ts:49-94` shows the repository's
  hardened regular-file pattern: `lstat`, `O_NOFOLLOW`, `fstat`, and a
  post-read identity check.
- `packages/local-collectors/src/local-history.ts:319-345` currently calls
  `new Database(dbPath, { readonly: true })`, starts a read transaction, and
  performs no main/WAL path validation.
- `packages/local-collectors/src/collector-cache.ts:271-294` returns `null`
  from `dbStat` for a symlink/non-regular main DB or WAL.
- `packages/local-collectors/src/collectors/cursor.ts:300-307` and
  `collectors/opencode.ts:87-103` treat that `null` only as a cache miss and
  continue to `storage.openDatabase`.
- `packages/local-collectors/src/local-history.test.ts:124-150` is the real
  SQLite/WAL coherence exemplar and must keep seeing committed WAL rows.
- `packages/local-collectors/src/db-collectors.integration.test.ts` is the
  existing real-filesystem Cursor/OpenCode integration fixture; there is no
  `db-collectors.test.ts` at this baseline.
- `CONTEXT.md` defines **local history** as harness-written files/databases; the
  collector may read them but must not repair or mutate them.

## Commands you will need

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Storage tests | `bun test packages/local-collectors/src/local-history.test.ts` | exit 0 |
| Collector tests | `bun test packages/local-collectors/src/db-collectors.integration.test.ts` | exit 0 |
| Package tests | `bun test packages/local-collectors` | exit 0 |
| Format check | `bun run check` | exit 0 |
| Typecheck | `bun run typecheck` | exit 0 |
| Full tests | `bun run test` | exit 0 |
| Diff safety | `git diff --check` | exit 0, no output |

## Scope

**In scope**:

- `packages/local-collectors/src/local-history.ts`
- `packages/local-collectors/src/local-history.test.ts`
- `packages/local-collectors/src/collector-cache.ts` — only to share one
  database identity representation rather than duplicate it
- `packages/local-collectors/src/db-collectors.integration.test.ts`
- `packages/local-collectors/src/collectors/cursor.ts` and
  `packages/local-collectors/src/collectors/opencode.ts` — only if an explicit
  invalid-identity gate is needed before collection

**Guarantee boundary**:

Bun 1.3.13 exposes no `SQLITE_OPEN_NOFOLLOW` option. This plan rejects symlinks already present and detects ordinary main/WAL identity changes before and after opening; it does not claim resistance to a hostile same-UID process racing the pathname between those checks.

**Out of scope**:

- copying, checkpointing, migrating, chmoding, or opening harness databases
  writable;
- changing cache hit semantics beyond sharing hardened identity validation;
- pagination/streaming of SQL result arrays;
- modifying `TestMemoryStorage` behavior except for a required interface-only
  compatibility change;
- resistance to an actively hostile same-UID process racing path replacement;

## Git workflow

- Branch: `fix/041-sqlite-history-identity`
- Prefer a test commit followed by one implementation commit. Example messages:
  `Cover redirected SQLite histories` and
  `Validate SQLite history identity`.
- Do not push or open a pull request unless explicitly requested.

## Steps

### Step 1: Define one main-and-WAL identity validator

In `packages/local-collectors/src/local-history.ts`, add a package-private
identity helper for a SQLite main path and its optional `-wal` sidecar. For each
present path, use `lstat` and require a non-symlink regular file; record at least
`dev`, `ino`, `size`, and high-resolution modification time. The main DB is
required; an absent WAL is valid.

Reuse this identity shape from `collector-cache.ts` if doing so avoids two
different trust checks. Preserve the rule that `-shm` is not a cache identity
input.

Provide typed `LocalHistoryError` failures whose messages identify only the
operation/path, never database contents.

**Verify**: add focused helper tests for regular DB, DB symlink, WAL symlink,
non-regular main path, and absent WAL; the targeted storage test exits 0.

### Step 2: Validate identity around the read-only SQLite snapshot

Change `createLocalHistoryStorage().openDatabase` to:

1. capture and validate main/WAL identity before opening;
2. open with `{ readonly: true }` and keep the existing read transaction;
3. immediately recapture identity after `BEGIN`;
4. reject and close/rollback if main identity changed, either sidecar is now a
   symlink/non-regular file, or a present sidecar's identity changed;
5. retain the existing Effect-wrapped `all` and idempotent close behavior.

An absent-to-present WAL transition caused by a legitimate concurrent harness
writer must have an explicit policy: fail this collection attempt cleanly and
retry on the next scheduled run rather than accepting an identity that was not
validated before open. Do not checkpoint or copy the database to avoid that
failure.

The pinned Bun version has no supported SQLite no-follow option. Document the `lstat`/open/post-`lstat` fallback in a short code comment without overstating its same-UID adversary guarantee. If a future pinned Bun exposes such a flag, adopting it is a follow-up rather than a requirement for this plan.

Ensure every failure after constructing `Database` rolls back where applicable
and closes the handle.

**Verify**:

```sh
bun test packages/local-collectors/src/local-history.test.ts
```

The existing committed-WAL test and all new redirect/cleanup tests pass.

### Step 3: Prove Cursor and OpenCode cannot bypass the boundary

Add real-filesystem collector tests that place:

- a symlink at the configured main DB path;
- a regular main DB with a symlinked `-wal`.

For both Cursor and OpenCode, assert collection returns the repository's
sanitized harness warning/failure outcome and does not read rows from the
redirect target. Keep neighboring harness behavior intact.

Do not rely only on `dbStat`; the enforcement assertion must reach
`LocalHistoryStorage.openDatabase`.

**Verify**:

```sh
bun test packages/local-collectors/src/db-collectors.integration.test.ts
bun test packages/local-collectors
```

Both commands exit 0.

### Step 4: Run repository gates

**Verify**:

```sh
bun run check
bun run typecheck
bun run test
git diff --check
```

All commands exit 0.

## Test plan

- Extend the real SQLite/WAL test in `local-history.test.ts`.
- Cover main symlink, WAL symlink, non-regular input, stable WAL, identity
  replacement, and database closure after rejected identity.
- Add Cursor/OpenCode boundary coverage using temporary files; do not use a
  fake storage for the actual redirection cases.
- Preserve WAL visibility and read-only behavior.

## Done criteria

- [ ] Main DB and optional WAL are non-symlink regular files before SQLite
      opens.
- [ ] Their identities are stable after the read transaction begins.
- [ ] Rejected identity paths close every database handle and expose no rows.
- [ ] Cursor/OpenCode reject static main/WAL symlinks and detect ordinary identity replacement around opening.
- [ ] Existing WAL-coherent reads continue to pass without source writes.
- [ ] Targeted/full tests, formatting, and typechecking pass.
- [ ] This plan's row in `plans/README.md` is `DONE`.

## STOP conditions

Stop and report if:

- the fix requires writable access, checkpointing, copying, or migration of a
  harness database;
- a supported live WAL fixture no longer produces a coherent read;
- the platform cannot establish stable regular-file identity and the proposed
  fallback would simply follow the path;
- identity rejection leaks database content or silently returns partial rows;
- the fix expands into SQL result pagination;
- a verification command fails twice after one reasonable correction.

## Maintenance notes

`dbStat` is cache identity; `openDatabase` enforces the documented practical boundary. Keep those
roles explicit. If Bun later exposes SQLite's native no-follow flag, adopt it
while retaining the main/WAL stability tests.
