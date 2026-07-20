import path from 'node:path';
import { Effect } from 'effect';
import { LocalHistoryError } from './errors';
import type {
  LocalHistoryDatabase,
  LocalHistoryDirEntry,
  LocalHistorySqlParameter,
  LocalHistoryStorage,
} from './local-history';

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

export class TestMemoryStorage implements LocalHistoryStorage {
  readonly home: string;
  private readonly files = new Map<string, string>();
  private readonly databases = new Map<string, Map<string, Record<string, unknown>[]>>();
  private readonly databaseRowsMatchers = new Map<string, TestDatabaseRowsMatcher[]>();

  constructor(home = '/home/test') {
    this.home = home;
  }

  writeText(relativePath: string, content: string) {
    this.files.set(path.join(this.home, relativePath), content);
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
    if (Buffer.byteLength(content, 'utf8') > maxBytes) {
      return Effect.fail(
        new LocalHistoryError({ operation: 'readText', path: filePath, cause: new Error('Fixture exceeds limit') }),
      );
    }
    return Effect.succeed(content);
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
    const content = this.files.get(filePath);
    if (content == null) {
      return Effect.fail(
        new LocalHistoryError({ operation: 'readLines', path: filePath, cause: new Error('Missing fixture file') }),
      );
    }
    return Effect.try({
      try: () => {
        if (Buffer.byteLength(content, 'utf8') > (limits.maxBytes ?? Number.POSITIVE_INFINITY)) {
          throw new Error('Fixture exceeds limit');
        }
        let lines = 0;
        for (const line of content.split(LINE_SEPARATOR)) {
          if (Buffer.byteLength(line, 'utf8') > (limits.maxLineBytes ?? Number.POSITIVE_INFINITY)) {
            throw new Error('Fixture line exceeds limit');
          }
          visit(line);
          lines++;
        }
        return { bytes: Buffer.byteLength(content, 'utf8'), lines };
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
          size: isDirectory ? 0 : Buffer.byteLength(this.files.get(path.join(dirPath, name)) ?? '', 'utf8'),
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
