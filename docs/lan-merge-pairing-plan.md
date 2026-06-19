# LAN Merge Pairing Plan

## Goal

Replace the current token/URL-oriented LAN sync UX with a pairing-first flow for one concrete use case:

- two machines are on the same LAN;
- both run the report UI;
- the user wants to merge the other machine's usage into the current UI/report;
- setup should feel like "both machines are online, pair them, then merge", not like configuring HTTP remotes.

The UI should expose machines and merge state. It should not expose snapshot URLs, token env names, host binding, or shell commands in the primary path.

## Product Direction

Primary flow:

1. Open `/sync` on machine A.
2. Click `Start LAN merge`.
3. Open `/sync` on machine B.
4. Click `Start LAN merge`.
5. A shows B as `online`; B shows A as `online`.
6. User clicks `Pair` on either side.
7. Both sides enter the same temporary pairing password.
8. Once paired, each side records the other machine as a trusted merge peer.
9. The first merge runs automatically after pairing, and the UI shows each merge state.

The visible objects are:

- local machine;
- LAN machine;
- paired machine;
- merge status;
- last merge time;
- warning/error state.

The hidden implementation details are:

- transport URLs;
- bearer tokens;
- env var names;
- endpoint names;
- LAN ports, unless troubleshooting.

## Decisions

- LAN service starts only after the user clicks `Start LAN merge`.
- Pairing uses the same temporary password typed on both machines.
- V1 PAKE spike targets balanced PAKE with CPace through `@cipherman/pake-js`, encapsulated inside `packages/lan-pairing`.
- OPAQUE/SRP-style options are fallback candidates only if CPace is rejected, because the LAN flow is symmetric peer-to-peer rather than client/server verifier based.
- Noise is not a replacement for this short-password PAKE flow.
- HMAC challenge-response is only an explicit fallback if no suitable PAKE library works in this runtime.
- Do not hand-roll PAKE from a paper/spec inside this project.
- LAN discovery v1 uses active subnet scan only.
- mDNS/Bonjour/Avahi is deferred to a later optional discovery adapter.
- LAN service binds the first available port in the stable range `3847-3857`.
- Discovery scans the same stable range `3847-3857`.
- Add `packages/usage-store` as the SQLite materialized usage store before LAN merge.
- Local raw history remains authoritative for the local machine; SQLite is the canonical indexed store for reporting queries.
- LAN merge replicates normalized machine-scoped facts exported from `usage-store`; it does not copy raw SQLite database files.
- Automatic deletes are conservative: missing rows in an import are not enough to hard-delete data.
- Stored peer rows remain available in reports when the peer is offline; the UI shows freshness/last merge state.
- Forgetting a peer deletes the trusted peer record and that peer's stored rows by default.
- First merge runs automatically after pairing.
- Trusted peers are stored in a new `lan-peers.json`.
- The old sync remote system is removed rather than kept as a compatibility path.
- The invite string fallback is removed entirely.
- Merged peer data is keyed by remote machine ID.
- Old stored snapshots are not migrated; they are deleted as part of the big bang migration.
- This is an intentional big bang migration, not a backwards-compatible refactor.

## Data Boundary

The LAN protocol exchanges normalized source data, not final report payloads.

Correct flow:

```txt
Machine A local collectors
  -> normalized rows with source provenance
  -> packages/usage-store upserts local rows
  -> UsageMergeBundle
  -> LAN pairing transport
  -> Machine B imports bundle into packages/usage-store under A machineId
  -> packages/report-data queries B local rows + stored peer rows
  -> UsageReportPayload
  -> /web renders the final report
```

Do not exchange `UsageReportPayload` between machines.

Reason:

- `UsageReportPayload` is a report/rendering result.
- It includes filters, sort order, analytics, `tableRows`, omitted row counts, and presentation-oriented serialization.
- Those choices belong to the receiving UI/report request, not the sending machine.

The portable cross-machine data object is `UsageMergeBundle`:

- rows are already normalized at the package boundary;
- rows include enough source provenance to dedupe and identify the source machine;
- warnings can travel with the source data;
- the receiving machine can apply its own report filters, aliases, sorting, analytics, and rendering.

## Usage Store Model

The project should move from "compute the report from local files on every page load" toward an indexed local usage store.

Do not model this as two equal sources of truth.

Correct model:

```txt
raw local history files
  -> authoritative source for this machine's local usage

SQLite usage store
  -> materialized, indexed, canonical store used by reporting

LAN merge
  -> machine-scoped replication of normalized facts exported from another machine's usage store
```

Rules:

- local rows are rebuildable from local raw history files;
- peer rows are rebuildable only by re-merging from that peer;
- reports read from the SQLite usage store, not directly from LAN and not directly from every raw source file;
- LAN merge exports/imports typed bundles from the store, not raw SQLite files;
- each machine is authoritative only for rows whose `originMachineId` is its own machine ID;
- importing a peer bundle upserts this machine's local copy of rows for that peer machine ID;
- absence from a later peer bundle does not delete previously imported rows.

Mutation model:

- stable row key identifies the logical row across imports;
- content hash detects changed rows, such as a session resumed after a previous import;
- same stable key and different content hash means update;
- merge/dedupe can mark a row as `superseded`;
- hard delete requires an explicit delete/tombstone event or user action, not simply absence from a later import.

Suggested row storage fields:

```txt
origin_machine_id
harness_key
source_session_id
source_fingerprint
row_key
content_hash
row_json
status               -- active | superseded | deleted
active_date
project
model
token_total
first_seen_at
last_seen_at
updated_at
superseded_by
```

## Snapshot Concern

The current sync implementation is built around `UsageSnapshot`. That product concept is too low-level for this UI and should be removed from the new system.

For this use case, the domain should shift from "pull a snapshot remote" to "merge another machine".

Recommended naming:

- public/product language: `LAN merge`, `machine`, `peer`, `pairing`, `merge bundle`;
- internal data object: `UsageMergeBundle`;
- no public API, UI copy, storage path, or config name should use `snapshot` for the new LAN merge flow.

That lets the architecture avoid lying to itself:

- transport still needs a portable data payload;
- the UI does not need snapshot vocabulary;
- future merge payloads can include report facets, warnings, cursor metadata, or versioning without changing the product language.

## Target Names And README Scope

This PR includes the package/app rename and boundary documentation. The LAN merge work should not land on top of ambiguous package names.

Target names:

```txt
packages/usage-core       -> packages/report-core
packages/reporting        -> packages/report-data
packages/local-collectors -> packages/local-collectors
packages/usage-store      -> new SQLite materialized usage store package
packages/sync             -> deleted/retired
packages/lan-pairing      -> generic LAN discovery/pairing/runtime package
packages/usage-merge      -> ai-usage LAN merge domain package
apps/report               -> apps/web
apps/cli                  -> apps/cli
packages/design-system    -> packages/design-system
```

README files required in this PR:

```txt
apps/web/README.md
apps/cli/README.md
packages/report-core/README.md
packages/report-data/README.md
packages/local-collectors/README.md
packages/usage-store/README.md
packages/lan-pairing/README.md
packages/usage-merge/README.md
packages/design-system/README.md
```

Each README should use the same structure:

```md
# Name

## Owns

## Does Not Own

## Public Interface

## Depends On

## Must Not Import

## Data Boundary

## Test Strategy
```

The README files are part of the architecture, not decorative docs. They should make package ownership obvious enough that future imports can be reviewed against them.

## Dependency Enforcement

The package graph is an enforced boundary, not a convention.

Allowed dependency direction:

```txt
packages/lan-pairing
  -> no @ai-usage/* domain packages

packages/report-core
  -> no workspace runtime packages

packages/local-collectors
  -> packages/report-core

packages/usage-store
  -> packages/report-core

packages/usage-merge
  -> packages/lan-pairing
  -> packages/report-core
  -> packages/usage-store
  -> packages/local-collectors for env/machine/trusted peer config only if needed

packages/report-data
  -> packages/report-core
  -> packages/usage-store
  -> packages/usage-merge

apps/web
  -> packages/report-data
  -> packages/usage-merge through server functions

apps/cli
  -> packages/report-data
```

Rules:

- `packages/lan-pairing` must stay project-agnostic. It must not import `report-core`, `report-data`, `usage-merge`, `local-collectors`, or app packages.
- `packages/report-core` must stay pure. It must not import filesystem, LAN, local collectors, app packages, or `UsageMerge` runtime modules.
- `packages/usage-store` owns SQLite import/query/export of normalized usage facts. It must not import LAN pairing, app packages, `usage-merge`, `report-data`, or raw local collectors.
- `packages/usage-merge` is the only package that knows both LAN pairing and ai-usage merge domain concepts.
- `packages/report-data` triggers local collectors when needed, imports their normalized rows into `packages/usage-store`, then reads report rows from `packages/usage-store`.
- `packages/report-data` may depend on `packages/usage-merge` for optional peer freshness/status metadata. That dependency must be optional in behavior: reports still work when no LAN peers or peer bundles exist.
- `packages/report-data` must not start LAN services, scan the LAN, pair machines, or fetch peers over the network while rendering reports.

Enforcement plan:

- package `dependencies` are the first boundary: a package must not declare forbidden workspace packages.
- Biome project-domain rules should catch undeclared imports and import cycles once enabled.
- Biome `noRestrictedImports` can enforce direct source import bans where the rule is expressible as import patterns.
- Use Biome Grit plugins for the package graph policy that is awkward in `noRestrictedImports`, especially `package.json` dependency checks and package-specific import matrix checks.
- Co-locate comments in the Grit rules explaining the architectural reason for each forbidden edge.
- Avoid a bespoke dependency checker unless Biome/Grit cannot express a required invariant.

## Proposed Architecture

Split the system into focused modules with explicit ownership.

```txt
apps/web
  UI route and server functions only.

packages/lan-pairing
  Generic LAN discovery, pairing protocol, process-local runtime state, and LAN HTTP pairing server.

packages/usage-merge
  ai-usage LAN merge domain: trusted usage peers, peer bundle fetch/import, merge state.

packages/usage-store
  SQLite materialized usage store: import/upsert/query/export normalized usage facts.

packages/report-core
  Pure report data types, normalized row helpers, merge bundle format, filtering, sorting, analytics, serialization.

packages/local-collectors
  Local filesystem/env/config persistence primitives and local history adapters.

packages/report-data
  Report payload creation from usage-store rows.
```

The existing `packages/sync` package should be deleted or retired during the migration. Do not add new LAN merge behavior to it as a compatibility layer.

The non-negotiable boundaries:

- `lan-pairing` stays project-agnostic.
- `usage-merge` is the adapter between generic LAN pairing and ai-usage merge semantics.
- `report-data` reads stored local and peer rows through `usage-store`. It may read peer freshness/status through `usage-merge`, but it must not start LAN runtimes or fetch the network during report rendering.
- `report-core` stays pure.
- UI, transport, pairing, persistence, and report payload generation do not collapse into one module.

## Module Responsibilities

### `apps/web`

Owns:

- rendering `/sync`;
- invoking server functions;
- displaying pairing/merge status;
- mapping typed errors to user-facing hints.

Does not own:

- LAN scan logic;
- pairing cryptography or token exchange;
- peer persistence;
- merge data format;
- filesystem `.env` writes.
- final report data orchestration.

Expected server functions:

```ts
getLanMergeState()
startLanMerge()
stopLanMerge()
scanLanMergePeers()
startPairing(discoveredPeerId, password)
confirmPairing(discoveredPeerId, password)
mergePeer(machineId)
forgetPeer(machineId)
```

Server functions return Promise/JSON facades. Effect types must not cross into Solid components.

### `packages/lan-pairing`

Owns generic LAN mechanics:

- local LAN pairing service lifecycle;
- process-local runtime state and server handles;
- LAN peer discovery;
- public peer metadata;
- temporary same-password pairing sessions;
- generic credential envelope exchange;
- LAN HTTP endpoints for discovery/pairing only.

Does not own:

- ai-usage machine config;
- `UsageMergeBundle`;
- report rows;
- `.env` writes;
- trusted ai-usage peer storage;
- `UsageReportPayload`;
- report rendering.

Core generic types:

```ts
interface LanPeerIdentity {
  id: string;
  label: string;
  protocol: string;
  version: number;
}

interface DiscoveredLanPeer {
  identity: LanPeerIdentity;
  host: string;
  port: number;
  online: boolean;
  pairingAvailable: boolean;
  lastSeenAt: string;
}

interface PairingEnvelope {
  peerId: string;
  credential: string;
  metadata: Record<string, string>;
}
```

Runtime shape:

```ts
interface LanPairingService {
  start(input: StartLanPairingInput): Effect<void, LanPairingError>;
  stop(): Effect<void, LanPairingError>;
  scan(): Effect<DiscoveredLanPeer[], LanPairingError>;
  startPairing(input: PairingInput): Effect<PairingState, LanPairingError>;
  confirmPairing(input: PairingInput): Effect<PairingResult, LanPairingError>;
  getState(): Effect<LanPairingState, never>;
}
```

`lan-pairing` may start a LAN HTTP server, but `apps/web` never talks to that server over HTTP. The app talks in-process through `usage-merge` server functions.

### `packages/usage-merge`

Owns ai-usage LAN merge semantics:

- adapting local machine identity into `LanPeerIdentity`;
- encoding/decoding ai-usage credentials into `PairingEnvelope`;
- requesting local `UsageMergeBundle` exports from `packages/usage-store`;
- fetching peer merge bundles after pairing;
- importing peer merge bundles into `packages/usage-store`;
- validating peer identity and rejecting self-merge;
- storing trusted peers in `lan-peers.json`;
- writing received peer tokens to `.env`;
- exposing LAN merge state to `apps/web`;
- exposing peer freshness/status metadata to `packages/report-data` if needed.

Does not own:

- generic LAN pairing implementation details;
- final report filtering, sorting, analytics, or `UsageReportPayload`;
- UI rendering.

Suggested public API:

```ts
startLanMerge(): Effect<void, UsageMergeError>;
stopLanMerge(): Effect<void, UsageMergeError>;
getLanMergeState(): Effect<LanMergeState, UsageMergeError>;
pairPeer(input: PairPeerInput): Effect<LanMergeState, UsageMergeError>;
mergePeer(machineId: string): Effect<LanMergeState, UsageMergeError>;
readPeerStatuses(): Effect<PeerStatusResult, UsageMergeError>;
```

`usage-merge` is the only package that knows both worlds: generic LAN pairing and ai-usage normalized-row merge semantics.

### `packages/report-core`

Owns pure types and deterministic calculations:

- normalized usage row types;
- machine provenance types;
- `UsageMergeBundle` type;
- merge bundle parse/serialize helpers;
- row dedupe helpers;
- report filtering/sorting;
- analytics;
- final report payload serialization.

Does not own:

- local collection;
- LAN discovery;
- pairing;
- HTTP transport;
- filesystem persistence;
- UI rendering.

Suggested data object:

```ts
interface UsageMergeBundle {
  version: 1;
  machine: {
    id: string;
    label: string;
  };
  generatedAt: string;
  rows: SerializedMergeRow[];
  warnings: LocalHistoryWarning[];
}

interface SerializedMergeRow extends SerializedUsageRow {
  source: UsageRowSource & {
    machineId: string;
    machineLabel: string;
  };
}
```

`SerializedMergeRow` should be a portable serialization of normalized rows, not a rendered report row.

### `packages/usage-store`

Owns SQLite materialized usage storage:

- schema and migrations for normalized usage facts;
- importing local collector rows;
- importing peer merge bundles;
- exporting this machine's `UsageMergeBundle`;
- upserting rows by stable row key and content hash;
- tracking active/superseded/deleted row status;
- querying rows for report-data;
- indexing date/project/model/token/source-machine fields.

Does not own:

- raw local history collection;
- LAN discovery or pairing;
- final report payload creation;
- UI rendering.

Suggested public API:

```ts
importLocalRows(input): Effect<ImportResult, UsageStoreError>;
exportLocalMergeBundle(input): Effect<UsageMergeBundle, UsageStoreError>;
importPeerMergeBundle(input): Effect<ImportResult, UsageStoreError>;
queryReportRows(input): Effect<QueryRowsResult, UsageStoreError>;
```

### `packages/report-data`

Owns:

- triggering local collection/import into `packages/usage-store` when requested;
- querying local and stored peer rows from `packages/usage-store`;
- optionally reading peer freshness/status metadata through `packages/usage-merge`;
- applying aliases, filters, sorting, analytics, and payload serialization through `packages/report-core`.
- producing `UsageReportPayload` for `/web`, CLI, and static renderers.

Does not own:

- LAN service lifecycle;
- LAN scanning;
- pairing;
- network fetches during report rendering;
- UI rendering.

Reports must work when no LAN peers or peer bundles exist.

Suggested public API:

```ts
collectAndImportLocalRows(request): Effect<ImportResult, ReportDataError, LocalHistoryStorage | UsageStore>
createReportPayload(request): Effect<UsageReportPayload, ReportDataError, UsageStore | LocalHistoryStorage>
```

### `packages/local-collectors`

Owns:

- local history storage;
- machine config;
- `.env` discovery/upsert;
- trusted peer config file reads/writes;

This package should not know about HTTP, pairing sessions, UI states, or `UsageReportPayload`.

`packages/report-data` is the only package that should produce `UsageReportPayload` for `/web` and CLI/static renderers.

## Effect Runtime Model

Effect is used inside runtime/orchestration packages. It is not exposed to UI components.

Runtime call path:

```txt
browser
  -> apps/web server function
    -> process-local UsageMerge runtime
      -> lan-pairing runtime
        -> LAN HTTP server for other machines
```

Rules:

- `packages/lan-pairing` exposes Effect-level service interfaces.
- `packages/usage-merge` exposes Effect-level service interfaces.
- `apps/web` owns Promise/JSON server function facades over those Effect services.
- `apps/web` creates a process-local runtime once at module/server scope, using `ManagedRuntime` or an equivalent Effect runtime.
- Runtime state and server handles live in Effect `Ref`s or equivalent process-local state owned by the live layer.
- Server functions must not recreate the LAN runtime per request.
- No Effect types cross into Solid components.
- Tests use fake layers/adapters for LAN transport, clock, random/token generation, and storage.

The LAN HTTP server is an adapter for other machines. The local web app talks to the runtime in-process, never through the LAN HTTP port.

## Runtime Protocol

Primary LAN server endpoints exposed by the `usage-merge` runtime:

```txt
GET  /lan/health
GET  /lan/peer
POST /lan/pair/start
POST /lan/pair/confirm
GET  /lan/merge-bundle
```

Public endpoints:

- `/lan/health`
- `/lan/peer`

Protected endpoints:

- `/lan/pair/*`
- `/lan/merge-bundle`

`/lan/peer` response:

```json
{
  "protocolVersion": 1,
  "machineId": "27fa...",
  "machineLabel": "nixos",
  "pairingAvailable": true,
  "mergeAvailable": true
}
```

`/lan/health`, `/lan/peer`, and `/lan/pair/*` are generic enough to be backed by `packages/lan-pairing`.

`/lan/merge-bundle` is ai-usage-specific. It is exposed by `packages/usage-merge`, requires bearer auth, exports from `packages/usage-store`, and returns `UsageMergeBundle`.

## Pairing Model

V1 pairing:

- pairing is disabled by default;
- clicking `Pair` opens a pairing password form;
- the user types the same temporary password on both machines;
- each machine opens a 2 minute pairing window for that peer and password;
- both sides exchange generated merge tokens;
- both sides persist a trusted peer record;
- both sides write the received token to `.env`;
- first merge runs automatically after success;
- pairing session is invalidated after success or timeout.

Important distinction:

- pairing password: temporary, human-visible, expires quickly;
- merge token: generated, long-lived, not shown in primary UI, stored only in `.env`.

The pairing exchange should be explicit about direction:

- A gives B the token B needs to fetch A;
- B gives A the token A needs to fetch B.

That is what makes the result symmetric without asking the user to repeat the flow twice.

## State Model

The UI should get one read model:

```ts
interface LanMergeState {
  localMachine: {
    id: string;
    label: string;
  };
  service: {
    status: "stopped" | "starting" | "running" | "pairing" | "error";
    urls: string[];
    lastError?: string;
  };
  discoveredPeers: DiscoveredLanPeer[];
  trustedPeers: Array<{
    machineId: string;
    machineLabel: string;
    online: boolean;
    paired: boolean;
    lastSeenAt?: string;
    lastMergedAt?: string;
    rows?: number;
    warnings: number;
  }>;
}
```

The UI should not assemble this state from multiple transport calls. A server-side read model should compose runtime state, discovery cache, trusted peers, and merge records.

## Persistence

Suggested files:

```txt
~/.config/ai-usage/machine.json
~/.config/ai-usage/lan-peers.json
~/.config/ai-usage/usage-store.sqlite
.env
```

Rules:

- `lan-peers.json` is the only trusted peer registry.
- SQLite stores local and peer usage facts keyed by `origin_machine_id`.
- merged peer data is keyed by remote machine ID inside SQLite, not by per-peer JSON files.
- old sync remote config is not read by the new LAN merge flow.
- old stored snapshots are deleted, not migrated.
- raw tokens are stored only in `.env`.
- forgetting a peer removes its trusted peer record and deletes that peer's stored rows from SQLite by default.

Reason: the old remote config is URL/token-env oriented. The new domain is machine-oriented.

## UI Shape

Primary screen:

```txt
LAN merge

This machine
  nixos
  Online
  [Stop]

Machines on LAN
  MacBook-Pro-de-Nathan  Online  Not paired  [Pair]

Paired machines
  MacBook-Pro-de-Nathan  Online  Last merge 10:42  [Merge now] [Forget]

Pairing
  Pair with MacBook-Pro-de-Nathan
  Password [          ]
  Waiting for same password on MacBook-Pro-de-Nathan...
```

Diagnostics section:

- raw online peer details;
- runtime errors;
- optional port override only if needed for troubleshooting.

The primary path should not show:

- token env;
- bearer token;
- host input;
- port input;
- snapshot URL;
- shell commands;
- invite string.

## Big Bang Migration From Current System

Current system has:

- `@ai-usage/sync`;
- snapshot server;
- remotes;
- token env;
- stored snapshots;
- `/sync` UI for manual add/pull.

Migration policy:

1. Remove the old `/sync` manual remote UX.
2. Remove invite-string UI and server functions.
3. Remove sync remote config from the active report flow.
4. Remove stored snapshot reads from reporting.
5. Delete old stored snapshot files during cleanup, if present.
6. Add the new LAN merge flow as the only maintained path.
7. Keep only low-level reusable code if it has no snapshot/remote product semantics.

No backwards compatibility requirement. If old sync remotes or stored snapshots exist, they can be ignored or deleted.

## Implementation Slices

Commit discipline:

- Slice 0 should be rename + README only, with no behavior change.
- Add `usage-store` before LAN behavior. The store is the foundation for local reports and later peer imports.
- Later slices can delete old sync behavior and add LAN merge behavior.
- Keep commits reviewable even though the product migration is big bang.
- Do not mix route/UI redesign with package renames in the same commit.

### Slice 0: Rename And Package READMEs

Deliverables:

- rename `packages/usage-core` to `packages/report-core`;
- rename `packages/reporting` to `packages/report-data`;
- rename `apps/report` to `apps/web`;
- update package names, workspace references, imports, build scripts, generated route/build ownership docs, and public package interface docs;
- add the required README file to every package/app listed in "Target Names And README Scope";
- keep runtime behavior unchanged in this slice.

Checks:

- `bun run check`;
- focused app/package checks after each rename if needed;
- search verifies no stale `@ai-usage/core`, `@ai-usage/reporting`, or `apps/report` references remain except historical docs explicitly marked as such;
- README files document `Owns`, `Does Not Own`, `Public Interface`, `Depends On`, `Must Not Import`, `Data Boundary`, and `Test Strategy`.

### Slice 1: Domain Boundaries

Deliverables:

- define `UsageMergeBundle`;
- define `SerializedMergeRow`, stable row key, content hash, and row status types;
- define `LanPeerIdentity`, `DiscoveredLanPeer`, `TrustedLanPeer`;
- define `packages/usage-store` public interfaces without implementing the full SQLite workflow yet;
- define module ownership in code comments/docs;
- create the new `lan-peers.json` storage boundary;
- create `packages/lan-pairing` with generic LAN pairing interfaces;
- create `packages/usage-merge` with ai-usage merge interfaces;
- no UI yet.

Checks:

- type tests or focused unit tests for parsing/validation;
- no dependency from domain modules to `apps/web`.
- lint/search proves `packages/lan-pairing` does not import ai-usage domain packages.

### Slice 2: Dependency Boundary Linting

Deliverables:

- enable the relevant Biome project-domain rules if compatible with the repo;
- add Biome/Grit plugin rules for the package dependency graph;
- enforce package-specific forbidden imports;
- enforce forbidden workspace dependencies in `package.json`;
- co-locate comments in the Grit rules explaining each forbidden edge.

Checks:

- lint fails if `packages/lan-pairing` imports any ai-usage domain package;
- lint fails if `packages/report-core` imports runtime packages;
- lint fails if `packages/usage-store` imports LAN, app, `usage-merge`, `report-data`, or raw collector packages;
- lint fails if `packages/report-data` starts importing LAN runtime modules directly instead of going through `usage-merge`;
- `bun run lint`;
- documentation links the lint rules back to this plan and package READMEs.

### Slice 3: Usage Store Local Pipeline

Deliverables:

- implement `packages/usage-store` SQLite schema and migrations;
- import normalized local collector rows into SQLite;
- compute stable row keys and content hashes;
- track `active`, `superseded`, and `deleted` statuses;
- update changed rows when the same stable key has a new content hash;
- query stored local rows for `packages/report-data`;
- make report generation read through `usage-store` for local data;
- no LAN behavior yet.

Checks:

- local report output remains equivalent to the pre-store report for the same source files;
- repeated local import is idempotent;
- resumed/mutated source session updates the stored row instead of duplicating it;
- superseded rows are excluded from default report queries;
- store has no dependency on LAN packages or app packages.

### Slice 4: Usage Store Peer Bundle Import/Export

Deliverables:

- export this machine's `UsageMergeBundle` from `packages/usage-store`;
- import a peer `UsageMergeBundle` into SQLite keyed by `originMachineId`;
- store peer rows using the same stable key/content hash/status model;
- keep missing rows from a later peer import by default;
- apply explicit tombstone/delete events when present;
- query local plus peer rows for `packages/report-data`;
- expose import/export result counts for UI state.

Checks:

- local unit test with two machine IDs;
- importing a peer bundle with the local machine ID is rejected;
- importing the same peer bundle twice is idempotent;
- same row key with different content hash updates the peer row;
- missing peer row in a later bundle does not hard-delete prior data;
- report-data tests prove local rows plus stored peer rows produce the final `UsageReportPayload`;
- `packages/usage-merge` tests never assert on `UsageReportPayload`.

### Slice 5: LAN Pairing Runtime

Deliverables:

- start/stop generic LAN pairing service in `packages/lan-pairing`;
- process-local runtime state using Effect service/layer/ref;
- bind the first available port in the stable range `3847-3857`;
- `/lan/health`;
- `/lan/peer`;
- generic pairing endpoints;
- no ai-usage imports.

Checks:

- two local servers on random ports;
- binding skips an occupied port and uses the next port in range;
- startup fails clearly if the full port range is occupied;
- generic pairing runtime starts/stops idempotently;
- no raw token in public state;
- lint proves `lan-pairing` is project-agnostic.

### Slice 6: Discovery

Deliverables:

- active subnet scan discovery only;
- scan the stable port range `3847-3857`;
- no mDNS/Bonjour/Avahi dependency in v1;
- discovery interface shaped so mDNS/manual-host adapters can be added later;
- discovery cache;
- online/offline state;
- self detection.

Checks:

- fake transport tests;
- peer dedupe by machine ID;
- tests cover multiple local interfaces if feasible.

### Slice 7: PAKE Library Spike

Deliverables:

- evaluate `@cipherman/pake-js` CPace for Bun/Node compatibility;
- verify the package maturity, maintenance posture, dependency surface, and lack of domain coupling before accepting it;
- compare OPAQUE/SRP-style candidates only as fallback options if CPace is rejected;
- explicitly exclude Noise as the short-password PAKE mechanism;
- prove same-password pairing between two local runtimes derives a shared session key;
- prove wrong password fails;
- bind the transcript to peer IDs, protocol version, session ID, and pairing roles;
- keep the proof inside `packages/lan-pairing` with no ai-usage imports;
- document the selected library and why alternatives were rejected.

Checks:

- Bun and Node can import and run the selected package;
- Bun test for successful A/B same-password key agreement;
- Bun test for wrong password failure;
- tests cover replayed messages, expired session, self-pair, and concurrent pairing attempts;
- test proves no password, session key, or merge token appears in public state/log output;
- no dependency from `lan-pairing` to ai-usage domain packages;
- README documents that PAKE is encapsulated and replaceable.

Fallback rule:

- If no suitable PAKE library works cleanly, use HMAC challenge-response only as a temporary LAN-only fallback.
- The fallback must be documented as weaker because captured handshakes can be brute-forced offline.
- The fallback must require a generated high-entropy code/passphrase, not a short user password.

### Slice 8: Pairing Protocol

Deliverables:

- temporary pairing window;
- same-password pairing;
- generic bidirectional credential envelope exchange in `lan-pairing`;
- ai-usage credential encoding/decoding in `usage-merge`;
- trusted peer records;
- `.env` writes.

Checks:

- successful A/B pairing test;
- wrong password rejected;
- expired session rejected;
- self-pair rejected.

### Slice 9: Usage Merge Peer Runtime

Deliverables:

- `/lan/merge-bundle` exposed by `usage-merge`, protected by generated token, and backed by `usage-store` export;
- `Merge now` for a paired peer;
- automatic first merge after pairing;
- peer bundle import into `usage-store`;
- rows/warnings/last merged state visible in the UI state model.

Checks:

- paired peer merge test;
- missing token recovery;
- offline peer error hint;
- report rendering still performs no network work.

### Slice 10: UI Refactor

Deliverables:

- `/sync` primary LAN merge UI;
- machine list;
- pair password UI;
- paired machine actions;
- diagnostics only for troubleshooting.

Checks:

- model tests for status labels and actions;
- manual local two-server flow;
- no visible token/URL in primary path;
- no invite string or manual remote UI.

### Slice 11: Cleanup

Deliverables:

- rename user-facing copy away from "snapshot";
- remove old sync remote UI;
- remove invite string UI;
- remove old sync remote server functions;
- remove old stored snapshot reads from reporting;
- delete old stored snapshots if present;
- remove or retire `packages/sync`.

Checks:

- full package checks;
- tests prove report data comes from `usage-store` local rows plus `usage-store` peer rows;
- search verifies LAN modules do not import `UsageReportPayload` or `createUsageReportPayload`.

## Architectural Risks

Hidden coupling between UI and transport:

- Mitigation: expose a single `LanMergeState` read model and typed commands.

Confusing old and new persistence during implementation:

- Mitigation: delete the old active sync path instead of adapting it.

Pairing protocol complexity:

- Mitigation: keep v1 LAN-only and short-lived; avoid full account/auth semantics.

Report rendering doing network work:

- Mitigation: report only reads `usage-store` local and peer rows. Network fetch happens through explicit UI actions.

Token leakage:

- Mitigation: generated tokens only; public state never includes them; `lan-peers.json` stores token env names and `.env` stores raw token values.

Port conflicts:

- Mitigation: bind the first available port in `3847-3857` and publish the actual port through discovery.

## Remaining Technical Decisions

None at this planning level. The PAKE slice still needs an implementation spike to accept or reject `@cipherman/pake-js` CPace.
