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

**Usage row**:
The normalized per-session record consumed by table, CSV, JSON, and analytics output. It includes tokens, model, harness, provider, project, cost approximation, and optional partial/subagent markers.
_Avoid_: raw event, database row

**Provider**:
The billing or subscription route inferred for a usage row, such as Claude API, Claude sub, Codex API, Codex sub, or Cursor sub.
_Avoid_: vendor, platform

**Cost approximation**:
A hypothetical API-rate cost calculated from local token counters and the editable pricing table. Subscription products bill differently, and unknown public rates remain unpriced.
_Avoid_: bill, invoice, actual spend

**Quota snapshot**:
The newest local Codex `token_count.rate_limits` event used to render subscription quota windows.
_Avoid_: billing limit, provider quota API
