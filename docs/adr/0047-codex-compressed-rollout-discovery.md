# ADR 0047: Discover Codex rollouts in their compressed and archived forms

- **Status**: Accepted
- **Date**: 2026-10-17
- **Extends**: 0009, 0016

> Amended 2026-10-24 (Bun 1.4.3): archives now decode as a stream through
> `DecompressionStream('zstd')` instead of one-shot `node:zlib`; the frame
> walk, the declared-size bounds and the typed `readLines.decompress` failure
> are unchanged. See "Amendment 2026-10-24" below; decision 1's sentences on
> whole-buffer decoding and on not using the streaming decoders are
> superseded by it.

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
   as a zstd archive of newline-delimited text with the same file hardening
   and per-line byte bound as a plain file: regular non-symlink file,
   `O_NOFOLLOW`, descriptor identity checks, compressed bytes bounded by the
   caller's byte budget. Unlike a plain file, whose lines stream past a
   constant buffer, an archive is decompressed whole, so its memory follows
   the size it declares rather than the per-line bound. Before anything is
   decompressed the archive must be exactly one zstd frame that declares its
   content size (header parsed and block headers walked to the end of the
   frame; no second frame, no trailing bytes), and that declared size is
   refused above the smaller of the caller's budget and a dedicated archive
   budget, `HISTORY_ARCHIVE_MAX_DECOMPRESSED_BYTES` (256 MiB; the plain-file
   budget is 1 GiB, and a frame declaring 1 GiB compresses to a few KiB);
   only then does one-shot `node:zlib` `zstdDecompressSync` run with
   `maxOutputLength` set to the declared size, and its output must have
   exactly the declared length. Every Codex archive audited (4,869 of 4,869)
   is such a frame. An archive that omits its size, carries more than one
   frame, is corrupt or truncated fails with a `LocalHistoryError` whose
   operation is `readLines.decompress`. `readText` and `readTextRange` never
   decompress. `Bun.zstdDecompressSync` is not used: on the pinned Bun 1.3.13
   it corrupts the heap (measured 2026-10-19: the local-machine suite
   segfaulted in mimalloc in 11–20 of 40 runs under parallel load with it,
   0 of 40 with `node:zlib`, and the engine runs on that Bun). One-shot
   `node:zlib` `zstdDecompressSync` alone accepts a truncated frame (on Bun
   1.3.13 it returned without throwing), so truncation safety comes from the
   frame walk and the length check, not from the decompressor.
   `maxOutputLength` refuses a frame whose blocks would emit more than it
   declares; the reader test pins only that typed refusal. A separate probe
   on Bun 1.3.13 and 1.4.2 (a 7-byte declaration over 2,000 RLE blocks of
   128 KiB, 256 MiB if decoded) threw `ZSTD_error_dstSize_tooSmall` with no
   measurable RSS growth. The walk, the capped decompression and the length
   check are one exported function (`decompressHistoryArchive`) that the
   in-memory test double also uses, so fixtures fail exactly as files do.
   The streaming decompressors (`DecompressionStream('zstd')`, `node:zlib`
   streams) are not used.
2. **Discovery.** Codex discovery walks `~/.codex/sessions` and
   `~/.codex/archived_sessions`, accepts `.jsonl` and `.jsonl.zst`, and keeps
   one file per rollout stem: a plain file wins over its archive (the plain
   file is the writer's authoritative form; identical with removal pending, or
   newer when rehydrated for a resume; the archive may be mid-write), and the
   active directory wins over the archived directory (archiving moves the
   file). The session detail index and the collector use that same list.
   `archived_sessions` is secondary: when its walk fails (a symlink, not a
   directory, unreadable, removed mid-walk, over a scan budget), the list
   holds the active rollouts only and carries that typed failure; the
   collector reports it as one `codex` warning (operation
   `unlistedHistoryDirectory`, no record count since the number of files is
   unknown), weakens both skill tiers by one source, and keeps the cache
   entries under that directory, which are unseen rather than gone. A session
   detail whose id is not in such a partial list fails with that error instead
   of answering "not found", and an ancestor missing from it makes the usage
   ownership `unknown`. The active `sessions` walk failing still fails the
   source. Distillation evidence keeps the strict list, which fails on either
   walk.
3. **Moved rollouts.** Codex compresses or archives a rollout and removes the
   listed file independently of a scan, so a read that fails with `ENOENT`
   (before or after its lines were visited) is retried, with fresh parser
   state, on the rollout's next forms: for a plain file its sibling `.zst`,
   then `archived_sessions/<stem>.jsonl` and `.jsonl.zst`. Only a rollout gone
   in every form, or a failure other than `ENOENT`, is a per-file failure. A
   rollout read under another path is not cached this pass; the next pass
   lists and caches it under that path. The collector, the session detail and
   the latest-quota reader read through this fallback.
4. **Per-file failure.** A rollout that cannot be read, plain or compressed,
   is a per-file failure: the collector keeps the typed error per file in its
   result, reports one `codex` warning with the count of skipped rollouts
   (operation `unreadableHistoryFile`, `rejectedRecords` = count, the first
   failure's operation and path for local diagnosis), marks both skill
   observation tiers of that pass as having rejected a source so no absence
   claim rests on the missing rollout, writes no cache entry for the file,
   keeps collecting the other rollouts, and retries it on the next scan.
   Walk-level failures of the active directory stay source-level failures, as
   before. A child session whose usage the root would own (prior token usage
   observed, no tokens of its own) and whose lineage stops at an ancestor the
   pass could not read (a session id named by an unreadable rollout's file
   name, or any missing ancestor while `archived_sessions` is unlisted) is held
   back from the pass instead of being decided as owning its usage: importing
   it would overwrite a root-owned row with tokens and
   `usageUnavailable: false`. The collector counts these in one `codex`
   warning (operation `deferredUsageOwnership`, `rejectedRecords` = count);
   they are decided again on the next pass that reads the ancestor. The
   latest-quota reader steps over an archive that does not decompress and a
   rollout gone in every form to the next older rollout; any other read
   failure fails it, and when it finds no reading after skipping anything it
   fails with the first skipped failure rather than answering "no quota".
5. **Cache.** The per-file session cache keeps its schema and version. An
   entry is keyed by the path actually read and that file's size and mtime, so
   an unchanged archive is decompressed once and never again; a rollout that
   changes form (plain to archive) is parsed once under its new path.
6. **Event loop.** After parsed files, the Codex scan sleeps 0 ms whenever
   50 ms of synchronous read-and-parse work have accumulated since the last
   yield, so a cold pass over thousands of archives yields regularly to the
   engine's control plane. A scan can therefore suspend, so tests run it with
   `Effect.runPromise`; `Effect.runSync` would fail with an
   `AsyncFiberException` whenever a slow runner crossed the slice.

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
  about 260 MB afterwards. The archive budget bounds what one archive can
  cost: measured 2026-10-20 on Bun 1.3.13, a standalone read of an archive
  declaring 256 MiB peaked at 1.3–2.0 GB RSS (the decompressor holds about
  twice its output, then decoding adds collectable strings); under the 1 GiB
  plain-file budget alone, an 82 KB archive declaring 1 GB took 14 s and
  3.16 GB RSS on the reader before this budget. A
  genuine rollout over 256 MiB decompressed is reported as unreadable rather
  than read; the largest audited one is under 145 MB compressed plus
  decompressed.
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
  `readLines`), `packages/local-machine/src/history-budgets.ts`
  (`HISTORY_ARCHIVE_MAX_DECOMPRESSED_BYTES`),
  `packages/local-machine/src/internal/codex-history.ts`
  (`listCodexRolloutFiles`, `listCodexSessionFiles`,
  `readCodexRolloutWithFallback`, `isCodexUsageOwnershipUndecided`),
  `packages/local-collectors/src/codex-history.ts` (per-file failures, cache
  keys, deferred ownership, latest-quota failures, time-sliced yield).
- Read-only audit of the real `~/.codex` on 2026-10-17 and decompressor
  strictness probes: `.agent-memory/codex-zst-discovery-2026-10-17/`.

## Amendment 2026-10-24: streamed archive decoding

**Context.** The cold pass peaked at 2.6–3.3 GB RSS because each archive was
decoded whole, and the dependency upgrade moved the engine to Bun 1.4.3 (ADR
0070), whose `DecompressionStream('zstd')` decodes lazily: it produces at most
one 64 KiB chunk ahead of the reader and refuses truncated input, trailing
bytes, a bad content checksum and an output that disagrees with the frame's
declared size.

**Decision.** `streamHistoryArchive` (`packages/local-machine/src/local-history.ts`)
replaces `decompressHistoryArchive`:

1. The compressed file is still read whole under the caller's byte budget, with
   the same hardening, because the frame walk needs all of it: exactly one zstd
   frame that declares its content size, refused above the smaller of the
   budget and `HISTORY_ARCHIVE_MAX_DECOMPRESSED_BYTES` before anything is
   decoded. The 256 MiB archive budget stays; it now bounds decoding work
   rather than memory, and raising it is a separate decision.
2. The compressed bytes are fed to `DecompressionStream('zstd')` 64 KiB at a
   time and its output is pulled one chunk at a time into the same UTF-8
   decoder and per-line emitter as a plain file. A chunk reaches the parser
   only while the running total stays within the declaration, and the total
   must equal it when the stream ends. Every failure of the archive (walk,
   decoder, either size check) is a `HistoryArchiveError`, so
   `readLines.decompress`; a failure thrown by the line visitor stays
   `readLines`.
3. An archive read is asynchronous (`Effect.tryPromise`) and stops between
   chunks when its fiber is interrupted. Every caller already ran the Codex
   readers with `Effect.runPromise`.
4. Lines before a late failure (a corrupt later block, a bad checksum) may
   already have been visited, as for a plain file that fails part-way. Every
   caller discards a failed read whole: the collector keeps no row and no cache
   entry for it and reports it as before.
5. The in-memory test double reads archive fixtures through the same
   `streamHistoryArchive`. The reader test now forbids every zstd decoder
   other than this one (Bun's and `node:zlib`'s one-shot decoders,
   `createZstdDecompress`) in `local-machine` and `local-collectors`, and
   allows `DecompressionStream` only in `local-history.ts`.

**Consequences.** Archive memory follows the compressed size plus one decoded
chunk instead of the declared size. Bun's one-shot decoder is still unused: it
takes no output bound.

**Evidence (2026-10-24, Bun 1.4.3, synthetic archives, no real history).**

- Peak RSS of one `readLines` over an archive, three runs each, HEAD reader
  (one-shot `node:zlib`) against the streamed reader: 198 MB decoded from
  1.1 MB compressed, VmHWM 715–716 MB → 85–86 MB and 361–376 ms → 236–264 ms;
  235 MB decoded from 37 MB compressed (6.3×), VmHWM 785–786 MB →
  202–206 MB and 495–529 ms → 344–353 ms.
- Heap-corruption stress, the one that caught the Bun 1.3.13 decoder (11–20 of
  40 runs segfaulted): 40 parallel runs of the `local-machine` suite in scratch
  copies with symlinked `node_modules`, 40 of 40 clean (200 tests each, no
  crash); and 40 parallel processes each reading 60 synthetic archives four
  times (mixed sizes, checksummed and not, a quarter corrupted) through the
  real reader, 40 of 40 clean, no crash and no mismatch.
- Decoder probes: a frame that declares 7 or 256 bytes and carries 2,000 RLE
  blocks of 128 KiB is refused at once with about 2 MB RSS growth; a valid
  256 MiB RLE frame read one chunk and left for 300 ms grew RSS by 2 MB (the
  decoder does not run ahead); a frame whose declaration is off by one byte in
  either direction fails at its end.
- Tests: `packages/local-machine/src/local-history.test.ts` (truncation by one
  byte, bad checksum, chunk-straddling multi-byte characters, a late corrupt
  block, interruption, overrun, the decoder guard) and
  `packages/local-collectors/src/codex-history.test.ts` (a rollout that fails
  after its first lines were read yields no row and no cache entry).
