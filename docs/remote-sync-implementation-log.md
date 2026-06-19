# Remote Sync Implementation Log

## 2026-06-19

### Starting Scope

Implement the remote sync plan from `docs/remote-sync-architecture-plan.md`.

Initial target:

- persist pulled `UsageSnapshot` data locally;
- keep final report merge on the reporting machine;
- support env-backed tokens;
- add `sync add/list/pull/watch/remove`;
- improve `serve` and `sync` logs;
- provide onboarding output;
- avoid raw local history sync and final report payload sync.

### Working Decisions

- Sync layer remains `UsageSnapshot`, not raw harness data and not `UsageReportPayload`.
- Bidirectional sync means symmetric pull: each machine can serve and pull, but no machine writes to another machine.
- Live sync means polling via `sync watch`, reusing the same pull implementation.
- Persistent remote credentials should be stored as `tokenEnv`, with token values loaded from process env or local `.env` files.

### Notes

- The repo already has `UsageSnapshot`, merge/dedupe, LAN `serve`, and one-shot `merge --remote`.
- The missing module is durable synced snapshot storage plus a CLI interface around it.

### Implementation Decisions

- `@ai-usage/core` will own the pure config shape for sync remotes.
- `@ai-usage/local-collectors` will own synced snapshot storage because it already owns user-local filesystem state and machine config.
- `@ai-usage/reporting` will read stored synced snapshots only as report inputs; it will not own sync persistence.

### Progress

- Added `sync.remotes` config shape with `tokenEnv`.
- Added `sync-storage` for remote config, env token lookup, stored snapshot records, corrupt snapshot warnings, and removal.
- Added parser support for `sync add/list/pull/watch/remove`.
- Moved sync command implementation into `apps/cli/src/sync.ts` so `main.ts` remains a command router.
- Added report inclusion of stored synced snapshots by default, with `--no-synced` escape hatch.
- Added serve request logs and first-run onboarding output.
- Added repo-level `.env` ignore entry to support token env files safely.

### Verification So Far

- `bun test apps/cli/src/cli.test.ts` passed.
- `bun test packages/local-collectors/src/sync-storage.test.ts` passed.
- `bun --filter @ai-usage/cli check` passed before the serve logging changes.
- `bun run check` passed with existing Biome large-file warnings from `/nix/store`.
- `bun run test` passed.
