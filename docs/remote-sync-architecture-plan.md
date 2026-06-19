# Remote Sync Architecture Plan

## Context

`ai-usage` already supports multi-machine reporting through `UsageSnapshot`:

```txt
local history
  -> harness adapters
  -> collected / normalized usage rows
  -> UsageSnapshot
  -> merge snapshots
  -> report payload / CLI table / CSV / HTML
```

The LAN flow currently makes this convenient, but it is not a sync:

```txt
merge --remote <url> --local
  -> fetch remote UsageSnapshot
  -> merge in memory
  -> render one report
  -> discard remote snapshot
```

This is why the workflow feels like it dumps remote usage into the CLI. The remote data is only an input to the current render.

## Decision

Sync should persist **UsageSnapshot** data, not final report payloads and not raw harness local history.

The synced data layer is:

```txt
harness-specific local history
  -> harness adapter
  -> normalized usage rows with source provenance
  -> UsageSnapshot
```

The report-producing machine remains responsible for the final merge:

```txt
local history + stored remote UsageSnapshots
  -> merge / dedupe
  -> apply project aliases
  -> filters
  -> analytics
  -> output adapter
```

## Why This Layer

- `UsageSnapshot` is portable across Mac, Linux, and Windows.
- It preserves source provenance: machine, harness key, source session id, and source path.
- It avoids coupling sync to raw Claude, Codex, Cursor, or OpenCode storage formats.
- It keeps report rendering local to the machine asking the question.
- It allows remote machines to be offline after a successful pull.
- It reuses the existing dedupe model: `machineId + harnessKey + sourceSessionId`.

## Non-Goals

- Do not sync final `UsageReportPayload` as the source of truth.
- Do not sync raw harness local history directories or databases.
- Do not read remote SQLite databases or JSONL files directly.
- Do not introduce a cloud service.
- Do not make the LAN server serve anything except normalized snapshots.
- Do not make project aliases part of the remote producer's responsibility.
- Do not make V1 bidirectional sync write to another machine.
- Do not implement streaming sync before polling has proven useful.

## Target User Model

One machine can expose a fresh `UsageSnapshot`:

```sh
ai-usage serve --host 0.0.0.0 --token <secret>
```

Another machine can register and pull it:

```sh
ai-usage sync add macbook http://192.168.1.63:3847/snapshot --token-env AI_USAGE_SYNC_MACBOOK_TOKEN
ai-usage sync pull macbook
```

The token can live in a gitignored `.env` or a user-local env file:

```sh
AI_USAGE_SYNC_MACBOOK_TOKEN=<secret>
```

Regular reports can then include the last synced snapshot:

```sh
ai-usage report
ai-usage report --since 30d --project ai-usage --html
```

The exact CLI shape is still open, but the product distinction should be clear:

- `merge`: render from explicit snapshot inputs now.
- `sync`: persist remote snapshot inputs for later reports.
- `report`: produce the final report from local history plus configured synced snapshots.

The CLI is only one adapter for this model. Web sync management should consume the same package-owned sync modules and may expose a guided flow without matching every CLI command.

Bidirectional sync should be modeled as symmetric pull:

```txt
Mac pulls Linux UsageSnapshot
Linux pulls Mac UsageSnapshot
```

Each machine owns its own local synced snapshot store. No machine writes into another machine's store in V1.

Live sync should be modeled as polling:

```sh
ai-usage sync watch --all --interval 60s
```

The watch mode should repeatedly run the same pull operation with backoff and clear logs.

## Target Data Flow

```txt
Remote machine
  local history
    -> adapters
    -> UsageSnapshot
    -> /snapshot

Report machine
  sync pull
    -> fetch UsageSnapshot
    -> validate UsageSnapshot
    -> store snapshot locally

  report
    -> collect local UsageSnapshot in memory
    -> read stored remote UsageSnapshots
    -> merge snapshots
    -> apply local aliases
    -> render output
```

## Architecture Changes

### 0. Keep Sync Logic In Packages

Sync behavior should live in `@ai-usage/sync`, not in `apps/cli` or `apps/report`.

Responsibilities:

- snapshot file and HTTP transport;
- endpoint health checks;
- remote registration, removal, enable/disable, and pull workflow;
- UI-consumable sync state;
- snapshot server protocol;
- LAN discovery.

The apps are adapters:

- `apps/cli` parses arguments and renders terminal text;
- `apps/report` exposes server functions and eventually renders a dedicated sync UI.

### 1. Add A Synced Usage Snapshot Module

Create one deep module that owns durable synced snapshot state.

Responsibilities:

- store a pulled `UsageSnapshot`;
- list stored snapshots;
- replace older snapshots from the same configured remote;
- expose stored snapshots to report orchestration;
- preserve metadata needed for diagnostics, such as fetched time and remote name.

This module should hide filesystem layout from callers.

Possible storage shape:

```txt
~/.config/ai-usage/sync.json
~/.local/share/ai-usage/snapshots/<remote-name>.json
```

The exact paths should follow the existing local storage conventions before implementation.

### 2. Move Snapshot Transport Behind A Seam

Historically `apps/cli/src/main.ts` owned file reading, HTTP fetching, auth headers, parsing, and render orchestration.

Introduce a snapshot transport module so file and HTTP sources are adapters behind one interface.

Responsibilities:

- read snapshot files;
- fetch snapshot URLs;
- attach auth headers;
- parse and validate `UsageSnapshot`;
- return useful connection and parse errors.

This gives sync and merge the same transport behavior without duplicating CLI code.

Current implementation target:

```txt
@ai-usage/sync/transport
  readSnapshotFile
  fetchRemoteSnapshot
  readSnapshotEndpointHealth
```

### 3. Keep Report Merge In Reporting

`@ai-usage/reporting` should remain the module that builds reports from:

- explicit snapshots;
- local history;
- stored synced snapshots.

The merge step should stay close to existing `createMergedUsageReport`, because that is already where snapshot dedupe and project aliases meet.

Expected evolution:

```txt
createMergedUsageReport({
  snapshots,
  includeLocal,
  options
})
```

can gain a sibling or request option that includes stored synced snapshots. The exact interface should be designed after choosing the user-facing CLI.

### 4. Separate CLI Intent

The CLI should stop making `merge --remote` carry sync semantics by implication.

Recommended command meanings:

- `snapshot`: produce a portable snapshot file.
- `serve`: expose a fresh snapshot over HTTP.
- `merge`: render a report from explicit snapshot inputs.
- `sync`: persist remote snapshot inputs.
- `report`: render from local history and, if configured, synced snapshots.

This keeps the interface aligned with behavior and avoids the current surprise.

### 5. Give Remote Config And Secrets An Owner

If remotes can be registered, local config needs a clear owner for:

- remote name;
- snapshot URL;
- auth token or secret reference;
- last successful pull metadata;
- enabled / disabled status.

Potential config shape:

```json
{
  "sync": {
    "remotes": [
      {
        "name": "macbook",
        "url": "http://192.168.1.63:3847/snapshot",
        "tokenEnv": "AI_USAGE_SYNC_MACBOOK_TOKEN"
      }
    ]
  }
}
```

Recommended token model:

- config stores `tokenEnv`, not the token value;
- CLI accepts `--token-env <name>` for persistent remotes;
- CLI can still accept `--token <secret>` for one-shot commands;
- logs and errors never print token values;
- local `.env` loading is supported from a gitignored path.

Possible env locations:

```txt
./.env
~/.config/ai-usage/.env
```

The user-local env file is safer for persistent remotes. A repo-local `.env` is acceptable for development if it is gitignored.

### 5a. Expose UI-Consumable Sync State

The web UI should not assemble state from raw config files and stored snapshot JSON. It should consume a package-owned read model:

```txt
getSyncState
  -> local machine
  -> configured remotes
  -> token status
  -> stored synced snapshot summaries
  -> warnings
```

This keeps UI rendering independent from filesystem layout and snapshot internals.

### 6. Define Bidirectional Sync As Symmetric Pull

Bidirectional sync should not add a remote write interface in V1.

Instead, each machine can run both sides:

```txt
Machine A
  serve snapshot
  pull Machine B snapshot

Machine B
  serve snapshot
  pull Machine A snapshot
```

This keeps the sync module deep without forcing it to own remote mutation, conflict resolution, or delete propagation.

Responsibilities:

- allow multiple remotes per machine;
- store each remote's last pulled `UsageSnapshot`;
- dedupe by machine provenance during report merge;
- avoid pulling this machine from itself when machine IDs match.

### 7. Add Live Sync As A Watch Mode

Live sync should be a polling loop over the existing pull interface.

Recommended command:

```sh
ai-usage sync watch --all --interval 60s
```

Responsibilities:

- run `sync pull` repeatedly;
- enforce a minimum interval, such as 30s or 60s;
- add jitter or backoff after network failures;
- keep the previous successful snapshot when a pull fails;
- handle Ctrl+C cleanly;
- log each attempt and result.

Do not add a streaming protocol unless polling proves insufficient.

### 8. Add Operational Logs And Onboarding Output

The serve and sync interfaces should explain what is happening.

Serve logs should include:

```txt
[serve] listening snapshot=http://192.168.1.63:3847/snapshot machine=MacBook-Pro
[serve] GET /health from 192.168.1.20 -> 200 duration=3ms
[serve] GET /snapshot from 192.168.1.20 auth=ok rows=1234 generatedAt=2026-06-19T05:20:00.000Z duration=842ms
[serve] GET /snapshot from 192.168.1.20 auth=denied -> 401 duration=1ms
```

Sync logs should include:

```txt
[sync] pulling remote=macbook url=http://192.168.1.63:3847/snapshot
[sync] fetched remote=macbook machine=MacBook-Pro rows=1234 generatedAt=2026-06-19T05:20:00.000Z
[sync] stored remote=macbook path=~/.local/share/ai-usage/snapshots/macbook.json
```

Logs must never include raw tokens.

Onboarding output should be part of the command interface:

- `serve` prints the reachable snapshot URL and the command to run on the other machine;
- `sync` with no remotes prints the command to run on the serving machine;
- `sync add` validates the token env name and shows the next pull command;
- connection failures print DNS/IP/firewall hints before generic fetch errors.

## Implementation Phases

### Phase 1: Name The Domain Model

Add domain language for synced snapshots.

Likely doc changes:

- update `CONTEXT.md`;
- define "Synced usage snapshot";
- define "Snapshot remote" if remote registration is chosen.

Acceptance criteria:

- The domain model distinguishes `UsageSnapshot`, stored synced snapshot, and report payload.
- Future work can use the same vocabulary without re-litigating the data layer.

### Phase 2: Extract Snapshot Transport

Move file and HTTP snapshot loading out of the CLI.

Likely files:

- `apps/cli/src/main.ts`;
- new module under `apps/cli/src/` or `@ai-usage/reporting`;
- tests around file, HTTP, auth, parse, and error modes.

Acceptance criteria:

- `merge ./mac.json --local` still works.
- `merge --remote <url> --token <secret> --local` still works.
- Transport behavior is tested without invoking the full CLI render path.

### Phase 3: Add Local Synced Snapshot Storage

Create storage for pulled snapshots.

Likely files:

- `packages/local-collectors/src/local-history.ts` if reusing the existing filesystem seam;
- `packages/local-collectors/src/machine-config.ts` or a new local config module;
- `@ai-usage/reporting` orchestration for reading stored snapshots.

Acceptance criteria:

- A pulled snapshot can be written and read back.
- Stored snapshot parsing uses existing `parseUsageSnapshot`.
- Corrupt stored snapshots produce warnings, not broken reports.
- Filesystem layout is hidden behind one module.

### Phase 4: Add Sync Pull Workflow

Add a minimal pull path that stores a remote snapshot.

Potential command:

```sh
ai-usage sync pull --remote http://192.168.1.63:3847/snapshot --token-env AI_USAGE_SYNC_MACBOOK_TOKEN --name macbook
```

or, if registration comes first:

```sh
ai-usage sync pull macbook
```

Acceptance criteria:

- Pull fetches a valid `UsageSnapshot`.
- Pull persists it locally.
- Pull reports which machine and generated time were stored.
- Pull does not render the full usage report.

### Phase 5: Include Synced Snapshots In Reports

Teach report generation to include stored synced snapshots.

Acceptance criteria:

- `ai-usage report` can include local history plus synced snapshots.
- The final merge still happens on the reporting machine.
- Project aliases are applied on the reporting machine.
- Existing output adapters work unchanged.
- Machine provenance remains visible in wide table, CSV, JSON, and HTML.

Open product decision:

- Should synced snapshots be included by default?
- Or should the user opt in with `--synced` / `--include-synced`?

### Phase 6: Add Remote Registration

Make repeated sync ergonomic.

Potential commands:

```sh
ai-usage sync add macbook http://192.168.1.63:3847/snapshot --token-env AI_USAGE_SYNC_MACBOOK_TOKEN
ai-usage sync list
ai-usage sync pull macbook
ai-usage sync pull --all
ai-usage sync remove macbook
```

Acceptance criteria:

- Remotes have stable names.
- Tokens are referenced by env name for persistent remotes.
- Tokens are loaded from process env or a supported gitignored `.env` file.
- Tokens are not printed in normal output, logs, or errors.
- `sync list` shows last successful pull and stored snapshot generated time.
- Removing a remote has clear behavior for existing stored snapshots.

### Phase 7: Improve Serve And Sync Logs

Make the operational path visible on both machines.

Acceptance criteria:

- `serve` logs listening URL, machine label, request path, remote address, auth result, response status, row count for snapshots, warning count, and duration.
- `sync pull` logs remote name, URL, fetched machine label, row count, generated time, stored path, and duration.
- Failed auth is visible on the serving machine without leaking the token.
- Network failures on the pulling machine include a targeted hint when DNS, connection refused, timeout, or HTTP status is identifiable.
- `--quiet` or equivalent can suppress routine logs for scripted use.

### Phase 8: Add Guided Onboarding

Make the first-run path self-explanatory.

Acceptance criteria:

- `serve --host 0.0.0.0 --token <secret>` prints the LAN snapshot URL when it can infer one.
- `serve` prints an example `sync add` command for the other machine.
- `sync` with no configured remotes explains that another machine must run `serve`.
- `sync add` validates URL shape and token env name before saving.
- `sync add` prints the next command: `ai-usage sync pull <name>`.
- `sync pull` with a missing token env explains where to put the token.

### Phase 9: Add Live Sync Watch

Add polling on top of the existing pull interface.

Potential commands:

```sh
ai-usage sync watch macbook --interval 60s
ai-usage sync watch --all --interval 60s
```

Acceptance criteria:

- Watch reuses the same pull implementation as `sync pull`.
- Watch enforces a minimum interval.
- Watch keeps the last successful snapshot after failures.
- Watch applies backoff or jitter after repeated failures.
- Watch exits cleanly on Ctrl+C.
- Watch logs each attempt without printing secrets.

### Phase 10: Support Bidirectional Sync Topologies

Support the workflow where each machine serves and pulls from the other.

Acceptance criteria:

- A machine can have multiple remotes.
- Pulling a remote whose snapshot machine ID matches the local machine ID is rejected or skipped with a clear message.
- Reports dedupe correctly when both machines have snapshots from each other.
- No remote write interface is introduced.
- Documentation shows the symmetric pull topology explicitly.

## Testing Strategy

### Unit Tests

- `UsageSnapshot` parsing and dedupe remain in `@ai-usage/core`.
- Snapshot transport tests cover file and HTTP adapters.
- Synced snapshot storage tests use a fake local filesystem root.
- Config parsing tests cover remotes and token redaction.
- Env loading tests cover process env, gitignored env file, missing env, and precedence.
- Log formatting tests assert token redaction.
- Watch tests use fake timers and a fake transport adapter.

### Integration Tests

- Pull a fixture snapshot through the transport module and store it.
- Build a report from local fixture history plus stored synced snapshots.
- Verify project aliases apply after merge on the reporting machine.
- Verify a newer snapshot replaces an older snapshot from the same remote.
- Verify `sync pull` can read a token through `tokenEnv`.
- Verify bidirectional symmetric pull does not duplicate rows in the final report.
- Verify `serve` logs a snapshot request with row count and auth status.

### Manual Test

On Mac:

```sh
bun run cli -- serve --host 0.0.0.0 --token <secret>
```

On Linux:

```sh
export AI_USAGE_SYNC_MACBOOK_TOKEN=<secret>
bun run cli -- sync add macbook http://<mac-ip>:3847/snapshot --token-env AI_USAGE_SYNC_MACBOOK_TOKEN
bun run cli -- sync pull macbook
bun run cli -- report --wide
```

Expected result:

- Mac usage appears without passing `--remote` to the report command.
- Machine column identifies Mac rows.
- Reports still work if the Mac is later offline.
- The Mac terminal running `serve` logs the snapshot request.
- The Linux terminal logs where the snapshot was stored.

## Open Questions

- Should synced snapshots be included in default `report` output?
- Should `merge --remote` remain as a one-shot render feature or be renamed/de-emphasized?
- Should user-local `~/.config/ai-usage/.env` be preferred over repo-local `./.env` by default?
- Should OS keychain support be added later as another secret adapter?
- Should one remote keep only its latest snapshot, or retain history for diagnostics?
- How should `sync remove` treat already stored snapshots?
- Should sync store remote endpoint metadata inside the snapshot wrapper, separate from the `UsageSnapshot` itself?
- What is the minimum allowed watch interval?
- Should `serve` default to access logs, or require `--verbose`?

## Recommended Next Step

Design the `Synced usage snapshot` module first.

Do not start with CLI commands. The key architecture decision is the seam that turns:

```txt
remote UsageSnapshot
```

into:

```txt
durable local snapshot input for future reports
```

Once that module is named and tested, the CLI can be thin and the product behavior becomes clear.
