# ADR 0058: Harness sessions read Work context through one bounded, read-only projection

- **Status**: Accepted
- **Date**: 2026-10-22
- **Extends**: 0009, 0027, 0050, 0056

## Context

A harness session (Claude Code, Codex) resuming work in a checkout needs to
know what exists, what was decided and what is waiting there. The Work view
already answers this from the Work attention dataset (ADR 0050, ADR 0056), but
only in the browser. Session distillation, which produced summaries of
sessions, was retired (ADR 0049); the store schema is private and migrates
without a downgrade path (ADR 0045); the control plane never carries report
data (ADR 0009).

## Decision

- One projection, `@ai-usage/report-data/work-context-read`, answers for one
  scope: a checkout path (absolute; roots whose `worktreePath ?? cwd`, or a
  family checkout status, is that path or inside it, compared as written) or
  a project label (the project directory's name, exact). It runs the one
  `queryWorkAttention` read at its widest page and selects from it. It is not
  a second read model, persists nothing and is not a Memory item or a Work
  handoff.
- The answer (`schemaVersion` 1) has four parts: `waiting` (roots whose
  attention is a human request or an external wait, with the declaration,
  its provenance and the open interpretations), `decisions` (the five ADR 0056
  kinds that name a dated native record: answered, handled elsewhere,
  archived, earlier answered, earlier superseded, newest first, each with its
  evidence resolved to fact kind, date and provenance), `linked` (pull
  request, checkout and Jira facts of those roots) and `coverage` (the Work
  read's own coverage, root counts and fixed notes on what is not covered:
  Claude Desktop sessions only, no transcript, declared links only, the
  activity window, literal paths). Amended with ADR 0059: `coverage.harnesses`
  says per harness what is read (Claude Desktop: declared waits; Codex:
  sessions only, campaigns read of those in the window), and when Codex
  campaigns were read the first note names both instead of "Claude Desktop
  sessions only"; a Codex root never enters `waiting`.
- It copies less than the dataset exposes: turn reports, wrap-ups,
  side-session notes and proposals are cited by id and date only. Every list
  has a count bound and the compact JSON encoding a 64 KiB ceiling; lists are
  cut from the least urgent (Jira, checkouts, pull requests, decisions) to
  the waits, and `truncation` counts what was left out.
- Two edges call the same `readWorkContext`: `ai-usage work context
  (--checkout <path> | --project-label <name>) [--json]` and the tool
  `work.context` on the existing local stdio MCP server. Both open the usage
  store through the read-only `query_only` reader, never start or contact an
  engine, and fail with typed, path-free codes (`store-missing`,
  `store-not-upgraded`, `incompatible-store`, `invalid-input`, `unavailable`,
  `cancelled`). A missing store is a failure, not an empty answer, because an
  empty answer would read as "nothing is waiting".
- `mcp-adapter` stays storage-free: it owns the schema, the one-scope rule,
  the 192 KiB response bound, the retrieved-data label and sanitized errors
  behind a `WorkContextMcpReadService` port; `apps/mcp` composes the port with
  `report-data` and the CLI's store path. No registration is added or
  changed; `mcp:register:codex` remains an explicit opt-in.

## Consequences

- A harness gets declarations dated by the session, never presented as a
  current state, with the same uncertainty the Work view shows.
- A store swept only once cannot show answered decisions (ADR 0056); the
  context then lists the requests and no decision.
- The CLI may import `report-data/work-context-read` besides
  `portable-report`, and `apps/mcp` may import it and `usage-store/reader`:
  both remain read-only consumers. A change to the shape that breaks
  consumers increments `schemaVersion`.

## Rejected alternative

Generating a Memory item or a handoff summary from the Work dataset was
rejected: it would bring back a summary library that ADR 0049 retired and
present an interpretation as accepted knowledge. Serving the context through
the web oRPC procedure was rejected too: a harness would need the web runtime
and its session, and the browser contract would become a harness contract.

## Evidence

- [`packages/report-data/src/work-context-read.ts`](../../packages/report-data/src/work-context-read.ts)
  and its tests (two sweeps of the representative registry, scopes, bounds,
  typed failures)
- [`apps/cli/src/work-context.ts`](../../apps/cli/src/work-context.ts),
  [`apps/cli/src/work-context.test.ts`](../../apps/cli/src/work-context.test.ts)
- [`packages/mcp-adapter/src/index.ts`](../../packages/mcp-adapter/src/index.ts)
  `work.context` and its tests,
  [`apps/mcp/src/main.ts`](../../apps/mcp/src/main.ts) composition
- [Plan 118](../../plans/118-work-resume-cockpit.md), lot N verification record
