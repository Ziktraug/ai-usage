import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Context, Effect, Layer } from 'effect';
import { LocalHistoryError } from './errors';
import {
  HISTORY_FILE_MAX_BYTES,
  HISTORY_JSONL_MAX_BYTES,
  HISTORY_LINE_MAX_BYTES,
  HISTORY_SCAN_MAX_DEPTH,
  HISTORY_SCAN_MAX_FILES,
} from './history-budgets';

const TRAILING_CARRIAGE_RETURN = /\r$/;

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
  readLines(
    filePath: string,
    visit: (line: string) => void,
    limits?: { maxBytes?: number; maxLineBytes?: number },
  ): Effect.Effect<{ bytes: number; lines: number }, LocalHistoryError>;
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
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    while (totalBytes <= maxBytes) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, maxBytes + 1 - totalBytes));
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
    const after = fs.lstatSync(filePath);
    if (after.isSymbolicLink() || after.dev !== opened.dev || after.ino !== opened.ino) {
      throw new Error(`History input changed while it was read: ${filePath}`);
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, totalBytes));
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
      text: new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead)),
    };
  } finally {
    fs.closeSync(descriptor);
  }
};

export const visitRegularFileLines = (
  filePath: string,
  visit: (line: string) => void,
  maxBytes: number,
  maxLineBytes: number,
): { bytes: number; lines: number } => {
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
  let bytes = 0;
  let lines = 0;
  let pending = '';
  const emitCompleteLines = (): void => {
    let separatorIndex = pending.indexOf('\n');
    while (separatorIndex >= 0) {
      const line = pending.slice(0, separatorIndex).replace(TRAILING_CARRIAGE_RETURN, '');
      if (Buffer.byteLength(line, 'utf8') > maxLineBytes) {
        throw new Error(`History input contains a line exceeding its ${maxLineBytes}-byte limit: ${filePath}`);
      }
      visit(line);
      lines++;
      pending = pending.slice(separatorIndex + 1);
      separatorIndex = pending.indexOf('\n');
    }
    if (Buffer.byteLength(pending, 'utf8') > maxLineBytes) {
      throw new Error(`History input contains a line exceeding its ${maxLineBytes}-byte limit: ${filePath}`);
    }
  };
  try {
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error(`History input changed while it was opened: ${filePath}`);
    }
    while (bytes <= maxBytes) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, maxBytes + 1 - bytes));
      const bytesRead = fs.readSync(descriptor, chunk, 0, chunk.length, null);
      if (bytesRead === 0) {
        break;
      }
      bytes += bytesRead;
      if (bytes > maxBytes) {
        throw new Error(`History input exceeds its ${maxBytes}-byte limit: ${filePath}`);
      }
      pending += decoder.decode(chunk.subarray(0, bytesRead), { stream: true });
      emitCompleteLines();
    }
    pending += decoder.decode();
    emitCompleteLines();
    if (pending.length > 0) {
      visit(pending.replace(TRAILING_CARRIAGE_RETURN, ''));
      lines++;
    }
    const after = fs.lstatSync(filePath);
    if (after.isSymbolicLink() || after.dev !== opened.dev || after.ino !== opened.ino) {
      throw new Error(`History input changed while it was read: ${filePath}`);
    }
    return { bytes, lines };
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
        visitRegularFileLines(
          filePath,
          visit,
          limits.maxBytes ?? HISTORY_JSONL_MAX_BYTES,
          limits.maxLineBytes ?? HISTORY_LINE_MAX_BYTES,
        ),
      catch: localHistoryError('readLines', { path: filePath }),
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
        // Read-only SQLite connections include committed WAL pages without
        // checkpointing or mutating the harness-owned database.
        const db = new Database(dbPath, { readonly: true });
        db.exec('BEGIN');
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
            try: () => {
              db.exec('ROLLBACK');
              db.close();
            },
            catch: localHistoryError('sqlite.close', { path: dbPath }),
          }).pipe(Effect.ignore),
        };
      },
      catch: localHistoryError('openDatabase', { path: dbPath }),
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
