import fs, { type BigIntStats } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

import { Context, Effect, Layer } from 'effect';
import { LocalHistoryError } from './errors';
import {
  HISTORY_ARCHIVE_MAX_DECOMPRESSED_BYTES,
  HISTORY_FILE_MAX_BYTES,
  HISTORY_JSONL_MAX_BYTES,
  HISTORY_LINE_MAX_BYTES,
  HISTORY_SCAN_MAX_DEPTH,
  HISTORY_SCAN_MAX_FILES,
} from './history-budgets';

const TRAILING_CARRIAGE_RETURN = /\r$/;

const READ_CHUNK_BYTES = 64 * 1024;

const ZSTD_FRAME_MAGIC = 0xfd_2f_b5_28;

export interface LocalHistoryDirEntry {
  isDirectory: boolean;
  isRegularFile: boolean;
  name: string;
  size: number;
}

export type LocalHistorySqlParameter = bigint | boolean | null | number | string | Uint8Array;

export interface LocalHistoryDatabase {
  all<T extends object = Record<string, unknown>>(
    sql: string,
    parameters?: readonly LocalHistorySqlParameter[],
  ): Effect.Effect<T[], LocalHistoryError>;
  close: Effect.Effect<void>;
}

export interface LocalHistoryFileMetadata {
  mtimeMs: number;
  size: number;
}

export interface LocalHistoryTextRange {
  bytesRead: number;
  text: string;
}

export interface LocalHistoryStorage {
  exists(filePath: string): Effect.Effect<boolean, LocalHistoryError>;
  home: string;
  openDatabase(dbPath: string): Effect.Effect<LocalHistoryDatabase, LocalHistoryError>;
  /**
   * Read a user-managed config file, following symlinks. Dotfiles managers
   * (home-manager, stow, …) commonly install configs as symlinks, so unlike
   * history inputs these must be resolved before the hardened regular-file
   * read applies to the target.
   */
  readConfigText(filePath: string, maxBytes?: number): Effect.Effect<string, LocalHistoryError>;
  readDir(dirPath: string): Effect.Effect<LocalHistoryDirEntry[], LocalHistoryError>;
  readFileMetadata?(filePath: string): Effect.Effect<LocalHistoryFileMetadata, LocalHistoryError>;
  /**
   * `oversizedLines` counts records dropped for exceeding `maxLineBytes`. They
   * are reported rather than thrown so one unreadable record costs its own
   * session detail instead of the whole collection source.
   *
   * A path ending in `.zst` is read as a zstd archive of newline-delimited
   * text: `bytes` and both limits apply to the decompressed content, and a
   * corrupt or truncated archive fails with operation `readLines.decompress`.
   * Only this reader understands archives; `readText` and `readTextRange`
   * never decompress.
   */
  readLines(
    filePath: string,
    visit: (line: string) => void,
    limits?: { maxBytes?: number; maxLineBytes?: number },
  ): Effect.Effect<{ bytes: number; lines: number; oversizedLines: number }, LocalHistoryError>;
  readText(filePath: string, maxBytes?: number): Effect.Effect<string, LocalHistoryError>;
  readTextRange?(
    filePath: string,
    offset: number,
    maximumBytes: number,
  ): Effect.Effect<LocalHistoryTextRange, LocalHistoryError>;
}

export const LocalHistoryStorage = Context.GenericTag<LocalHistoryStorage>('@ai-usage/LocalHistoryStorage');

interface LocalHistoryErrorDetails {
  readonly path?: string;
  readonly sql?: string;
}

const localHistoryError =
  (operation: string, details: LocalHistoryErrorDetails = {}) =>
  (cause: unknown) =>
    new LocalHistoryError({ operation, cause, ...details });

interface SqliteFileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mtimeNs: bigint;
  readonly size: bigint;
}

interface SqliteHistoryIdentity {
  readonly main: SqliteFileIdentity;
  readonly wal: SqliteFileIdentity | null;
}

const sqliteIdentityError = (operation: string, filePath: string, message: string): LocalHistoryError =>
  new LocalHistoryError({
    operation,
    path: filePath,
    cause: new Error(message),
  });

const lstatSqlitePath = (filePath: string): BigIntStats | undefined => {
  try {
    return fs.lstatSync(filePath, { bigint: true, throwIfNoEntry: false });
  } catch {
    throw sqliteIdentityError('sqlite.identity', filePath, 'SQLite history identity could not be inspected.');
  }
};

const readPresentSqliteFileIdentity = (filePath: string): SqliteFileIdentity | null => {
  const stat = lstatSqlitePath(filePath);
  if (!stat) {
    return null;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw sqliteIdentityError(
      'sqlite.identity',
      filePath,
      'SQLite history identity is not a non-symlink regular file.',
    );
  }
  return {
    dev: stat.dev,
    ino: stat.ino,
    mtimeNs: stat.mtimeNs,
    size: stat.size,
  };
};

/** Capture the regular-file identities SQLite may read for one database. */
const readSqliteHistoryIdentity = (dbPath: string): SqliteHistoryIdentity => {
  const main = readPresentSqliteFileIdentity(dbPath);
  if (!main) {
    throw sqliteIdentityError('sqlite.identity', dbPath, 'SQLite history identity is unavailable.');
  }
  return {
    main,
    wal: readPresentSqliteFileIdentity(`${dbPath}-wal`),
  };
};

const sqliteFileIdentitiesMatch = (left: SqliteFileIdentity, right: SqliteFileIdentity): boolean =>
  left.dev === right.dev && left.ino === right.ino && left.mtimeNs === right.mtimeNs && left.size === right.size;

const changedSqliteIdentityPath = (
  dbPath: string,
  before: SqliteHistoryIdentity,
  after: SqliteHistoryIdentity,
): string | null => {
  if (!sqliteFileIdentitiesMatch(before.main, after.main)) {
    return dbPath;
  }
  if (before.wal === null || after.wal === null) {
    return before.wal === after.wal ? null : `${dbPath}-wal`;
  }
  return sqliteFileIdentitiesMatch(before.wal, after.wal) ? null : `${dbPath}-wal`;
};

const assertStableSqliteHistoryIdentity = (
  dbPath: string,
  before: SqliteHistoryIdentity,
  after: SqliteHistoryIdentity,
): void => {
  const changedPath = changedSqliteIdentityPath(dbPath, before, after);
  if (changedPath) {
    throw sqliteIdentityError('sqlite.identityChanged', changedPath, 'SQLite history identity changed while opening.');
  }
};

/**
 * Read an opened descriptor to its end in bounded chunks. Reading at most
 * `maxBytes + 1` bytes detects a file that grew past the bound without
 * allocating for it.
 */
const readDescriptorBounded = (descriptor: number, filePath: string, maxBytes: number): Buffer => {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  while (totalBytes <= maxBytes) {
    const chunk = Buffer.alloc(Math.min(READ_CHUNK_BYTES, maxBytes + 1 - totalBytes));
    const bytesRead = fs.readSync(descriptor, chunk, 0, chunk.length, null);
    if (bytesRead === 0) {
      break;
    }
    chunks.push(chunk.subarray(0, bytesRead));
    totalBytes += bytesRead;
  }
  if (totalBytes > maxBytes) {
    throw new Error(`History input exceeds its ${maxBytes}-byte limit: ${filePath}`);
  }
  return Buffer.concat(chunks, totalBytes);
};

export const readRegularFileText = (filePath: string, maxBytes: number): string => {
  const before = fs.lstatSync(filePath);
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error(`History input is not a regular file: ${filePath}`);
  }
  if (before.size > maxBytes) {
    throw new Error(`History input exceeds its ${maxBytes}-byte limit: ${filePath}`);
  }
  // biome-ignore lint/suspicious/noBitwiseOperators: Node combines open flags as a bit mask.
  const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error(`History input changed while it was opened: ${filePath}`);
    }
    const content = readDescriptorBounded(descriptor, filePath, maxBytes);
    const after = fs.lstatSync(filePath);
    if (after.isSymbolicLink() || after.dev !== opened.dev || after.ino !== opened.ino) {
      throw new Error(`History input changed while it was read: ${filePath}`);
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(content);
  } finally {
    fs.closeSync(descriptor);
  }
};

export const readRegularFileMetadata = (filePath: string): LocalHistoryFileMetadata => {
  const metadata = fs.lstatSync(filePath);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`History input is not a regular file: ${filePath}`);
  }
  return { mtimeMs: metadata.mtimeMs, size: metadata.size };
};

export const readRegularFileTextRange = (
  filePath: string,
  offset: number,
  maximumBytes: number,
): LocalHistoryTextRange => {
  if (!(Number.isSafeInteger(offset) && offset >= 0 && Number.isSafeInteger(maximumBytes) && maximumBytes >= 0)) {
    throw new Error(`History range is invalid for ${filePath}`);
  }
  const before = fs.lstatSync(filePath);
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error(`History input is not a regular file: ${filePath}`);
  }
  // biome-ignore lint/suspicious/noBitwiseOperators: Node combines open flags as a bit mask.
  const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error(`History input changed while it was opened: ${filePath}`);
    }
    const buffer = Buffer.alloc(Math.min(maximumBytes, Math.max(0, opened.size - offset)));
    const bytesRead = buffer.length === 0 ? 0 : fs.readSync(descriptor, buffer, 0, buffer.length, offset);
    const after = fs.lstatSync(filePath);
    if (after.isSymbolicLink() || after.dev !== opened.dev || after.ino !== opened.ino) {
      throw new Error(`History input changed while it was read: ${filePath}`);
    }
    return {
      bytesRead,
      // A bounded byte range may end between the bytes of one UTF-8 code point.
      // Streaming decode retains that incomplete suffix while still rejecting
      // invalid byte sequences inside the range. Callers commit only complete
      // newline-delimited records and will reread the retained suffix.
      text: new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead), { stream: true }),
    };
  } finally {
    fs.closeSync(descriptor);
  }
};

export interface BoundedLineEmitter {
  /**
   * Close the stream: an unterminated trailing record is emitted, or counted
   * as oversized when it had already passed the bound.
   */
  finish(): void;
  readonly lines: number;
  readonly oversizedLines: number;
  /** Append decoded text and emit every newline-terminated record it completes. */
  push(text: string): void;
}

/**
 * Newline-delimited record emission shared by the plain and the archive
 * reader: CRLF stripping, a per-record byte bound, and discarding of a record
 * over that bound as its bytes arrive, so peak memory stays at the bound
 * rather than following the size of the offending record.
 *
 * The unterminated record is kept as the pieces it arrived in and joined once,
 * when its newline arrives; only the newly pushed text is searched, and each
 * piece is measured once. Appending to one string and searching it again on
 * every push re-copied the whole buffered record per chunk (JSC flattens the
 * rope to search it), which made a multi-megabyte record quadratic and drove a
 * cold Codex pass to gigabytes of discarded copies. Pushed text comes from a
 * streaming `TextDecoder`, so a piece never splits a surrogate pair and the
 * per-piece UTF-8 byte counts add up to the record's.
 */
export const createBoundedLineEmitter = (visit: (line: string) => void, maxLineBytes: number): BoundedLineEmitter => {
  let lines = 0;
  let oversizedLines = 0;
  let pendingPieces: string[] = [];
  let pendingBytes = 0;
  // Set once the buffered record has already passed `maxLineBytes`. Its bytes
  // are discarded as they arrive instead of being retained until the closing
  // newline.
  let discardingOversizedLine = false;
  const clearPending = (): void => {
    pendingPieces = [];
    pendingBytes = 0;
  };
  return {
    push: (text) => {
      let start = 0;
      for (;;) {
        const separatorIndex = text.indexOf('\n', start);
        if (separatorIndex < 0) {
          break;
        }
        const tail = text.slice(start, separatorIndex);
        start = separatorIndex + 1;
        if (discardingOversizedLine) {
          discardingOversizedLine = false;
          oversizedLines++;
          continue;
        }
        let record = tail;
        if (pendingPieces.length > 0) {
          pendingPieces.push(tail);
          record = pendingPieces.join('');
        }
        clearPending();
        const line = record.replace(TRAILING_CARRIAGE_RETURN, '');
        if (Buffer.byteLength(line, 'utf8') > maxLineBytes) {
          oversizedLines++;
          continue;
        }
        visit(line);
        lines++;
      }
      if (discardingOversizedLine || start === text.length) {
        return;
      }
      const rest = text.slice(start);
      pendingPieces.push(rest);
      pendingBytes += Buffer.byteLength(rest, 'utf8');
      // Nothing arriving later can shrink an unterminated record that is
      // already over the bound, so commit to discarding it now.
      if (pendingBytes > maxLineBytes) {
        discardingOversizedLine = true;
        clearPending();
      }
    },
    finish: () => {
      if (discardingOversizedLine) {
        // The trailing record ran past the bound and the input ended before
        // its newline, so it closes here.
        oversizedLines++;
        discardingOversizedLine = false;
      } else if (pendingPieces.length > 0) {
        visit(pendingPieces.join('').replace(TRAILING_CARRIAGE_RETURN, ''));
        lines++;
      }
      clearPending();
    },
    get lines() {
      return lines;
    },
    get oversizedLines() {
      return oversizedLines;
    },
  };
};

export const visitRegularFileLines = (
  filePath: string,
  visit: (line: string) => void,
  maxBytes: number,
  maxLineBytes: number,
): { bytes: number; lines: number; oversizedLines: number } => {
  const before = fs.lstatSync(filePath);
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error(`History input is not a regular file: ${filePath}`);
  }
  if (before.size > maxBytes) {
    throw new Error(`History input exceeds its ${maxBytes}-byte limit: ${filePath}`);
  }
  // biome-ignore lint/suspicious/noBitwiseOperators: Node combines open flags as a bit mask.
  const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const emitter = createBoundedLineEmitter(visit, maxLineBytes);
  let bytes = 0;
  try {
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error(`History input changed while it was opened: ${filePath}`);
    }
    while (bytes <= maxBytes) {
      const chunk = Buffer.alloc(Math.min(READ_CHUNK_BYTES, maxBytes + 1 - bytes));
      const bytesRead = fs.readSync(descriptor, chunk, 0, chunk.length, null);
      if (bytesRead === 0) {
        break;
      }
      bytes += bytesRead;
      if (bytes > maxBytes) {
        throw new Error(`History input exceeds its ${maxBytes}-byte limit: ${filePath}`);
      }
      emitter.push(decoder.decode(chunk.subarray(0, bytesRead), { stream: true }));
    }
    emitter.push(decoder.decode());
    emitter.finish();
    const after = fs.lstatSync(filePath);
    if (after.isSymbolicLink() || after.dev !== opened.dev || after.ino !== opened.ino) {
      throw new Error(`History input changed while it was read: ${filePath}`);
    }
    return { bytes, lines: emitter.lines, oversizedLines: emitter.oversizedLines };
  } finally {
    fs.closeSync(descriptor);
  }
};

/**
 * A history archive that is not one well-formed zstd frame with a declared
 * content size, or whose bytes the decompressor refused; `cause` names the
 * reason.
 */
export class HistoryArchiveError extends Error {
  constructor(filePath: string, cause: unknown) {
    super(`History archive could not be decompressed: ${filePath}`, { cause });
    this.name = 'HistoryArchiveError';
  }
}

const zstdDictionaryIdBytes = (flag: number, filePath: string): number => {
  switch (flag) {
    case 0:
      return 0;
    case 1:
      return 1;
    case 2:
      return 2;
    case 3:
      return 4;
    default:
      throw new HistoryArchiveError(filePath, new Error(`Invalid zstd Dictionary_ID_Flag ${flag}`));
  }
};

const zstdContentSizeBytes = (flag: number, singleSegment: boolean, filePath: string): number => {
  switch (flag) {
    case 0:
      return singleSegment ? 1 : 0;
    case 1:
      return 2;
    case 2:
      return 4;
    case 3:
      return 8;
    default:
      throw new HistoryArchiveError(filePath, new Error(`Invalid zstd Frame_Content_Size_Flag ${flag}`));
  }
};

const readZstdContentSize = (archive: Buffer, offset: number, width: number): number => {
  switch (width) {
    case 1:
      return archive.readUInt8(offset);
    case 2:
      return archive.readUInt16LE(offset) + 256;
    case 4:
      return archive.readUInt32LE(offset);
    default:
      // Above 2^53 the conversion is lossy, but any such size already exceeds
      // every bound a caller can pass.
      return Number(archive.readBigUInt64LE(offset));
  }
};

interface ZstdFrameLayout {
  /** The Frame_Content_Size the frame declares; the decompressed length must equal it. */
  readonly declaredContentSize: number;
  /** Offset one past the frame's last byte (its checksum when present). */
  readonly frameEnd: number;
}

/**
 * Lay out the zstd frame at the start of `archive` without decompressing it
 * (RFC 8878 §3.1.1): the content size it declares, refused above `maxBytes`
 * before any block is walked, and where the frame ends, found by walking its
 * block headers. The caller requires that end to be the end of the archive, so
 * the declaration bounds everything the decompressor can emit. A missing
 * magic number, a reserved bit or block type, a header or block running past
 * the end, or a frame that omits its content size (every Codex archive
 * declares it) is refused like any corrupt archive.
 */
const zstdSingleFrameLayout = (archive: Buffer, filePath: string, maxBytes: number): ZstdFrameLayout => {
  const malformed = (reason: string): HistoryArchiveError => new HistoryArchiveError(filePath, new Error(reason));
  if (archive.length < 5 || archive.readUInt32LE(0) !== ZSTD_FRAME_MAGIC) {
    throw malformed('Missing zstd frame magic number');
  }
  const descriptor = archive.readUInt8(4);
  // biome-ignore lint/suspicious/noBitwiseOperators: Frame_Header_Descriptor bit 3 is reserved and must be clear.
  if ((descriptor & 0x08) !== 0) {
    throw malformed('Reserved zstd frame header bit set');
  }
  // biome-ignore lint/suspicious/noBitwiseOperators: Frame_Content_Size_Flag is bits 7-6.
  const contentSizeFlag = descriptor >>> 6;
  // biome-ignore lint/suspicious/noBitwiseOperators: Single_Segment_Flag is bit 5.
  const singleSegment = (descriptor & 0x20) !== 0;
  // biome-ignore lint/suspicious/noBitwiseOperators: Content_Checksum_Flag is bit 2.
  const contentChecksum = (descriptor & 0x04) !== 0;
  // biome-ignore lint/suspicious/noBitwiseOperators: Dictionary_ID_Flag is bits 1-0.
  const dictionaryIdFlag = descriptor & 0x03;
  const contentSizeBytes = zstdContentSizeBytes(contentSizeFlag, singleSegment, filePath);
  if (contentSizeBytes === 0) {
    throw malformed(`History archive does not declare its content size: ${filePath}`);
  }
  let offset = 5 + (singleSegment ? 0 : 1) + zstdDictionaryIdBytes(dictionaryIdFlag, filePath);
  if (archive.length < offset + contentSizeBytes) {
    throw malformed('Truncated zstd frame header');
  }
  const declaredContentSize = readZstdContentSize(archive, offset, contentSizeBytes);
  offset += contentSizeBytes;
  if (declaredContentSize > maxBytes) {
    throw new Error(`History input exceeds its ${maxBytes}-byte limit: ${filePath}`);
  }
  for (;;) {
    if (archive.length < offset + 3) {
      throw malformed('Truncated zstd frame');
    }
    const blockHeader = archive.readUIntLE(offset, 3);
    // biome-ignore lint/suspicious/noBitwiseOperators: Last_Block is bit 0 of the Block_Header.
    const lastBlock = (blockHeader & 0x01) !== 0;
    // biome-ignore lint/suspicious/noBitwiseOperators: Block_Type is bits 2-1.
    const blockType = (blockHeader >>> 1) & 0x03;
    // biome-ignore lint/suspicious/noBitwiseOperators: Block_Size is bits 23-3.
    const blockSize = blockHeader >>> 3;
    if (blockType === 3) {
      throw malformed('Reserved zstd block type');
    }
    // An RLE block stores its one repeated byte; Raw and Compressed blocks
    // store Block_Size bytes.
    offset += 3 + (blockType === 1 ? 1 : blockSize);
    if (offset > archive.length) {
      throw malformed('Truncated zstd frame');
    }
    if (lastBlock) {
      break;
    }
  }
  if (contentChecksum) {
    offset += 4;
    if (offset > archive.length) {
      throw malformed('Truncated zstd frame');
    }
  }
  return { declaredContentSize, frameEnd: offset };
};

/**
 * Decompress the bytes of a history archive: exactly one zstd frame that
 * declares its content size (walked before anything is decoded, the declared
 * size refused above `maxBytes` and above
 * `HISTORY_ARCHIVE_MAX_DECOMPRESSED_BYTES`, because the whole output is held
 * in memory at once), decompressed with its output capped at that
 * declaration, and refused unless the output has exactly the declared length.
 * Pure over its input so the test double reads fixtures through the same
 * path. A zero-byte archive is refused with the rest: zstd of empty input is
 * a 9-byte frame, and Codex removes the plain source only after writing the
 * archive, so an empty one is damage rather than an empty history.
 *
 * `node:zlib`, not Bun's own `zstdDecompressSync`: on the pinned Bun 1.3.13
 * the Bun decompressor corrupts the heap (intermittent mimalloc segfaults in later
 * allocations, measured 2026-10-19), and the engine runs on that Bun.
 * Truncation safety comes from the frame walk and the length check, not from
 * the decompressor. `maxOutputLength` caps what a frame can emit at its
 * declaration (the option refuses 0, so an empty declaration is capped at one
 * byte and the length check refuses that byte); a frame whose blocks would
 * exceed it fails inside the decompressor.
 */
export const decompressHistoryArchive = (compressed: Buffer, filePath: string, maxBytes: number): Buffer => {
  const layout = zstdSingleFrameLayout(
    compressed,
    filePath,
    Math.min(maxBytes, HISTORY_ARCHIVE_MAX_DECOMPRESSED_BYTES),
  );
  if (layout.frameEnd !== compressed.length) {
    throw new HistoryArchiveError(filePath, new Error(`History archive is not a single zstd frame: ${filePath}`));
  }
  let decompressed: Buffer;
  try {
    decompressed = zstdDecompressSync(compressed, { maxOutputLength: Math.max(1, layout.declaredContentSize) });
  } catch (cause) {
    throw new HistoryArchiveError(filePath, cause);
  }
  if (decompressed.length !== layout.declaredContentSize) {
    throw new HistoryArchiveError(
      filePath,
      new Error(`History archive content does not match its declared size: ${filePath}`),
    );
  }
  return decompressed;
};

/**
 * Read a zstd archive of newline-delimited text with the same file hardening
 * and per-line bound as the plain reader. A readable archive is exactly one
 * zstd frame that declares its content size, which every Codex archive does.
 * `maxBytes` bounds the compressed file; the declared size is refused above
 * the smaller of `maxBytes` and `HISTORY_ARCHIVE_MAX_DECOMPRESSED_BYTES`
 * before any decompression, and the decompressed length must equal the
 * declaration, so the bound holds for every archive. Unlike the plain reader,
 * which streams, the archive is decompressed whole, so peak memory follows
 * that declared size. `bytes` reports the decompressed count so byte budgets
 * follow what the parser saw.
 */
export const visitCompressedFileLines = (
  filePath: string,
  visit: (line: string) => void,
  maxBytes: number,
  maxLineBytes: number,
): { bytes: number; lines: number; oversizedLines: number } => {
  const before = fs.lstatSync(filePath);
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error(`History input is not a regular file: ${filePath}`);
  }
  if (before.size > maxBytes) {
    throw new Error(`History input exceeds its ${maxBytes}-byte limit: ${filePath}`);
  }
  // biome-ignore lint/suspicious/noBitwiseOperators: Node combines open flags as a bit mask.
  const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error(`History input changed while it was opened: ${filePath}`);
    }
    const compressed = readDescriptorBounded(descriptor, filePath, maxBytes);
    const decompressed = decompressHistoryArchive(compressed, filePath, maxBytes);
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const emitter = createBoundedLineEmitter(visit, maxLineBytes);
    for (let offset = 0; offset < decompressed.length; offset += READ_CHUNK_BYTES) {
      emitter.push(decoder.decode(decompressed.subarray(offset, offset + READ_CHUNK_BYTES), { stream: true }));
    }
    emitter.push(decoder.decode());
    emitter.finish();
    const after = fs.lstatSync(filePath);
    if (after.isSymbolicLink() || after.dev !== opened.dev || after.ino !== opened.ino) {
      throw new Error(`History input changed while it was read: ${filePath}`);
    }
    return { bytes: decompressed.length, lines: emitter.lines, oversizedLines: emitter.oversizedLines };
  } finally {
    fs.closeSync(descriptor);
  }
};

const MAX_CONFIG_SYMLINK_DEPTH = 16;

/**
 * Configuration files are the only local-collector inputs allowed to be
 * symlinks because dotfile managers commonly project them. Inspect every link
 * in the chain before resolving the next path, then apply the normal bounded,
 * no-follow regular-file read to the final target.
 */
export const readConfigFileText = (filePath: string, maxBytes = HISTORY_FILE_MAX_BYTES): string => {
  let currentPath = path.resolve(filePath);
  const visited = new Set<string>();
  for (let depth = 0; depth <= MAX_CONFIG_SYMLINK_DEPTH; depth++) {
    const stat = fs.lstatSync(currentPath);
    if (!stat.isSymbolicLink()) {
      return readRegularFileText(currentPath, maxBytes);
    }
    if (visited.has(currentPath) || depth === MAX_CONFIG_SYMLINK_DEPTH) {
      throw new Error(`Config symlink chain is cyclic or exceeds ${MAX_CONFIG_SYMLINK_DEPTH} links: ${filePath}`);
    }
    visited.add(currentPath);
    const target = fs.readlinkSync(currentPath);
    currentPath = path.resolve(path.dirname(currentPath), target);
  }
  throw new Error(`Config symlink chain could not be resolved: ${filePath}`);
};

export const createLocalHistoryStorage = (home = os.homedir()): LocalHistoryStorage => ({
  home,
  exists: (filePath) =>
    Effect.try({
      try: () => fs.existsSync(filePath),
      catch: localHistoryError('exists', { path: filePath }),
    }),
  readText: (filePath, maxBytes = HISTORY_FILE_MAX_BYTES) =>
    Effect.try({
      try: () => readRegularFileText(filePath, maxBytes),
      catch: localHistoryError('readText', { path: filePath }),
    }),
  readConfigText: (filePath, maxBytes = HISTORY_FILE_MAX_BYTES) =>
    Effect.try({
      try: () => readConfigFileText(filePath, maxBytes),
      catch: localHistoryError('readConfigText', { path: filePath }),
    }),
  readLines: (filePath, visit, limits = {}) =>
    Effect.try({
      try: () =>
        (filePath.endsWith('.zst') ? visitCompressedFileLines : visitRegularFileLines)(
          filePath,
          visit,
          limits.maxBytes ?? HISTORY_JSONL_MAX_BYTES,
          limits.maxLineBytes ?? HISTORY_LINE_MAX_BYTES,
        ),
      catch: (cause) =>
        localHistoryError(cause instanceof HistoryArchiveError ? 'readLines.decompress' : 'readLines', {
          path: filePath,
        })(cause),
    }),
  readFileMetadata: (filePath) =>
    Effect.try({
      try: () => readRegularFileMetadata(filePath),
      catch: localHistoryError('readFileMetadata', { path: filePath }),
    }),
  readTextRange: (filePath, offset, maximumBytes) =>
    Effect.try({
      try: () => readRegularFileTextRange(filePath, offset, maximumBytes),
      catch: localHistoryError('readTextRange', { path: filePath }),
    }),
  readDir: (dirPath) =>
    Effect.try({
      try: () => {
        const directory = fs.lstatSync(dirPath);
        if (directory.isSymbolicLink() || !directory.isDirectory()) {
          throw new Error(`History scan root is not a directory: ${dirPath}`);
        }
        return fs.readdirSync(dirPath, { withFileTypes: true }).map((entry) => {
          const stat = fs.lstatSync(path.join(dirPath, entry.name));
          return {
            name: entry.name,
            isDirectory: stat.isDirectory() && !stat.isSymbolicLink(),
            isRegularFile: stat.isFile() && !stat.isSymbolicLink(),
            size: stat.isFile() ? stat.size : 0,
          };
        });
      },
      catch: localHistoryError('readDir', { path: dirPath }),
    }),
  openDatabase: (dbPath) =>
    Effect.tryPromise({
      try: async () => {
        const { Database } = await import('bun:sqlite');
        const beforeIdentity = readSqliteHistoryIdentity(dbPath);
        // Bun 1.3.13 has no supported SQLITE_OPEN_NOFOLLOW option. This
        // lstat/open/post-lstat fallback rejects static redirection and
        // ordinary replacement, but not a hostile same-UID pathname race.
        // Read-only SQLite connections include committed WAL pages without
        // checkpointing or mutating the harness-owned database.
        const db = new Database(dbPath, { readonly: true });
        // Harness databases reach GBs (Codex logs); with SQLite's default ~2 MB page cache,
        // any sort or group over them spills a transient B-tree to disk on every query.
        db.exec('PRAGMA cache_size = -65536');
        db.exec('PRAGMA temp_store = MEMORY');
        let closed = false;
        const rollbackAndClose = (): void => {
          if (closed) {
            return;
          }
          closed = true;
          let cleanupFailure: unknown;
          try {
            if (db.inTransaction) {
              db.exec('ROLLBACK');
            }
          } catch (cause) {
            cleanupFailure = cause;
          }
          try {
            db.close();
          } catch (cause) {
            cleanupFailure ??= cause;
          }
          if (cleanupFailure !== undefined) {
            throw cleanupFailure;
          }
        };
        try {
          db.exec('BEGIN');
          const afterIdentity = readSqliteHistoryIdentity(dbPath);
          assertStableSqliteHistoryIdentity(dbPath, beforeIdentity, afterIdentity);
        } catch (cause) {
          try {
            rollbackAndClose();
          } catch {
            // Preserve the identity/open failure after attempting both cleanup operations.
          }
          throw cause;
        }
        return {
          all: <T extends object = Record<string, unknown>>(
            sql: string,
            parameters: readonly LocalHistorySqlParameter[] = [],
          ) =>
            Effect.try({
              try: () => db.query(sql).all(...parameters) as T[],
              catch: localHistoryError('sqlite.all', { path: dbPath, sql }),
            }),
          close: Effect.try({
            try: rollbackAndClose,
            catch: localHistoryError('sqlite.close', { path: dbPath }),
          }).pipe(Effect.ignore),
        };
      },
      catch: (cause) =>
        cause instanceof LocalHistoryError ? cause : localHistoryError('openDatabase', { path: dbPath })(cause),
    }),
});

export const LocalHistoryStorageLive = Layer.succeed(LocalHistoryStorage, createLocalHistoryStorage());

export const historyPath = (storage: LocalHistoryStorage, ...segments: string[]) =>
  path.join(storage.home, ...segments);

export const walkFiles = (
  storage: LocalHistoryStorage,
  dirPath: string,
  include: (fileName: string, filePath: string) => boolean,
  budgets: { maxBytes?: number; maxDepth?: number; maxFiles?: number } = {},
): Effect.Effect<string[], LocalHistoryError> =>
  Effect.gen(function* () {
    if (!(yield* storage.exists(dirPath))) {
      return [];
    }

    const maxBytes = budgets.maxBytes;
    const maxDepth = budgets.maxDepth ?? HISTORY_SCAN_MAX_DEPTH;
    const maxFiles = budgets.maxFiles ?? HISTORY_SCAN_MAX_FILES;
    const files: string[] = [];
    const pending = [{ depth: 0, directory: dirPath }];
    let aggregateBytes = 0;
    while (pending.length > 0) {
      const current = pending.pop();
      if (!current) {
        break;
      }
      if (current.depth > maxDepth) {
        return yield* Effect.fail(
          new LocalHistoryError({
            operation: 'walkFiles.depthLimit',
            path: current.directory,
            cause: new Error(`History scan exceeds its depth limit of ${maxDepth}.`),
          }),
        );
      }
      const entries = (yield* storage.readDir(current.directory)).sort((left, right) =>
        right.name.localeCompare(left.name),
      );
      for (const entry of entries) {
        const filePath = path.join(current.directory, entry.name);
        if (entry.isDirectory) {
          pending.push({ depth: current.depth + 1, directory: filePath });
        } else if (entry.isRegularFile && include(entry.name, filePath)) {
          files.push(filePath);
          aggregateBytes += entry.size;
          if (files.length > maxFiles || (maxBytes !== undefined && aggregateBytes > maxBytes)) {
            return yield* Effect.fail(
              new LocalHistoryError({
                operation: 'walkFiles.completenessLimit',
                path: dirPath,
                cause: new Error('History scan exceeds its file or aggregate-byte limit.'),
              }),
            );
          }
        }
      }
    }
    return files;
  });
