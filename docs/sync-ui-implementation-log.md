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
- keep `@ai-usage/report-data` focused on report and `UsageSnapshot` production;
- keep `apps/cli` and `apps/web` as adapters, with feature parity optional.

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

### Phase 2: Shared Sync Workflow And State

Status: completed.

Intent:

- move remote registration, token validation, pull, self-machine rejection, and state assembly out of `apps/cli`;
- make `apps/cli/src/sync.ts` render package results instead of owning sync behavior;
- expose a serializable `SyncState` shape for future web server functions.

Decisions:

- kept low-level persistence in `@ai-usage/local-collectors/sync-storage`;
- added `@ai-usage/sync/state` as the UI-facing read model over config plus stored snapshots;
- added `@ai-usage/sync/workflow` for remote selection, `tokenEnv` validation, token resolution, and pull operations;
- kept the CLI `watch` loop in the adapter for now, but it now calls package-owned remote selection and pull logic.

Difficulties:

- repo/local `.env` can make common token env names present during tests, so workflow tests use a unique missing env name.
- `expect(error._tag)` does not narrow Effect error unions for TypeScript, so tests use explicit guards before reading `reason`.

Checks:

- `bun test packages/sync/src/workflow.test.ts packages/sync/src/transport.test.ts` passed.
- `bun test apps/cli/src/cli.test.ts` passed.
- `bun --filter @ai-usage/sync check` passed.
- `bun --filter @ai-usage/cli check` passed.
- `bun run check` passed.
- Biome still reports existing large-file warnings for files under `/nix/store`.

Commit:

- this phase commit records the shared sync workflow and state extraction.

### Phase 3: Shared Snapshot Server Protocol

Status: completed.

Intent:

- move `/health` and `/snapshot` behavior out of `apps/cli/src/serve.ts`;
- expose a testable snapshot HTTP handler for CLI and future web adapters;
- keep CLI output as formatting over package request events.

Decisions:

- added `@ai-usage/sync/server`;
- split server support into `createSnapshotHttpHandler` and `startSnapshotServer`;
- made request logging an event callback so package code does not render terminal text;
- kept snapshot production injected as `collectSnapshot` so `@ai-usage/sync` does not depend on `@ai-usage/report-data`.

Difficulties:

- Bun's `server.port` type allows `undefined`, so the server handle normalizes to `server.port ?? input.port`;
- Bun's `server.stop()` can return a promise, so the shared handle exposes a synchronous `stop` wrapper that discards it.

Checks:

- `bun test packages/sync/src/server.test.ts packages/sync/src/workflow.test.ts packages/sync/src/transport.test.ts` passed.
- `bun test apps/cli/src/cli.test.ts` passed.
- `bun --filter @ai-usage/sync check` passed.
- `bun --filter @ai-usage/cli check` passed.
- `bun run check` passed.
- Biome still reports existing large-file warnings for files under `/nix/store`.

Commit:

- this phase commit records the shared snapshot server protocol.

### Phase 4: Discovery And Web Server-Function Readiness

Status: completed.

Intent:

- add package-owned LAN peer discovery so browser/UI code does not scan the network directly;
- add report-app server functions that expose sync state and sync actions for a future `/sync` page;
- keep the web adapter server-backed and leave visible UI work for a later slice.

Decisions:

- added `@ai-usage/sync/discovery` with active `/health` scanning and host injection for tests;
- added timeouts to snapshot transport so active discovery does not hang indefinitely;
- changed `SyncState.storedSnapshots` from full snapshot records to serializable summaries because TanStack server functions enforce strict serialization and the full snapshot facets type can contain `unknown`;
- server functions return `{ ok, data/error }` so the future page can render typed failures without depending on Effect error internals.

Difficulties:

- TanStack Start server functions rejected `SyncState` while it contained full `StoredSyncedSnapshot` records; summarizing stored snapshots made the interface more UI-shaped and serializable.
- `createServerFn` input handling has no local examples with validators, so the adapter validates unknown input manually in `sync.server.ts`.

Checks:

- `bun test packages/sync/src/discovery.test.ts packages/sync/src/server.test.ts packages/sync/src/workflow.test.ts packages/sync/src/transport.test.ts` passed.
- `bun --filter @ai-usage/sync check` passed.
- `bun --filter @ai-usage/web check` passed.
- `bun --filter @ai-usage/cli check` passed.
- `bun run check` passed.
- Biome still reports existing large-file warnings for files under `/nix/store`.

Commit:

- this phase commit records LAN discovery and report server-function readiness.

### Final Validation And Documentation Cleanup

Status: completed.

Intent:

- update domain and architecture docs after the package extraction;
- run full repository validation;
- confirm the remaining work is UI implementation, not sync decoupling.

Decisions:

- added domain language for `Snapshot peer` and `Sync state`;
- left visible `/sync` UI work in future work because the requested success criterion is readiness for UI integration.

Difficulties:

- none beyond the serialization cleanup already handled in phase 4.

Checks:

- `bun run test` passed.
- `bun run check` passed.
- Biome still reports existing large-file warnings for files under `/nix/store`.

Commit:

- this phase commit records final documentation cleanup after validation.
