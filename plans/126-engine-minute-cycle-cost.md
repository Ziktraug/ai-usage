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

## Execution notes

### 2026-11-18 — Steps 0, 1 and 2 (branch `perf/engine-minute-cycle-cost`, from `037edb83`)

Steps 3 to 5 are not started. Figures only: no prompt, title, project name or
home path was copied out of the histories.

#### Drift since `a42fc803`

The drift check reports 982 insertions and 745 deletions over nine of the
thirteen in-scope files (the collector-coherence fixes of 2026-11: explicit row
retirement, OpenCode `session_v2`, Claude checkout attribution, Codex transcript
retirement). `perf.ts`, `live.ts`, `served-report-store.ts` and `file-sink.ts`
are unchanged. Every seam named in the plan still exists, but the line numbers
in "Measured current state" no longer apply, and the OpenCode figures in
section C are out of date: the collector now reads two databases and emits 878
rows (209 from the stable database), not ~722.

The plan names one `perf.ts`. There are two identical copies, one in
`local-collectors` and one in `report-data`, because the package boundary
rules forbid `report-data` from importing `local-collectors` or
`effect-runtime`. Both were extended the same way. `usage-engine-runtime` had
none and now imports the `local-collectors` one through a new `./perf` export.

#### Step 0 — measurement target

`docs/local-store-upgrade.md` ("Update") documents the supported way, with no
code change. The engine ran as `bun --no-env-file src/main.ts serve --port 0`
from `apps/usage-engine`, with:

| Variable | Value | Why |
| --- | --- | --- |
| `AI_USAGE_DATABASE_PATH` | `<base>/home/.config/ai-usage/usage-store.sqlite` | the copy; its writer lock sits beside it |
| `AI_USAGE_ENGINE_STATE_DIR` | `<base>/state` (`0700`) | own `rendezvous.json`, inbox and delegation directory |
| `AI_USAGE_HOME` | `<base>/home` | harness caches, `machine.json` and `config.json` stay apart from the live ones |
| `AI_USAGE_ROOT_DIR` | `<base>/root` | a copy of `ai-usage.config.ts`; the engine repairs modes under this root, so it must not be the main checkout |
| `AI_USAGE_LOG_DIR` | `<base>/logs` | wide events outside the repository |
| `AI_USAGE_TEMP_ROOT` | `<base>/tmp` | startup recovery sweeps this root |
| `AI_USAGE_PERF` | `1` | spans on stderr |

`<base>` is a `0700` directory outside the repository. `--port 0` asks the
kernel for a free loopback port, published only in the copy's
`rendezvous.json`, so it cannot collide with another engine.

- **Copy.** `VACUUM INTO` through a read-only connection: 450.7 MB live,
  372.8 MB copy, `user_version` 5, `integrity_check` ok, live mtime unchanged
  by the copy, no `-wal` or `-shm` left beside the live store.
- **Histories.** `AI_USAGE_HOME` moves the history roots together with the
  caches. The measurement home therefore holds a symlink for each history root
  (Claude Code, Claude Desktop, Codex, Cursor, OpenCode, RTK) and copies of
  `machine.json` and `config.json`. The no-follow readers refuse a symlink only
  as the last path component, so a linked parent directory is read normally.
  Proof that the same histories were read under the same machine identity: the
  first pass matched the copy's rows (Codex 5,130 unchanged and 2 updated of
  5,132; Claude 1,173 unchanged, 17 inserted, 1 updated of 1,191; Cursor 87 of
  87 unchanged). `machine.json` is copied because the engine creates a new
  machine identity when the file is missing, and the copy's rows belong to the
  existing one.
- **Isolation.** The live store's mtime is not conclusive, and it did change
  during the measurement. A watcher looked, twice per second for 9 minutes
  (1,082 scans), for descriptors under the live `~/.config/ai-usage` in the
  measurement engine, in its descendants (`gh`, `git`, `codex`, `claude`,
  `opencode`) and in every `bun`, `node` and `sqlite3` process. The
  measurement processes held none. The 34 hits all belong to one other
  process, a separate engine (`bun` under `bun` under `systemd`) that held
  the live store read-write for about 17 seconds, during which its mtime
  changed 13 times. Over the three sessions (1,593 one-second samples of
  `/proc/<pid>/fd`) the measurement engine's only `usage-store.sqlite*`
  descriptors were the copy's.
- **Publication.** Each session published on the copy (43 changed revisions
  over 26 minutes); the copy holds three retained revisions, the current one
  with 10,350 rows.
- **What the engine did outside the copy.** It read the histories, and its
  read-only SQLite connections created `-wal`/`-shm` siblings beside the
  OpenCode and Cursor databases, as every engine does. The provider-usage and
  GitHub sources ran as they do in a live engine (read-only lookups);
  `jira.issues` never ran in this setup.
- **Warm caches.** A first 5.5-minute session rebuilt the harness caches from
  empty (first Codex pass 19.7 s CPU, first Claude pass 9.7 s). The measured
  sessions started with those caches on disk, like a restarted live engine.

#### Step 1 — one cycle per phase

Setup: two sessions on the copy, 12 and 9 minutes, first 2 minutes of each
dropped (startup), 15 one-minute windows kept. Other agent sessions were
running on the machine (load average about 9 on 20 threads), so 5 to 9 Claude
rows changed on every pass. Wall-clock durations are noisy for the same
reason; **CPU seconds and RSS are the primary figures**. `VmRSS`, `RssAnon`,
`RssFile` and the process CPU counters were sampled once per second.

Totals in PR #61's terms (engine process only):

| | CPU per active minute | Peak RSS | Idle floor |
| --- | --- | --- | --- |
| PR #61, after (`50fcf631`) | 3.5–4.0 s | 1,330 MB | not recorded |
| Plan, live engine 2026-11-03 | ~16 s | 2,100 MB (`VmHWM` 2,290 MB) | 597–650 MB |
| Session 1 (9 windows) | median 12.9 s, mean 12.0 s, range 5.4–18.9 s | 1,164 MB (median per minute 963 MB; `VmHWM` 1,176 MB) | median 229 MB |
| Session 2 (6 windows) | median 10.4 s, mean 10.8 s, range 6.1–19.7 s | 1,163 MB (median per minute 1,072 MB; `VmHWM` 1,203 MB) | median 231 MB |

CPU is about three times PR #61's level. Peak RSS is already under PR #61's
1,330 MB, and well under the 2.1 GB the plan observed: this measurement does
not reproduce the plan's 1.4 GB swing or its 600 MB floor. The setups differ
(vacuumed copy, engine a few minutes old, collectors changed since
`a42fc803`), so the gap to 2026-11-03 is not explained by phase. The floor
rose from 171 MB to 243 MB over the first 9 minutes and from 183 MB to 248 MB
over 6; neither session was long enough to say where it settles.

Per phase, session 1 (medians per run; shares are of the engine's CPU and of
the summed RSS increases, per minute):

| Phase | Runs/min | Duration | CPU | ΔRSS | Δheap | Rows | CPU s/min | CPU share | RSS climb share |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| **publication** | 1.89 | 3,263 ms | 3,493 ms | +394 MB | +98 MB | 10,349 | 6.49 | **54.0 %** | **45.8 %** |
| — assemble (stored capture) | 1.89 | 508 ms | 581 ms | +53 MB | +33 MB | 10,349 | 1.16 | 9.7 % | 8.2 % |
| — store side (revision minus assemble, difference of medians) | 1.89 | 2,193 ms | 2,404 ms | +380 MB | +65 MB | 10,349 | 4.48 | 37.2 % | 40.5 % |
| — retain revisions | 1.89 | 230 ms | 199 ms | +3 MB | 0 | – | 0.38 | 3.2 % | 0.7 % |
| — reconcile work branches | 1.89 | 239 ms | 213 ms | −13 MB | 0 | – | 0.45 | 3.7 % | 0 % |
| **opencode.sessions** | 1.00 | 194 ms | 113 ms | +15 MB | 0 | 878 | 1.62 | 13.5 % | 5.3 % |
| **codex.sessions** | 1.00 | 1,242 ms | 1,310 ms | +363 MB | +83 MB | 5,132 | 1.43 | 11.9 % | **25.9 %** |
| — collect | 1.00 | 481 ms | 671 ms | +229 MB | +62 MB | 5,132 | 0.72 | 6.0 % | 15.5 % |
| — importSkillObservations | 1.00 | 269 ms | 243 ms | +22 MB | 0 | 95,553 | 0.26 | 2.1 % | 1.9 % |
| — importLocalRows | 1.00 | 144 ms | 150 ms | +98 MB | +21 MB | 5,132 | 0.16 | 1.4 % | 6.1 % |
| — importCodexWorkObservations | 1.00 | 72 ms | 52 ms | +3 MB | 0 | 5,132 | 0.06 | 0.5 % | 0.4 % |
| **rtk.savings** | 2.67 | 301 ms | 319 ms | +47 MB | +21 MB | 7,291 | 0.89 | 7.4 % | 11.4 % |
| **claude.sessions** | 1.00 | 317 ms | 295 ms | +146 MB | +10 MB | 1,195 | 0.37 | 3.1 % | 10.5 % |
| — collect | 1.00 | 163 ms | 215 ms | +132 MB | +10 MB | 1,195 | 0.27 | 2.2 % | 9.2 % |
| — importLocalRows | 1.00 | 75 ms | 47 ms | +25 MB | 0 | 1,195 | 0.05 | 0.5 % | 1.5 % |
| checkouts.status | 0.33 | 833 ms | 560 ms | −166 MB | +2 MB | 142 | 0.18 | 1.5 % | 0 % |
| github.pull-requests | 0.22 | 33,633 ms | 722 ms | −111 MB | −6 MB | 24 | 0.16 | 1.3 % | 0 % |
| claude.desktop-sessions | 1.00 | 87 ms | 59 ms | +14 MB | +1 MB | 129 | 0.07 | 0.6 % | 1.0 % |
| the three usage-limits sources | 0.22 each | ~1,700 ms | 32–153 ms | ≤ 0 | ≤ 0 | 1 | 0.06 | 0.6 % | 0 % |
| cursor.sessions | 1.00 | 32 ms | 13 ms | −9 MB | 0 | 87 | 0.02 | 0.1 % | 0 % |
| **All top-level spans** | | | | | | | 11.29 | 94 % | 100 % |

Coverage: the top-level spans (one per source run, one per publication) hold
94 % of the engine's CPU, 96 % of its busy seconds and 100 % of the RSS
increases seen by the sampler (session 2: 94 %, 99 %, 100 %). The peak RSS
sample of every one of the 15 windows falls inside a publication.

Session 2 gives the same order: publication 47.9 % of CPU and 49.2 % of the
climb, opencode.sessions 16.7 % and 1.3 %, codex.sessions 14.9 % and 29.2 %,
rtk.savings 7.2 % and 7.8 %, claude.sessions 3.4 % and 11.6 %.

Inside one publication (session 2, 11 full publications, medians; the steps
were timed through the store's existing publication-phase visitor, installed
by a measurement-only entry script kept outside the repository):

| Step | Duration | CPU | Share of the publication | ΔRSS | Δheap |
| --- | ---: | ---: | ---: | ---: | ---: |
| assemble the stored capture | 504 ms | 588 ms | 20 % | +32 MB | +33 MB |
| validate, serialize and fingerprint it | 510 ms | 597 ms | 21 % | +155 MB | +43 MB |
| insert the served projection | 746 ms | 865 ms | 30 % | +240 MB | +24 MB |
| validate the staged revision | 608 ms | 683 ms | 24 % | +7 MB | +40 MB |
| commit | 200 ms | 167 ms | 6 % | −1 MB | 0 |

What the table says:

- **Publication is the cycle.** It takes about half of the CPU and of the RSS
  climb, 1.5 to 1.9 times per minute, and every one of the 26 publications in
  the measured windows changed the revision. Four fifths of it is store-side work on a
  capture that is already assembled: 10,349 rows are serialized,
  fingerprinted, inserted and validated again each time. A fingerprint
  computed before assembly, the plan's first idea for 3c, would not skip
  anything on this workload, because the capture does change.
- **OpenCode is cheap except after its own usage-limits call.** A pass costs
  about 0.1 s when the database is unchanged. A full read costs 4.0 to 6.4 s
  of CPU and happened 6 times in 21 minutes, each time one pass after a failed
  open. The sequence: the `opencode.usage-limits` source runs the OpenCode
  CLI; the next read-only open of the live database then fails the reader's
  own identity check ("identity changed while opening"), so that pass reads
  only the stable database (209 rows instead of 878); the pass after it finds
  a changed WAL stat and reads everything. Of the 7 failed opens in the two
  sessions, 5 directly follow that source and the other 2 coincide with the
  separate engine working on the live store. The message row counts were the
  same in all six full reads: nothing had been written. The likely mechanism,
  inferred from the WAL file's mtime and not verified in the code: the CLI's
  exit removes the WAL file and the engine's own read-only open creates it
  again between the two identity readings.
- **Codex rebuilds everything for two rows.** Each pass loads and parses the
  session cache for 5,531 rollouts (95,553 skill observations), compares
  5,132 rows and 95,553 observations, and updates 2 rows (104 on 6 of the 21
  passes). It raises RSS by about 360 MB, a quarter of the climb.
- **`rtk.savings` runs after each changed session source**, 2.3 to 2.7 times
  per minute, re-reads 7,291 rows each time and changed nothing in any of its
  62 runs.
- **Claude is already proportional in CPU** (0.3 s for 5 to 9 changed rows of
  1,195), but reading its cache still raises RSS by about 130 MB.

Peak composition. At the peak, `RssAnon` is 96 % of RSS (1,123 of 1,164 MB)
and `RssFile` stays at 41 MB, so it is not mapped files. At the highest-RSS
step of a publication (medians): RSS 879 MB, `heapUsed` 232 MB (27 %),
`heapTotal` 400 MB, `external` 140 MB. About a quarter of the peak is live JS
heap; heap capacity and external buffers account for about 60 %; the rest is
native (SQLite and allocator pages not yet returned). The climb is object and
string churn around SQLite writes more than SQLite page cache.

Garbage from earlier phases is still live in later ones. The heap floor at
the start of a phase is 38 to 40 MB. Of 136 back-to-back transitions (gap
≤ 5 s), 79 start at least 50 MB above it: `codex.sessions → rtk.savings`
+114 MB (median), `rtk.savings → publication` +93 MB in session 1 and +125 MB
in session 2. It decides the peak: the 9 publications that started with
`heapUsed` ≥ 150 MB (RSS 500–710 MB, right after `codex.sessions`) ended at
1,034–1,149 MB, except two at 667 and 723 MB; the 17 that started below
150 MB ended at 638–903 MB. Step 5's second condition holds on this
measurement.

Against the ≥ 20 % rule of Step 3:

| Branch | CPU share | RSS climb share | Meets the rule |
| --- | ---: | ---: | --- |
| 3a OpenCode incremental | 13.5 % / 16.7 % | 5.3 % / 1.3 % | No |
| 3b collection and import (Codex, Claude, `rtk.savings`, Cursor) | 22.5 % / 25.7 % | 47.8 % / 48.6 % | Yes as a group; alone, only `codex.sessions`, on the climb (25.9 % / 29.2 %) |
| 3c publication | 54.0 % / 47.9 % | 45.8 % / 49.2 % | Yes; the assembly alone is 9.7 % |

Two STOP conditions are close and belong to the operator, not to this
execution: the remaining cost of 3c is publication freshness (the capture
changes on every publication while agent sessions are active), and Step 5
needs a publication cap.

Sources and import paths added since `50fcf631`. Sources:
`opencode.usage-limits` (5 min), `claude.desktop-sessions` (1 min),
`executors.capabilities` (15 min), `checkouts.status` (5 min),
`github.pull-requests` (10 min) and `jira.issues` (2 min);
`cursor.commit-attribution` was removed. Import paths in `source-adapters.ts`:
`retireLocalRows`, `importCodexWorkObservations`,
`importClaudeDesktopSessions`, `importExecutorObservations`,
`importCheckoutStatusObservations`, `importPullRequestObservations`,
`importJiraIssueObservations`, `attachDeclaredWorkThreadSessions` and
`applyWorkThreadWaitObservations`. Together the new sources cost 0.4 s of CPU
per minute (4 %). `github.pull-requests` ran 11 times in 26 minutes against a
10-minute cadence, in bursts of one run per minute, each holding the single
worker for about 33 s of wall time: it delays the session sources behind it
without costing CPU.

Spans. `withPerfSpan` now reports `cpuMs`, `rssMbBefore`, `rssMbAfter`,
`heapUsedMbBefore` and `heapUsedMbAfter` beside `durationMs`, on success and
on failure. `cpuMs` is not in the plan's list; it was added because Step 3's
rule is stated in CPU time. All figures are process-wide. New spans:
`aiUsage.engine.source.<id>` around every source run,
`aiUsage.engine.publication` around every publication,
`aiUsage.engine.<source>.collect`, `.importLocalRows`, `.retireLocalRows`,
`.importSkillObservations` and `.importCodexWorkObservations` in the session
sources, `aiUsage.engine.rtk.savings.queryEnrichableUsageRows` and
`.upsertContributions`, and `aiUsage.engine.publication.assemble`,
`.revision`, `.retainRevisions` and `.reconcileWorkBranches`. With
`AI_USAGE_PERF` unset the wrapped effect is returned as is.

Not measured: the store-side publication steps have no span in the
repository (the split above came from the test-only phase visitor); a
minute with no agent activity; the cause of the two Codex rows rewritten on
every pass; the engine after hours of uptime.

#### Step 2 — the file sink's circuit recovers

`file-sink.ts`: an open circuit drops and counts every record; once the
cool-down has passed (30 s) and the blocked append has released the worker,
the next record is tried as a probe. The first append that succeeds closes
the circuit. A probe that misses its deadline reopens it with a doubled
cool-down, up to 10 minutes. Any other probe failure is counted and leaves the
circuit half-open. There is no timer: recovery is decided when a record
arrives. The state is reported by a new `circuit-closed` warning with the
dropped and failed counters, by a `circuit` field in the file transport's
diagnostics and by `circuit=` in the shutdown loss summary. ADR 0014 carries
the rule as a dated amendment.

Tests (`file-sink.test.ts`): a slow append opens the circuit and drops the two
records queued behind it; a record inside the cool-down is dropped; after the
cool-down a fast append closes the circuit and later records are written,
with `accepted`, `dropped` and `failed` matching; a failed probe doubles the
cool-down up to the cap; no probe starts while the blocked append still holds
the worker; an ordinary probe failure leaves the circuit half-open; the
shutdown summary names the state.

The measured sessions did not exercise the recovery: no append missed its
deadline in 26 minutes.

### 2026-11-18 — Step 3b (branch `perf/engine-collection-proportional`, from `edf868af`)

Steps 3a, 3c, 4 and 5 are not part of this entry. Figures only.

#### Why two Codex rows were rewritten on every pass

One session id is carried by two rollouts (5,531 rollouts, 399 imported
transcripts, 5,131 distinct ids, 5,132 rows). Both became a row under the same
row key. The import compared the first copy with the stored one (the second
copy of the previous pass) and rewrote it, then compared the second copy with
the first and rewrote it again: 2 updates, a generation bump and `changed=true`
on every pass, with no rollout read (0 cache misses in all 21 passes).

The collector now emits one row per session id: the last copy in session order,
which is the one the store ended up with after each pass. The stored row is
therefore the same as before; it is no longer rewritten. Which copy is the
better reading of the thread (the last one, or the one with the larger
cumulative counter that the lineage code already prefers) is left as it was:
changing it would change stored content.

#### Why about 100 rows were rewritten on some passes

Four times in the two measured sessions the thread-metadata read of Codex's
state database returned no row in 1 to 3 ms (5,530 otherwise). The read-only open refuses a
database whose file identity moves while it opens, which happens when a Codex
process writes it (the `codex.usage-limits` source starts one every 5 minutes).
The failure was caught and replaced by an empty metadata map, so 102 rows that
take a field from the database were rewritten without it, and rewritten back on
the next pass. The open is now retried (3 attempts, 100 ms apart) before the
fallback applies. A database that stays unreadable, or one whose query fails
(a Codex schema change, for one), still yields no metadata, but no longer
silently: the pass carries a `codex.threadMetadata` warning. The sanity run
below met no such failure in its 8 passes, so the retry is covered by its test
only.

#### Why `rtk.savings` ran 2.67 times a minute

It never ran on its own cadence in the measured windows: 30 of its 31 runs
were dependency runs. The scheduler queues it after every session source that
reports a change, and three did almost every minute: `claude.sessions` (real
activity, 12 of 12 passes), `codex.sessions` (the two-row rewrite above, 12 of
12) and `opencode.sessions` (8 of 12, with 0 rows inserted or updated in all
of them; the change comes from its skill-observation state and belongs to
step 3a). 32 changed passes in 12 minutes is 2.67 per minute. The scheduling
is unchanged. With Codex quiet it ran 1.8 times a minute in the sanity run.

#### What changed

- **Session sources import what changed** (`source-adapters.ts`). A session
  source keeps, for the life of the engine, a fingerprint of each row it last
  imported. A pass imports a row only when its fingerprint moved. Every row is
  imported again, as before, on the first pass, after a pass that failed or
  was interrupted, on the first pass of a new clock hour (the freshness
  heartbeat of ADR 0046 is due for every row then), and when the store's rows
  of that harness were written by anyone else since the last pass (count and
  latest `updated_at`, read before and after each pass). A retired session is
  forgotten so that a later re-emission reaches the store. Rows without a
  session id, and rows sharing one, are imported on every pass. This applies
  to the four session sources.
- **Codex keeps a resident index** (`codex-history.ts`). The collector of a
  long-running process keeps every parsed session without its skill
  observations (36.4 of the cache's 48.1 MB of JSON). A pass stats the rollout
  files, re-reads the ones whose size or mtime changed, and builds all rows
  from the index; it no longer loads the session cache. Skill observations are
  returned for the rollouts read in that pass only, and for every rollout
  sharing a session id with one of them. Rows, work observations and
  retirements are complete on every pass. The SQLite cache is still written,
  for the next cold start. One-shot collection (CLI, foreground) does not use
  the index, but it is not unchanged: the one-row-per-session-id filter, the
  metadata retry and the metadata warning sit in the code both paths share, so
  `collectCodexResult` emits 5,131 rows where it emitted 5,132. The index has
  one construction site: `createIncrementalCollector` on the Codex entry of
  `HARNESS_ADAPTERS` (`collectors/index.ts`). Without that line the session
  source collects Codex through `collectResult` on every pass, as before, and
  keeps the import change. The repository has no mechanism for an engine
  tuning option (the environment variables these packages read name paths and
  executables, and `AI_USAGE_PERF` turns diagnostics on; none selects a
  collection strategy), so no switch was added.
- **`rtk.savings` reads what changed** (`source-adapters.ts`,
  `rtk-enrichment.ts`, `queryEnrichableUsageRowChanges`). The match still runs
  over every active row on each run, because a command goes to the narrowest
  matching session and any row can win or lose one. What a run needs from a
  row is its window (project path, start, end), kept by content hash; the
  stored JSON is read, parsed and validated only for rows whose hash moved.
- **Claude**: only the import change above. Its collector is untouched.

No store schema change. Two read-only store functions were added
(`queryEnrichableUsageRowChanges`, `queryLocalRowsWatermark`). The Codex cache
keeps its format and version.

#### Limits that keep the result equal to a full collection

- Work observations are sent in full on every pass: coverage is recorded per
  collection id, so leaving a session out would mark it uncovered. Making that
  incremental needs a change in `codex-work-store.ts`.
- The engine caps one skill-observation import at 100,000 and truncates the
  full list by recency. A pass that returns changed rollouts only cannot
  reproduce that truncation, so the index is not used while the rollouts hold
  more than 100,000 observations in total: every pass is then a complete one,
  at the cost measured in step 1. The real history holds 95,649. **This cliff
  is close.**
- Retirements are declared in full on every pass (399 ids), as the retirement
  rule requires.

#### Tests

`source-adapters.incremental.test.ts`: unchanged inputs import 0 rows and
leave every stored column and both generations as they were; one changed
session imports 1 row and moves the generation by 1; over 15 passes (change,
new session, retirement and re-emission, failed pass, hour boundary with a
session absent across it, rewrite of the stored rows by another writer) a
source that keeps its memory leaves the store column for column equal to a
source rebuilt for every pass, with equal run results; a failed pass, an hour
boundary, a retirement and an import by another writer each force a full
import; the engine asks an incremental collector for a complete pass first and
after a failure. Five mutations of the conditions (no hour check, no watermark
check, retired session kept, memory merged instead of rebuilt, failed pass
trusted) each fail at least one of these tests. For `rtk.savings`: over 7 runs
(content change, window change, new command, retirement, new session) the
stored contributions equal those of a source rebuilt for every run, and the
rows read are 3, 0, 1, 1, 0, 0, 1.

`codex-incremental-collection.test.ts`: one row for a shared session id;
a complete incremental pass equals a one-shot collection; an unchanged pass
returns no observation; a changed rollout returns its own; rows, work
observations, retirements, completeness and warnings equal a one-shot
collection after each of 5 passes with a rollout added, rewritten and deleted;
a stat change alone forces a re-read; a deleted rollout leaves the cache; a
changed rollout brings the observations of the rollout sharing its id; two
collectors do not share an index; the metadata read succeeds on its third
attempt.

`local-rows-incremental.test.ts`: the incremental read returns the rows of
the full read in the same order and reads only unknown hashes; a stored row
that no longer validates is reported invalid; the watermark moves on a
rewrite, an insert, a retirement and a relabel, and not on an unchanged
import, a heartbeat or another harness's rows.

#### Sanity measurement (one run, not the step 4 proof)

One 8-minute run on a fresh `VACUUM INTO` copy of the measurement store, first
2 minutes dropped, 5 windows, while another measurement engine and the test
suites of other sessions were running (load average about 46 on 20 threads).
The run started cold for Codex: the session cache is keyed by absolute path
and the measurement home had moved, so the first pass parsed all 5,531
rollouts (25.9 s of CPU, outside the measured windows).

| Phase | Before (step 1, session 1) | After | Change |
| --- | ---: | ---: | ---: |
| `codex.sessions`, CPU per run | 1,310 ms | 637 ms | −51 % |
| `codex.sessions`, ΔRSS per run | +363 MB | +111 MB | −69 % |
| — collect, CPU / ΔRSS | 671 ms / +229 MB | 365 ms / +52 MB | −46 % / −77 % |
| — importLocalRows, rows compared | 5,132 | 0 | |
| — importSkillObservations, observations compared | 95,553 | 0 | |
| `rtk.savings`, CPU per run | 319 ms | 83 ms | −74 % |
| `rtk.savings`, ΔRSS per run | +47 MB | +4 MB | −92 % |
| `rtk.savings`, runs per minute | 2.67 | 1.80 | |
| `rtk.savings`, CPU per minute | 0.89 s | 0.13 s | −85 % |
| `codex.sessions`, CPU per minute | 1.43 s | 0.64 s | −55 % |
| `claude.sessions`, rows compared per run | 1,195 | 8 | |
| `claude.sessions`, importLocalRows ΔRSS | +25 MB | −10 MB | |
| `codex.sessions` rows updated per pass | 2 (104 on 6 passes) | 0 | |
| `codex.sessions` reports `changed` | 12 of 12 passes | 0 of 8 | |

`claude.sessions` as a whole did not get cheaper in this run (510 ms of CPU
and +131 MB per run against 295 ms and +146 MB): its cost is the re-read of
the transcripts that changed, 368 ms of the 510, and more and larger
transcripts were active than during step 1. The engine totals of this run
(12.8 s of CPU per minute, peak 1,090 MB) are not comparable with step 1
either: publication alone took 7.8 s per minute, and `opencode.sessions` did
three full reads of 4.2 to 6.8 s of CPU.

What remains in a Codex pass: listing and stat of 5,531 files and the copy of
their sessions (170 to 230 ms), the thread-metadata read of 5,530 rows (about
65 ms), building 5,131 rows and their fingerprints, the full work-observation
import (80 ms) and the 399 retirements (43 ms).

**Idle floor: not established, to be checked in step 4.** The resident state
costs heap: the lowest `heapUsed` at the start of a phase was 88 MB in minutes
6 and 7 of this run against 67 MB at the same uptime in step 1, about +21 MB
(the row fingerprints and the RTK windows are part of it). For the Codex index
alone there is a heap figure from outside the engine: a standalone script
parsed the 5,531 cached sessions of the measurement cache and kept them, and
`heapUsed` after a forced collection rose by 31.5 MB with their skill
observations and by 11.7 MB without, which is what the index keeps. That is
not a figure from a running engine. It happens to equal the difference between
the two JSON sizes quoted above (48.1 − 36.4 MB); the JSON of what the index
keeps is 11.5 MB. Against the 245 MB floor the
step 1 sessions reached, +21 MB is 8 to 9 %: inside the 10 % budget, without
margin. The RSS floor of this run was higher than that (median 292 MB, 317 MB
in the last window, against 229 to 248 MB: +18 % to +38 %, over the limit if a
like-for-like run confirms it), but the run is not like for like:
it was already 106 MB above step 1 in its first minute (255 MB against 149 MB),
before any of the new state existed, and the gap narrowed to 72 MB by minute
7. A warm run on the step 1 setup has to settle whether the floor stays within
10 %; if it does not, that is the plan's STOP condition for the Codex index.

#### Review fixes (same day)

An adversarial review of the branch confirmed defects, each fixed with a test
that failed first.

1. **Stale fingerprint across a duplicated session id.** A source that emitted
   one row for a session id, then two rows with different content, then one
   row again kept the fingerprint of the first pass: the third pass imported
   nothing and the store held the last row of the duplicated pass. The
   remembered identity is now deleted whenever a pass holds more than one row
   for it. The equivalence sequence has the unique, duplicated, unique
   transition.
2. **Sibling observations when a rollout leaves the scan.** Two rollouts
   sharing a session id and an observation identity: when the earlier one was
   deleted or became unreadable, a full collection emits the other one's copy,
   and the incremental pass returned nothing. Every session id whose set of
   rollouts moved (read again, unreadable, removed, or read as another
   session) now brings the observations of its remaining rollouts.
3. **Sibling observations read from an older cache entry.** They are read from
   the SQLite cache, whose writes may fail without failing the pass. The read
   now requires the entry's size and mtime to be those of the index; otherwise
   the pass is redone as a complete one, which re-reads the rollout.
4. **Store-side rejection counts.** The stored completeness is the collector's
   figure plus the observations the store refused in that batch, so a pass
   delivering changed inputs only could record a lower figure than a full one.
   A pass in which the store refuses an observation is no longer taken as
   settled: passes are complete until the store accepts everything. While
   settled, nothing delivered earlier was refused, so the batch's count is the
   full count. `skill-observation-store.ts` is unchanged.
5. **Silent metadata fallback.** See above: the failure is returned with the
   empty map and reported as a warning, after the retries or at once for any
   other error.

Tests added with them: a failure after the import has committed (the run is
interrupted, or the retirement is refused) forces a complete next pass and
leaves the store equal to a rebuilt source's; the observation bound exactly
reached (index used) and one above (every pass complete), including a pass
that crosses it; the real Codex collector behind a session source over 7
passes, compared with a source rebuilt for every pass on the run result, the
stored rows and the stored `skill_observations` and collection state; the
index with an unreadable rollout over three passes; a sibling whose cache
entry is missing.

The equivalence sequence relabels the machine in two ways. As the engine does
it (`live.ts` rewrites the stored rows and sets the label on the very machine
object the sources hold): the next pass imports every row, because the
watermark moved, and finds them unchanged. And as a writer the sources do not
know would: their machine object keeps the old label, and a rebuilt source and
a resident one both write it back. The second case does not occur in the live
engine; it is there to exercise the watermark.

#### Not done

- Claude collection itself (the transcript re-read and the 2.6 MB cache file
  rewritten on every pass with a changed transcript, +13 to +17 MB).
- Incremental work observations and retirements (see the limits above).
- The `opencode.sessions` passes that report a change without changing a row.
