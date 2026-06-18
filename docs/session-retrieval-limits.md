# Session Retrieval Limits

_Last audited: 2026-06-16_

This document explains why the usage timeline has multi-week/month gaps before
~May 2026, which gaps are **real local-history losses** versus **collector
blind spots**, and what would be needed to close the remaining gaps.

The reporting pipeline only reads **local history** written by each harness on
this machine — it never calls provider APIs. So a session can only appear in a
usage row if the harness still has its data on disk **and** the collector knows
how to read it.

## Where each harness keeps its local history

| Harness | Source read by the collector | Retention on disk |
|---|---|---|
| Claude Code | `~/.claude/projects/**/*.jsonl` (token-bearing transcripts) + fallback `~/.claude/history.jsonl` | **Purged after `cleanupPeriodDays`, default 30 days** |
| Codex | `~/.codex/sessions/<YYYY>/<MM>/<DD>/*.jsonl` + `~/.codex/state_5.sqlite` metadata + `~/.codex/session_index.jsonl` names | Kept; bounded by when Codex was adopted |
| Cursor | `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb` (`cursorDiskKV`) | Sessions kept; **token counters dropped (see below)** |
| OpenCode | `~/.local/share/opencode/opencode.db` | Kept — full history, no purge |

Sources the collectors intentionally do **not** read (verified to carry no
usable token data): `~/.codex/history.jsonl`, Codex logs/goals/memories/app-state
SQLite databases, and `~/.cursor/projects/*/agent-transcripts/**/*.jsonl`
(CLI-agent transcripts — `role`/`message` events only, zero token fields).

## The two structural limits

### 1. Claude Code purges transcripts after 30 days

Claude Code deletes session transcripts under `~/.claude/projects/` older than
`cleanupPeriodDays` (default **30**). With no override set, only the most recent
~30 days of token-level Claude data survive on disk.

What remains for older Claude sessions is `~/.claude/history.jsonl`, a durable
prompt-history index. It preserves that a session existed (timestamps, first
prompt, turn count) but **carries no token counters**. The collector already
falls back to it, emitting `usageUnavailable` usage rows for sessions absent
from `projects/`. Note this index is itself incomplete — it had no entries for
Nov 2025, Dec 2025, or Feb 2026 at audit time.

**Consequence:** token-level Claude usage before ~mid-May 2026 is gone; only a
partial set of token-less sessions can be reconstructed from the prompt history.

### 2. Cursor stopped persisting token counters locally (~Feb 2026)

Cursor's `state.vscdb` retains every session (`composerData:` entries with name,
timestamp, model, line counts). But around **February 2026** Cursor stopped
writing usable per-message token counts:

- Pre-Feb bubbles store real counts in `tokenCount.{inputTokens, outputTokens,
  cacheReadTokens, cacheWriteTokens}`.
- Feb-onward bubbles keep only `tokenCount.{inputTokens: 0, outputTokens: 0}` —
  zero across every bubble (16.6k inspected). `cacheRead`/`cacheWrite` fields
  are gone, `composerData.usageData` is empty, and nothing else in the DB or the
  agent transcripts carries a billed token count.

Token usage for recent Cursor sessions now lives **only on Cursor's servers**.

**Consequence:** the real token totals for Cursor sessions from Feb 2026 onward
are not recoverable from local history. Before the fix below, the collector
dropped these sessions entirely because it only emitted rows for token-bearing
bubbles.

## Not data loss: adoption timing

Codex sessions only appear from ~March 2026, and Claude prompt history only from
~mid-January 2026. The empty earlier periods for those harnesses reflect when
each tool was first used, not a retention failure. Before then, the timeline is
legitimately Cursor + OpenCode only.

## What has been addressed

- **Stopped future Claude loss** — set `"cleanupPeriodDays": 3650` in
  `~/.claude/settings.json` so transcripts are no longer purged at 30 days.
  (Forward-looking only; already-purged data is gone.)
- **Recovered Cursor sessions without tokens** — the Cursor collector now emits
  `usageUnavailable` usage rows for composers that have user turns but no token
  data, mirroring the Claude prompt-history fallback. These rows carry the date,
  name, line counts, and turn count, with zero tokens and null cost. This
  brought Cursor from 76 to 262 rows, restoring the Feb-Jun 2026 sessions to the
  timeline (as usage-unavailable).
- **Hardened Codex extraction beyond the UI index** — the Codex collector treats
  session JSONL files as the source of truth, enriches them from `state_5.sqlite`,
  emits one usage row per local session including subagents/guardian checks, and
  marks token-less local sessions as `usageUnavailable` instead of dropping them.

## What still requires work

| Gap | Recoverable? | What it would take |
|---|---|---|
| Exact Cursor token totals, Feb 2026 onward | Server-side only | Integrate the cursor.com usage/admin API; out of scope for local collectors |
| Token-level Claude usage before ~mid-May 2026 | No | Purged; no Time Machine destination, APFS snapshot, or cloud copy exists. Mitigated by the `history.jsonl` fallback (token-less) for Jan/Mar/Apr |
| Codex / Claude before adoption | N/A | No usage existed |

### Hardening recommendations

- **Codex**: confirm whether Codex applies its own session retention; if so,
  consider periodically archiving `~/.codex/sessions/` to avoid a future
  equivalent of the Claude 30-day purge.
- **General**: a periodic backup (Time Machine or a scheduled copy) of
  `~/.claude/projects`, `~/.codex/sessions`, the Cursor `state.vscdb`, and the
  OpenCode DB would make any future provider-side retention change non-fatal.
- **Reporting**: usage-unavailable rows now appear for both Claude and Cursor —
  ensure analytics that sum tokens/cost continue to treat them as zero rather
  than dropping them, so session counts stay accurate even when tokens are
  missing.
