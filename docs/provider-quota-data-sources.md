# Provider quota data sources

Status: research snapshot as of 2026-07-15. This document covers subscription quota percentages and reset windows. It does not treat context-window usage, session token counts, estimated cost, API billing, or HTTP request throttling as equivalent metrics.

## Executive summary

Provider quota data does not follow one universal 5-hour/weekly/monthly model:

| Provider | Quota windows available | Best supported source | Historical backfill | Main limitation |
| --- | --- | --- | --- | --- |
| Codex | Commonly 5-hour and weekly; optional monthly credit/spend control is a different concept | `codex app-server` JSON-RPC `account/rateLimits/read` | Rich but imperfect local rollout JSONL | Local snapshots are redundant, opportunistic, and can be replayed as apparently fresh |
| Claude Code | 5-hour and 7-day for Claude.ai Pro/Max | Status-line JSON on stdin | No quota data found in local transcripts | Available only after a model response and while Claude is active |
| OpenCode Go | 5-hour, weekly, monthly | Web console only | No quota fields in local OpenCode SQLite | No supported public usage endpoint yet |
| Cursor | Primarily monthly included usage/spend | Dashboard; Admin API for Teams | Admin API supports usage events and daily data | Individual plans have no documented programmatic quota source; no equivalent 5-hour/weekly windows |
| Gemini CLI | Primarily daily and per-model | Interactive `/stats model` | No documented quota-history source | No documented headless quota command; different window model |

The recommended MVP is Codex first, using the CLI's app-server as the live polling adapter and rollout JSONL for a best-effort backfill. Claude should use passive status-line ingestion rather than a standalone poller.

## Metric boundaries

The data model and UI must keep these concepts separate:

- Subscription quota: percentage consumed within a provider-defined allowance window, such as 5 hours or 7 days.
- API usage: absolute tokens, requests, or cost billed to an API key or organization.
- Context-window usage: how full the current conversation context is.
- Session cost: a provider or client estimate for one local session.
- HTTP rate limits: short-lived RPM/TPM/request throttles, often returned through response headers.
- Spend control: an administrator-defined credit or currency cap, which is not necessarily a subscription quota window.

## Codex

### Recommended live source

Codex exposes a first-party machine-readable account interface through `codex app-server`. A client performs the JSON-RPC initialization handshake, then calls:

```text
account/rateLimits/read
```

The response can contain:

- `rateLimits.primary` and `rateLimits.secondary`;
- `usedPercent`;
- `windowDurationMins`;
- `resetsAt` as Unix seconds;
- `limitId` and `limitName`;
- `planType`;
- additional limits in `rateLimitsByLimitId`;
- credit information;
- an optional effective monthly `individualLimit` and spend-control state.

This call does not require a model turn. It reuses the CLI's saved authentication and token-refresh behavior, so the collector should spawn or connect to the app-server instead of reading `auth.json`.

The app-server protocol uses newline-delimited JSON over stdin/stdout by default. Its generated TypeScript or JSON Schema is version-specific, allowing an adapter to validate the protocol supported by the installed Codex version.

Official sources:

- [Codex app-server documentation](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md#7-rate-limits-chatgpt)
- [Codex backend rate-limit client](https://github.com/openai/codex/blob/main/codex-rs/backend-client/src/client/rate_limit_resets.rs)

The CLI currently calls `GET /api/codex/usage` or `GET /wham/usage` internally. These routes are implementation details, not the recommended integration boundary. Calling them directly would require handling private backend URLs and OAuth credentials outside the CLI.

### Semantics and caveats

- `usedPercent` means consumed percentage. Some Codex UI surfaces display the inverse, remaining percentage.
- `primary` and `secondary` are structural slots, not durable semantic names. Classify a window using `windowDurationMins` and retain the provider's `limitId`.
- A missing primary or secondary window is valid and must not be treated as zero usage.
- `individualLimit` is an effective monthly credit/spend limit when available. It is not necessarily a monthly subscription quota equivalent to the 5-hour or weekly windows.
- `account/usage/read` returns account token-activity summaries and daily buckets. That is useful analytics data, but it is not a quota-percentage source.
- `account/rateLimits/updated` is a sparse notification. Consumers must merge only present values into the latest complete snapshot or refetch `account/rateLimits/read`.

### Local backfill

Codex rollout files under `~/.codex/sessions` persist `token_count` events with optional `rate_limits`. A structural audit on the current machine found:

- 1,095 rollout JSONL files;
- 1,061 files containing non-null rate-limit snapshots;
- approximately 1.35 million `token_count` events with non-null `rate_limits`;
- one observed null rate-limit event.

This makes a historical backfill viable, but the data is not a continuous time series:

- snapshots are emitted around active Codex work, not while the account is idle;
- many adjacent events repeat the same quota state;
- older versions or backend incidents can produce `null`;
- resumed or forked sessions can replay historical rate-limit snapshots;
- replayed snapshots may receive a fresh outer rollout timestamp even though the quota data is stale;
- local snapshots may not contain enough identity information to attribute multiple users sharing an account or machine safely.

The import must therefore deduplicate snapshots and distinguish capture time from file/event observation time. It should not use the outer rollout timestamp alone as proof of freshness.

Relevant first-party reports:

- [Replayed Codex quota snapshots can appear fresh](https://github.com/openai/codex/issues/23190)
- [Account attribution limitations in rollout rate-limit data](https://github.com/openai/codex/issues/16323)

The current `~/.codex/state_5.sqlite` schema exposes session token usage but no persisted quota-window table, so it is not a substitute for rollout backfill or app-server polling.

### Codex recommendation

- Poll `account/rateLimits/read` every 5 to 15 minutes while the ai-usage collector is active.
- Treat the app-server as the owner of authentication and token refresh.
- Perform an idempotent, best-effort rollout backfill.
- Prefer a long-lived app-server connection if operationally convenient; otherwise cache subprocess results and avoid starting one process per UI render.
- Store provider windows dynamically rather than naming `primary` as 5-hour and `secondary` as weekly in the persistence layer.

## Claude Code

### Supported source

Claude Code passes structured JSON to a configured status-line command. For Claude.ai Pro and Max subscribers, after the first API response in a session, it can contain:

```text
rate_limits.five_hour.used_percentage
rate_limits.five_hour.resets_at
rate_limits.seven_day.used_percentage
rate_limits.seven_day.resets_at
```

Each window may be independently absent. `resets_at` is expressed in Unix seconds and `used_percentage` is consumed percentage from 0 to 100.

The status-line script runs locally and does not consume API tokens. This creates a supported passive ingestion path:

```text
active Claude session
  -> status-line JSON on stdin
  -> local quota snapshot collector
  -> ai-usage SQLite
```

Official sources:

- [Claude Code status-line rate-limit fields](https://code.claude.com/docs/en/statusline#rate-limit-usage)
- [Claude Code usage-limit errors and `/usage`](https://code.claude.com/docs/en/errors#usage-limits)
- [Claude Code command reference](https://code.claude.com/docs/en/commands)

### Limitations

- `/usage` is an interactive command, not a documented headless JSON subcommand.
- The top-level CLI has no documented `claude usage --json` equivalent.
- `rate_limits` is absent before the first API response.
- A configured `refreshInterval` reruns the status-line command, but does not guarantee that Claude fetched a fresh account snapshot from the backend.
- The source produces observations only while Claude Code is running.
- No `rate_limits` fields were found in the local Claude project transcripts inspected on this machine.
- The documented subscription windows are 5-hour and 7-day. A monthly overage or spend amount is a separate billing concept.

Do not confuse these fields with:

- `context_window.used_percentage`, which describes the active conversation context;
- `cost.total_cost_usd`, which is a client-side session estimate;
- Anthropic API RPM/TPM headers, which describe API-key throttling.

### Claude recommendation

- Offer an opt-in status-line integration that forwards or appends only normalized quota fields.
- Avoid modifying or replacing an existing user status line without explicit UX for composition.
- Mark the series as inactive or stale when no Claude observation has arrived recently.
- Do not promise continuous idle polling or historical backfill.
- Do not reverse-engineer Claude OAuth credentials or undocumented web endpoints for the initial implementation.

## OpenCode

### OpenCode Go

OpenCode Go documents three subscription usage limits:

- 5-hour: $12 of usage;
- weekly: $30 of usage;
- monthly: $60 of usage.

The limits are denominated in dollar-value usage, so request counts vary by model. The current usage is visible in the OpenCode console.

Official sources:

- [OpenCode Go usage limits](https://github.com/anomalyco/opencode/blob/dev/packages/web/src/content/docs/go.mdx#usage-limits)
- [Open request for a public Go quota endpoint](https://github.com/anomalyco/opencode/issues/16017)

At the time of this research, the first-party issue requesting a public rolling/weekly/monthly usage endpoint remains open. The dashboard has the data, but no supported CLI or public API contract exposes it programmatically.

The installed `opencode stats` command reports local session token and cost statistics, not subscription quota windows. A structural inspection of the current local OpenCode SQLite database found session cost and token columns but no quota-window fields.

Scraping the web dashboard with browser cookies would be technically possible but is not recommended: it couples the product to private endpoints, browser storage, fragile authentication, and sensitive session cookies.

### OpenCode Zen

OpenCode Zen is pay-as-you-go. Balance, auto-reload, and configured monthly spend limits are different from OpenCode Go's 5-hour/weekly/monthly subscription allowances and should use a separate metric kind.

### OpenCode recommendation

- Keep an OpenCode Go adapter contract in the architecture, but report the source as unavailable until a supported API lands.
- Continue importing local session tokens and costs separately through the existing OpenCode data path.
- Do not infer authoritative Go quota percentages from local token costs unless OpenCode publishes a stable accounting contract that matches its server-side meter.

## Cursor

Cursor individual plans primarily expose a monthly included agent-usage budget calculated using model inference prices. Usage and token breakdowns are shown in the dashboard, with editor notifications near the limit.

The documented Cursor Agent CLI supports authentication status and structured agent-run output, but its output schema does not expose account quota percentages.

Official sources:

- [Cursor pricing and included usage](https://docs.cursor.com/account/pricing)
- [Cursor Agent CLI parameters](https://docs.cursor.com/en/cli/reference/parameters)
- [Cursor Agent output schema](https://docs.cursor.com/en/cli/reference/output-format)

### Teams Admin API

Cursor Teams administrators can create an Admin API key and query:

- daily usage data;
- current-month spending data;
- detailed usage events with model, cost, request units, and optional token breakdown;
- date ranges of up to 90 days per daily-usage request.

Official source:

- [Cursor Admin API](https://docs.cursor.com/en/account/teams/admin-api)

This API is useful for historical absolute usage, but it does not expose Codex/Claude-style 5-hour and weekly subscription quota windows. A monthly percentage may be derived only when the applicable included allowance or configured hard limit is known and semantically compatible.

### Cursor recommendation

- Treat individual Cursor usage as dashboard-only until an official personal API or CLI quota command exists.
- Optionally support the Teams Admin API as a separate, admin-configured source.
- Label derived monthly utilization clearly; do not present it as a provider-returned percentage.
- Keep request units, token costs, and spend caps separate from rolling subscription quota windows.

## Gemini CLI

Gemini CLI documents `/stats model` for viewing current session token usage and information about applicable quota limits. Quotas are primarily daily and per model, so they do not fit a fixed 5-hour/weekly/monthly schema.

Official sources:

- [Gemini CLI quota and pricing](https://geminicli.com/docs/resources/quota-and-pricing/#check-usage-and-limits)
- [Gemini CLI command reference](https://geminicli.com/docs/reference/commands/)
- [Request for a headless quota check](https://github.com/google-gemini/gemini-cli/issues/19067)

No documented headless equivalent to `/stats model` or durable local quota-history source was identified. Gemini can be added later if a supported programmatic source appears, using daily/per-model windows rather than forcing its data into the Codex or Claude shape.

## Proposed normalized observation model

The persistence layer should store provider-defined windows rather than fixed columns for `5h`, `weekly`, and `monthly`:

```text
QuotaObservation
  providerKey
  accountKeyHash?
  machineId
  source
  observedAt
  providerGeneratedAt?
  freshness
  plan?

QuotaWindowObservation
  observationId
  providerLimitId?
  providerLimitName?
  semanticKind: rolling | daily | weekly | monthly | spend | other
  durationSeconds?
  usedPercent?
  remainingPercent?
  resetAt?
  reached?
```

Normalization rules:

- Preserve the provider's consumed percentage as `usedPercent`.
- Derive `remainingPercent = 100 - usedPercent` only for display or as an explicitly derived field.
- Preserve unknown or missing values as null; never coerce them to zero.
- Identify windows using both semantic information and duration.
- Store `observedAt` separately from `providerGeneratedAt` when available.
- Record the source, such as `codex-app-server`, `codex-rollout`, `claude-statusline`, or `cursor-admin-api`.
- Store a freshness/confidence classification so passive, replayed, and directly polled snapshots can be rendered differently.
- Hash or otherwise minimize account identity; never persist OAuth tokens, browser cookies, or raw auth payloads.

## Collection and UX implications

- A chart represents observations, not continuous metering. Break the line across long collection gaps.
- Split series when `resetAt` or the provider's window identity changes.
- Do not draw a normal downward consumption slope across a reset.
- Show both the quota-window type and the historical display range; a `5h` quota and a `7d` chart range are different controls.
- Surface source and freshness in tooltips or diagnostics.
- Distinguish unsupported provider, no history yet, stale collector, authentication failure, and no observation in the selected range.
- Downsample dense Codex rollout data before sending it to the UI.

## Recommended delivery order

1. Implement Codex live snapshots through `codex app-server`.
2. Backfill Codex rollout snapshots with aggressive deduplication and replay safeguards.
3. Add optional Claude status-line ingestion.
4. Add Cursor Teams absolute usage as a separately labeled source if there is demand.
5. Wait for an official OpenCode Go quota endpoint before adding live Go polling.
6. Reassess Gemini when a supported headless quota interface exists.

This ordering provides a useful quota-history feature without making raw OAuth tokens, browser-cookie scraping, or undocumented provider endpoints part of the security and maintenance surface.
