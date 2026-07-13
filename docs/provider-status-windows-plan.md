# Provider Status Windows Plan

## Goal

Add a dashboard surface that shows operational status for every AI provider or
harness, starting with Codex quota/reset extraction and expanding to the common
5h, weekly, and monthly windows where each provider exposes them.

The first implementation should not treat Codex reset credits as a one-off CLI
feature. It should create a shared provider-status model that can carry:

- live or local status freshness;
- plan/account labels when available;
- quota windows such as 5h, weekly, monthly, model-specific, or provider-specific
  windows;
- reset credits where a provider exposes them;
- provider-specific limitations, auth state, and errors.

## Reference Checked

Repository checked on 2026-07-02:

```txt
https://github.com/AyalX/codex-reset-tracker
```

Useful details from that implementation:

- Codex auth can be read from `~/.codex/auth.json`, specifically
  `tokens.access_token` and optional `tokens.account_id`.
- Environment overrides are `CODEX_BEARER_TOKEN` and `CODEX_ACCOUNT_ID`.
- Backend base URL is `https://chatgpt.com/backend-api`.
- Read-only endpoints are:
  - `GET /wham/usage`
  - `GET /wham/rate-limit-reset-credits`
- Headers include:
  - `Accept: application/json`
  - `OpenAI-Beta: codex-1`
  - `OAI-Language: en`
  - `Authorization: Bearer <token>`
  - optional `ChatGPT-Account-ID: <account_id>`
- `/wham/usage` carries the current rate-limit windows:
  - `rate_limit.primary_window`
  - `rate_limit.secondary_window`
  - `additional_rate_limits[].rate_limit.primary_window`
  - `additional_rate_limits[].rate_limit.secondary_window`
- Those windows expose `used_percent`, `limit_window_seconds`, `reset_at`,
  and block state via `limit_reached` or `allowed === false`.
- `/wham/rate-limit-reset-credits` carries reset credit rows under either the
  top-level payload or `rate_limit_reset_credits`, with `credits`,
  `available_count`, `title`, `status`, `granted_at`, and `expires_at`.

These Codex endpoints are undocumented. The app should isolate this code behind
a narrow adapter, treat failures as provider-status warnings, and never make
normal usage reporting depend on them.

## Current Repo Context

The current app mostly reports from local history. `docs/architecture.md` says
provider APIs are not called by normal usage reporting.

Existing Codex quota support is local-only:

- `packages/local-collectors/src/codex-history.ts` extracts the latest
  `token_count.rate_limits` event from recent Codex session JSONL files.
- `findLatestCodexQuotaSnapshot()` normalizes only `plan_type`, `primary`,
  `secondary`, and `credits`.
- `apps/cli/src/quota.ts` renders that local snapshot as a Codex-only CLI
  command.

The dashboard payload currently has a flexible `facets` escape hatch. Cursor
commit attribution already uses this path through:

- `packages/local-collectors/src/facets.ts`
- `packages/report-data/src/index.ts`
- `apps/web/src/report-data.ts`

That escape hatch was acceptable while the app was centered on usage rows. It is
now too generic: the app is growing toward collecting, enriching, transporting,
and displaying multiple local-machine datasets, not only session rows. Provider
status and skills should be treated as collected datasets rather than secondary
facets of usage rows.

Provider status should therefore use the new dataset transport path, with
`facets` retained only as a compatibility path while existing Cursor attribution
is migrated.

## Architecture Review Decisions

The architecture review on 2026-07-02 added these constraints before
implementation:

- Treat provider status as a deep module in `@ai-usage/report-core`. The public
  interface should be the provider-agnostic status model and deterministic
  helpers; raw Codex payload quirks, timestamp parsing, percentage clamping,
  label derivation, and reset-credit normalization belong in the implementation.
- Do not let `packages/local-collectors/src/codex-history.ts` become a catch-all
  for sessions, quota, and live Codex auth. Keep session parsing local, and put
  provider-status behavior behind a status adapter seam.
- Add a dataset assembly module before provider status lands. The module should
  own known dataset adapters, default offline selection policy, and per-dataset
  error policy. `facets` and `includeFacets` can remain as compatibility names
  while callers migrate, but new provider-status code should use dataset naming.
- Preserve machine-scoped provider status through snapshots and merged reports.
  Snapshot parsing may keep unknown datasets opaque, but known provider-status
  datasets need merge policy so remote machine status is not dropped.
- Keep provider-status warnings local to the provider row/panel. They are
  operational status warnings, not global report-integrity warnings unless they
  affect usage totals.
- Treat the current CLI `quota` command as a compatibility adapter. It should
  eventually project from provider status while keeping existing output behavior
  stable for users and scripts.

## Target Domain Model

Add pure provider-status types in `@ai-usage/report-core`, for example:

```ts
export type ProviderStatusState =
  | 'ok'
  | 'partial'
  | 'auth-required'
  | 'unsupported'
  | 'stale'
  | 'error';

export interface ProviderLimitWindow {
  blocked: boolean;
  group: string | null;
  id: string;
  label: string;
  limitSeconds: number | null;
  remainingPercent: number | null;
  resetsAt: string | null;
  scope: 'global' | 'model' | 'provider' | 'unknown';
  usedPercent: number | null;
}

export interface ProviderResetCredit {
  daysLeft: number | null;
  expiresAt: string | null;
  grantedAt: string | null;
  status: string;
  title: string;
}

export interface ProviderStatus {
  accountLabel?: string | null;
  creditsBalance?: string | null;
  generatedAt: string;
  key: string;
  label: string;
  machineId?: string;
  machineLabel?: string;
  plan?: string | null;
  resetCredits?: ProviderResetCredit[];
  resetCreditsAvailable?: number | null;
  source: 'local-history' | 'live-api' | 'manual' | 'unsupported';
  state: ProviderStatusState;
  warnings?: string[];
  windows: ProviderLimitWindow[];
}

export interface ProviderStatusFacet {
  generatedAt: string;
  providers: ProviderStatus[];
  schemaVersion: 1;
}
```

Keep the model provider-agnostic. A provider with no known quota API should
still produce a useful status row such as `unsupported` or `partial` rather than
being invisible.

Provider status identity:

- `ProviderStatus.key` identifies provider/account, not machine provenance;
- use `<provider>` when no account id is known, for example `codex`;
- use `<provider>:<accountId>` when an account id is known, for example
  `codex:acct_123`;
- keep `machineId` and `machineLabel` as provenance fields outside the key.

`ProviderStatusFacet` is the existing transport-compatible name. The preferred
domain name for new code should be `ProviderStatusDataset`. If both names exist
during migration, `ProviderStatusFacet` should be a compatibility alias, not the
canonical model.

The serialized types are only the external interface. The same module should
also own the implementation details that make the interface deep:

- status and dataset validation from unknown JSON;
- window label derivation and known-window grouping;
- percentage normalization and clamping;
- timestamp normalization, invalid-date handling, and freshness helpers;
- reset-credit normalization and earliest-expiry helpers;
- provider-status merge helpers when snapshot/report merging needs to combine
  known status datasets.

Callers should not parse `/wham/*` payloads, local Codex `rate_limits`, or
dashboard dataset JSON themselves.

## Implementation Sequence

### 0. Dataset Transport Refactor

This refactor is a hard prerequisite for provider status. Provider status should
not be implemented first under `facets` and renamed later.

Add a naming and transport preamble before provider status implementation:

- Introduce `datasets` on `UsageReportPayload` as the canonical home for
  collected report datasets that are not `UsageRow[]`.
- Keep `facets?: Record<string, unknown>` as a compatibility field during the
  migration. Do not add new provider-status work only to `facets`.
- Introduce a `ReportDatasets` or equivalent typed module in
  `@ai-usage/report-core` for known serialized datasets.
- Keep `ReportDatasets` generic enough for future collected skills. Do not bake
  provider-specific assumptions such as quota windows, account ids, or
  `machineId` into the dataset assembly interface itself.
- Rename the collector-facing concept from facet assembly to dataset assembly.
  Existing `packages/local-collectors/src/facets.ts` can either be renamed in a
  focused commit or wrapped by a new dataset module to reduce churn.
- Migrate Cursor attribution to `datasets.cursorCommitAttribution` in the same
  PR, while temporarily mirroring it to `facets.cursor.commitAttribution` for
  compatibility.
- Update app readers to prefer `datasets.cursorCommitAttribution` and fall back
  to legacy `facets.cursor.commitAttribution`.
- Replace boolean-only selection with a dataset selection interface, while
  preserving `includeFacets` as a compatibility option that means “include safe
  local datasets”.
- Add parsing/serialization tests showing payloads without `datasets`, payloads
  with compatibility `facets`, and payloads with both fields remain readable.
- Add at least one unknown-dataset preservation or ignore test so future skills
  datasets can be transported without breaking provider-status readers.

The goal is not a broad rename for its own sake. The goal is a deeper module
interface: callers ask for collected datasets; the implementation owns adapter
selection, local/live policy, compatibility mirroring, and error policy.

### 1. Provider Status Domain Module

Create the pure provider-status module before any network code:

- `packages/report-core/src/provider-status.ts`
  - provider-status serialized types;
  - validation/parsing helpers for `ProviderStatusDataset` from unknown JSON;
  - window label helper for `5h`, `Weekly`, `Monthly`, or custom durations;
  - percentage normalization and clamping;
  - reset-credit normalization;
  - freshness, state ordering, and status merge helpers where they are
    provider-agnostic.
- Add a public export in `packages/report-core/package.json` and document it in
  `docs/public-package-interfaces.md`.
- Tests:
  - `/wham/usage` fixture with primary, secondary, and additional rate limits;
  - `/wham/rate-limit-reset-credits` fixture with available, redeemed, expired,
    and nested payload shapes;
  - invalid/missing timestamps and percentages.

This first PR should not perform network calls or read local history. Its goal
is depth: every later adapter and UI test should exercise provider status
through this one interface.

### 2. Local Codex Status Adapter

Create a local-history adapter while keeping the old CLI behavior working:

- Keep `findLatestCodexQuotaSnapshot()` for compatibility with `apps/cli`.
- Add `findLatestCodexProviderStatus()` in
  `packages/local-collectors/src/codex-history.ts`.
- Normalize local `rate_limits.primary` and `rate_limits.secondary` into
  `ProviderLimitWindow` rows.
- Preserve snapshot timestamp and expose `source: 'local-history'`.
- Keep live auth/HTTP code out of `codex-history.ts`.
- Prefer a small internal adapter module if adding provider-status logic would
  make Codex session parsing less local.
- Make `findLatestCodexQuotaSnapshot()` a compatibility projection over the
  normalized provider status once that can be done without changing CLI output.
- Add tests next to `codex-history.test.ts`.

This gives the UI an offline Codex status even before live reset credits are
available.

Watch for duplicate session-file scans when report rows and local status are
collected in the same report run. If this becomes measurable, share the raw
local rate-limit snapshot internally before broadening the public interface.

### 3. Live Codex Status Adapter

Add an opt-in live adapter for Codex:

- Read auth from `~/.codex/auth.json`, `CODEX_BEARER_TOKEN`, and
  `CODEX_ACCOUNT_ID`.
- Call the two read-only Codex endpoints from server/CLI code only.
- Never expose tokens to client modules, report payloads, logs, warnings, or
  thrown error messages.
- Use short timeouts and convert HTTP/auth/network failures into provider-status
  warnings.
- Merge live `/wham/usage` windows and `/wham/rate-limit-reset-credits` credits
  into a single `ProviderStatus`.
- Put auth and transport behind a narrow adapter seam so tests can supply fake
  auth and fake HTTP without touching the real filesystem or network.
- Add explicit token-leak tests for error messages, warnings, logs, and returned
  status objects.

Recommended location:

- If this remains Codex-only initially, put it under
  `@ai-usage/local-collectors/codex-history` or a new
  `@ai-usage/local-collectors/provider-status` export.
- If we plan to add multiple live provider APIs quickly, create a new
  `@ai-usage/provider-status` package so `@ai-usage/local-collectors` can stay
  focused on local history.

Default behavior should remain local/offline. Live API status should require an
explicit option or server action.

`@ai-usage/report-data` should not import live transport modules directly. It
can orchestrate an explicitly provided live status adapter or call a package
function whose interface keeps network behavior obvious to callers.

This step may be deferred if the PR is already large after local status,
datasets, snapshots, and UI. If deferred, leave an explicit TODO in the plan or
follow-up issue with the auth source rules, endpoint list, token-leak tests,
timeout behavior, and UI refresh seam. Do not leave undocumented live behavior
half-wired into the local/offline reporting path.

### 4. Dataset Assembly And Transport

Add `datasets.providerStatus` as the first transport path:

- Extend `ReportDatasets` with `providerStatus?: ProviderStatusDataset`.
- Replace or extend the shallow `includeFacets` boolean with a dataset selection
  interface such as `includeProviderStatus` and `includeLiveProviderStatus`.
- Include local Codex status by default when safe local datasets are requested.
- Include live Codex status only when explicitly requested by the app/CLI.
- Ensure snapshot parsing keeps working if the dataset is absent or unknown.
- Centralize dataset adapter selection in a dataset assembly module rather than
  repeating selection logic in every
  `packages/report-data/src/index.ts` call site.
- Give each known dataset an error policy. Cursor attribution may still degrade
  to absent data; provider status should usually produce a provider row with
  `partial`, `auth-required`, `unsupported`, `stale`, or `error` state.
- Do not mirror provider status into `facets.providerStatus`. There is no
  existing consumer for that path, so the provider-status transport should start
  canonical-only at `datasets.providerStatus`.

For sync/multi-machine, keep provider status machine-scoped. A remote snapshot
should be able to carry the status that was true for that machine when the
snapshot was produced.

Snapshot rule:

- local/offline provider status is included when datasets are requested;
- live provider status is included only when the caller explicitly requested
  live status for that snapshot/report generation;
- every provider status row must preserve `source`, `generatedAt`, `machineId`,
  and `machineLabel`;
- old live status from a snapshot is rendered as stale operational data, not as
  a fresh live recomputation.

### 5. Snapshot And Merge Dataset Policy

Make provider-status dataset transport work through snapshots and merged reports:

- Add `UsageSnapshot.datasets` as the canonical dataset transport.
- Keep `UsageSnapshot.facets` available for opaque legacy facets during the
  migration.
- Keep `@ai-usage/report-core/snapshot` responsible for parsing, preserving, and
  exposing pure helpers for known datasets.
- Keep final report dataset assembly in `@ai-usage/report-data`, including the
  policy that combines provider status from snapshots and local collection.
- Preserve each provider status row's `machineId`, `machineLabel`, source, and
  `generatedAt` during snapshot creation and merge.
- Ensure `createMergedUsageReport({ includeLocal: false })` can surface provider
  status carried by remote snapshots instead of recollecting only local datasets.
- Treat stale remote status as visible status, not as a report failure.
- Add tests in `packages/report-core/src/snapshot.test.ts` and
  `packages/report-data/src/reporting.test.ts`.

This keeps locality for multi-machine behavior: snapshot/report merge modules
own the merge semantics instead of forcing dashboard code to infer which machine
a status row came from.

### 6. Dashboard Model

Add a pure UI model module:

```txt
apps/web/src/provider-status-model.ts
```

Responsibilities:

- parse `payload.datasets?.providerStatus`, with temporary fallback to
  `payload.facets?.providerStatus` if compatibility requires it;
- infer `partial` or `unsupported` provider rows from usage rows when a provider
  has no explicit provider-status dataset entry;
- sort providers by actionable state first, then provider label;
- group windows into 5h, weekly, monthly, and other;
- calculate next reset, worst used percentage, and display tone;
- format stale/live/local source labels.

Tests should cover:

- missing dataset;
- Codex local-only status;
- Codex live status with reset credits;
- unsupported providers;
- stale/error states;
- malformed provider-status datasets;
- multi-machine provider status;
- providers inferred from report usage when no quota windows exist.

The model should be the UI seam. `Dashboard` should not learn status sorting,
window grouping, source/freshness wording, or warning placement rules.

### 7. Dashboard Panel

Add a large but dense component:

```txt
apps/web/src/provider-status-panel.tsx
```

Placement:

- in `Dashboard`, after `ReportWarnings` and before the metric grid;
- visible only when report data is real, not demo-only;
- optionally collapsed if every provider is unsupported and there are no windows.

Display rules:

- one row/card per provider;
- provider label, status badge, source/freshness, and plan/account context;
- compact progress bars for 5h, weekly, monthly windows;
- a secondary area for model-specific/additional windows;
- Codex reset credits summarized as count plus earliest expiry;
- warnings/errors shown per provider, not as a global wall of text;
- report-integrity warnings remain in `ReportWarnings`; provider operational
  warnings stay inside the provider-status panel.

Accessibility and UX:

- use semantic buttons only for actions;
- each quota bar should have an accessible label with provider, window, used
  percent, remaining percent, and reset time;
- text must fit on mobile, so window labels and timestamps should wrap rather
  than shrink with viewport width;
- use existing design-system slots where possible before adding new report
  styles;
- use status-specific quota bars rather than reusing analytics cost/token bars
  if the semantics would be ambiguous.

### 8. Optional Live Refresh

Do not couple live provider status refresh to the main report refresh loop until
the behavior is proven.

Preferred follow-up:

- add a TanStack Start server function that fetches live provider status;
- let `ProviderStatusPanel` refresh its own status on demand;
- show separate loading/error state;
- cache briefly in process memory to avoid hammering undocumented endpoints.

The provider refresh interface should be separate from the report payload
refresh interface. Live provider API failures should degrade only the provider
status surface, not normal usage reporting.

### 9. CLI Compatibility

Keep the current `quota` command stable while provider status becomes the shared
model:

- Continue to support `ai-usage quota` and the existing no-history/no-snapshot
  messages.
- Render the same local Codex primary/secondary windows from the provider-status
  projection once available.
- Preserve color threshold behavior.
- Do not show live reset credits in the legacy command unless the command has an
  explicit live option or a replacement `status` command exists.
- Add CLI render tests for no history, no snapshot, windows, credits, and color
  thresholds.

## Provider Rollout

Codex should be first because it has both local snapshots and a known live
status API.

Initial provider rows:

- Codex: local 5h/weekly from session history, live 5h/weekly/model-specific
  windows and reset credits when enabled.
- Claude: `unsupported` or `local-history-only` until a reliable plan/quota
  source is identified.
- Cursor: show subscription-value context from existing rows as `partial`, but
  do not invent reset windows unless a real source exists.
- OpenCode: provider depends on configured backend, so show `partial` with
  usage data and no quota windows unless backend-specific support is added.
- RTK: status depends on local DB availability; no quota windows initially.

The UI should make missing provider quota data normal and explicit. Empty
windows are a data limitation, not an error.

Unsupported or partial provider rows can be inferred from report usage rows, but
provider-status identity should not depend on display labels alone. Use stable
provider/account keys where possible, and keep provider display wording as UI
presentation. Machine provenance should influence grouping and labels, not the
canonical provider status key.

Inference rule:

- explicit `datasets.providerStatus` rows win;
- providers observed in usage rows but missing from `datasets.providerStatus`
  should still appear as `partial` or `unsupported`;
- inferred provider rows must not invent quota windows, reset times, auth state,
  or reset credits.

## Open Decisions

- Should live Codex status be enabled by default in the dev web app, or only via
  an explicit refresh button?
- How should multiple Codex accounts be represented if `auth.json` contains or
  later gains more account metadata?
- Do we want a CLI `status` command that supersedes the current Codex-only
  `quota` command?

## Verification Plan

Run targeted tests as the work lands:

```sh
bun test packages/report-core/src/provider-status.test.ts
bun test packages/report-core/src/snapshot.test.ts
bun test packages/local-collectors/src/codex-history.test.ts
bun test packages/report-data/src/reporting.test.ts
bun test apps/web/src/report-data.test.ts
bun test apps/web/src/provider-status-model.test.ts
bun test apps/cli/src/quota.test.ts
bun x ultracite check
```

For the UI PR, also run the web app and capture desktop/mobile screenshots to
check that quota bars, timestamps, reset credits, and provider warnings do not
overlap.
