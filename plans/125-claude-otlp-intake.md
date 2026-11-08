# Plan 125: Claude Code OTLP Intake — Count the API Calls the Transcripts Never Record

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 88b45743..HEAD -- packages/local-machine/src/claude-session-facts.ts packages/local-collectors/src/collectors/claude.ts packages/usage-store/src/index.ts packages/usage-store/src/skill-observation-store.ts packages/usage-engine-runtime/src/source-adapters.ts packages/report-core/src/source-control.ts packages/report-core/src/pricing.ts packages/local-machine/src/machine-config.ts apps/usage-engine/src/main.ts apps/usage-engine/src/process.ts apps/usage-engine/src/control-server.ts apps/usage-engine/src/memory-service-server.ts packages/usage-engine-control/src/runtime-paths.ts`
> If any in-scope file changed since this plan was written, compare the
> "Measured current state" excerpts against the live code before proceeding.
> A changed Claude Code OTLP event shape (see Step 0 and STOP conditions) is a
> hard stop; a changed neighbouring module is not, as long as the named seams
> still exist.

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: MED (first inbound network listener that carries data, a new auxiliary fact family, a Claude collector cache-version bump; no change to existing base row numbers)
- **Depends on**: none. Reuses the auxiliary-fact pattern of plan 111 / ADR 0022 and the second-listener precedent of the Memory service.
- **Category**: feature (new collection source + presentation)
- **Planned at**: commit `88b45743`, 2026-10-29
- **Origin**: operator question after the public `agent_summary` report (Flamerix gist, anthropics/claude-code#86879, #104358): Claude Code sends side requests — the background-agent progress summary first among them — that are never written to `~/.claude/projects/**/*.jsonl`, so every transcript-based report, ai-usage included, undercounts them. A simulation over 14 days of the operator's own history (334 child sessions, ~35k assistant messages) put the missing share between ~8 % and ~20 % of weighted usage depending on the server-tuned interval (30–240 s). Anthropic publicly put the fleet average at ~2 % (API price) / ~6 % (terminal) and shipped a cache fix in 2.1.311. The real share for this machine is unknown; this plan makes it measurable.

## Why this matters

ai-usage promises "unified local AI usage reporting", and for Claude Code it
reads the only local history that exists: the transcripts. Claude Code 2.1.x
issues API requests that skip the transcript (`skipTranscript` forks:
`agent_summary`, and possibly others). They consume subscription headroom and
API spend but leave no local trace except Claude Code's own OpenTelemetry
export, where each one is a `claude_code.api_request` event with a
`query_source`.

Two answers are currently impossible:

- **How complete is the Claude Code number?** ai-usage cannot say whether a
  session's tokens are 100 % or 80 % of what was billed.
- **Which subsystem spends it?** The operator cannot tell `agent_summary`,
  compaction, or a named subagent apart, so cannot decide whether a mitigation
  (a preload hook, a Claude Code setting, fewer background agents) is worth it.

The goal is not a second Claude collector. The transcripts stay the base. The
intake only records the API calls the transcripts miss, joined on the API
request id, and shows them as an explicit, separate measure.

## Measured current state (evidence, 2026-10-29, `88b45743`)

### A. Claude rows are per session; request ids are read but never kept

- `packages/local-collectors/src/collectors/claude.ts:375-480` — `parseClaudeFile` turns one transcript file into exactly one `CollectedSession` and pushes `sessionToUsageRow(session)` (line 478). Child-session files (`subagents/agent-*.jsonl`) become their own rows (`isAgentFile`, line 383; `origin: 'subagent'`, line 465; `subagent: report.sidechain`, line 476).
- `packages/local-machine/src/claude-session-facts.ts:1714-1718` — records inside a child-session file carry `record.sessionId` = the **parent** session id (explicitly compared `!== input.sourceSessionId`). Lineage is reconciled afterwards by `reconcileClaudeLineage` (claude.ts:486-613, `claudeLineageIdentity`).
- `packages/report-core/src/merge-bundle.ts:129-136` — row key is `v1:<machineId>:claude:<sourceSessionId>`; `sourceSessionId` is the file basename (claude.ts:382).
- `packages/local-machine/src/claude-session-facts.ts:696-699` — streamed-record dedupe key is `${message.id}:${requestId}`; `requestId` is read here and **nowhere else** in production code. It is not persisted, and the collector cache (`CLAUDE_CACHE_VERSION = 22`, claude.ts:93) stores whole rows, not calls.
- Fixtures already carry `requestId`: `packages/local-machine/src/testing/harness-home.ts` (root and child transcripts).

### B. Cost is always the local approximation

- `packages/report-core/src/pricing.ts` (`priceFor`, line 341; `approxCost`, line 376) is the only cost source. No `costUSD` / `cost_usd` appears in `packages` or `apps`. CONTEXT.md "Cost approximation" is the canonical term.

### C. Auxiliary fact families and enrichments exist

- `packages/usage-store/src/index.ts:1717-1774` — `skill_observations` is "an auxiliary fact family with its own table and its own read path, deliberately NOT a widening of usage_rows"; written on the same engine pass as rows (`packages/usage-engine-runtime/src/source-adapters.ts:470-500`).
- `usage_row_enrichments` (index.ts:1561-1574, `rtk.savings`) is a per-row contribution keyed by `row_key`; CONTEXT.md:69-70: "neither writer replaces the other's durable data."
- ADR 0037 (`docs/adr/0037-current-producers-and-durable-skill-invocations.md:33-36`) requires current producer completeness before asserting absence.
- Additive migrations follow ADR 0075 (`...Missing` absence checks, `CREATE TABLE IF NOT EXISTS`, index.ts:1455-1500); `docs/local-store-upgrade.md` must be read before any schema change (AGENTS.md).

### D. Listeners

- `apps/usage-engine/src/control-server.ts:414-428` — `Bun.serve`, numeric `127.0.0.1` only, bearer token compared with `timingSafeEqual`, ephemeral port published in owner-only `<stateDir>/rendezvous.json` (`packages/usage-engine-control/src/runtime-paths.ts:42-58`).
- `apps/usage-engine/src/memory-service-server.ts:498-511` — a second `Bun.serve` with the same loopback guard: the precedent for a separately named listener in the engine.
- Only the **control server** is serve-only (`apps/usage-engine/src/process.ts:255-290`). The Memory listener is started through `createRuntime` → `withLocalMemoryIdentityKernel(..., { startService })` (`apps/usage-engine/src/main.ts:78-170`, `memory-identity-runtime.ts:94`), and `createRuntime` runs in both `serve` (process.ts:260) and `once` (process.ts:371). The Memory listener therefore also binds in every `once` run (CLI fallback `apps/cli/src/usage-engine.ts:291`, NixOS quota timer) — harmless only because its port is ephemeral.

### E. Sources and config

- `packages/report-core/src/source-control.ts:6-24` lists 14 source ids (`collectionSourceIds`), all named `<harness>.<kind>` (`claude.sessions`, `claude.usage-limits`, `claude.desktop-sessions`). Definitions start at line 55 (`kind`, `group`, `defaultEnabled`, optional `experimental`); `CollectionSourceGroup = 'sessions' | 'provider-usage' | 'enrichments'`, `CollectionSourceKind = 'producer' | 'enricher' | 'dataset-producer'` (lines 28-30). `resolveSourceEnabled` (line 239).
- Source policy is home-config only. Repo config is rejected by a literal home-only list in `packages/local-machine/src/machine-config.ts:585-589` (`['campaignLabelOverrides','delegation','github','jira','routing','sourcePolicies']`).
- Package boundaries (`tools/check-package-boundaries.ts:70-72`): `@ai-usage/report-core` imports no `@ai-usage/*` package; `local-machine` must stay independent of collectors, storage, engine and apps. `local-machine` → `report-core` is an allowed direction.

### F. Policy constraints this plan must respect

- AGENTS.md:39-43 (ADR 0009): SQLite is the data plane; loopback HTTP control "never carries report data"; only `apps/usage-engine` writes the store.
- README.md:5 / docs/architecture.md:8-9: never read provider credentials, never store or log raw provider payloads.
- docs/architecture.md:945-947, ADR 0074: production listeners bind only to numeric loopback.
- ADR 0014:57 and ADR 0008:68 forbid "OTLP, or a remote exporter" for the **wide-event export** path. That rule is about ai-usage emitting telemetry; this plan ingests Claude Code's. The new ADR must say so explicitly so the two are never confused.
- ADR 0016 (never rewrite collected rows; partial aggregates are explicit lower bounds) and ADR 0018 (one canonical number per concept).

### G. What Claude Code emits (docs: code.claude.com/docs/en/monitoring-usage)

- Enabled by `CLAUDE_CODE_ENABLE_TELEMETRY=1`, `OTEL_LOGS_EXPORTER=otlp`, `OTEL_EXPORTER_OTLP_PROTOCOL=http/json`, `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=http://127.0.0.1:<port>/v1/logs`. Exporters: `otlp`, `console`, `none` — **no file exporter**, so a listener is required. Export interval default 5 s. These variables are ignored in a repository's `.claude/settings.json`; they belong in `~/.claude/settings.json` or the environment.
- `claude_code.api_request` attributes: `model`, `cost_usd`, `cost_usd_micros`, `duration_ms`, `input_tokens` (excludes cache), `output_tokens`, `cache_read_tokens`, `cache_creation_tokens`, `cache_creation_5m_tokens`, `cache_creation_1h_tokens`, `request_id` (`req_011…`), `client_request_id`, `speed`, `effort`, `query_source` (`repl_main_thread`, `compact`, a subagent name, …), `agent.name`, `skill.name`, `plugin.name`, `mcp_server.name`.
- Standard attributes on every event include **personal or account data**: `user.email`, `user.account_uuid`, `user.account_id`, `organization.id`, `user.id`, `terminal.type`, `vcs.*`. Content attributes appear only with `OTEL_LOG_USER_PROMPTS` / `OTEL_LOG_TOOL_CONTENT` / `OTEL_LOG_TOOL_DETAILS`.
- Auth: static `OTEL_EXPORTER_OTLP_HEADERS`, or `otelHeadersHelper` in settings (a command printing a JSON header map, re-run every 29 min by default).

## Design decisions (binding on the executor)

1. **Transcripts stay the base; the intake only adds what they miss.** No base usage row is created, rewritten or widened from OTLP data (ADR 0016). Base totals are unchanged by this plan.
2. **A new auxiliary fact family, not a `usage_rows` widening.** `claude_api_request_observations`, primary key `(origin_machine_id, request_id)`, columns limited to the allowlist in decision 4 plus `received_at`. One row per API request.
3. **Transcript coverage is persisted, not recomputed from cache-skipped files.** The Claude collector already reads `requestId`; it persists the set per session in a second auxiliary family, `claude_transcript_requests (origin_machine_id, source_session_id, request_id)`, written on the same engine pass as the rows. The collector cache stores the id set with each file result (bump `CLAUDE_CACHE_VERSION`) so unchanged files still contribute coverage. An observation is **unrecorded** only when no transcript row covers its `request_id` **and** a successful `claude.sessions` pass completed at or after `event.timestamp + settle window` (10 min default; transcripts are written asynchronously, child-session files late). Otherwise — `claude.sessions` disabled, failed, or not yet scanned past that instant — it is **provisional** and shown as such, never as unrecorded (ADR 0037, ADR 0016 lower-bound language).
4. **Strict attribute allowlist at the intake boundary.** Accept only log records whose event name is `claude_code.api_request` (match on `event.name` attribute `api_request` and/or the record body, per Step 0). Keep only: `event.timestamp`, `request_id`, `session.id`, `model`, the token counters, `cost_usd_micros`, `duration_ms`, `speed`, `effort`, `query_source`, `agent.name`, `skill.name`. **Drop everything else before it reaches memory beyond the request handler** — in particular `user.email`, all account/organization ids, `user.id`, `terminal.type`, `vcs.*`, prompts, tool content, request/response bodies. Bound string attributes (≤ 128 chars, printable) and reject the record otherwise. The raw OTLP payload is never stored or logged (README.md:5).
5. **Cost has one canonical number.** Unrecorded calls are priced with `priceFor` from their tokens, like every other Claude call (ADR 0018). `cost_usd_micros` is stored as provenance only and used in a diagnostic parity check, never displayed as the cost.
6. **A separately named listener in the engine: the "Claude OTLP intake".** Hosted by `apps/usage-engine` (the sole writer, ADR 0009) and started **only in `runServe`** in `process.ts`, beside `startControlServer` — never through `createRuntime` / `withLocalMemoryIdentityKernel`, which also run in `once` mode and would make every `once` run collide with the serve engine on the fixed port. It copies the Memory service's loopback guard, not its lifecycle seam: numeric `127.0.0.1`, **fixed** port from home config (Claude Code needs a stable endpoint), `POST /v1/logs` with `Content-Type: application/json` only (no protobuf, no metrics, no traces → 404), body size cap, bearer auth. It is not part of the control plane and never returns report data (responds with the OTLP partial-success shape only).
7. **A stable intake token, separate from the control token.** The **engine** is the only writer of the token file: it creates it on first bind under the engine `stateDir` (`~/.config/ai-usage/engine`), mode 0600, atomic rename, and never rotates it on restart (Claude Code reads headers at startup and every 29 min). Claude Code obtains it through `otelHeadersHelper` pointing at a CLI subcommand (`ai-usage claude-otlp headers`) that prints `{"Authorization":"Bearer …"}`. That subcommand **reads one file, opens no database and never spawns an engine** (the helper runs synchronously); when the file is absent it exits non-zero with a typed "intake not started" error. The token never appears in settings files, the repo, or logs.
8. **A new collection source, off by default.** `claude.api-requests` (dotted `<harness>.<kind>` like its siblings), `kind: 'producer'`, `group: 'sessions'`, `experimental: true`, `defaultEnabled: false`. Its scheduled pass does no file collection: it reclassifies provisional observations (decision 3) and reports intake health; ingestion itself is push-driven by the listener. If the ADR review finds `producer` misleading for a push source, introduce a new `CollectionSourceKind` in the same step and say what the scheduler does with it — do not leave it implicit. Disabled → the listener is not bound. Disabling never deletes stored observations (CONTEXT.md:23-25).
9. **Presentation: an explicit separate measure, never a silent total change.** Attribution is to the **root session**: OTLP `session.id` is expected to be the parent session id even for child-session and `agent_summary` calls (child transcripts carry the parent id, measured state A), so the read path joins `session.id` to the root row and, through the existing Claude lineage (`claudeLineageIdentity`), exposes the breakdown by `query_source` / `agent.name` beneath it. It never attributes to an `agent-<id>` child row by guess. This decision is **conditional on Step 0**: if `session.id` matches neither root basenames nor the lineage for a material share of events, stop (STOP conditions). Reports show "Unrecorded API calls" (tokens, cost approximation, count) per root session and per `query_source`, plus provisional calls separately, plus a coverage statement: the OTLP measure exists only for the time the intake was running (lower bound before that, ADR 0016). Unmatched `session.id` values are reported as a separate bucket, not dropped.
10. **Terms.** Add CONTEXT.md entries: *Claude OTLP intake*, *API request observation*, *Unrecorded API call*, *Transcript coverage*. Avoid "telemetry data", "hidden cost", "real cost".
11. **One ADR** (next number, `docs/adr/0084-claude-otlp-intake.md`): inbound OTLP ingest is allowed under the loopback rule; it does not relax ADR 0008/0014 (no outbound OTLP); the allowlist and the no-raw-payload rule are binding.

## Steps

### Step 0 — Measure the real event shape (no product code)

Write a throwaway capture in scratch space (not committed): a `Bun.serve` on `127.0.0.1` that inspects each received `/v1/logs` JSON **in memory** and writes only structural metadata — attribute *names* and counts, the event-name carrier, and the values of `request_id`, `session.id` and `query_source`. **Never write the envelope, even to scratch**: Section G attributes (`user.email`, account and organization ids, `vcs.*`) are on every event regardless of `OTEL_LOG_*`, and persisting them violates README.md:5 and decision 4. Run a real Claude Code session against it with `OTEL_LOGS_EXPORTER=otlp`, `OTEL_EXPORTER_OTLP_PROTOCOL=http/json`, `OTEL_METRICS_EXPORTER=none`, a short export interval, and **no** `OTEL_LOG_*` content variables; launch one background subagent that runs for at least 2 minutes.

Record in the plan's execution notes (counts and attribute names only, no values beyond `query_source` names):

- the OTLP JSON envelope (`resourceLogs[].scopeLogs[].logRecords[]`, how the event name is carried, `intValue` as string);
- that `request_id` equals the transcript `requestId` for main-thread and child-session calls;
- the `session.id` carried by child-session calls and by `agent_summary` calls (parent session or child file id?), and whether it equals the root transcript file basename;
- whether `session.id` changes after `/clear` within one Claude Code process, and whether the new id gets its own root transcript file;
- the observed `query_source` values, and how many `request_id`s are absent from every transcript.

Verification: the capture shows ≥ 1 `api_request` whose `request_id` matches a transcript `requestId`, and the counts above are recorded.

### Step 1 — Name the concepts, record the decision

Add the CONTEXT.md terms (decision 10) and ADR 0084 (decision 11), referencing ADR 0008, 0009, 0014, 0016, 0018, 0022, 0074, 0075. Update `docs/architecture.md` listener and source-catalogue sections (also fix the stale "exact eight-source catalogue" sentence at line ~924 while there).

Verification: `bun run check` passes on the docs.

### Step 2 — Parse and sanitise, as a pure module

The `ApiRequestObservation` value type lives in `packages/report-core` (pure, no `@ai-usage/*` imports), so the writer, the reader and `web-contract` can all see it. The parser lives in `packages/local-machine` and depends on that type (`local-machine` → `report-core` is allowed): `parseClaudeOtlpLogs(json: unknown) → { accepted: ApiRequestObservation[]; rejected: { reason }[] }`. Pure, typed failures, allowlist and bounds from decision 4. No I/O. Run `bun run lint` to confirm the boundary check accepts the placement.

Tests (`*.test.ts`, `bun:test`), fixture built from the Step 0 shape with synthetic values:
- keeps only allowlisted attributes; a fixture carrying `user.email`, `organization.id`, `vcs.repository.url.full` and a prompt-like attribute yields an observation with none of them (assert on the serialised object);
- non-`api_request` events, metrics and malformed records are rejected with a reason;
- integer attributes encoded as strings parse; overlong strings reject.

### Step 3 — Persist two fact families

Following `docs/local-store-upgrade.md` and ADR 0075: add `claude_api_request_observations` and `claude_transcript_requests` with absence-checked `CREATE TABLE IF NOT EXISTS` (no `user_version` bump), their own store module modelled on `skill-observation-store.ts`, writer methods exposed only through the writer facade (sole-writer boundary), reader methods through `./reader`. Upsert observations by `(origin_machine_id, request_id)` (Claude Code may retry an export).

Tests: `auxiliary-fact-isolation.test.ts` extended — writing either family changes no `usage_rows` row and no served revision of existing reports; idempotent re-ingest; upgrade from a store fixture without the tables.

### Step 4 — Record transcript coverage in the Claude collector

In `claude-session-facts.ts` keep the deduplicated `requestId` set per session; carry it on `ClaudeFileResult`; bump `CLAUDE_CACHE_VERSION`; write it through the Claude source adapter in `source-adapters.ts` on the same pass as the rows. Base row content must be byte-identical before and after (compare `content_hash` on the `harness-home` fixture).

Tests: root and child fixtures produce the expected id sets; cache hit still yields coverage; base rows unchanged.

### Step 5 — The intake listener and source

- `claude.api-requests` source definition (decision 8).
- Home-config field `claudeOtlpIntake: { port: number }` (1024–65535): add it to `AiUsageConfig` and to the home-only literal list in `machine-config.ts:585-589`, with a test that a repo `ai-usage.config.ts` containing it is rejected.
- `apps/usage-engine/src/claude-otlp-intake-server.ts` (decision 6): started from `runServe` in `process.ts` only, and only when the source is enabled; numeric-loopback guard identical to the Memory service; bearer check with `timingSafeEqual`; body cap; returns `{}` / OTLP partial success; passes accepted observations to the runtime writer in batches. Failure to bind (port in use) is a typed, visible engine status error, not a silent skip.
- Intake token file (decision 7) and the CLI `ai-usage claude-otlp headers` subcommand.

Tests: wrong host, missing/invalid token, non-JSON content type, oversized body, non-`/v1/logs` path are all refused; a valid batch lands in the store; disabled source binds nothing; a `once` run with the source enabled binds nothing (no fixed-port collision with a running `serve`); `ai-usage claude-otlp headers` returns the typed error when the token file is absent and opens no database.

### Step 6 — Read model and contract

Reader query: per root session and per `query_source`, unrecorded and provisional observations (decision 3) joined per decision 9, priced with `priceFor`, plus the unmatched-session bucket and the intake coverage interval. Add it to the relevant web-contract and extend the SQLite query tests next to `packages/usage-store/src/session-query-sqlite.test.ts` and `focused-report-query-sqlite.test.ts`, keeping pure/SQLite parity (ADR 0018). Diagnostic: total `cost_usd_micros` vs the approximation over the same calls, exposed only in a CLI diagnostic.

### Step 7 — Surface it

- CLI: `ai-usage claude-otlp status` (intake bound?, port, last event time, coverage interval, unrecorded share for `--since`), and an "Unrecorded API calls" section in the Claude report filtered by `query_source`.
- Web: on the Session view, an "Unrecorded API calls" line with tokens and cost approximation, and the coverage caveat. No change to existing totals.

### Step 8 — Document operator activation (not executed by this plan)

README section "Claude Code OTLP intake": enable the source and port in `~/.config/ai-usage/config.json`; set in **user** `~/.claude/settings.json` `env`: `CLAUDE_CODE_ENABLE_TELEMETRY=1`, `OTEL_LOGS_EXPORTER=otlp`, `OTEL_METRICS_EXPORTER=none`, `OTEL_EXPORTER_OTLP_PROTOCOL=http/json`, `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=http://127.0.0.1:<port>/v1/logs`, and `otelHeadersHelper: "ai-usage claude-otlp headers"`; never set `OTEL_LOG_USER_PROMPTS`, `OTEL_LOG_TOOL_CONTENT`, `OTEL_LOG_TOOL_DETAILS`. State that a persistent `serve` engine is required (events sent while it is down are lost) and that the daemon/pty host of Claude Code must be restarted to pick up the environment. The NixOS side (a `systemd.user` service running `serve`, the Claude Code settings) is a companion change in the nixos repo, out of scope here.

## STOP conditions

- Step 0 shows no `request_id` on `api_request`, or it does not equal the transcript `requestId` → stop: the join this plan rests on does not exist.
- Step 0 shows no `api_request` without a matching transcript entry over a session with background agents → stop and report: the feature would show zero; ask before continuing (it may still be wanted as a coverage proof).
- The OTLP envelope carries content attributes even with all `OTEL_LOG_*` variables unset → stop; the allowlist must be re-reviewed before anything is stored.
- Adding the listener requires the control plane to carry report data, or a non-loopback bind → stop.
- Step 0 shows that `session.id` matches neither a root transcript basename nor the Claude lineage for more than 5 % of `api_request` events → stop: decision 9's attribution does not hold; report the observed shape.
- Step 4 changes any base row `content_hash` on the fixture → stop.
- Before Step 8, measure the idle cost of a persistent `serve` engine on the operator machine (the operator optimises for low idle power): context switches over 60 s idle with `perf stat -e cs -p <engine pid> -- sleep 60`, with the intake enabled and disabled. Report both numbers and stop for the operator's decision; do not pick a threshold yourself.

## Done criteria

- With the source disabled, behaviour and every existing report are unchanged (existing tests pass untouched).
- With it enabled and Claude Code configured per Step 8, a real session with a background agent shows the unrecorded measure (possibly zero) by `query_source` in CLI and web, provisional calls are labelled as such, and `ai-usage claude-otlp status` reports a coverage interval.
- No stored observation contains any attribute outside the allowlist (asserted by test and by a query on a store copy after a real session).
- ADR 0084 accepted, CONTEXT.md terms added, README activation documented, plan row updated.

## Verification

```sh
bun run check
bun run lint
bun run typecheck
bun run test
bun run verify
```

Real-data proof on a **copy** of the live store (AGENTS.md: do not claim live-store safety from disposable fixtures): run the engine against the copy with the intake enabled, run one Claude Code session with a 2-minute background agent, then report observation count, unrecorded count by `query_source`, and an allowlist audit query showing only permitted columns are populated.
