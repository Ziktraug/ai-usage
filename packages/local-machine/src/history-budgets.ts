export const HISTORY_FILE_MAX_BYTES = 128 * 1024 * 1024;
export const HISTORY_JSONL_MAX_BYTES = 1024 * 1024 * 1024;
/**
 * One newline-delimited record. Codex and Claude inline a pasted image as
 * base64 inside a single `input_image` record, so a screenshot-heavy session
 * routinely writes 10-15 MB lines and 8 MiB rejected them.
 *
 * Reads no longer fail on an oversized record — it is dropped and counted — so
 * this bound decides how much of a session survives, never whether the harness
 * collects at all.
 */
export const HISTORY_LINE_MAX_BYTES = 32 * 1024 * 1024;
export const HISTORY_SCAN_MAX_DEPTH = 64;
export const HISTORY_SCAN_MAX_FILES = 50_000;
/**
 * What one history archive may decompress to. A frame declaring 1 GiB
 * compresses to a few KiB, so the compressed-byte budget does not bound the
 * decoding work an archive can ask for; this does. Archives decode as a stream
 * since 2026-10-24 (see `streamHistoryArchive`), so their memory follows the
 * compressed bytes and the per-line bound rather than this size; before that,
 * an archive at this bound peaked at 1.3-2.0 GB RSS (Bun 1.3.13, whole-buffer
 * decoding). The largest audited Codex rollout stays under 145 MB compressed
 * plus decompressed; an archive declaring more than this bound is a per-file
 * failure.
 */
export const HISTORY_ARCHIVE_MAX_DECOMPRESSED_BYTES = 256 * 1024 * 1024;
