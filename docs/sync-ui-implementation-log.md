# Sync UI Decoupling Implementation Log

This log tracks the implementation of `docs/sync-ui-decoupling-plan.md`.

## 2026-06-19

### Phase 0: Documentation And Tracking

Status: completed.

Intent:

- preserve the UX clarification that LAN sync starts by running `serve` and copying a printed URL;
- write the full decoupling plan into the repo;
- create this implementation log before moving code.

Decisions:

- use a new package-oriented module shape centered on `@ai-usage/sync`;
- keep `@ai-usage/reporting` focused on report and `UsageSnapshot` production;
- keep `apps/cli` and `apps/report` as adapters, with feature parity optional.

Difficulties:

- none yet.

Checks:

- `bun run check` passed.
- Biome still reports existing large-file warnings for files under `/nix/store`.

Commit:

- `f815731 docs: plan sync ui decoupling`

### Phase 1: Shared Snapshot Transport

Status: completed.

Intent:

- create `@ai-usage/sync`;
- move snapshot file and HTTP transport out of `apps/cli`;
- keep the CLI behavior unchanged while making the transport available to future web server functions.

Decisions:

- introduced `SyncTransportError` instead of reusing `CliArgumentError`;
- made `@ai-usage/sync/transport` own bearer auth, HTTP response handling, `UsageSnapshot` parsing, and `/health` parsing.

Difficulties:

- Bun's `fetch` type includes extra members, so test mocks need an explicit `unknown as typeof fetch` cast.
- TypeScript narrowed a captured auth variable too aggressively in the test; using a small mutable object kept the assertion typed.

Checks:

- `bun test packages/sync/src/transport.test.ts` passed.
- `bun test apps/cli/src/cli.test.ts` passed.
- `bun --filter @ai-usage/sync check` passed.
- `bun --filter @ai-usage/cli check` passed.
- `bun run check` passed.
- Biome still reports existing large-file warnings for files under `/nix/store`.

Commit:

- this phase commit records the shared transport extraction.
