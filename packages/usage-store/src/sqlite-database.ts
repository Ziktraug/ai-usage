export interface SqliteStatement {
  all: (...params: unknown[]) => unknown[];
  finalize: () => void;
  get: (...params: unknown[]) => unknown;
  iterate: (...params: unknown[]) => IterableIterator<unknown>;
  run: (...params: unknown[]) => unknown;
}

export interface SqliteDatabase {
  clearStatements: () => void;
  close: (throwOnError?: boolean) => void;
  exec: (sql: string) => unknown;
  readonly inTransaction: boolean;
  query: (sql: string) => SqliteStatement;
}

export interface RawSqliteDatabase {
  clearQueryCache: () => void;
  close: (throwOnError?: boolean) => void;
  exec: (sql: string) => unknown;
  readonly inTransaction: boolean;
  query: (sql: string) => SqliteStatement;
}

export const createTrackedSqliteDatabase = (database: RawSqliteDatabase): SqliteDatabase => {
  const statements = new Set<SqliteStatement>();
  const clearStatements = (): void => {
    let firstError: unknown;
    for (const statement of statements) {
      try {
        statement.finalize();
      } catch (cause) {
        firstError ??= cause;
      }
    }
    statements.clear();
    database.clearQueryCache();
    if (firstError !== undefined) {
      throw firstError;
    }
  };
  return {
    clearStatements,
    close: (throwOnError) => {
      clearStatements();
      database.close(throwOnError);
    },
    exec: (sql) => database.exec(sql),
    get inTransaction() {
      return database.inTransaction;
    },
    query: (sql) => {
      const statement = database.query(sql);
      statements.add(statement);
      return statement;
    },
  };
};
