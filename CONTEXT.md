# ai-usage Context

This context describes the local AI usage reporting domain. The CLI reads local history from installed AI coding tools and turns it into usage rows, analytics, CSV, and quota output without calling provider APIs.

## Language

**Harness**:
An installed AI coding tool whose local history can be collected, such as Claude Code, Codex, OpenCode, or Cursor.
_Avoid_: source, tool, integration

**Local history**:
The files or databases written by a harness on this machine. Local history is the only input for reports; provider APIs are not called.
_Avoid_: remote usage, cloud billing data

**Session**:
A single conversation or agent run found in local history. A session can include child sessions, such as Codex subagent threads.
_Avoid_: chat, transcript, thread

**Collected session**:
An intermediate collector result that preserves harness-specific local history details before normalization into a usage row. It is the seam used by collectors that need shared row conversion.
_Avoid_: raw event, source row

**Usage row**:
The normalized per-session record consumed by table, CSV, JSON, and analytics output. It includes tokens, model, harness, provider, project, cost approximation, and optional partial/subagent markers.
_Avoid_: raw event, database row

**Report payload**:
The JSON-serializable aggregate consumed by the interactive report app and static HTML export. It contains serialized usage rows, filters, analytics, facets, and optional local history warnings.
_Avoid_: app state, server response blob

**Usage snapshot**:
A portable multi-machine export of usage rows and machine provenance that can be merged with other snapshots or local history.
_Avoid_: backup, provider export

**Synced usage snapshot**:
A usage snapshot fetched from another machine and stored locally so future reports can include it without contacting that machine.
_Avoid_: report cache, raw sync, remote history

**Snapshot remote**:
A named endpoint that serves a fresh usage snapshot from another machine. A snapshot remote is pulled by this machine; it is not written to by this machine.
_Avoid_: peer database, cloud account, upstream

**Snapshot peer**:
A machine discovered on the LAN as exposing snapshot endpoint health. A snapshot peer is not necessarily configured as a snapshot remote yet.
_Avoid_: sync account, remote database, device

**Sync state**:
The UI-consumable view of local machine identity, configured snapshot remotes, stored synced usage snapshot summaries, token status, and sync warnings.
_Avoid_: raw config, sync database, report payload

**Provider**:
The billing or subscription route inferred for a usage row, such as Claude API, Claude sub, Codex API, Codex sub, or Cursor sub.
_Avoid_: vendor, platform

**Cost approximation**:
A hypothetical API-rate cost calculated from local token counters and the editable pricing table. Subscription products bill differently, and unknown public rates remain unpriced.
_Avoid_: bill, invoice, actual spend

**Quota snapshot**:
The newest local Codex `token_count.rate_limits` event used to render subscription quota windows.
_Avoid_: billing limit, provider quota API
