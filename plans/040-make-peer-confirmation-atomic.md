# Plan 040: Make peer confirmation an atomic usage-store capability

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update this plan's row in
> `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 96b3dff..HEAD -- packages/usage-store/src/index.ts packages/usage-store/src/index.test.ts packages/usage-merge/src/index.ts packages/usage-merge/src/index.test.ts apps/web/src/server/manual-merge-upload.server.ts apps/web/src/server/manual-merge-upload.server.test.ts apps/web/src/server/sync-upload.server.ts apps/web/src/server/sync-upload.server.test.ts apps/web/src/routes/sync.tsx`
> If an in-scope file changed, compare the current-state excerpts below with the
> live code. Any semantic mismatch is a STOP condition.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: MED
- **Depends on**: none
- **Category**: bug / security
- **Planned at**: commit `96b3dff`, 2026-07-26


## Confirmed design amendment

This amendment records the maintainer decision made after the audit and overrides any conflicting generation/token or absent-store instruction later in this plan.

- `usage-store` owns private store initialization, canonical bundle binding, state fingerprinting, token construction and interpretation, write serialization, and stale detection.
- Preview returns one versioned opaque `confirmationToken`. Replace `generation` plus `storeStateToken` throughout `usage-store`, `usage-merge`, the upload adapter, and the Sync browser route. Those callers transport only a non-empty bounded token plus the separately owned document digest; they never decode store state.
- The token is stateless. Do not add a token table, process-local registry, expiration scheduler, or cleanup lifecycle.
- A first preview may initialize an empty private current-schema store inside `usage-store`, without inserting usage rows or advancing semantic generation. This eliminates the synthetic absent token.
- Confirmation recomputes and compares the token after acquiring the same `BEGIN IMMEDIATE` transaction that owns classification and import. A mismatch returns `preview-stale` before any confirmed write.
- Token reuse is allowed only while the exact bound state is unchanged. Conservative invalidation after a storage write is acceptable; do not add stateful one-shot consumption.

The web application remains a thin transport. Public success results, upload limits, error sanitization, and the HTTP mapping for `preview-stale` stay unchanged.

## Why this matters

The `/sync` workflow promises that confirmation applies the previewed
digest/store state. Today confirmation checks state in a read-only preview,
closes that connection, and only later begins the importing write transaction.
A competing import in that gap can make the confirmed effects differ from the
review without producing `preview-stale`.

## Current state

- `packages/usage-store/src/index.ts:977-1038` owns classification and mutation
  in `importMergeRows`, beginning `BEGIN IMMEDIATE` immediately before it
  classifies and writes.
- `packages/usage-store/src/index.ts:1112-1146` previews in a separate read
  transaction, then rolls back and closes it.
- `packages/usage-store/src/index.ts:1161-1179` calls
  `previewPeerMergeBundle`, compares generation/token, and delegates to
  `importPeerMergeBundle`; the import opens another connection and transaction.
- `packages/usage-store/src/index.test.ts:143-225` covers normal
  preview/confirm, and `:360-384` covers an absent store, but there is no
  same-preview concurrency test.
- `packages/usage-merge/src/index.test.ts:150-180` verifies the adapter's stale
  token behavior and must keep the existing public error/result contract.
- `README.md` describes `/sync` as confirming the same digest/store generation;
  preserve that product guarantee.

## Commands you will need

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Store tests | `bun test packages/usage-store/src/index.test.ts` | exit 0 |
| Adapter tests | `bun test packages/usage-merge/src/index.test.ts` | exit 0 |
| Upload tests | `bun test apps/web/src/server/manual-merge-upload.server.test.ts apps/web/src/server/sync-upload.server.test.ts` | exit 0 |
| Format check | `bun run check` | exit 0 |
| Typecheck | `bun run typecheck` | exit 0 |
| Full tests | `bun run test` | exit 0 |
| Diff safety | `git diff --check` | exit 0, no output |

## Scope

**In scope**:

- `packages/usage-store/src/index.ts`
- `packages/usage-store/src/index.test.ts`
- `packages/usage-merge/src/index.test.ts`
- `packages/usage-merge/src/index.ts`
- `apps/web/src/server/manual-merge-upload.server.ts`
- `apps/web/src/server/manual-merge-upload.server.test.ts`
- `apps/web/src/server/sync-upload.server.ts`
- `apps/web/src/server/sync-upload.server.test.ts`
- `apps/web/src/routes/sync.tsx`

**Out of scope**:

- changing merge-bundle bytes, digest validation, successful import results, or the public `preview-stale` reason;
- changing row precedence, authority, deletion, RTK contribution, or semantic
  generation rules;
- changing ordinary direct `importPeerMergeBundle`, which intentionally has no
  prior-preview guarantee;
- unrelated UI presentation, upload limits, or trusted-request behavior;
- a general usage-store module split or unrelated query optimization.

## Git workflow

- Branch: `fix/040-atomic-peer-confirmation`
- Prefer two commits: regression coverage, then the transaction refactor. Use
  imperative messages such as `Cover concurrent peer confirmation` and
  `Make peer confirmation atomic`.
- Do not push or open a pull request unless explicitly requested.

## Steps

### Step 1: Add deterministic concurrency regressions

In `packages/usage-store/src/index.test.ts`, add tests proving:

1. two confirmations using the same preview race on one existing store;
   exactly one succeeds and the other fails with reason `preview-stale`;
2. a competing import that commits after preview but before confirmation makes
   confirmation stale and leaves the competitor's rows/generation intact;
3. the same-preview race against an absent store also imports once rather than
   allowing two confirmations to report the reviewed effect.

Use synchronization/barriers or separate Bun child processes rather than
timing sleeps. Reuse the current temporary store and `makeBundle` helpers. The
tests must assert final rows and generation, not only error tags.

**Verify**: against the old implementation, at least the existing-store
check-then-act regression fails deterministically.

### Step 2: Share classification and mutation inside an acquired transaction

Refactor the internal merge engine so `confirmPeerMergeBundle`:

1. validates/parses the peer bundle once and rejects self-import as today;
2. opens the store using a confirmation-specific path that does not perform an
   unreviewed row mutation;
3. acquires `BEGIN IMMEDIATE`;
4. while that write transaction is held, reads the current semantic generation
   and state identity and compares both expected values;
5. on mismatch, rolls back and returns `UsageStoreError` with
   `reason: "preview-stale"` before preparing/applying row mutations;
6. on match, classifies and imports those exact canonical rows in the same
   transaction, including RTK contributions and generation advancement;
7. commits once and returns the actual classification counts.

Extract internal helpers as needed so ordinary import and confirmed import use
one classifier/writer. Do not call the public preview function from
confirmation after this change.

For a preview of an absent store, retain an explicit absent-state precondition.
The first confirmer may initialize generation 0 and import while holding the
write serialization point; a second confirmer must observe the resulting
generation/state and fail stale. An empty store created after preview is still
identity drift and must not silently satisfy an `absent` token.

If normal `openUsageStoreDatabase` changes the identity token before the
transaction check (for example by migration or journal setup), factor a
current-schema confirmation opener rather than weakening token comparison.

**Verify**:

```sh
bun test packages/usage-store/src/index.test.ts
bun test packages/usage-merge/src/index.test.ts
```

Both commands exit 0, including the new race tests.

### Step 3: Prove rollback and contract parity

Add/retain assertions that stale confirmation:

- writes no usage row or RTK contribution;
- does not advance semantic generation;
- returns the existing typed `preview-stale` reason through usage-merge;
- preserves normal insert/update/unchanged/superseded/deleted counts for a
  successful confirmation.

Ensure every error path after `BEGIN IMMEDIATE` attempts rollback and closes the
connection via the existing Effect acquisition boundary.

**Verify**:

```sh
grep -n "confirmPeerMergeBundle" packages/usage-store/src/index.ts
bun run check
bun run typecheck
bun run test
git diff --check
```

There is no `previewPeerMergeBundle(input)` call inside the confirmation
implementation; all commands exit 0.

## Test plan

- Use real temporary SQLite stores, not a mocked database.
- Cover current store, absent store, competing import, two same-preview
  confirmations, stale rollback, and successful count parity.
- Keep adapter coverage for the JSON-safe `preview-stale` mapping.
- Avoid arbitrary sleeps; concurrency tests need a deterministic coordination
  seam or child-process barrier.

## Done criteria

- [ ] State comparison and row import occur under one write serialization
      boundary.
- [ ] Exactly one of two same-preview confirmations can succeed.
- [ ] A competing import makes confirmation stale before any confirmed write.
- [ ] Absent-store confirmation preserves identity and single-winner semantics.
- [ ] Public contracts and merge semantics are unchanged.
- [ ] Targeted/full tests, formatting, and typechecking pass.
- [ ] This plan's row in `plans/README.md` is `DONE`.

## STOP conditions

Stop and report if:

- the opaque token requires a process-local registry, persistence table, expiry job, or cleanup lifecycle;
- generation, inode, WAL, or decoded token fields must be exposed above `usage-store`;
- token comparison cannot share the transaction that classifies and imports;

- acquiring the transaction itself changes the state token and no
  current-schema non-mutating opener can preserve comparison;
- exact absent-store identity requires weakening the token to generation-only;
- the proposed fix requires changing public upload/merge contracts;
- concurrent tests can pass only with timing sleeps or nondeterministic retries;
- any stale path writes rows, contributions, metadata, or migration state;
- a verification command fails twice after one reasonable correction.

## Maintenance notes

Preview may remain lock-free and read-only, but confirmation's precondition and
effects are one atomic unit. Review future import refactors for accidental
reintroduction of a public-preview call before a separate write transaction.
