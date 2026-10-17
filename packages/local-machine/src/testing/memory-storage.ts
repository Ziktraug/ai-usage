import path from 'node:path';
import { LocalHistoryError } from '@ai-usage/local-machine/errors';
import type {
  LocalHistoryDatabase,
  LocalHistoryDirEntry,
  LocalHistorySqlParameter,
  LocalHistoryStorage,
} from '@ai-usage/local-machine/local-history';
import { Effect } from 'effect';

const LINE_SEPARATOR = /\r?\n/;

const databaseParameterKey = (parameter: LocalHistorySqlParameter): unknown => {
  if (typeof parameter === 'bigint') {
    return { type: 'bigint', value: parameter.toString() };
  }
  if (parameter instanceof Uint8Array) {
    return { type: 'bytes', value: [...parameter] };
  }
  return { type: typeof parameter, value: parameter };
};

const databaseStatementKey = (sql: string, parameters: readonly LocalHistorySqlParameter[]): string =>
  JSON.stringify([sql, parameters.map(databaseParameterKey)]);

const databaseParametersKey = (parameters: readonly LocalHistorySqlParameter[]): string =>
  JSON.stringify(parameters.map(databaseParameterKey));

export interface TestSqlMatcher {
  includes: readonly string[];
}

interface TestDatabaseRowsMatcher extends TestSqlMatcher {
  parametersKey: string;
  rows: Record<string, unknown>[];
}

const fixtureByteLength = (content: string | Uint8Array): number =>
  typeof content === 'string' ? Buffer.byteLength(content, 'utf8') : content.byteLength;

const decodeFixture = (content: string | Uint8Array): string =>
  typeof content === 'string' ? content : new TextDecoder('utf-8', { fatal: true }).decode(content);

export class TestMemoryStorage implements LocalHistoryStorage {
  readonly home: string;
  private readonly files = new Map<string, string | Uint8Array>();
  private readonly databases = new Map<string, Map<string, Record<string, unknown>[]>>();
  private readonly databaseRowsMatchers = new Map<string, TestDatabaseRowsMatcher[]>();

  constructor(home = '/home/test') {
    this.home = home;
  }

  writeText(relativePath: string, content: string) {
    this.files.set(path.join(this.home, relativePath), content);
  }

  /** A binary fixture, such as a zstd archive of newline-delimited text. */
  writeBytes(relativePath: string, bytes: Uint8Array) {
    this.files.set(path.join(this.home, relativePath), bytes);
  }

  writeDatabaseRows(
    relativePath: string,
    sql: string | TestSqlMatcher,
    rows: Record<string, unknown>[],
    parameters: readonly LocalHistorySqlParameter[] = [],
  ) {
    const dbPath = path.join(this.home, relativePath);
    const database = this.databases.get(dbPath) ?? new Map<string, Record<string, unknown>[]>();
    this.databases.set(dbPath, database);
    if (typeof sql === 'string') {
      database.set(databaseStatementKey(sql, parameters), rows);
      return;
    }
    if (sql.includes.length === 0) {
      throw new Error('A database SQL matcher must contain at least one required fragment');
    }
    const matchers = this.databaseRowsMatchers.get(dbPath) ?? [];
    matchers.push({ includes: [...sql.includes], parametersKey: databaseParametersKey(parameters), rows });
    this.databaseRowsMatchers.set(dbPath, matchers);
  }

  exists(filePath: string) {
    return Effect.succeed(
      this.files.has(filePath) ||
        this.databases.has(filePath) ||
        [...this.files.keys(), ...this.databases.keys()].some((storedPath) =>
          storedPath.startsWith(filePath.endsWith(path.sep) ? filePath : `${filePath}${path.sep}`),
        ),
    );
  }

  readText(filePath: string, maxBytes = Number.POSITIVE_INFINITY) {
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
    if (fixtureByteLength(content) > maxBytes) {
      return Effect.fail(
        new LocalHistoryError({ operation: 'readText', path: filePath, cause: new Error('Fixture exceeds limit') }),
      );
    }
    // Like the real reader, the text read never decompresses: a byte fixture
    // is decoded as it is stored.
    return Effect.try({
      try: () => decodeFixture(content),
      catch: (cause) => new LocalHistoryError({ operation: 'readText', path: filePath, cause }),
    });
  }

  readConfigText(filePath: string, maxBytes?: number) {
    // The in-memory fixture store has no symlinks, so config reads behave
    // exactly like plain reads.
    return this.readText(filePath, maxBytes);
  }

  readLines(
    filePath: string,
    visit: (line: string) => void,
    limits: { maxBytes?: number; maxLineBytes?: number } = {},
  ) {
    const stored = this.files.get(filePath);
    if (stored == null) {
      return Effect.fail(
        new LocalHistoryError({ operation: 'readLines', path: filePath, cause: new Error('Missing fixture file') }),
      );
    }
    // Mirrors the real reader: a `.zst` path is a zstd archive of the text,
    // the limits apply to the decompressed bytes, and a corrupt archive is its
    // own typed failure rather than a plain read error. The double trusts
    // `Bun.zstdDecompressSync` and does not walk the frame layout.
    let bytes: string | Uint8Array = stored;
    if (filePath.endsWith('.zst')) {
      const archive = typeof stored === 'string' ? Buffer.from(stored, 'utf8') : stored;
      // `Bun.zstdDecompressSync` of empty input returns an empty buffer, but
      // the real reader refuses a zero-byte archive as damage.
      if (archive.byteLength === 0) {
        return Effect.fail(
          new LocalHistoryError({
            operation: 'readLines.decompress',
            path: filePath,
            cause: new Error('Missing zstd frame magic number'),
          }),
        );
      }
      try {
        bytes = Bun.zstdDecompressSync(archive);
      } catch (cause) {
        return Effect.fail(new LocalHistoryError({ operation: 'readLines.decompress', path: filePath, cause }));
      }
    }
    return Effect.try({
      try: () => {
        if (fixtureByteLength(bytes) > (limits.maxBytes ?? Number.POSITIVE_INFINITY)) {
          throw new Error('Fixture exceeds limit');
        }
        const content = decodeFixture(bytes);
        let lines = 0;
        let oversizedLines = 0;
        for (const line of content.split(LINE_SEPARATOR)) {
          // Mirrors the real reader: an oversized record is dropped and
          // counted, never thrown.
          if (Buffer.byteLength(line, 'utf8') > (limits.maxLineBytes ?? Number.POSITIVE_INFINITY)) {
            oversizedLines++;
            continue;
          }
          visit(line);
          lines++;
        }
        return { bytes: Buffer.byteLength(content, 'utf8'), lines, oversizedLines };
      },
      catch: (cause) => new LocalHistoryError({ operation: 'readLines', path: filePath, cause }),
    });
  }

  readDir(dirPath: string): Effect.Effect<LocalHistoryDirEntry[], LocalHistoryError> {
    const prefix = dirPath.endsWith(path.sep) ? dirPath : `${dirPath}${path.sep}`;
    const entries = new Map<string, boolean>();
    for (const filePath of [...this.files.keys(), ...this.databases.keys()]) {
      if (!filePath.startsWith(prefix)) {
        continue;
      }
      const rest = filePath.slice(prefix.length);
      const [name, ...remaining] = rest.split(path.sep);
      if (!name) {
        continue;
      }
      entries.set(name, remaining.length > 0);
    }
    return Effect.succeed(
      [...entries.entries()]
        .map(([name, isDirectory]) => ({
          name,
          isDirectory,
          isRegularFile: !isDirectory,
          size: isDirectory ? 0 : fixtureByteLength(this.files.get(path.join(dirPath, name)) ?? ''),
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    );
  }

  openDatabase(dbPath: string): Effect.Effect<LocalHistoryDatabase, LocalHistoryError> {
    const database = this.databases.get(dbPath);
    if (!database) {
      return Effect.fail(
        new LocalHistoryError({
          operation: 'openDatabase',
          path: dbPath,
          cause: new Error(`Missing fixture database: ${dbPath}`),
        }),
      );
    }

    return Effect.succeed({
      all: <T extends object = Record<string, unknown>>(
        sql: string,
        parameters: readonly LocalHistorySqlParameter[] = [],
      ) => {
        const exactRows = database.get(databaseStatementKey(sql, parameters));
        const matchingRows = (this.databaseRowsMatchers.get(dbPath) ?? []).filter(
          (fixture) =>
            fixture.parametersKey === databaseParametersKey(parameters) &&
            fixture.includes.every((fragment) => sql.includes(fragment)),
        );
        if (exactRows === undefined && matchingRows.length > 1) {
          return Effect.fail(
            new LocalHistoryError({
              operation: 'sqlite.all',
              path: dbPath,
              sql,
              cause: new Error(`Multiple fixture row sets match SQL: ${sql}`),
            }),
          );
        }
        const rows = exactRows ?? matchingRows[0]?.rows;
        if (!rows) {
          return Effect.fail(
            new LocalHistoryError({
              operation: 'sqlite.all',
              path: dbPath,
              sql,
              cause: new Error(`Missing fixture rows for SQL: ${sql}`),
            }),
          );
        }
        return Effect.succeed(rows as T[]);
      },
      close: Effect.succeed(undefined),
    });
  }
}
