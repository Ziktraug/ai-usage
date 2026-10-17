# ADR 0047: Discover Codex rollouts in their compressed and archived forms

- **Status**: Accepted
- **Date**: 2026-10-17
- **Extends**: 0009, 0016

## Context

Codex CLI 0.163 compresses finished rollouts in place: once a thread is no
longer being written, `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl`
is replaced by `rollout-<ts>-<id>.jsonl.zst` (one zstd frame, original mtime
preserved), and an archived thread moves to the flat
`~/.codex/archived_sessions/`. On the audited machine 4,869 of 4,927 rollouts
were compressed in one pass; only the live sessions of the current day stayed
plain. The Codex collector discovered `.jsonl` under `sessions/` only, so a
scan after that pass saw 58 of 4,927 rollouts, the session detail of every
compressed thread was unavailable, and the usage store would have kept the
older rows only as long as nothing re-collected them.

The `state_5.sqlite` `threads.rollout_path` column still names the plain path,
so it cannot be used as the discovery source either. Codex's own compression
stages (`read_metadata`, compress, `remove_source`; a rollout that changes
during the pass is skipped) mean a plain file and its archive coexist only
while removal is pending, and an archive beside a plain file may still be
mid-write.

## Decision

1. **Reader.** `LocalHistoryStorage.readLines` reads a path ending in `.zst`
   as a zstd archive of newline-delimited text through the same hardened,
   bounded path as a plain file: regular non-symlink file, `O_NOFOLLOW`,
   descriptor identity checks, compressed bytes bounded by the caller's byte
   budget, and the same per-line byte bound. Before anything is decompressed
   the archive must be exactly one zstd frame that declares its content size
   (header parsed and block headers walked to the end of the frame; no second
   frame, no trailing bytes), and that declared size is refused above the
   budget; only then does one-shot `Bun.zstdDecompressSync` run, and its
   output must have exactly the declared length. Every Codex archive audited
   (4,869 of 4,869) is such a frame. An archive that omits its size, carries
   more than one frame, is corrupt or truncated fails with a
   `LocalHistoryError` whose operation is `readLines.decompress`. `readText` and `readTextRange` never
   decompress. `Bun.zstdDecompressSync` is the only decompressor that rejects
   a truncated archive on both the pinned Bun 1.3.13 and Bun 1.4; the
   `DecompressionStream('zstd')` and `node:zlib` streams accept a truncated
   archive silently on 1.3.13, which is a silent fallback.
2. **Discovery.** Codex discovery walks `~/.codex/sessions` and
   `~/.codex/archived_sessions`, accepts `.jsonl` and `.jsonl.zst`, and keeps
   one file per rollout stem: a plain file wins over its archive (the plain
   file is the writer's authoritative form; identical with removal pending, or
   newer when rehydrated for a resume; the archive may be mid-write), and the
   active directory wins over the archived directory (archiving moves the
   file). The session detail index and the collector use that same list.
3. **Per-file failure.** A rollout that cannot be read, plain or compressed,
   is a per-file failure: the collector keeps the typed error per file in its
   result, reports one `codex` warning with the count of skipped rollouts
   (operation `unreadableHistoryFile`, `rejectedRecords` = count, the first
   failure's operation and path for local diagnosis), marks both skill
   observation tiers of that pass as having rejected a source so no absence
   claim rests on the missing rollout, writes no cache entry for the file,
   keeps collecting the other rollouts, and retries it on the next scan.
   Walk-level failures stay source-level failures, as before.
4. **Cache.** The per-file session cache keeps its schema and version. An
   entry is keyed by the path actually read and that file's size and mtime, so
   an unchanged archive is decompressed once and never again; a rollout that
   changes form (plain to archive) is parsed once under its new path.
5. **Event loop.** After parsed files, the Codex scan sleeps 0 ms whenever
   50 ms of synchronous read-and-parse work have accumulated since the last
   yield, so a cold pass over thousands of archives yields regularly to the
   engine's control plane while small fixtures stay synchronous.

No configuration flag is added.

## Consequences

- The first scan after this change decompresses every archive once (1.64 GB
  compressed, 6.87 GB decompressed, 4.2× on the audited machine: 4,927
  rollouts in a 30 s span, 41–47 CPU s for the engine process against 37 CPU s
  for the same rollouts read plain) and rewrites the Codex cache under the
  archive paths. Later scans cost what a plain-file scan cost, because archives
  hit the cache on size and mtime: 4,927 cache hits in 310 ms, 6.3–6.5 CPU s
  and about 1 GB peak RSS for the whole process, the same figures as the
  plain-file warm pass.
- Each archive is decompressed whole, one at a time (compressed plus
  decompressed buffers, 145 MB for the largest audited rollout). The engine
  process peaked at 2.6–3.3 GB RSS during the cold archive pass, below the
  6.6 GB it reached reading the same rollouts as plain files, and returned to
  about 260 MB afterwards.
- A corrupt archive no longer takes the whole Codex source down; the pass
  reports how many rollouts it skipped, and the skill-observation producer of
  that pass is recorded as partial.
- The cache is written once at the end of a pass. An engine stop or the
  source timeout (10 minutes) during the first cold pass discards that pass
  and the next one starts from zero; a cold pass measured at about 30 s stays
  far inside the timeout.
- A home with `archived_sessions` but no `sessions` directory is not
  detected as Codex history (detection and the cache still key on
  `sessions`); Codex creates `sessions` on its first run, so this is not
  expected in practice.
- Distillation evidence and the rollout quota backfill still read plain
  rollouts only (their byte-range readers cannot address a compressed file);
  compressed rollouts are unavailable to them, as before this change.
- `thread_history_1.sqlite` (per-turn projection of the same rollouts, with
  `subAgentActivity` and `collabAgentToolCall` items) is a future source for
  session lineage, not part of this decision.

## Rejected alternative

Prefer the archive when both forms exist, on the grounds that it is the
durable form. Rejected: the archive is derived from the plain file and can be
mid-write, so choosing it can read a truncated archive while the complete
plain file sits beside it, and it would lose any turns Codex appends to a
rehydrated plain file after a resume.

## Evidence

- `packages/local-machine/src/local-history.ts` (`visitCompressedFileLines`,
  `readLines`), `packages/local-machine/src/internal/codex-history.ts`
  (`listCodexSessionFiles`), `packages/local-collectors/src/codex-history.ts`
  (per-file failures, cache keys, time-sliced yield).
- Read-only audit of the real `~/.codex` on 2026-10-17 and decompressor
  strictness probes: `.agent-memory/codex-zst-discovery-2026-10-17/`.
