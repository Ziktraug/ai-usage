import path from 'node:path';
import { Effect } from 'effect';
import { LocalHistoryError } from './errors';
import type { LocalHistoryDatabase, LocalHistoryDirEntry, LocalHistoryStorage } from './local-history';

export class TestMemoryStorage implements LocalHistoryStorage {
  readonly home: string;
  private readonly files = new Map<string, string>();

  constructor(home = '/home/test') {
    this.home = home;
  }

  writeText(relativePath: string, content: string) {
    this.files.set(path.join(this.home, relativePath), content);
  }

  exists(filePath: string) {
    return Effect.succeed(
      this.files.has(filePath) ||
        [...this.files.keys()].some((storedPath) =>
          storedPath.startsWith(filePath.endsWith(path.sep) ? filePath : `${filePath}${path.sep}`),
        ),
    );
  }

  readText(filePath: string) {
    const content = this.files.get(filePath);
    if (content == null) {
      return Effect.fail(
        new LocalHistoryError({
          operation: 'readText',
          path: filePath,
          cause: new Error(`Missing fixture file: ${filePath}`),
        }),
      );
    }
    return Effect.succeed(content);
  }

  readDir(dirPath: string): Effect.Effect<LocalHistoryDirEntry[], LocalHistoryError> {
    const prefix = dirPath.endsWith(path.sep) ? dirPath : `${dirPath}${path.sep}`;
    const entries = new Map<string, boolean>();
    for (const filePath of this.files.keys()) {
      if (!filePath.startsWith(prefix)) continue;
      const rest = filePath.slice(prefix.length);
      const [name, ...remaining] = rest.split(path.sep);
      if (!name) continue;
      entries.set(name, remaining.length > 0);
    }
    return Effect.succeed(
      [...entries.entries()]
        .map(([name, isDirectory]) => ({ name, isDirectory }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    );
  }

  openDatabase(dbPath: string): Effect.Effect<LocalHistoryDatabase, LocalHistoryError> {
    return Effect.fail(
      new LocalHistoryError({
        operation: 'openDatabase',
        path: dbPath,
        cause: new Error('TestMemoryStorage does not implement SQLite fixtures'),
      }),
    );
  }
}
