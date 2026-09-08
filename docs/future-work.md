# Future Work

Global backlog for known follow-ups that should survive individual refactor logs.

## Report Data Architecture

- Preserve the delivered compatibility split: the served app reads exact immutable revisions through focused Overview, Breakdown, bounded-support, Session page, campaign, and neighbor queries, while compatible CLI consumers retain the complete `UsageReportPayload` path.
- Continue deepening served report surfaces into bounded, destination-specific queries with canonical request fingerprints; do not make the full compatibility payload the live refresh protocol again.
- Keep quota refresh on the usage-engine command seam and quota reads/rendering on the read-only durable-observation seam; do not restore a report-data one-shot port.

## Report UI Models

- Keep adding pure model tests when dashboard or overview calculations change.

## Manual Transfer

- Improve `/sync` file import review with clearer bundle identity, generated-at, row-count, and conflict summaries before the user confirms a bounded import.
- Consider a documented encrypted-file workflow for users whose existing file-transfer tools do not already protect merge bundles at rest.
- Keep transfer explicit and file-based. Machine discovery and non-loopback listeners stay excluded; outbound-only Device replication (ADR 0031, plan 107) is the accepted background path and must not grow an inbound, peer, or remote-command channel.

## Skill Management

- Add safe adoption/import flows for unmanaged target skills once the core source scan, diagnostics, and reconciliation flows have settled.
- Add a git-diff view for the `SKILL.md` editor after the bounded editor flow has real use.
- Add editing for non-`SKILL.md` skill files only after there is a clear safety model for reference files and scripts.
- Add per-target reconcile actions if operators need more granular control than skill-level reconcile.
- Revisit disabled default target locations for Cursor and GitHub Copilot after real local use verifies their system skill paths.

## Design System

- Audit `@ai-usage/design-system/report` after another app exists or a second report surface appears.
- Promote genuinely reusable primitives from `@ai-usage/design-system/report` to the root `@ai-usage/design-system` API only when there is a concrete second consumer.
- Keep report-specific style slots in `@ai-usage/design-system/report` rather than making the root API app-specific.
- Defer Drawer/Tabs out of the Sessions initial preload only after Popover (or its Ark focus-trap dependency) is no longer shared with Drawer on the table path. Plan 071 measured a +2.13 KiB initial gzip regression for a naive split; see `docs/performance/web-session-optimization.md`.

## Web Session Performance

- Keyset pagination for session pages needs a separate ADR: Plan 071 removed CTE rebuild cost via exact-revision projection materialization; further OFFSET elimination would change the public cursor contract.
- Revisit direct Sessions/Breakdown SSR shells only with fresh traces showing ≥10% usable-render gain without growing Overview initial gzip by more than 5 KiB.

## Tooling And Generated Files

- Revisit direct `bun --filter @ai-usage/design-system build` calls in `apps/web` scripts if all local workflows move through `turbo run`.
- Keep `docs/generated-tooling-ownership.md` updated when Panda, SvelteKit, Vite, the Bun adapter, or Turbo generated outputs change.

## Dashboard And Product

Ideas captured during product brainstorming. Guiding constraints: the dashboard
already shows many numbers, so hierarchize ruthlessly and prefer inductive /
on-hover explanation over adding always-visible figures; sources are
heterogeneous, so carry data limitations per-metric, never as a single global
"data quality" flag. The leverage metric is the emotional hook but is imprecise
(ignores subscription cost, mixes pro/perso usage, has lossy data) — do not
over-emphasize it or build ROI/break-even features on top of it.

- "Wrapped"-style shareable report: a celebratory PNG/PDF recap of a period.
  The app's thesis is "if I had to pay API rates, how impossible would it be" —
  frame the recap around that, not ROI optimization.
- Filter-aware period-over-period comparison: deltas + sparklines derived from the
  same aggregation over `[t-Δ, t]` in `dashboard-model.ts`, computed against the
  *current* filter set. Must respect data hierarchy — surface a delta only where it
  changes a decision; push the full explanation to hover/tooltip.
- Universal drill-down: clicking a Rhythm day, a Model-migration band, or a
  Session-shape point applies the corresponding filter and scrolls to the session
  list. The filter bar already supports title/project/model.
- Outlier sessions framed as *ambitious work*, not "runaway": the top-right of the
  Session-shape scatter (long + expensive) usually means planning-heavy /
  orchestrator-driven efforts. Highlight them as a positive signal worth inspecting.
- Per-metric provenance/limitations: instead of a global completeness badge, let
  individual columns/cards carry their own caveats (partial Cursor counters,
  ambiguous reconciliation, usage-unavailable sessions) where they apply.
- Session intention via `firstPrompt` + parent linking: propagate `firstPrompt`
  into `UsageRow`, then cluster sessions by intent. Parent linking is already in
  place (see below); the remaining work is the intent signal and grouping UI.
- Timeline charts now collapse additive tails beyond 12 categories into a
  non-filterable `Other` series while retaining its member keys in the UI model.
  Add an explicit expand/drill-down interaction only if users need to inspect
  those members directly; do not turn `Other` into an exact dimension filter.
- Add saved dashboard views only if URL-backed state is insufficient in real
  use. A saved view needs naming, overwrite/delete behavior, schema migration,
  and a clear distinction from a shareable URL before local persistence is
  justified.
- Further split the root report bundle only when HTTP route loading remains
  well-covered; Plan 007 intentionally splits server-only Skills and `/sync`
  file-transfer components and keeps `/` intact.

## Session Linking And Titles

- Codex parent-link propagation now exists through `parentSourceSessionId` on
  `UsageRow.source`, and report normalization derives `rootSourceSessionId` via
  `packages/report-core/src/session-lineage.ts`. The remaining useful work is
  around `firstPrompt` propagation, campaign-level intent/title display, and how
  child sessions inherit or group under parent titles.
- Claude Code remains harness-asymmetric: raw logs do not expose the same
  cross-session parent pointer (only the in-file `isSidechain` flag and
  `agent-*` filename convention). Reflect that as a per-metric limitation
  rather than pretending parity across harnesses.
- Titles are already extracted per harness (Claude `ai-title` event, Codex
  `threads.title`, OpenCode `session.title`, Cursor `composerData.name`) and
  shown in Top Sessions. Remaining gap is narrower: subagent/orchestrator
  children fall back to generic ids — children could inherit the parent's title
  once campaign grouping is surfaced in the UI.

## AI Operations And Memory Platform (plans 099–110)

The platform runtime for plans 101–107 is integrated via PR #53; plan 107 is
partial and plans 108–110 are `TODO` (`plans/README.md`). Guardrails that every
item below must keep: local mode never consults PostgreSQL or shared
authentication (`bun run test:local-platform`), replication stays outbound-only
(ADR 0031), Memory keeps one mutation authority per mode (ADR 0026, ADR 0038),
and authorization stays application-owned (ADR 0029).

- Memory ingress and export surfaces (plan 105 remainder).
  Problem: `previewMemoryImport`, `confirmMemoryImport`, `exportMemory`,
  `recordObservation`, `createProposal`, `reviseMemoryItem`,
  `supersedeMemoryItem`, and `purgeMemoryItem` exist in
  `packages/memory-service/src/application.ts`, but the local Memory service
  (`apps/usage-engine/src/memory-service-server.ts`) exposes only proposal
  list/accept/reject, search, exact get, Project context, and repository
  resolutions; no CLI, Web, or MCP surface calls the others.
  Impact: a fresh local store has an empty corpus, so `/memory`,
  `memory search`, and the MCP tools return nothing, and legacy NixOS or
  `.agent-memory/` content cannot be migrated by an operator.
  Acceptance: a preview-then-confirm import command and an export command over
  the Memory service (no independent SQLite writer), idempotent re-import
  proven on a copy of a real store, and harvest that still never becomes
  durable guidance without acceptance.
- Device-side enrollment command (plans 104/107 remainder).
  Problem: `storePrivateDeviceCredential`
  (`packages/identity/src/private-device-credential.ts`) has no caller
  outside tests; nothing on the Device exchanges a grant at
  `POST /api/device-enrollment-exchanges`.
  Impact: connected mode requires hand-writing `device-credential.json`.
  Acceptance: one CLI command that reads a grant token from stdin or a
  prompt (never argv), exchanges it, stores the credential owner-only, and
  prints the shared Device identity; covered by a PostgreSQL test.
- Server-side bundle bootstrap (plan 107, step 6).
  Problem: rows imported through a manual usage merge bundle are not mapped
  to the same replication fact keys as direct publication.
  Impact: a Device bootstrapped from a bundle can re-publish or diverge from
  the shared projection.
  Acceptance: bundle-imported rows publish with the same `fact_key`/event
  identity, duplicate-free after acknowledgement, proven in
  `tools/replication-e2e.postgres.test.ts`.
- Blocked-stream repair controls (plan 107, step 7).
  Problem: a `blocked` outbox stream (authentication, revocation, Capture
  Context, version, generation, or identity conflict) is only reported; there
  is no preview/confirm repair.
  Impact: the operator must stop the engine and act on SQLite by hand.
  Acceptance: a content-free preview-then-confirm repair command on the engine
  control plane with the same all-or-nothing identity guarantees and tests.
- Target-Space visibility and revocation of a publishing Device (needs an
  ADR).
  Problem: `authorizeSpaceContext`
  (`packages/postgres-store/src/internal/replication-adapter.ts`) lets a
  Device owned in a personal Space publish into an organization Space when its
  owner is an `admin`/`member`, but Device list/rename/revoke are scoped to the
  Device's owning Space (`packages/identity/src/device-enrollment.ts`,
  `spaceScopeSql('manage_device')` in
  `packages/postgres-store/src/internal/authorization-query.ts`).
  Impact: an organization admin cannot see or revoke a Device that publishes
  facts into their Space.
  Acceptance: an ADR deciding whether publication into a Space requires a
  Space-visible Device binding with admin revocation, or is limited to the
  Device's own Space; list and ingest tests on both sides of the decision.
- `propose_memory` at Space scope includes auditor memberships.
  Problem: `spaceScopeSql` in
  `packages/postgres-store/src/internal/authorization-query.ts` uses an
  unfiltered `membership()` for `propose_memory` and `create_work_handoff` on
  resource kind `space`, so `usage-auditor` and `security-auditor` pass; the
  replication adapter restricts the same decision to `admin`/`member` in its
  own SQL instead of asking the Authorizer.
  Impact: no exposed surface proposes Memory at Space scope in connected mode
  today, so it is a rule defect rather than an exploitable path; the two
  rules disagree.
  Acceptance: restrict to `admin`/`member` in the SQL and in-memory adapters,
  add conformance deny cases for both auditor roles, and make the replication
  adapter reuse the Authorizer scope.
- No rate limiting on the enrollment exchange.
  Problem: `POST /api/device-enrollment-exchanges`
  (`apps/server/src/application.ts`) accepts a one-time bearer with no attempt
  bound; the `rate-limited` to `429` mapping has no producer.
  Impact: online guessing of the 43-character secret is infeasible, but
  attempts are unmetered and unaudited.
  Acceptance: bounded attempts per source and per public token ID with `429`
  and a content-free diagnostic, tested.
- Migration runner runs under the pool `query_timeout`.
  Problem: `createPlatformStore` (`packages/postgres-store/src/writer.ts`)
  builds the pool with `query_timeout: config.queryTimeoutMs` (default
  5 000 ms) and `runPlatformMigrations`
  (`packages/postgres-store/src/internal/migration-runner.ts`) takes its client
  from that pool.
  Impact: a migration statement slower than the query timeout on a large
  database aborts that migration's transaction (ledger unchanged, so safe) and
  the server never becomes ready.
  Acceptance: migrations run on a dedicated client with an explicit migration
  timeout and `lock_timeout`, documented in `platform-server-operations.md`.
- MCP registration beyond Codex and `mcpServers` JSON files.
  Problem: `apps/mcp/src/register.ts` supports `codex` and a `.mcp.json` /
  `mcp.json` `mcpServers` file; OpenCode has no mode.
  Impact: OpenCode operators edit configuration by hand.
  Acceptance: an OpenCode mode with the same lock, identity, and
  unmanaged-entry refusal rules, or a documented manual snippet.
- Plans 108–110 (Work handoffs and Work threads, session-detail archives, the
  native portability spike) stay `TODO`; the reserved MCP tool names
  `memory.latest_work_handoff`, `work_handoff.get`, and
  `work_thread.get_context` remain unregistered until plan 108 supplies real
  services.
