# Frozen parity-ledger interface

Plan 068 uses this directory as a release ledger, not as a generated coverage
report. The records freeze the Solid baseline and are changed to replacement
evidence only by the packet named in each shard.

- `schema.ts` owns record kinds, statuses, packet IDs, and required register
  IDs. Only the coordinator may change that interface after B1 converges.
- `aggregate.ts` discovers `shards/*.parity.ts` lexicographically. There is no
  barrel to edit and no filesystem-order dependency.
- A shard filename starts with its lowercase `owner` (`p1.parity.ts` or
  `p1.detail.parity.ts`). Every record's `targetOwner` must equal the shard
  owner. This makes cross-shard edits fail mechanically.
- IDs are globally unique. A later packet edits only its existing shard; it
  does not duplicate an ID in a new shard.
- `current` means the Solid implementation is the release authority during the
  additive migration. `complete` requires integrated, non-baseline
  `phase: "target"` evidence for the replacement.
- `reviewed-removal` requires a non-empty reviewed `replacementReason` and
  integrated target review evidence. Required feature IDs cannot be removed.
- Baseline evidence defaults to reviewed B0 checkpoint
  `2051c4887894e42f31b309adf8446869d2e1b566`. Target evidence must name its
  explicit implementation commit and use `phase: "target"`.
- The checker accepts evidence only when Git proves its commit is an ancestor
  of the checked integration `HEAD`. A packet lands implementation first and
  may use a following evidence commit to reference that SHA.
- `bun tools/check-web-migration-parity.ts` accepts Wave-0 `current` records.
  `--require-complete` is the Wave-12 gate and rejects every remaining
  `current` record.

The checker derives current production TSX files, server-function wrappers,
design-system exports, Solid render suites, and Playwright titles from the
repository. Adding or deleting one of those items without updating the owning
shard is a failure, as are missing feature/URL/design register IDs, duplicates,
unowned records, stale evidence, and unsupported removals.
