# Provider quota data sources

Status: research snapshot as of 2026-07-15, re-verified against primary sources on 2026-08-08. This document covers subscription quota percentages and reset windows. It does not treat context-window usage, session token counts, estimated cost, API billing, or HTTP request throttling as equivalent metrics.

The 2026-08-08 pass confirmed the Codex, OpenCode, and Cursor findings unchanged, and corrected two errors in the Claude Code and Gemini CLI sections. Both are marked inline below.

## Executive summary

Provider quota data does not follow one universal 5-hour/weekly/monthly model:

| Provider | Quota windows available | Best supported source | Historical backfill | Main limitation |
| --- | --- | --- | --- | --- |
| Codex | Commonly 5-hour and weekly; optional monthly credit/spend control is a different concept | `codex app-server` JSON-RPC `account/rateLimits/read` | Rich but imperfect local rollout JSONL | Local snapshots are redundant, opportunistic, and can be replayed as apparently fresh |
| Claude Code | 5-hour and 7-day for Claude.ai subscribers, plus per-model weekly windows and overage | Agent SDK `Query.usage_EXPERIMENTAL_…()` for polling; status-line JSON on stdin as the documented fallback | No quota data found in local transcripts | The polling source is shipped but explicitly unstable; the documented status-line source is push-only |
| OpenCode Go | 5-hour, weekly, monthly | Web console only | No quota fields in local OpenCode SQLite | No supported public usage endpoint yet |
| Cursor | Primarily monthly included usage/spend | Dashboard; Admin API for Teams | Admin API supports usage events and daily data | Individual plans have no documented programmatic quota source; no equivalent 5-hour/weekly windows |
| Gemini CLI | Primarily daily and per-model | Interactive `/stats model` | No documented quota-history source | No documented headless quota command; different window model |

The recommended MVP is Codex first, using the CLI's app-server as the live polling adapter and rollout JSONL for a best-effort backfill. Claude is the recommended second provider: unlike the other three it has a real programmatic source, and it can be polled at rest rather than only observed passively.

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

> **Correction (2026-08-08).** The 2026-07-15 pass concluded that status-line ingestion was the only
> Claude source and that Claude therefore could not be polled. That was an omission, not a change:
> the Agent SDK has exposed a pollable quota read since `0.3.169`, published 2026-06-08 — five weeks
> before the original snapshot. The status-line material below remains accurate and is retained as
> the documented fallback.

### Recommended live source

`@anthropic-ai/claude-agent-sdk` exposes a control-plane method on `Query`:

```text
query({ … }).usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()
```

It returns `SDKControlGetUsageResponse` (`package/sdk.d.ts`, verified against `0.3.224`):

- `subscription_type` — `'pro' | 'max' | 'team' | 'enterprise'`, or null for API-key and third-party provider sessions;
- `rate_limits_available` — false for API key, Bedrock, and Vertex, where `rate_limits` is null;
- `rate_limits.five_hour` and `rate_limits.seven_day` — `{ utilization, resets_at }`, where `utilization` is consumed percentage from 0 to 100 and `resets_at` is an **ISO 8601 string**;
- `rate_limits.model_scoped[]` — per-model weekly windows with a server-supplied `display_name`; additive and present only when the server emits them;
- `rate_limits.extra_usage` — overage state (`is_enabled`, `monthly_limit`, `used_credits`, `utilization`), which is a spend concept and not a subscription window;
- `rate_limits.limits[]` — the flat window array behind the `/usage` dialog: `{ kind, group, percent, severity, resets_at, scope, is_active }`. Observed kinds include `session` (group `session`) and `weekly_all` (group `weekly`);
- `session` — cost and token totals for the current session, which is not quota data;
- `behaviors` — a local-transcript scan for usage attribution, explicitly approximate and not quota data.

The method sits alongside `supportedModels()`, `mcpServerStatus()`, and `getContextUsage()` on the
same control interface. A probe against a live session confirmed it **answers without a model turn**:
opening a query with a streaming prompt that never yields returns quota data in well under a second
with a session cost of zero. This makes it a genuine polling source, comparable to the Codex
app-server, rather than a passive observation.

Authentication reuses the session's existing Claude.ai credentials. Nothing reads or persists tokens.

### Stability caveat

This is shipped and typed, but it is **not documented and not supported**:

- the method name is itself a stability disclaimer, and the doc comment says the name will change when the API is stabilised;
- it is absent from the published Agent SDK TypeScript reference;
- a request to document the related rate-limit types ([claude-code#26392](https://github.com/anthropics/claude-code/issues/26392)) was closed without a docs fix.

Any adapter must therefore treat the whole payload as untrusted: parse defensively, tolerate renamed
or removed fields, and fall back to `unsupported` rather than failing, so a Claude Code upgrade can
never break collection for other providers.

Do **not** use the SDK's push-based `rate_limit_event` / `SDKRateLimitInfo` as a live source. Its
`utilization` is populated only once a bucket crosses a warning threshold; under normal conditions the
event carries only `{ status, resetsAt, rateLimitType }`. The request to expose per-bucket utilization
there ([claude-code#50518](https://github.com/anthropics/claude-code/issues/50518)) was closed as not
planned.

### Documented fallback source

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

### Status-line limitations

- `/usage` is an interactive command, not a documented headless JSON subcommand.
- The top-level CLI has no documented `claude usage --json` equivalent. Re-confirmed on 2026-08-08 against CLI 2.1.220, whose subcommand list contains no usage or quota entry. Neither hooks nor the OpenTelemetry export carry window utilization.
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

- Poll the Agent SDK usage method on the same cadence as Codex, behind a feature flag, with a defensive parse and an `unsupported` fallback.
- Prefer `rate_limits.limits[]` over the named `five_hour`/`seven_day` members when both are present: it is the flat, extensible shape, and it carries `severity` and `is_active`.
- Normalise `resets_at` from ISO 8601 here and from Unix seconds in the status-line payload. Do not assume one encoding.
- Keep `extra_usage` as a spend concept, separate from subscription windows.
- Treat the status-line path as an opt-in fallback. If it is offered, forward or append only normalised quota fields, and never replace an existing user status line without explicit UX for composition.
- Mark the series as inactive or stale when no Claude observation has arrived recently.
- Do not promise historical backfill; no local Claude quota history exists.
- Do not reverse-engineer Claude OAuth credentials or undocumented web endpoints.

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

Re-confirmed 2026-08-08: issue #16017 is still open, and the community pull request that would close it ([#16513](https://github.com/anomalyco/opencode/pull/16513), adding `/zen/go/v1/usage`) is still unmerged, its author noting they could not test it as an outside contributor. A separate request, [#31084](https://github.com/anomalyco/opencode/issues/31084), was closed same-day by its own author as a duplicate — not because a feature shipped. Tooling that scans issue state should not read that closure as resolution.

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

Re-confirmed 2026-08-08: Cursor's API index still scopes every usage and spend endpoint to Teams and Enterprise, the individual-scope APIs (Cloud Agents, TypeScript SDK, Python SDK, SDK Bridge) expose no plan quota, and the CLI documents no usage, quota, or billing command. Cursor's own help pages describe usage as monthly and resetting with the billing cycle, so there is no 5-hour or weekly window to query in the first place. Third-party tools that display a Cursor personal quota do so by local estimation or dashboard scraping.

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
- [Headless quota check request](https://github.com/google-gemini/gemini-cli/issues/19067)

No documented headless equivalent to `/stats model` or durable local quota-history source was identified. Gemini can be added later if a supported programmatic source appears, using daily/per-model windows rather than forcing its data into the Codex or Claude shape.

> **Correction (2026-08-08).** The 2026-07-15 pass cited issue #19067 as a pending request. It had
> already been closed on 2026-04-27 — before that snapshot — with the comment that quota stats are now
> shown in the bottom-right of the interface. That is a TUI footer, not a headless surface, so the
> conclusion stands even though the citation was stale.

The two attempts that would have delivered a headless path both failed: pull request [#17665](https://github.com/google-gemini/gemini-cli/pull/17665), which would have enabled `gemini -p "/stats model" -o json`, was closed unmerged; and issue [#15391](https://github.com/google-gemini/gemini-cli/issues/15391) was closed with a maintainer declining to address it. The documented `--output-format json` headless schema returns `response`, `stats`, and `error`, where `stats` is token and latency metrics with no quota or reset fields.

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

1. Implement Codex live snapshots through `codex app-server`. *(Done.)*
2. Backfill Codex rollout snapshots with aggressive deduplication and replay safeguards. *(Done.)*
3. Poll Claude through the Agent SDK usage method with a defensive parse. *(Done as a default-enabled experimental source with its own source policy.)*
4. Add optional Claude status-line ingestion only if the SDK method is withdrawn or proves unreliable.
5. Add Cursor Teams absolute usage as a separately labeled source if there is demand.
6. Wait for an official OpenCode Go quota endpoint before adding live Go polling.
7. Reassess Gemini when a supported headless quota interface exists.

This ordering provides a useful quota-history feature without making raw OAuth tokens, browser-cookie scraping, or undocumented provider endpoints part of the security and maintenance surface. Steps 3 and 4 are deliberately ordered against stability: the SDK method is the better source but the weaker contract, so the documented status-line path is kept in reserve rather than built first.
