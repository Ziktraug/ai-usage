# Sync UI Decoupling Plan

## Goal

Prepare `ai-usage` for a dedicated web UI that manages sync state without making the CLI own LAN sync behavior.

Success means:

- `apps/cli` is an adapter for argument parsing and terminal rendering.
- `apps/report` can expose server functions for a future `/sync` page without calling CLI code.
- shared sync behavior lives behind package interfaces.
- `@ai-usage/reporting` remains focused on report and `UsageSnapshot` production.
- a future UI can render serve/discovery/remote/pull state from serializable data.

## Architecture Decision

Create a package-owned sync module instead of growing app code:

```txt
@ai-usage/core
  pure sync config and snapshot types

@ai-usage/local-collectors
  user-local storage, machine config, env-backed token lookup

@ai-usage/reporting
  local history -> UsageSnapshot and report assembly

@ai-usage/sync
  snapshot transport, sync workflow, snapshot server protocol,
  discovery, and UI-consumable sync state

apps/cli
  CLI adapter over @ai-usage/sync

apps/report
  web server-function adapter over @ai-usage/sync
```

`@ai-usage/sync` is the deep module. It hides auth, parsing, self-machine guards, storage, HTTP protocol, LAN host discovery, and derived sync status behind a smaller interface.

## Target Package Interfaces

Initial public exports:

```txt
@ai-usage/sync
@ai-usage/sync/transport
@ai-usage/sync/state
@ai-usage/sync/server
@ai-usage/sync/discovery
```

Expected interface shape:

```ts
readSnapshotFile(filePath)
fetchRemoteSnapshot(url, token)
readSnapshotHealth(url, token)
validateSnapshotRemote(input)

getSyncState()
upsertRemote(input)
setRemoteEnabled(name, enabled)
removeRemote(name)
pullRemote(name)
pullOneShot(input)
watchRemotes(input)

createSnapshotHttpHandler(input)
startSnapshotServer(input)

discoverSnapshotRemotes(input)
```

Names can change during implementation, but app adapters should not need to know about:

- raw `fetch` calls to `/snapshot` or `/health`;
- `Authorization` header construction;
- `UsageSnapshot` parsing details;
- local snapshot file paths;
- token resolution details;
- self-sync rejection;
- LAN interface enumeration;
- active scan timeout mechanics.

## Phase 0: Documentation And Tracking

Deliverables:

- write this plan;
- create an implementation log;
- preserve the README clarification that `serve` prints the URL used by `sync add`;
- commit documentation and tracking setup.

Checks:

- `bun run check`

## Phase 1: Shared Snapshot Transport

Move CLI-private snapshot file/HTTP loading into `@ai-usage/sync/transport`.

Implementation:

- add `packages/sync`;
- add `readSnapshotFile`;
- add `fetchRemoteSnapshot`;
- add a typed sync error shape or reuse `CliArgumentError` only at the CLI adapter;
- move parsing/auth/HTTP body handling out of `apps/cli/src/snapshot-transport.ts`;
- update `merge --remote` and `sync pull` callers.

Tests:

- parse local snapshot file;
- reject invalid file;
- fetch remote snapshot with bearer token;
- surface HTTP failures with useful messages.

Success:

- no app-owned `parseUsageSnapshot` transport code remains for merge/sync;
- `apps/cli/src/snapshot-transport.ts` is removed or reduced to a re-export-free adapter wrapper.

## Phase 2: Shared Sync Workflow And State

Move sync workflow out of `apps/cli/src/sync.ts`.

Implementation:

- add `getSyncState`;
- add `upsertRemote`, `removeRemote`, `pullRemote`, `pullOneShot`;
- add `setRemoteEnabled` if needed for UI readiness;
- derive `tokenStatus`, stored snapshot info, last fetched, rows, and machine label;
- keep `sync-storage` as the low-level persistence module;
- update CLI commands to call workflow functions and render returned state.

Tests:

- configured remote pulls and stores snapshot;
- missing token becomes a typed failure/state;
- self-machine snapshot is rejected;
- one-shot pull does not require a configured remote;
- `getSyncState` combines config and stored snapshots.

Success:

- CLI does not own token resolution, self-sync guard, or store-after-pull logic.
- a web server function can call `pullRemote` without invoking CLI code.

## Phase 3: Shared Snapshot Server Protocol

Move `/health` and `/snapshot` behavior behind `@ai-usage/sync/server`.

Implementation:

- create `createSnapshotHttpHandler`;
- return `Response` for `/health`, `/snapshot`, and not-found;
- centralize bearer auth behavior;
- centralize request metadata and status output in typed events/results;
- create `startSnapshotServer` as a Bun adapter when runtime supports it;
- keep CLI terminal logs in `apps/cli`.

Tests:

- `/health` returns local machine metadata;
- `/snapshot` returns a fresh `UsageSnapshot`;
- missing/wrong token returns `401`;
- snapshot production errors return `500`;
- unknown path returns `404`.

Success:

- a future web toggle can start the same snapshot server behavior.
- CLI `serve` is lifecycle + rendering only.

## Phase 4: Discovery

Add package-owned LAN discovery.

Implementation:

- add `discoverSnapshotRemotes`;
- start with active scan over local IPv4 subnet candidates and port `3847`;
- call `/health` through transport;
- dedupe by machine id and URL;
- include `self`, `alreadyConfigured`, `authRequired` where possible;
- keep manual URL validation as part of the same module.

Tests:

- scanner dedupes multiple URLs for the same machine;
- timeout/failure returns partial successes;
- manual URL validation shares transport behavior.

Success:

- browser/UI code receives a peer list from server functions.
- UI never owns network scanning logic.

## Phase 5: Web Server-Function Adapter Readiness

Add server functions in `apps/report` without building the visible page yet.

Implementation:

- add `apps/report/src/server/sync.ts`;
- expose serializable server functions:
  - `getSyncState`;
  - `discoverPeers`;
  - `validateRemote`;
  - `upsertRemote`;
  - `setRemoteEnabled`;
  - `pullRemote`;
  - `removeRemote`;
  - optional serve toggle if server lifecycle is safe inside the report runtime;
- return UI-shaped data and typed errors.

Tests:

- typecheck server functions;
- JSON-serialize returned state in a small test or helper where practical.

Success:

- a dedicated `/sync` route can be added as UI-only work.
- static HTML export remains unaffected.

## Phase 6: Documentation And Cleanup

Update architecture docs and public package interfaces.

Documentation:

- `docs/architecture.md`;
- `docs/public-package-interfaces.md`;
- `docs/remote-sync-architecture-plan.md`;
- `CONTEXT.md` if new domain terms are added.

Checks:

- `bun run check`;
- `bun run test`;
- targeted CLI/report tests.

Success:

- no app-to-app dependency;
- package guardrails pass;
- implementation log describes decisions and known follow-ups.

## Commit Rhythm

For each phase:

1. pick the next phase;
2. implement it;
3. run targeted tests;
4. update docs and implementation log;
5. commit;
6. pick the next phase.
