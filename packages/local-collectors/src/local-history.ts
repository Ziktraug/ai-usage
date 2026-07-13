import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Context, Effect, Layer } from 'effect';
import { LocalHistoryError } from './errors';

export interface LocalHistoryDirEntry {
  isDirectory: boolean;
  name: string;
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
  readText(filePath: string): Effect.Effect<string, LocalHistoryError>;
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

export const createLocalHistoryStorage = (home = os.homedir()): LocalHistoryStorage => ({
  home,
  exists: (filePath) =>
    Effect.try({
      try: () => fs.existsSync(filePath),
      catch: localHistoryError('exists', { path: filePath }),
    }),
  readText: (filePath) =>
    Effect.try({
      try: () => fs.readFileSync(filePath, 'utf8'),
      catch: localHistoryError('readText', { path: filePath }),
    }),
  readDir: (dirPath) =>
    Effect.try({
      try: () =>
        fs.readdirSync(dirPath, { withFileTypes: true }).map((entry) => ({
          name: entry.name,
          isDirectory: entry.isDirectory(),
        })),
      catch: localHistoryError('readDir', { path: dirPath }),
    }),
  openDatabase: (dbPath) =>
    Effect.tryPromise({
      try: async () => {
        const { Database } = await import('bun:sqlite');
        // Read-only SQLite connections include committed WAL pages without
        // checkpointing or mutating the harness-owned database.
        const db = new Database(dbPath, { readonly: true });
        return {
          all: <T extends object = Record<string, unknown>>(sql: string) =>
            Effect.try({
              try: () => db.query(sql).all() as T[],
              catch: localHistoryError('sqlite.all', { path: dbPath, sql }),
            }),
          close: Effect.try({
            try: () => db.close(),
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
): Effect.Effect<string[], LocalHistoryError> =>
  Effect.gen(function* () {
    if (!(yield* storage.exists(dirPath))) {
      return [];
    }

    const files: string[] = [];
    const walk = (currentPath: string): Effect.Effect<void, LocalHistoryError> =>
      Effect.gen(function* () {
        for (const entry of yield* storage.readDir(currentPath)) {
          const filePath = path.join(currentPath, entry.name);
          if (entry.isDirectory) {
            yield* walk(filePath);
          } else if (include(entry.name, filePath)) {
            files.push(filePath);
          }
        }
      });

    yield* walk(dirPath);
    return files;
  });
