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
