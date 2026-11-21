import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Effect } from 'effect';
import { initializeUsageStore, migrateWriterDatabase } from './connections';
import { UsageStoreError } from './errors';
import { createTrackedSqliteDatabase, type RawSqliteDatabase } from './sqlite-database';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const createStore = async (): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), 'usage-store-writer-busy-'));
  temporaryRoots.push(root);
  const dbPath = path.join(root, 'usage-store.sqlite');
  await Effect.runPromise(initializeUsageStore({ dbPath }));
  return dbPath;
};

const failureOf = (run: () => unknown): unknown => {
  try {
    run();
  } catch (cause) {
    return cause;
  }
  throw new Error('Expected the migration to fail.');
};

// The seam is the writer's migration boundary itself, not a full writer open: the open sets a 5 s busy
// timeout, so meeting real contention there would cost 5 s per run. A connection with no busy timeout
// meets the same SQLITE_BUSY on `migrate()`'s `BEGIN IMMEDIATE` at once.
describe('the writer migration boundary', () => {
  test('lock contention on BEGIN IMMEDIATE keeps storage-failure, not migration-failure', async () => {
    const dbPath = await createStore();
    const holder = new Database(dbPath, { create: false, readwrite: true });
    const contender = createTrackedSqliteDatabase(
      new Database(dbPath, { create: false, readwrite: true }) as unknown as RawSqliteDatabase,
    );
    try {
      contender.exec('PRAGMA busy_timeout = 0');
      holder.exec('BEGIN IMMEDIATE');
      const failure = failureOf(() => migrateWriterDatabase(contender, dbPath));
      expect(failure).toBeInstanceOf(UsageStoreError);
      expect(failure).toMatchObject({
        operation: 'openUsageStoreWriter',
        reason: 'storage-failure',
        cause: expect.objectContaining({ code: 'SQLITE_BUSY' }),
      });
      holder.exec('ROLLBACK');
    } finally {
      contender.close(true);
      holder.close(true);
    }
  });

  test('a failure raised by the migration itself stays migration-failure', async () => {
    const dbPath = await createStore();
    const db = createTrackedSqliteDatabase(
      new Database(dbPath, { create: false, readwrite: true }) as unknown as RawSqliteDatabase,
    );
    try {
      db.exec('DROP TABLE usage_local_machine');
      db.exec('CREATE TABLE usage_local_machine (singleton INTEGER PRIMARY KEY)');
      const failure = failureOf(() => migrateWriterDatabase(db, dbPath));
      expect(failure).toMatchObject({ operation: 'openUsageStoreWriter', reason: 'migration-failure' });
    } finally {
      db.close(true);
    }
  });
});
