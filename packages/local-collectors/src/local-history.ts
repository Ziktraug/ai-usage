import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Context, Effect, Layer } from 'effect';
import { LocalHistoryError } from './errors';
import {
  HISTORY_FILE_MAX_BYTES,
  HISTORY_SCAN_MAX_BYTES,
  HISTORY_SCAN_MAX_DEPTH,
  HISTORY_SCAN_MAX_FILES,
} from './history-budgets';

export interface LocalHistoryDirEntry {
  isDirectory: boolean;
  isRegularFile: boolean;
  name: string;
  size: number;
}

export interface LocalHistoryDatabase {
  all<T extends object = Record<string, unknown>>(sql: string): Effect.Effect<T[], LocalHistoryError>;
  close: Effect.Effect<void>;
}

export interface LocalHistoryStorage {
  exists(filePath: string): Effect.Effect<boolean, LocalHistoryError>;
  home: string;
  openDatabase(dbPath: string): Effect.Effect<LocalHistoryDatabase, LocalHistoryError>;
  readDir(dirPath: string): Effect.Effect<LocalHistoryDirEntry[], LocalHistoryError>;
  readText(filePath: string, maxBytes?: number): Effect.Effect<string, LocalHistoryError>;
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
          all: <T extends object = Record<string, unknown>>(sql: string) =>
            Effect.try({
              try: () => db.query(sql).all() as T[],
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

    const maxBytes = budgets.maxBytes ?? HISTORY_SCAN_MAX_BYTES;
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
        throw new LocalHistoryError({
          operation: 'walkFiles.depthLimit',
          path: current.directory,
          cause: new Error(`History scan exceeds its depth limit of ${maxDepth}.`),
        });
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
          if (files.length > maxFiles || aggregateBytes > maxBytes) {
            throw new LocalHistoryError({
              operation: 'walkFiles.completenessLimit',
              path: dirPath,
              cause: new Error('History scan exceeds its file or aggregate-byte limit.'),
            });
          }
        }
      }
    }
    return files;
  });
