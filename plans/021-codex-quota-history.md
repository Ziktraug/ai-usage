# Plan 021: Persist and visualize Codex quota history behind a provider-neutral seam

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan in
> `plans/README.md` unless a reviewer dispatched you and told you they maintain
> the index.
>
> **Drift check (run first)**:
> `git diff --stat 17bcf28..HEAD -- packages/report-core packages/local-collectors packages/usage-store packages/report-data apps/web apps/cli README.md docs`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding. On a
> material mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: MED
- **Depends on**: none
- **Category**: direction
- **Planned at**: commit `17bcf28`, 2026-07-15

## Why this matters

`ai-usage` already shows the latest Codex subscription quota snapshot, but it
does not retain observations and therefore cannot show how the 5-hour, weekly,
or provider-defined limits evolve. Codex now exposes a supported local
machine-readable source through `codex app-server`, while existing rollout
JSONL files provide a best-effort historical backfill.

This plan adds Codex only. It deliberately makes the persisted observation
model, ingestion interface, history query, and UI series provider-neutral so a
future provider can write normalized observations without inheriting Codex's
JSON-RPC process lifecycle. The module should be deep: callers request a quota
refresh or a bounded history query; authentication, app-server protocol,
rollout quirks, deduplication, checkpoints, SQLite transactions, and
downsampling stay behind those interfaces.

## Architecture decisions

These decisions are requirements, not suggestions for the executor:

1. **Use `codex app-server`, never direct WHAM HTTP.** Spawn the installed
   `codex` CLI, perform the JSON-RPC initialization handshake, and call
   `account/rateLimits/read`. Do not read `~/.codex/auth.json`, copy bearer
   tokens, call `/wham/usage`, or persist raw responses.
2. **Separate observation ingestion from source lifecycle.** The common seam is
   a normalized `ProviderQuotaObservation[]` batch. A poll-based adapter may
   produce a batch now; a future push/status-line adapter may send a batch to
   the same store without implementing fake polling methods.
3. **Keep the batch-source interface minimal.** Define one internal
   `ProviderQuotaBatchSource.collect(request)` method. Do not add hypothetical
   `watch`, `subscribe`, `authenticate`, or `backfill` methods. Codex live and
   Codex rollout backfill may be separate adapters satisfying that one role.
4. **Keep storage and query contracts provider-neutral.** No SQLite column or
   public query field may be named `primary`, `secondary`, `5h`, or `weekly`.
   Persist provider limit identity, duration, semantic group, percentage, and
   reset time as data.
5. **Do not put history in `UsageReportPayload`.** The report support bootstrap
   is byte-bounded and current provider status is small. Historical points use
   a dedicated bounded query, independent of report revisions and session date
   filters.
6. **Polling is opportunistic, not a daemon.** The served dashboard requests a
   refresh on mount and every five minutes while open. Server-side singleflight
   and a persisted last-attempt/success record prevent every tab or one-minute
   report refresh from spawning Codex repeatedly. Static HTML remains read-only.
7. **Backfill and live polling are different confidence classes.** Live
   app-server reads are authoritative current observations. Rollout snapshots
   are historical, opportunistic, potentially replayed, and may lack account
   identity. Preserve that distinction through persistence and UI diagnostics.
8. **Store coverage without storing every duplicate.** Adjacent observations
   with identical normalized content extend the latest row's
   `last_observed_at`. Insert a new change point when content or reset-cycle
   identity changes, and insert an unchanged heartbeat at least every 30
   minutes so the chart can distinguish coverage from silence.
9. **Current status remains compatible.** Project the latest stored Codex
   observation back into the existing `ProviderStatusDataset`. Existing local
   history and static reports remain fallbacks; `apps/cli/src/quota.ts` keeps its
   current output and behavior in this plan.
10. **Do not fabricate a monthly quota.** Render every returned Codex window by
    identity/duration. Show a monthly series only when Codex actually returns a
    monthly/provider-defined limit compatible with that label.

## Target module shape

The external seams should be small:

```ts
// @ai-usage/report-core/provider-quota (pure serialized domain)
export interface ProviderQuotaObservation {
  accountScope: string | null;
  machineId: string;
  machineLabel: string | null;
  observedAt: string;
  plan: string | null;
  providerGeneratedAt: string | null;
  providerKey: string;
  providerLabel: string;
  source: ProviderQuotaObservationSource;
  state: ProviderStatusState;
  windows: ProviderLimitWindow[];
}

export interface ProviderQuotaObservationSource {
  confidence: 'authoritative' | 'historical' | 'derived';
  key: string; // e.g. codex-app-server, codex-rollout
  mode: 'poll' | 'push' | 'backfill';
}

export interface ProviderQuotaHistoryRequest {
  from: string;
  machineId?: string;
  maximumPoints?: number;
  providerKey?: string;
  to: string;
}

export interface ProviderQuotaHistoryResult {
  coverage: ProviderQuotaCoverage[];
  generatedAt: string;
  latest: ProviderStatus[];
  points: ProviderQuotaHistoryPoint[];
  truncated: boolean;
}
```

Names may be adjusted to match repository conventions, but the information and
separation above must remain. `accountScope` must be an opaque stable digest or
`null`, never a raw credential. Reuse `ProviderLimitWindow` and
`ProviderStatusState`; do not create a second percentage/window vocabulary.

The orchestration seam in `@ai-usage/report-data` should expose two operations:

```ts
refreshLocalProviderQuotas(input): Effect<ProviderQuotaRefreshResult, ...>
queryLocalProviderQuotaHistory(input): Effect<ProviderQuotaHistoryResult, ...>
```

Only `@ai-usage/report-data` composes machine identity, source adapters,
checkpoints, and `@ai-usage/usage-store`. Callers must not coordinate these
packages themselves.

## Current state

### Existing provider-status domain

`packages/report-core/src/provider-status.ts:30-40` already defines the shared
window vocabulary:

```ts
export interface ProviderLimitWindow {
  blocked: boolean;
  group: string | null;
  id: string;
  label: string;
  limitSeconds: number | null;
  remainingPercent: number | null;
  resetsAt: string | null;
  scope: ProviderLimitWindowScope;
  usedPercent: number | null;
}
```

`packages/report-core/src/provider-status.ts:283-329` normalizes legacy Codex
rollout/WHAM-shaped snake-case data into current `ProviderStatus`. It does not
parse the app-server camel-case response (`usedPercent`,
`windowDurationMins`, `resetsAt`, `rateLimitsByLimitId`). Keep legacy parsing
working and add an explicit app-server normalization path.

`packages/report-core/src/provider-status.ts:566-588` merges only the latest
status per machine/provider. That behavior is correct for current status and
must not be repurposed as history storage.

### Existing local Codex snapshot

`packages/local-collectors/src/codex-history.ts:869-907` scans recent rollout
files, chooses one newest `rate_limits` payload, and stops after the first file
with a match. This is a latest-status compatibility path, not an incremental
backfill implementation.

`packages/local-collectors/src/datasets.ts:59-67` always builds current Codex
provider status from that local snapshot when provider status is requested.

### Existing SQLite store

`packages/usage-store/src/index.ts:118-153` migrates only `usage_rows` and
`usage_store_metadata`. `packages/usage-store/src/index.ts:155-164` already
opens SQLite with `busy_timeout = 5000` and WAL. Follow the existing
`BEGIN IMMEDIATE` / commit / rollback and Effect error conventions in this
module.

### Existing orchestration and web transport

`packages/report-data/src/index.ts:234-272` owns report dataset collection and
merge. `packages/report-data/src/index.ts:522-594` builds stored report payloads
from SQLite rows plus collected current datasets.

`apps/web/src/dashboard.tsx:141` refreshes the full report every minute. Do not
use that timer as the Codex polling cadence. `apps/web/src/provider-status-panel.tsx`
shows a compact current status and provider details but no historical surface.

Server functions in `apps/web/src/server/report-payload.ts` strictly validate
inputs before lazy-importing `.server` implementations. Bun-only report/query
work is isolated behind subprocess runners; match that pattern because
`bun:sqlite` cannot execute inside the Node/Nitro production runtime.

### Repository conventions

- Effect-based storage/collector errors live with their owning package.
- Cross-package imports use declared package exports only; private `src` paths
  are blocked by tooling.
- Unit and integration tests use `bun:test` and colocated `*.test.ts` files.
- Web server functions validate unknown input before delegating.
- Generated `apps/web/src/routeTree.gen.ts` must never be edited manually.
- Formatting/linting is enforced by Ultracite/Biome.

## Commands you will need

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Domain tests | `bun test packages/report-core/src/provider-quota.test.ts packages/report-core/src/provider-status.test.ts` | exit 0, all tests pass |
| Collector tests | `bun test packages/local-collectors/src/codex-app-server.test.ts packages/local-collectors/src/codex-quota-history.test.ts` | exit 0, all tests pass |
| Store tests | `bun test packages/usage-store/src/index.test.ts` | exit 0, all tests pass |
| Orchestration tests | `bun test packages/report-data/src/provider-quota.test.ts` | exit 0, all tests pass |
| Web model/server tests | `bun --filter @ai-usage/design-system build && bun test apps/web/src/provider-quota-history-model.test.ts apps/web/src/server/provider-quota.server.test.ts` | exit 0, all tests pass |
| Browser test | `bun run test:e2e -- --grep "Codex quota history"` | exit 0, scenario passes |
| Typecheck | `bun run typecheck` | exit 0, no TypeScript errors |
| Lint | `bun run lint` | exit 0, no boundary or lint failures |
| Format/check | `bun x ultracite check` | exit 0 |
| Full unit suite | `bun run test` | exit 0, all package/tool tests pass |

Do not run `bun install` unless dependencies are actually missing. This plan
should not require a new runtime dependency.

## Suggested executor toolkit

- Use the repository's TDD skill if available for the domain parser, SQLite
  idempotency, JSON-RPC transport, and chart segmentation.
- Read `docs/provider-quota-data-sources.md` before implementing the Codex
  adapter.
- Consult the official Codex app-server schema generated by the locally
  installed CLI if response details are uncertain, but do not commit generated
  schemas unless the repository explicitly chooses that maintenance burden.

## Scope

**In scope** — these existing files may be modified:

- `packages/report-core/package.json`
- `packages/report-core/src/provider-status.ts`
- `packages/report-core/src/provider-status.test.ts`
- `packages/local-collectors/package.json`
- `packages/local-collectors/src/index.ts`
- `packages/local-collectors/src/local-history.ts`
- `packages/local-collectors/src/datasets.ts`
- `packages/usage-store/src/index.ts`
- `packages/usage-store/src/index.test.ts`
- `packages/report-data/package.json`
- `packages/report-data/src/index.ts`
- `apps/web/src/dashboard.tsx`
- `apps/web/src/provider-status-panel.tsx`
- `apps/web/src/report-data.ts`
- `apps/web/src/server/report-payload.ts`
- `apps/web/e2e/dashboard.spec.ts`
- `README.md`
- `docs/architecture.md`
- `docs/provider-status-windows-plan.md`
- `docs/public-package-interfaces.md`

**In scope** — these focused files may be created (rename only when repository
conventions strongly require it):

- `packages/report-core/src/provider-quota.ts`
- `packages/report-core/src/provider-quota.test.ts`
- `packages/local-collectors/src/provider-quota.ts`
- `packages/local-collectors/src/codex-app-server.ts`
- `packages/local-collectors/src/codex-app-server.test.ts`
- `packages/local-collectors/src/codex-quota-history.ts`
- `packages/local-collectors/src/codex-quota-history.test.ts`
- `packages/local-collectors/src/test-fixtures/fake-codex-app-server.ts`
- `packages/report-data/src/provider-quota.ts`
- `packages/report-data/src/provider-quota.test.ts`
- `packages/report-data/src/provider-quota-runner.ts`
- `apps/web/src/provider-quota-client.ts`
- `apps/web/src/provider-quota-history-model.ts`
- `apps/web/src/provider-quota-history-model.test.ts`
- `apps/web/src/provider-quota-history-panel.tsx`
- `apps/web/src/server/provider-quota.ts`
- `apps/web/src/server/provider-quota.server.ts`
- `apps/web/src/server/provider-quota.server.test.ts`
- `apps/web/src/server/provider-quota-runner.server.ts`

**Out of scope** — do not touch even if related:

- Claude, Cursor, OpenCode, Gemini, or other provider adapters.
- Direct OpenAI HTTP endpoints, OAuth files, browser cookies, or token refresh.
- A system daemon, cron entry, launchd unit, systemd unit, or background process
  that survives the app.
- Synchronizing quota history between machines or adding it to merge bundles.
- Embedding the full history in static HTML/snapshot exports.
- Changing the current `ai-usage quota` CLI output.
- Inferring spend, credits, or a monthly percentage not returned by Codex.
- Adding a fourth dashboard route/tab or editing `routeTree.gen.ts`.
- A generic provider plugin framework. The normalized ingestion seam is enough
  until a second real provider exists.
- New chart libraries.

## Git workflow

- Suggested branch: `advisor/021-codex-quota-history`.
- Commit by vertical verification boundary, for example:
  `feat(quota): add provider-neutral observation contracts`,
  `feat(quota): persist codex quota observations`, and
  `feat(web): visualize codex quota history`.
- Do not push or open a PR unless the operator explicitly asks.
- Preserve the pre-existing untracked research document
  `docs/provider-quota-data-sources.md`; it belongs to the user's current work.

## Steps

### Step 1: Add pure provider-quota contracts and app-server normalization

Create `packages/report-core/src/provider-quota.ts` as the serialized domain and
query contract. Reuse `ProviderLimitWindow`, `ProviderStatus`, and validation
helpers from `provider-status.ts`. Add strict parsers from `unknown` for every
value crossing the server/browser or SQLite JSON seam.

Implement pure helpers for:

- parsing the app-server `account/rateLimits/read` result;
- enumerating the root limit and every entry in `rateLimitsByLimitId`;
- mapping camel-case `usedPercent`, `windowDurationMins`, and `resetsAt` to the
  existing window model;
- preserving `limitId`, optional limit name, plan, block state, and reset time;
- assigning semantic groups from duration without assuming primary means 5h;
- projecting the latest observation to `ProviderStatus`;
- computing a canonical content fingerprint input that excludes observation
  timestamps and account credentials;
- parsing bounded history requests/results;
- segmenting points at reset identity changes and collection gaps;
- bounded downsampling that always preserves first/last points, extrema, reset
  boundaries, blocked states, and gap boundaries.

Do not make app-server parsing a broad collection of optional property probes
spread across callers. One normalizer should own all raw payload quirks.

Tests must cover:

- root primary/secondary windows;
- multiple `rateLimitsByLimitId` entries;
- absent windows remaining absent, never zero;
- Unix-second resets and invalid timestamps;
- percentages clamped using existing rules;
- unexpected extra fields ignored;
- malformed nested fields rejected or downgraded without throwing;
- stable content fingerprints across property order and observation time;
- reset/gap segmentation and downsampling preservation.

Add the package export and document it in `docs/public-package-interfaces.md`.

**Verify**:
`bun test packages/report-core/src/provider-quota.test.ts packages/report-core/src/provider-status.test.ts`
→ all tests pass.

### Step 2: Add append-only quota persistence, deduplication, and checkpoints

Extend the existing migration in `packages/usage-store/src/index.ts` with three
provider-neutral tables. Exact names may follow local naming conventions, but
the schema must carry these concepts:

```text
provider_quota_observations
  id INTEGER PRIMARY KEY
  provider_key TEXT NOT NULL
  account_scope TEXT
  machine_id TEXT NOT NULL
  machine_label TEXT
  source_key TEXT NOT NULL
  source_mode TEXT NOT NULL
  source_confidence TEXT NOT NULL
  state TEXT NOT NULL
  plan TEXT
  provider_generated_at TEXT
  first_observed_at TEXT NOT NULL
  last_observed_at TEXT NOT NULL
  content_hash TEXT NOT NULL

provider_quota_windows
  observation_id INTEGER NOT NULL REFERENCES provider_quota_observations(id) ON DELETE CASCADE
  provider_window_id TEXT NOT NULL
  label TEXT NOT NULL
  semantic_group TEXT
  scope TEXT NOT NULL
  limit_seconds INTEGER
  used_percent REAL
  reset_at TEXT
  blocked INTEGER NOT NULL
  PRIMARY KEY (observation_id, provider_window_id)

provider_quota_source_state
  provider_key TEXT NOT NULL
  machine_id TEXT NOT NULL
  source_key TEXT NOT NULL
  cursor_key TEXT NOT NULL
  cursor_json TEXT
  last_attempt_at TEXT
  last_success_at TEXT
  updated_at TEXT NOT NULL
  PRIMARY KEY (provider_key, machine_id, source_key, cursor_key)
```

Enable foreign keys for this database connection. Add indexes supporting
`provider_key + machine_id + observed range` and latest-observation lookup.
Window rows must remain queryable without JSON scans. Do not store a raw Codex
response. If a normalized JSON copy is retained for schema evolution, it must
contain only the normalized observation and pass the strict parser on read.

Expose store operations for:

- importing one normalized batch plus checkpoint updates in one transaction;
- reading source state/checkpoints;
- recording source attempt/success without erasing the last successful data;
- querying the latest observation per provider/machine/account scope;
- querying a bounded range, including one anchor point immediately before
  `from` for step-chart continuity;
- returning skipped/corrupt counts rather than allowing one damaged row to
  break the whole history.

Import rules:

- Compare each observation with the latest row for its series.
- Same content within 30 minutes: update `last_observed_at`, do not add windows.
- Same content after 30 minutes: insert a heartbeat row.
- Changed content or reset identity: insert immediately.
- Exact re-import of a backfill source event must be idempotent. Use a stable
  source-event digest or checkpoint plus transaction; do not rely on timestamp
  coincidence alone.
- Advance a backfill checkpoint only in the same transaction that commits its
  observations.
- Increment the existing store generation when quota data changes so stored
  report freshness can observe the mutation.

Tests must cover clean migration, migration over an existing usage-only DB,
idempotent re-import, adjacent coalescing, 30-minute heartbeat, reset changes,
transaction rollback, checkpoint atomicity, range bounds, pre-range anchor,
machine/account isolation, latest projection, and corrupt normalized data.

**Verify**: `bun test packages/usage-store/src/index.test.ts` → all tests pass.

### Step 3: Implement the Codex app-server batch adapter

Create `packages/local-collectors/src/codex-app-server.ts`. Its public role is
to produce normalized observations; JSON-RPC and subprocess details remain
private.

The live implementation must:

1. Spawn `codex app-server --stdio` without a shell.
2. Send one `initialize` request with stable client information identifying
   `ai-usage`, wait for its matching response, then send `initialized`.
3. Send `account/rateLimits/read` with a distinct request id.
4. Ignore unrelated notifications and correlate responses by id.
5. Parse the result through the pure report-core normalizer.
6. Close stdin and terminate the child after the response.
7. Enforce an overall timeout (10 seconds initially), bounded line length, and
   a bounded stderr tail.
8. Honor `AbortSignal` and always clean up readers/processes in `finally`.
9. Map missing executable, timeout, auth-required RPC error, protocol error,
   malformed result, and empty limits to explicit typed errors.
10. Never log or persist raw response bodies, environment variables, auth data,
    or unbounded stderr.

Use an injected process runner or executable path for tests. The second adapter
at this internal seam is the deterministic fake app-server fixture, not a
hypothetical provider implementation.

The fixture must test handshake order and emit configurable success, sparse
notification, RPC error, malformed JSON, delayed response, and noisy stderr
cases. Include a test proving that a rate-limit read does not start a model
thread/turn.

Export only the high-level Codex batch collector through
`@ai-usage/local-collectors`; do not export raw transport helpers unless another
package genuinely needs them.

**Verify**: `bun test packages/local-collectors/src/codex-app-server.test.ts`
→ all tests pass and no real network/model call occurs.

### Step 4: Implement bounded incremental Codex rollout backfill

Create `packages/local-collectors/src/codex-quota-history.ts`; do not add this
responsibility to the already-large session parser in `codex-history.ts`.

Extend `LocalHistoryStorage` only as needed for efficient, testable incremental
reads, preferably with file metadata and byte-range text reads. The live layer
may use Node filesystem primitives; tests provide a temporary-home adapter.

Backfill behavior:

- Discover Codex rollout JSONL under `~/.codex/sessions`.
- Default to the last 35 days, enough for the 30-day history control. Make the
  bound explicit in the collection request rather than a hidden global scan.
- Skip unchanged files using per-file size/mtime/offset checkpoints.
- Resume append-only files at the last committed byte offset and handle a
  partial trailing line without advancing past it.
- Parse only `token_count.payload.rate_limits` observations.
- Normalize through the existing legacy Codex normalizer and then the common
  observation model.
- Collapse adjacent identical content into coverage intervals before returning
  the batch; always keep reset changes and a 30-minute heartbeat.
- Treat the rollout timestamp as observation time, not authoritative provider
  generation time. Set `providerGeneratedAt` to `null` unless the payload has a
  trustworthy provider timestamp.
- Mark the source `codex-rollout`, mode `backfill`, confidence `historical`.
- Reject or flag snapshots whose reset data proves they were already expired at
  the event time; do not let replayed stale snapshots replace newer live data.
- Bound one run by files/bytes/time and return `hasMore` plus checkpoint updates
  so later polls can continue without blocking dashboard startup.

Tests must use temporary JSONL fixtures for duplicate snapshots, reset changes,
null limits, malformed lines, partial final lines, append-after-checkpoint,
truncation/rotation, stale replay, time-range filtering, and bounded continuation.

**Verify**:
`bun test packages/local-collectors/src/codex-quota-history.test.ts packages/local-collectors/src/codex-history.test.ts`
→ all tests pass.

### Step 5: Compose refresh and history query in report-data

Create `packages/report-data/src/provider-quota.ts` as the deep orchestration
module. It owns:

- current machine identity and usage-store path;
- persisted source-state lookup;
- the five-minute live polling due check;
- live app-server collection;
- bounded rollout backfill continuation;
- import/checkpoint transaction calls;
- isolation of source errors so existing history remains readable;
- latest-status projection;
- bounded history query and downsampling.

The default production source registry contains only Codex app-server and Codex
rollout. Tests may inject batch sources, a clock, and cadence values through
internal options. `apps/web`, `apps/cli`, and `usage-store` must not import Codex
adapter implementation details.

Refresh semantics:

- If live success is less than five minutes old, skip the app-server call.
- Join concurrent refreshes in the host process; duplicate processes must remain
  harmless because store import is idempotent.
- Attempt backfill in bounded chunks until the 35-day cursor is current, at
  most one chunk per refresh request.
- A live error records source state and returns a warning/status but does not
  delete or overwrite the latest successful observation.
- An auth error is visible as `auth-required`; a missing `codex` executable is
  `unsupported`; protocol/timeout errors are `error` or `partial` according to
  whether stored data exists.
- Query results always remain bounded by validated `maximumPoints` and include
  truncation/coverage metadata.

Add `provider-quota-runner.ts` for the production Node-to-Bun bridge. Accept a
strictly parsed operation/request and write/read a private bounded artifact or
another existing repository-approved bounded transport. Do not serialize
unbounded history to command-line arguments. Add an explicit package export
only for the orchestration interface, not the runner entrypoint.

Modify report dataset assembly so `ProviderStatusDataset` merges the latest
stored quota projection with the existing local latest-snapshot fallback. A
newer authoritative live observation wins; remote snapshot provider statuses
and static report behavior remain unchanged. Stored report creation must not
implicitly run live polling.

Tests must use fake batch sources and a temporary SQLite DB to prove cadence,
singleflight, failure preservation, one-chunk backfill, latest projection,
source precedence, range bounds, and provider/machine filtering.

**Verify**: `bun test packages/report-data/src/provider-quota.test.ts`
→ all tests pass.

### Step 6: Add strict server functions and opportunistic browser polling

Add validated server functions in `apps/web/src/server/provider-quota.ts`:

- a POST refresh-if-due operation because it mutates SQLite;
- a bounded history read operation using the report-core request parser.

The `.server` implementation owns process-level singleflight and delegates all
domain work to the report-data runner. Match existing runner protections:
private temp artifacts, bounded output/error tails, timeout/abort cleanup, no
shell, and strict result parsing before returning JSON to the browser.

Create `apps/web/src/provider-quota-client.ts` with a small injectable source
used by `Dashboard`. On served HTTP(S) dashboards:

- refresh immediately after mount;
- repeat every five minutes while the page is visible;
- pause when the document is hidden and refresh once when it becomes visible;
- abort in-flight work on cleanup;
- update quota history independently from the one-minute report revision;
- keep last successful history visible when refresh fails.

Static/file/demo runtime must never call the server. For deterministic E2E, add
an injectable fixture result to `Dashboard` or its quota-history child rather
than enabling a real Codex subprocess in browser tests.

Server tests must cover input rejection, singleflight, five-minute throttle,
runner timeout/failure, bounded response, and stale-success preservation.

**Verify**:
`bun --filter @ai-usage/design-system build && bun test apps/web/src/server/provider-quota.server.test.ts`
→ all tests pass.

### Step 7: Add the Codex history surface without changing dashboard navigation

Keep the compact current-status card. Add a `View history` action for Codex
when at least one stored observation exists, opening a wide dialog/drawer
modeled on the existing session drawer interaction rather than adding a new
top-level tab.

Create a pure `provider-quota-history-model.ts` and keep chart rendering in a
separate `provider-quota-history-panel.tsx`.

UX requirements:

- Provider, account scope (when safely known), and machine selectors remain
  explicit; never average machines or accounts.
- History range controls are `24h`, `7d`, and `30d`. They are independent from
  the session report's date range.
- Render one small multiple per returned window group/identity on a fixed
  0–100% Y axis. Do not assume exactly two series.
- Use a step line or line with explicit observation points. Break it at reset
  changes and when the observed coverage gap exceeds twice the expected polling
  cadence (10 minutes for live data; use stored coverage for backfill).
- Mark resets with a labeled vertical indicator. Never draw a normal downward
  consumption slope across a reset.
- Show current percentage, first/last observation, next reset, source,
  confidence, point count, and largest gap in text.
- Distinguish loading, no history yet, unsupported/missing Codex CLI,
  auth-required, stale history, partial backfill, and refresh error.
- Preserve the last valid chart underneath a non-destructive stale/error banner.
- Do not invent or show an empty monthly chart if Codex did not return one.
- Use existing design-system colors/tokens and no chart dependency.

Accessibility requirements:

- The dialog has a visible heading, focus trap/return, Escape close, and
  semantic controls.
- SVG is supplementary; provide a text summary and an accessible table of
  observations or equivalent keyboard-readable representation.
- Resets/gaps are not encoded only by color.
- Every interactive point/control has an accessible name and visible focus.
- Reduced-motion preferences are respected.

Add pure model tests for grouping, resets, gaps, coverage, source precedence,
and empty/error states. Add a deterministic Playwright scenario named with
`Codex quota history` that opens history, changes range, finds 5h/weekly
summaries, verifies reset/gap text, exercises keyboard close, and verifies the
surface on a 390px viewport.

**Verify**:

1. `bun --filter @ai-usage/design-system build && bun test apps/web/src/provider-quota-history-model.test.ts`
   → all model tests pass.
2. `bun run test:e2e -- --grep "Codex quota history"`
   → desktop/mobile deterministic scenario passes.

### Step 8: Reconcile documentation, compatibility, and full verification

Update documentation to describe the changed privacy/network behavior:

- `README.md`: normal usage remains local, but served quota history may invoke
  the installed Codex CLI's local app-server; no provider credentials are read
  or stored by `ai-usage`.
- `docs/architecture.md`: record package ownership, normalized ingestion seam,
  dedicated history query, SQLite ownership, polling cadence, and static-report
  limitation.
- `docs/provider-status-windows-plan.md`: mark the old direct `/wham` approach
  superseded by the official app-server interface. Do not leave contradictory
  active guidance.
- `docs/public-package-interfaces.md`: list only the new public package seams.

Confirm current compatibility:

- Existing report creation works when Codex is absent or logged out.
- Existing `bun run cli -- quota` output remains unchanged.
- Static HTML still shows current payload status but clearly does not promise
  interactive persisted history.
- No raw app-server payload, token, cookie, auth file, or unbounded stderr is
  stored or logged.
- No history is added to report bootstrap, snapshot, or merge-bundle payloads.

**Verify**, in order:

1. `bun run typecheck` → exit 0.
2. `bun run lint` → exit 0.
3. `bun x ultracite check` → exit 0.
4. `bun run test` → all package/tool tests pass.
5. `bun run test:e2e -- --grep "Codex quota history|provider"` → selected browser tests pass.
6. `git diff --check` → no whitespace errors.
7. `git status --short` → only in-scope implementation/docs files and the
   pre-existing research note are changed.

## Test plan

The executor must add tests at every seam rather than relying only on E2E:

- **Pure domain**: app-server normalization, strict serialization, stable
  content identity, reset/gap segmentation, bounded downsampling.
- **Store integration**: migration, atomic append/checkpoint, idempotency,
  coalescing/heartbeat, latest/range queries, machine/account isolation,
  corruption tolerance.
- **Codex process adapter**: exact handshake, response correlation, timeout,
  abort, cleanup, typed errors, bounded stderr, no model turn.
- **Rollout adapter**: incremental byte cursor, partial line, file change,
  replay/staleness, duplicate collapse, bounded continuation.
- **Report-data integration**: due checks, one live call per cadence,
  singleflight, backfill continuation, failure preservation, current-status
  projection.
- **Web server/client**: strict request/result validation, subprocess failure,
  visibility-aware cadence, static-runtime no-op, stale data preservation.
- **UI model/E2E**: provider-defined windows, reset segmentation, gaps, range
  controls, empty/error/auth states, keyboard and mobile behavior.

Use the existing tests as structural patterns:

- `packages/report-core/src/provider-status.test.ts`
- `packages/usage-store/src/index.test.ts`
- `packages/local-collectors/src/machine-config.test.ts` for subprocess/temp-home
  cleanup patterns
- `packages/report-data/src/reporting.test.ts`
- `apps/web/src/server/report-payload.server.test.ts`
- `apps/web/src/provider-status-model.test.ts`
- `apps/web/e2e/dashboard.spec.ts`

## Done criteria

All criteria must hold:

- [x] A live Codex quota read uses only `codex app-server` and performs no model turn.
- [x] Codex rollout backfill resumes incrementally and does not rescan unchanged file contents.
- [x] SQLite retains normalized provider-neutral observations/windows and atomic source checkpoints.
- [x] Duplicate snapshots coalesce while 30-minute heartbeats preserve coverage.
- [x] Live, backfill, reset, gap, error, and auth states have deterministic tests.
- [x] The common ingestion/store/query contracts contain no Codex-only window fields.
- [x] The server-owned `codex.usage-limits` source refreshes quota on its own
      bounded cadence, independently of report publication and browser refresh.
- [x] The Codex history surface supports 24h/7d/30d and provider-defined window identities.
- [x] Resets and collection gaps are not drawn as continuous consumption changes.
- [x] The retired static HTML export remains absent, and existing CLI quota
      behavior remains compatible.
- [x] No raw provider response or credential is persisted/logged.
- [x] `bun run typecheck`, `bun run lint`, `bun x ultracite check`, and `bun run test` exit 0.
- [x] The focused Playwright quota-history scenario passes on desktop and mobile.
- [x] No files outside Scope are modified, apart from updating `plans/README.md` status.
- [x] `plans/README.md` status row is updated.

## STOP conditions

Stop and report back instead of improvising if any occurs:

- The installed/supported Codex versions do not expose
  `account/rateLimits/read` after a normal stable app-server initialization.
- App-server integration requires reading/exporting raw OAuth credentials or
  calling an undocumented HTTP endpoint.
- Codex rejects `ai-usage` client identification in a way that requires
  registration or a product decision.
- The actual app-server result cannot be normalized without storing sensitive
  raw payload fields.
- The current provider-status or report-query architecture has materially
  changed from the excerpts above.
- SQLite migration or foreign-key activation damages/invalidates existing
  `usage_rows` behavior.
- Correct incremental JSONL reading requires a broad rewrite of Codex session
  parsing rather than a focused storage-interface addition.
- Backfill cannot be bounded to acceptable startup work while still progressing
  through checkpoints.
- Implementing the browser query would require placing history in the bounded
  report bootstrap or editing generated router files.
- A step's verification fails twice after one reasonable correction.
- Work appears to require an out-of-scope provider, daemon, sync format, or auth
  implementation.

## Maintenance notes

- When a second provider arrives, first decide whether it is a batch source
  (poll/backfill) or a push producer. Reuse normalized ingestion; do not widen
  `ProviderQuotaBatchSource` merely to make every lifecycle look identical.
- Reviewers should scrutinize subprocess cleanup, bounded buffers, timestamp
  semantics, source precedence, account/machine scope, SQLite transaction
  boundaries, and reset/gap visualization more than chart aesthetics.
- If Codex changes its app-server schema, update only the Codex normalizer and
  adapter tests. Store/query/UI callers should remain unchanged; that locality is
  the design test for this module.
- Multi-machine quota history and static-export embedding are intentionally
  deferred because they require retention, identity, merge, and payload-budget
  decisions beyond this local Codex MVP.
- Retention is intentionally indefinite for the first version because
  change-point compression bounds growth. Revisit retention only after measuring
  real database growth; do not add speculative cleanup now.
