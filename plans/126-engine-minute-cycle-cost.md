# Plan 126: Usage-Engine Minute Cycle — Stop Rebuilding Everything Every 60 Seconds

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat a42fc803..HEAD -- packages/report-core/src/source-control.ts packages/usage-engine-runtime/src/source-control.ts packages/local-collectors/src/collectors/opencode.ts packages/local-collectors/src/collector-cache.ts packages/local-collectors/src/codex-history.ts packages/local-collectors/src/perf.ts packages/local-machine/src/local-history.ts packages/usage-engine-runtime/src/live.ts packages/usage-engine-runtime/src/source-adapters.ts packages/usage-store/src/served-report-store.ts packages/usage-store/src/index.ts packages/report-data/src/index.ts packages/effect-runtime/src/node/file-sink.ts`
> If any in-scope file changed since this plan was written, compare the
> "Measured current state" excerpts against the live code before proceeding.
> A changed collection cadence or a removed source is not a stop by itself, as
> long as the named seams still exist.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW-MED (measurement first; every optimisation must leave served report content byte-identical for the same inputs)
- **Depends on**: none
- **Category**: performance (resident memory and CPU of the long-running `serve` engine)
- **Planned at**: commit `a42fc803`, 2026-11-03
- **Origin**: operator machine analysis on 2026-11-03 (i7-12700KF, 32 GB, CPU saturated at 78 % average by parallel agent sessions). The dev-stack engine (`bun --no-orphans --no-env-file src/main.ts serve`, cwd `apps/usage-engine`) showed RSS swinging between ~600 MB and ~2.1 GB every minute. The analysis was read-only; no code was changed.

## Why this matters

The engine is meant to be a quiet, always-on sole writer. On the operator
machine it currently spends ~0.85 of a core for 35–40 s of every minute and
allocates ~1.4 GB, then frees it. That is ~0.5 core on average and a 1.4 GB
resident swing on a machine whose CPU is already the binding constraint and
whose zram swap absorbs cold pages during agent typecheck bursts. With several
agent sessions active, some source always changes, so the existing
"unchanged generations" skip never fires: every minute pays for full
collection, full import and a full report assembly.

The work is not wrong; it is not proportional to what changed. Between two
passes only a few active transcripts and a handful of OpenCode messages
differ.

## Measured current state (evidence, 2026-11-03, `a42fc803`)

### A. Runtime observation (live engine, PID 243714, ~80–85 min uptime)

- RSS sampled every 2 s for 180 s: floor 597–650 MB; peaks 1.9–2.1 GB; climbs at t≈3–17 s, 57–90 s, 131–170 s — one cycle per ~60 s, each 15–40 s long, CPU ~80–115 % of one core during the climb, near idle between. `VmHWM` 2.29 GB. RSS ~96 % anonymous (RssAnon ~1.26 of 1.30 GB at a peak), so it is heap / native allocation, not mapped files.
- A second independent 1 s sampling (4 min) confirmed the same 60 s cadence, climb starting at ~:26 past the minute, and `rchar` growing ~2.4 GB per minute with small `read_bytes` (page-cache re-reads).
- Phase order observed from `/proc/<pid>/fd` and `/proc/<pid>/io` (observation, not attribution): claude (`~/.claude/history.jsonl` open; RSS 0.62 → 1.7 GB within 4–10 s) → codex (`~/.codex/state_5.sqlite`, then `codex-session-cache.sqlite`) → opencode (`opencode.db` open ~4 s) → cursor (`state.vscdb`) → publication (peak ~2.03 GB, `usage-store.sqlite` re-read) → back to floor.
- The floor stayed flat across 4 cycles: this is a periodic peak, not a leak.

### B. Schedule

- `packages/report-core/src/source-control.ts:49-56` — `oneMinuteMs = 60_000`; definitions carry `cadenceMs` (first at line 56). The session sources (claude, codex, opencode, cursor), `rtk.savings` and `claude.desktop-sessions` run every minute; usage limits and `checkouts.status` every 5 min; GitHub and Jira every 10 min.
- `packages/usage-engine-runtime/src/source-control.ts:272` — each source sleeps until its next due time after it finishes. Any changed source queues a full report publication through `publicationSettleDecision` (`:560-579`): a 5 s settle, re-queued with `deferrals + 1`, at most 2 deferrals. Before the wide-event log stopped (see F), events showed 2 publications per minute, 2.5–4.3 s each, always `changed=true`.
- All collection and parsing runs inside the engine process. No fs watchers. No `--smol`, `Bun.gc` or heap tuning anywhere in the repo.

### C. OpenCode collector: full reads, but cheaper than the peak

- `packages/local-collectors/src/collectors/opencode.ts:117-123` — five whole-table queries per pass: sessions, tool counts and skill parts (both scan `part` with `json_valid` / `json_extract`), turn counts (`message` ⋈ `part` with `json_extract` on both), and `MESSAGE_SQL = 'SELECT session_id, data, time_created FROM message ORDER BY session_id, time_created, id'`.
- `opencode.ts:238-246` — every message row is `safeJSON`-parsed; user rows are then only counted and discarded; only assistant rows feed `agg`.
- `packages/local-collectors/src/collector-cache.ts:309-336` — the db cache key includes the `-wal` file's dev/ino/mtime/size. Any OpenCode write invalidates it, so on a machine running OpenCode the cache never hits.
- `packages/local-machine/src/local-history.ts:851-852` — `PRAGMA cache_size = -65536` and `temp_store = MEMORY` on the read-only connection.
- **Measured in isolation** (read-only `bun:sqlite` against the live `opencode.db`, same pragmas, 2026-11-03): db 1.04 GB; `message` 22,784 rows / 84 MB of JSON (21,261 assistant); `part` 102,124 rows / 308 MB. Query times: sessions 1 ms, toolCounts 357 ms, turnCounts 506 ms, messages 95 ms, plus the size scans; RSS growth ≤ ~200 MB. **OpenCode alone does not explain a 1.4 GB swing.** Its full re-read is still ~1.4 s and ~400 MB of page-cache reads per minute. The existing index `message_session_time_created_id_idx` would support an incremental read.

### D. Publication rebuilds the whole report

- `packages/usage-engine-runtime/src/live.ts:1240-1262` — `publishServedReportRevision({ assemble })` calls `createStoredReportCapture` (`packages/report-data/src/index.ts:263`) with `limit: null`, `since: null`, `includeFacets: true`, `includeCursor: true`: every stored row and dataset of the 436 MB `~/.config/ai-usage/usage-store.sqlite`.
- `packages/usage-store/src/served-report-store.ts:1125-1141` — the only skip is "unchanged by generations". The generation counters are bumped **only on a real projection change** (`packages/usage-store/src/index.ts:1723` guarded by `changes() > 0`; `:2571`, `:3487` guarded by `projectionChanged`). That is correct, but an active agent session changes its row every minute, so the skip never applies while anyone is working.
- After assembly there is a second short-circuit when `private_capture_fingerprint` is unchanged (`served-report-store.ts` ~1145), but it runs **after** the expensive assembly.

### E. Other per-minute full rebuilds (read, not yet measured)

- `packages/usage-engine-runtime/src/source-adapters.ts` ~399–470 — each session source returns all rows of its whole history and `importLocalRows` compares all of them (~985 Claude, ~5,298 Codex, ~722 OpenCode rows).
- `packages/local-collectors/src/codex-history.ts:487-495` — every cached session in the 91 MB `codex-session-cache.sqlite` (`SELECT file_path, size, mtime_ms, session_json FROM codex_session_cache`) is loaded and parsed into a Map on each run; cache hits are cloned (`:644`, `cloneCodexSession` at `:238`); any rollout whose mtime changed is re-read in full.
- `packages/usage-engine-runtime/src/source-adapters.ts:541-581` — the `rtk.savings` source re-queries and enriches the stored rows on each one-minute pass (~7,033 rows reported by the read-only analysis; the row count is not re-measured here).
- Active inputs are small: on 2026-11-03, 2 Claude transcripts (5.5 MB, largest 4.8 MB) and 6 Codex rollouts (25 MB, largest 8.3 MB) changed within 5 minutes, out of 961 Claude files (1.5 GB) and 90 Codex files (98 MB). Re-reading the changed files is not the problem; rebuilding everything around them is the likely one.

### F. Observability gap that blocks diagnosis

- `packages/effect-runtime/src/node/file-sink.ts:19` — `DEFAULT_APPEND_TIMEOUT_MS = 1000`. `:377-381` and `:436` set `circuitOpen = true` after one append misses its deadline; nothing ever sets it back to `false` (`:323` is the only initialisation). After that, pending and new events are dropped for the life of the process.
- On 2026-11-03 the engine's `logs/wide-events-2026-11-03.ndjson` has no engine events after 21:05Z; a long synchronous block on the event loop during a cycle is the likely trigger. Per-source durations since then are lost.
- `packages/local-collectors/src/perf.ts:6,40-44` — `AI_USAGE_PERF=1` prints `[perf] <label> ok key=value …` spans to stderr; spans cover OpenCode queries and parsing; they carry durations and row counts but no memory figures.

### G. This is a regression of PR #61

- PR #61 (`50fcf631`, merged 2026-10-21, from the 2026-10-17 session "Scan resource usage: profile and spread the load", branch `feat/perf-scan-resource-usage-b600bd`) cached Claude transcripts per file, recorded row freshness heartbeats at clock-hour granularity (ADR 0046), and settled source-woken publications behind a burst (`publicationSettleDecision`, B). Its message records, measured on a copy of the real store: **CPU per active minute 11.6–12.0 s → 3.5–4.0 s, peak RSS 2,440 MB → 1,330 MB**.
- On 2026-11-03 the live dev engine averaged ~27 % of one core over 180 s (~16 s of CPU per minute) with a 2.1 GB peak (2.29 GB `VmHWM`). The two measurements differ in setup (store copy then, live dev engine now), so the size of the gap is indicative, not exact. Its direction matches the growth of the history and of the per-minute work added by PRs #67, #73, #74 and #75 (2026-10-25 to 10-28: work, desktop-session, delegation and checkout facts), whose sources and import paths still reprocess full history.
- That session also concluded "Staggering admission helps bursts; bounded processing is still necessary", and did not stagger the collectors within the minute (see Step 5).

## Design decisions (binding on the executor)

1. **Attribute before optimising.** No optimisation lands before Step 1 has produced a per-phase table (duration, ΔRSS, Δheap) for a full cycle on real data. The fix order in Step 3 follows that table, not this plan's guesses.
2. **Same inputs, same report.** For a fixed set of input files and store, the served revision content (its canonical capture fingerprint) must be byte-identical before and after every change. Incrementality is a cost change, never a content change (ADR 0016, ADR 0018).
3. **Incremental reads over bigger caches.** Prefer reading only what changed (per-session high-water marks, file-stat keys at the right granularity) over keeping more data resident. The idle RSS floor must not rise by more than 10 % to buy CPU.
4. **Cadence and sources stay as they are.** Do not lengthen intervals, disable sources or drop facets to make the numbers look better. A publication-freshness trade-off (e.g. coalescing publications while only active-session tokens move) is an operator decision: propose it with numbers and stop (STOP conditions).
5. **The wide-event sink recovers.** A slow append may drop events, visibly and counted, but must not silence the sink for the rest of the process.
6. **PR #61's numbers are the target, under the same setup.** Step 1 reproduces PR #61's measurement setup (store copy, CPU per active minute, peak RSS) so the regression is measured like for like. The aim is to get back to at least PR #61's level (≤ 4.0 s CPU per active minute, ≤ 1,330 MB peak) and to make the remaining cost grow with what changed, not with the size of the history.
7. **Spreading work in time comes after reducing it.** Staggering sources within the minute changes when the work happens, not how much there is. It is only considered in Step 5, after Step 3, and never without a publication cap.

## Steps

### Step 0 — Drift check and a safe measurement target

Run the drift check. Find how to run `serve` against a **copy** of the store (state/config directory override) so the measurement never writes the operator's live store (AGENTS.md: do not claim live-store safety from disposable fixtures). The histories (`~/.claude`, `~/.codex`, OpenCode, Cursor) are read-only inputs and may stay live.

Verification: a `serve` process runs against the copy, publishes at least one revision, and the live `usage-store.sqlite` mtime does not change.

### Step 1 — Measure one cycle per phase

- Extend `withPerfSpan` (perf.ts) so that, when `AI_USAGE_PERF` is enabled, each span also reports `rssMb` before/after and `heapUsedMb` before/after (`process.memoryUsage()`). Off by default, zero cost when disabled.
- Make sure spans exist around: each session source (claude, codex, opencode, cursor), `importLocalRows`, `rtk.savings`, and the publication `assemble` call. Add spans where missing, with row counts.
- Run the copy engine with `AI_USAGE_PERF=1` for at least 5 cycles while real agent sessions are active, and sample `VmRSS` once per second in parallel.

Record in the plan's execution notes a table: phase → median duration, median ΔRSS, median Δheap, rows. Also state whether the peak is mostly JS heap (object churn) or mostly native (SQLite page cache, in-memory sorts), and whether garbage from earlier phases is still live when later phases run (heap not falling between phases), which is what Step 5 would exploit. Also report CPU per active minute and peak RSS in PR #61's terms (decision 6), and which sources and import paths were added since `50fcf631` (`git log 50fcf631..HEAD -- packages/usage-engine-runtime/src/source-adapters.ts packages/report-core/src/source-control.ts`).

Verification: the table covers ≥ 90 % of the cycle's wall time and of the RSS climb. Tests for the perf span extension pass (`bun:test`, disabled path returns the effect unchanged).

### Step 2 — Restore the wide-event sink

In `file-sink.ts`, replace the permanent open circuit with a recovering one: after the circuit opens, retry after a cool-down (e.g. 30 s, then doubling to a cap), close it on the first successful append, and keep counting dropped events. Surface the open/closed state and the dropped count where the engine already reports sink health.

Tests: a fault-injected slow append opens the circuit and drops pending events; after the cool-down a fast append closes it and later events are written; the dropped counter matches.

### Step 3 — Remove the dominant full rebuild(s), in the order Step 1 dictates

Apply only the branches that Step 1 shows carry ≥ 20 % of the cycle's RSS climb or CPU time. Each branch keeps decision 2 and has its own tests.

- **3a — OpenCode incremental.** Keep a per-session high-water mark `(time_created, id)` with the cached aggregates; on the next pass read only `message` rows past it through `message_session_time_created_id_idx`, and filter `json_extract(data,'$.role') = 'assistant'` in SQL for the token read. Replace the WAL-stat cache key with content markers (per-session max `(time_created, id)` and row counts) so OpenCode activity stops invalidating everything. Recompute tool, turn and skill counts only for sessions whose markers moved. Handle deleted or rewritten sessions by falling back to a full read for that session (detected by a count or marker regression).
  Tests: a fixture db plus appended messages yields the same rows as a full read; a deleted message or session triggers the per-session fallback; an unchanged db does no message read.
- **3b — Collection and import proportional to change.** Sources return, and `importLocalRows` compares, only rows whose input file or session markers changed since the last successful pass, while the store keeps the rest. Codex: keep the parsed session cache resident between runs keyed by file stat, or load only entries whose rollout changed, within decision 3's floor budget. `rtk.savings`: enrich only rows whose content hash changed.
  Tests: unchanged inputs import zero rows and bump no generation; one changed transcript imports one row; store content after N incremental passes equals a full re-collection.
- **3c — Publication assembly.** If assembly dominates: first try computing `private_capture_fingerprint` (or an equivalent cheap input fingerprint) before the full assembly so an unchanged capture skips it. If the capture really changes every minute because active sessions move, measure an incremental or bounded assembly and propose a coalescing policy with numbers. That policy is an operator decision (STOP conditions).

### Step 4 — Prove the gain on real data

Repeat Step 1's measurement on the copy with the same active workload. Report before/after per phase and for the whole cycle, and against PR #61's numbers (decision 6).

### Step 5 — Stagger sources within the minute (conditional)

Do this step only if, after Step 4, at least one holds:
- the remaining per-cycle CPU burst still lasts more than ~10 s at more than half a core;
- Step 1 showed garbage from earlier phases still live during later ones, so that spacing them would lower the peak.

Otherwise record "not needed" and skip it.

- Give each one-minute source a fixed offset within its cadence (stable per source id, e.g. evenly spaced in the order of `collectionSourceIds`), so the sources no longer run back to back in one burst. Keep the single writer worker and job order semantics; offsets change start times only.
- **Cap publications before staggering.** Today the 5 s settle (`publicationSettleDecision`) merges the back-to-back sources of one minute into about 2 publications. Spread across the minute, each changed source would fall outside the settle window and trigger its own full publication, the heaviest phase. That would multiply the publication cost by the number of sources. Staggering therefore needs a publication cap (e.g. at most one source-woken publication per cadence period; explicit requests stay immediate). The cap value changes report freshness, so propose it with numbers and stop for the operator's choice (STOP conditions).

Tests: offsets are stable and within the cadence; an explicit request is never deferred; with the cap, N sources changing in one period produce one source-woken publication; served content for fixed inputs is unchanged.

Verification: repeat Step 1's measurement. The longest burst and the peak RSS go down, the publication count per minute does not go up, and CPU per minute does not go up.

## STOP conditions

- No supported way to run `serve` against a store copy without writing the live store → stop and report; do not measure against the live store.
- Step 1 attributes no phase ≥ 20 % of the RSS climb or CPU time (cost spread evenly) → stop and report the table; the fix is then architectural and needs its own plan.
- Any change alters the served revision content for fixed inputs → stop.
- The idle RSS floor rises by more than 10 % → stop.
- The remaining cost is publication freshness (active sessions change the capture every minute) → stop with numbers for the operator to choose a coalescing policy.
- OpenCode's schema lacks the columns or index named in 3a in the operator's current OpenCode version → stop for 3a only.
- Step 5 would raise the number of publications per minute, or needs a publication cap → stop with numbers for the operator to choose the cap.

## Done criteria

- Step 1's per-phase table and Step 4's before/after table are recorded in the execution notes.
- On the operator workload, the per-cycle RSS climb and the per-cycle CPU time are each reduced by at least 50 % for the phases fixed, with an unchanged idle floor (±10 %).
- Measured like PR #61 (decision 6): CPU per active minute ≤ 4.0 s and peak RSS ≤ 1,330 MB, or the gap is explained by phase in the execution notes.
- Step 5 is either recorded as "not needed" with the reason, or done with its verification, or stopped for the operator's publication-cap decision.
- Served report content is byte-identical for fixed inputs (test and real-data comparison).
- The wide-event sink recovers after a slow append (test) and reports dropped events.
- Plan row updated.

## Verification

```sh
bun run check
bun run lint
bun run typecheck
bun run test
bun run verify
```

Real-data proof on a **copy** of the live store: run the engine with `AI_USAGE_PERF=1` before and after, sample `VmRSS` at 1 s for ≥ 5 cycles each, compare the served revision fingerprints for an identical input snapshot, and report the per-phase tables.
