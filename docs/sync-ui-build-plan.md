# LAN Sync UI Build Plan

## Goal

Build a dedicated web UI for LAN sync management in `apps/report`.

Success means:

- the report dashboard has a clear navigation control to a `/sync` page;
- `/sync` can show local sync state, configured snapshot remotes, stored synced snapshot summaries, and sync warnings;
- `/sync` can start and stop this machine's local snapshot server from the UI;
- `/sync` can discover LAN snapshot peers, validate endpoints, add remotes, enable or disable remotes, pull now, and remove remotes;
- the UI never calls `apps/cli` code;
- sync behavior remains owned by `@ai-usage/sync`;
- token values are not stored in persistent config or printed in logs;
- static HTML report export remains unaffected.

## Existing Foundation

The sync decoupling work already created the main package and web seams.

Available package modules:

- `@ai-usage/sync/state`: `getSyncState` returns the UI-consumable read model.
- `@ai-usage/sync/workflow`: remote add, remove, enable/disable, token validation, pull, and one-shot pull workflow.
- `@ai-usage/sync/discovery`: active LAN scan over snapshot endpoint health.
- `@ai-usage/sync/transport`: snapshot and endpoint health HTTP transport.
- `@ai-usage/sync/server`: snapshot HTTP protocol and the current Bun server adapter.

Available report server functions:

- `getSyncState`;
- `discoverSyncPeers`;
- `validateSyncRemote`;
- `upsertSyncRemote`;
- `setSyncRemoteEnabled`;
- `pullSyncRemote`;
- `pullOneShotSyncRemote`;
- `removeSyncRemote`.

Known missing pieces:

- a visible `/sync` route;
- navigation from the report dashboard to `/sync`;
- a report-app server lifecycle adapter for starting and stopping local snapshot serving;
- UI components and styles for sync management;
- tests for the new route, state mapping, and serve lifecycle.

## Product Model

The `/sync` page is an operational console, not a marketing or onboarding page.

Primary jobs:

1. Show whether this machine is exposing a snapshot endpoint on the LAN.
2. Let the user toggle local snapshot serving on or off.
3. Show configured remotes and their last pulled snapshot state.
4. Let the user discover, add, validate, pull, disable, and remove remotes.
5. Make token, network, self-sync, and stale-data states visible without leaking secrets.

The page should use the domain language from `CONTEXT.md`:

- local machine;
- snapshot peer;
- snapshot remote;
- synced usage snapshot;
- sync state.

## Route And Navigation

Add a dedicated TanStack Router file route:

```txt
apps/report/src/routes/sync.tsx
```

The dashboard should expose a navigation control to `/sync`.

Recommended placement:

- in the dashboard header next to the theme toggle, because sync is a page-level operational action;
- label: `Sync`;
- use an existing compact button style or add a small report-specific navigation button style;
- use a TanStack `Link` so browser navigation, focus, and active route behavior stay predictable.

The sync page header should include:

- eyebrow: `ai-usage`;
- title: `LAN sync`;
- local machine label and id;
- a compact link or button back to `/`;
- the existing theme toggle.

## Page Layout

Recommended layout:

```txt
Header

Serve status band
  - enabled/off status
  - host, port, token policy
  - reachable snapshot URLs
  - start/stop toggle
  - recent request events

Sync summary
  - configured remotes
  - enabled remotes
  - missing tokens
  - stored snapshots
  - warning count

Configured remotes table
  - name
  - enabled
  - token status
  - machine
  - rows
  - fetched at
  - URL
  - actions

Discovery and add remote
  - scan LAN
  - discovered peers
  - manual endpoint form
```

Keep the UI dense and work-focused. Avoid a landing-page hero. Reuse the existing report visual system: restrained surfaces, tables, compact controls, and status badges.

## Local Snapshot Serving Toggle

### User Behavior

The serve toggle controls whether this machine exposes a snapshot endpoint for other machines to pull.

When off:

- show `Not serving`;
- show editable host, port, and token fields;
- primary action: `Start`.

When starting:

- disable host, port, and token inputs;
- show `Starting`;
- prevent duplicate starts.

When on:

- show `Serving`;
- show one or more reachable `/snapshot` URLs;
- show the local machine label;
- show recent request events;
- primary action: `Stop`.

When stopping:

- disable controls;
- show `Stopping`;
- preserve last known URLs until stopped.

When start fails:

- show the error with a direct cause where possible, such as port already in use or runtime unsupported;
- keep the form values intact.

### Token Policy

For `host=0.0.0.0`, require a non-empty token before starting.

For `localhost` or `127.0.0.1`, token may be empty.

The token entered for serving is process-local runtime state:

- do not write it to user config;
- do not write it to repo-local `.env`;
- do not include it in URLs;
- do not include it in logs or errors;
- clear it from client state after a successful start if practical.

Persistent remote configuration continues to store `tokenEnv`, not raw token values.

### Server Functions

Add report server functions, probably in `apps/report/src/server/sync.ts` backed by `sync.server.ts` or a new `sync-serve.server.ts`:

```ts
getSyncServeState()
startSyncServe(input)
stopSyncServe()
```

Suggested serializable state:

```ts
type SyncServeStatus = 'stopped' | 'starting' | 'running' | 'stopping' | 'error';

interface SyncServeState {
  status: SyncServeStatus;
  host: string;
  port: number;
  urls: string[];
  machine?: {
    id: string;
    label: string;
  };
  tokenRequired: boolean;
  tokenConfigured: boolean;
  startedAt?: string;
  lastError?: {
    message: string;
    tag?: string;
  };
  recentRequests: SyncServeRequestEvent[];
}

interface SyncServeRequestEvent {
  method: string;
  path: string;
  remoteAddress: string;
  status: number;
  durationMs: number;
  details?: string;
  at: string;
}

interface StartSyncServeInput {
  host: string;
  port: number;
  token: string | null;
}
```

### Runtime Adapter Requirement

Do not assume the report app can call `Bun.serve`.

The CLI currently uses the Bun adapter in `@ai-usage/sync/server`, but `apps/report` can be run through Nitro with a Node server in production (`node .output/server/index.mjs`). The UI toggle needs a runtime-safe server starter.

Recommended implementation:

1. Keep `createSnapshotHttpHandler` as the shared protocol.
2. Add a Node HTTP adapter for snapshot serving, either in `@ai-usage/sync/server` or behind a package-owned runtime seam.
3. Let the report server lifecycle use the Node-compatible adapter.
4. Keep the CLI on the existing Bun adapter unless unifying them is simple.

The adapter should return the same handle shape:

```ts
interface SnapshotServerHandle {
  port: number;
  urls: string[];
  stop: () => void | Promise<void>;
}
```

If the runtime cannot support opening a listener, `startSyncServe` should return a typed unsupported-runtime error and the UI should render the toggle disabled.

### Process Lifetime

The serve handle should be stored in process-local module state inside the server runtime.

Constraints:

- one active serve instance per report server process;
- repeated `start` while running returns the current running state;
- `stop` is idempotent;
- dev-server reload can reset process-local state, so the UI should re-read state after route load and after mutations;
- this is intended for local report app usage, not hosted multi-user deployment.

## Remote Management

The configured remotes table is driven by `getSyncState`.

Each remote row should show:

- name;
- URL;
- enabled state;
- token status: `none`, `present`, or `missing`;
- token env name when present;
- machine label after the first successful pull;
- row count from the stored snapshot;
- last fetched timestamp;
- actions.

Actions:

- `Pull now`: calls `pullSyncRemote`, then refreshes `getSyncState`.
- `Enable/Disable`: calls `setSyncRemoteEnabled`, then refreshes state.
- `Edit`: opens the add/edit form prefilled with name, URL, and token env.
- `Remove`: asks for confirmation, then calls `removeSyncRemote`.

Remote enable/disable means whether normal pull selection should include the remote. It does not delete the stored snapshot.

## LAN Discovery

The discovery panel should call `discoverSyncPeers`.

Default behavior:

- scan the default LAN candidates from `@ai-usage/sync/discovery`;
- use port `3847`;
- use the package default timeout;
- show partial results as a completed scan, not as an error, because unreachable hosts are expected.

Peer row fields:

- machine label;
- host;
- snapshot URL;
- `self` badge when the peer is this machine;
- `configured` badge when it already exists as a remote;
- last seen time;
- action to add or pull where allowed.

Rules:

- self peers cannot be added;
- already configured peers should link or scroll to the existing remote row;
- discovered peer add should prefill the add form with a generated remote name and the peer snapshot URL.

## Add And Validate Remote Form

Fields:

- remote name;
- snapshot URL;
- token env;
- optional one-time validation token.

Validation:

- URL must be `http://` or `https://`;
- token env must match the package validation rule;
- endpoint validation should call `/health`;
- validation token is used only for the validation call and is not persisted.

Save behavior:

- persist only name, URL, and token env through `upsertSyncRemote`;
- refresh state after save;
- optionally offer `Pull now` after save.

One-shot pull:

- can remain a secondary advanced action;
- for V1, prefer add then pull, because persistent sync state is the main product path.

## Error States

Render known workflow reasons explicitly:

- `missing-token`: show the env var name and the supported `.env` locations;
- `invalid-url`: mark the URL field invalid;
- `invalid-token-env`: mark the token env field invalid;
- `unknown-remote`: refresh state and show that the remote no longer exists;
- `no-remotes`: show the discovery and add form empty state;
- `self-sync`: explain that this endpoint is the local machine and cannot be synced as a remote.

Render transport failures by operation:

- fetch error or timeout: suggest checking host, IP, firewall, and whether serving is on;
- HTTP 401: token mismatch or missing token;
- HTTP 404: endpoint is not a snapshot endpoint;
- parse errors: endpoint did not return a valid `UsageSnapshot`.

Errors returned by server functions should stay in `{ ok: false, error }` form so client components do not depend on Effect error internals.

## Refresh Model

Initial page load:

1. call `getSyncState`;
2. call `getSyncServeState`.

After mutations:

- start/stop serve: refresh serve state;
- add/edit/remove/enable/pull: refresh sync state;
- discovery: update peer list only;
- successful pull: refresh sync state and optionally trigger report payload refresh only when navigating back to the dashboard.

Avoid automatic full-page polling in V1. Use explicit refresh buttons and refresh after mutations. A later live mode can add polling once the basic operations are stable.

## Design System Work

Prefer existing report styles from `@ai-usage/design-system/report`.

Likely additions:

- sync page layout classes;
- status badge styles;
- compact action row styles;
- inline form row styles;
- request log styles;
- possibly a generic icon button style if navigation/action icons are added.

Keep additions report-specific unless another app needs them.

Do not introduce a new color theme for sync. Use existing semantic tokens and chart colors for status accents.

## Implementation Slices

### Slice 1: Route And Navigation

Files:

- `apps/report/src/routes/sync.tsx`;
- `apps/report/src/Dashboard.tsx`;
- `apps/report/src/routeTree.gen.ts` if route generation is manual in this workflow;
- design-system report styles if needed.

Deliverables:

- dashboard has a `Sync` navigation control;
- `/sync` renders a static shell using existing layout and theme toggle;
- `/sync` links back to `/`.

Checks:

- `bun --filter @ai-usage/report check`.

### Slice 2: Read-Only Sync State

Files:

- `apps/report/src/sync-page.tsx` or route-local components;
- optional `apps/report/src/sync-page-model.ts`.

Deliverables:

- `/sync` calls `getSyncState`;
- local machine, warnings, remotes, and stored snapshot summaries render;
- empty state points users toward serving on another machine or discovery.

Checks:

- model tests if formatting/status derivation is extracted;
- `bun --filter @ai-usage/report check`.

### Slice 3: Remote Mutations

Deliverables:

- add/edit remote form;
- enable/disable toggle;
- pull now;
- remove with confirmation;
- typed error rendering for workflow and transport errors.

Checks:

- targeted server adapter tests where practical;
- `bun --filter @ai-usage/report check`;
- sync package tests remain passing.

### Slice 4: LAN Discovery

Deliverables:

- scan button;
- discovered peer list;
- self/configured badges;
- add-from-peer flow;
- scan loading and empty states.

Checks:

- model tests for peer-to-form mapping and badge derivation;
- `bun test packages/sync/src/discovery.test.ts`;
- `bun --filter @ai-usage/report check`.

### Slice 5: Serve Runtime Adapter

Deliverables:

- runtime-safe snapshot server adapter for the report server;
- process-local serve runtime state;
- `getSyncServeState`, `startSyncServe`, `stopSyncServe` server functions;
- ring buffer of recent request events;
- unsupported-runtime and port-in-use error mapping.

Checks:

- unit tests around serve state transitions using an injected fake server starter;
- direct adapter smoke test if the runtime supports it;
- `bun --filter @ai-usage/sync check`;
- `bun --filter @ai-usage/report check`.

### Slice 6: Serve Toggle UI

Deliverables:

- serve status band;
- host, port, token controls;
- start/stop toggle;
- URLs display with copy affordance if easy;
- recent request log;
- token policy validation.

Checks:

- component/model tests for state labels and validation;
- manual start/stop on localhost;
- manual start on `0.0.0.0` with token.

### Slice 7: Polish And Resilience

Deliverables:

- responsive layout at mobile and desktop widths;
- keyboard-accessible controls;
- focus states;
- no overlapping text;
- clear loading and disabled states;
- final docs update.

Checks:

- `bun run check`;
- `bun run test`;
- manual two-machine sync flow.

## Manual Acceptance Flow

On Machine A:

1. open the report app;
2. go to `/sync`;
3. start serving on `0.0.0.0:3847` with a token;
4. confirm the page shows one or more snapshot URLs.

On Machine B:

1. open the report app;
2. go to `/sync`;
3. scan LAN or manually add Machine A's snapshot URL;
4. configure `tokenEnv`;
5. ensure the token is available through a supported `.env` location or process env;
6. pull now;
7. confirm rows, machine label, and fetched time update;
8. go back to the report and confirm Machine A rows are included.

Back on Machine A:

1. confirm recent request events show health and snapshot requests;
2. stop serving;
3. confirm Machine B cannot pull until serving is restarted.

## Non-Goals For V1

- no remote write API;
- no cloud service;
- no raw local history sync;
- no final report payload sync as source of truth;
- no raw token persistence in config;
- no background daemon outside the report server process;
- no streaming protocol;
- no automatic live polling toggle unless added as a later slice.

## Risks And Mitigations

Runtime mismatch:

- Risk: `Bun.serve` is unavailable in the report runtime.
- Mitigation: add a Node-compatible adapter over `createSnapshotHttpHandler`.

Long-lived server lifecycle:

- Risk: server functions are normally request/response, while serving requires process-local lifecycle.
- Mitigation: isolate lifecycle in a small runtime module with explicit state transitions and idempotent start/stop.

Port conflicts:

- Risk: port `3847` is already in use.
- Mitigation: return a typed start error and keep user inputs intact.

Token leakage:

- Risk: token appears in logs, URLs, errors, or persistent config.
- Mitigation: keep serving token in memory only, store remote credentials as `tokenEnv`, and sanitize request event details.

Firewall and LAN reachability:

- Risk: serving starts but other machines cannot connect.
- Mitigation: show all detected URLs, show request logs, and map fetch failures to actionable network hints.

Self-sync:

- Risk: user adds this machine as its own remote.
- Mitigation: discovery marks `self`; pull workflow already rejects matching machine IDs.

Static export:

- Risk: static HTML export includes unusable server controls.
- Mitigation: `/sync` is a server-backed route in the report app runtime; static HTML export should not expose it as an active management surface.

## Open Decisions

- Should the serve toggle remember the last host and port in local browser storage, user config, or not at all?
- Should serving include all harnesses by default, or expose harness filters like the CLI `serve` command?
- Should the UI include a raw one-time token for endpoint validation, or only validate remotes whose token env is already available server-side?
- Should pull success on `/sync` trigger a report payload refresh when returning to `/`, or should the dashboard refresh itself normally?
- Should a later slice expose `sync watch` style polling from the UI, or keep polling CLI-only until there is a durable daemon model?

## Implementation Follow-Up Log

### 2026-06-19: All-in-one setup UX correction

Picked:

- Fix the confusing all-in-one flow after a real UI run showed `EADDRINUSE` and unclear two-machine instructions.

Implemented:

- The generated copy block is now a paste-ready shell block for the other machine.
- The block upserts `.env` with `TOKEN_ENV`/`TOKEN_VALUE`, then runs `sync add` and `sync pull`.
- The all-in-one server start retries with port `0` when the requested port is already occupied, so the OS picks a free port and the copied URL uses that real port.
- The sync page maps `EADDRINUSE` into an actionable hint and clarifies that the paste block is for the other repo checkout.

Difficulties:

- A plain `AI_USAGE_SYNC_HOST_TOKEN=secret` line in the copied block does not reliably expose the token to child commands and does not modify `.env` on the other machine.
- `0.0.0.0` is correct for binding but not correct as the remote URL; the copied command must use a reachable LAN URL.

Decisions:

- Keep manual `Start` strict when a selected port is busy.
- Make only the all-in-one path auto-fallback to a free port, because it can also print the exact URL that the other machine should use.

Tested:

- `bun test apps/report/src/server/sync-serve.server.test.ts apps/report/src/sync-page-model.test.ts`
- `bun --filter @ai-usage/report check`

### 2026-06-19: UI-to-UI sync invite

Picked:

- Replace the terminal-oriented share flow with a single copy/paste string that moves from machine A's UI into machine B's UI.

Implemented:

- Added a versioned `ai-usage-sync-v1:` invite string containing remote name, snapshot URL, token env name, and one-time copied token.
- The all-in-one setup now shows the invite string as the primary copy target.
- Added a `Paste sync invite` panel that writes/replaces `.env`, saves the remote, and pulls it immediately.

Difficulties:

- The invite necessarily contains the secret while it is being copied, but the secret is still not persisted in sync config.
- The import path needed shared `.env` upsert logic without creating a circular dependency between sync serving and sync remote management.

Decisions:

- Keep the shell block generation server-side for compatibility, but do not expose it as the primary UI path.
- Importing an invite performs one pull immediately, so the user sees whether the connection works without needing a second action.

Tested:

- `bun test apps/report/src/server/sync-serve.server.test.ts apps/report/src/sync-page-model.test.ts`
- `bun --filter @ai-usage/report check`
