import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Effect } from 'effect';
import {
  initializeUsageStore,
  migrateWriterDatabase,
  setUsageStoreConnectionsForTesting,
  withUsageStoreReader,
  withUsageStoreWriter,
} from './connections';
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

describe('the connection test seam', () => {
  const fixtureConnection =
    (label: string) =>
    <A>(_dbPath: string, _use: unknown): Effect.Effect<A, UsageStoreError> =>
      Effect.succeed(label as A);

  test('refuses a second registration for a path that already has one', () => {
    const dispose = setUsageStoreConnectionsForTesting('/fixture/seam-double.sqlite', {
      withUsageStoreReader: fixtureConnection('first'),
    });
    try {
      expect(() =>
        setUsageStoreConnectionsForTesting('/fixture/seam-double.sqlite', {
          withUsageStoreReader: fixtureConnection('second'),
        }),
      ).toThrow('Usage store test connections are already registered for /fixture/seam-double.sqlite');
    } finally {
      dispose();
    }
  });

  test('the disposer removes exactly its own registration', async () => {
    const disposeFirst = setUsageStoreConnectionsForTesting('/fixture/seam-first.sqlite', {
      withUsageStoreReader: fixtureConnection('first'),
    });
    const disposeSecond = setUsageStoreConnectionsForTesting('/fixture/seam-second.sqlite', {
      withUsageStoreWriter: fixtureConnection('second'),
    });
    try {
      disposeFirst();
      const reopened = await Effect.runPromise(
        Effect.result(withUsageStoreReader('/fixture/seam-first.sqlite', () => Effect.succeed('fixture'))),
      );
      expect(reopened._tag === 'Failure' ? reopened.failure.reason : reopened).toBe('store-missing');
      expect(
        await Effect.runPromise(withUsageStoreWriter('/fixture/seam-second.sqlite', () => Effect.succeed('real'))),
      ).toBe('second');
      // A disposer run again does not remove a later registration of the same path.
      const disposeAgain = setUsageStoreConnectionsForTesting('/fixture/seam-first.sqlite', {
        withUsageStoreReader: fixtureConnection('again'),
      });
      disposeFirst();
      expect(
        await Effect.runPromise(withUsageStoreReader('/fixture/seam-first.sqlite', () => Effect.succeed('real'))),
      ).toBe('again');
      disposeAgain();
    } finally {
      disposeSecond();
    }
  });

  test('a stale disposer does not remove a later registration of the same connections object', async () => {
    const connections = { withUsageStoreReader: fixtureConnection('shared') };
    const disposeStale = setUsageStoreConnectionsForTesting('/fixture/seam-shared.sqlite', connections);
    disposeStale();
    const disposeCurrent = setUsageStoreConnectionsForTesting('/fixture/seam-shared.sqlite', connections);
    try {
      disposeStale();
      expect(
        await Effect.runPromise(withUsageStoreReader('/fixture/seam-shared.sqlite', () => Effect.succeed('real'))),
      ).toBe('shared');
    } finally {
      disposeCurrent();
    }
    const reopened = await Effect.runPromise(
      Effect.result(withUsageStoreReader('/fixture/seam-shared.sqlite', () => Effect.succeed('fixture'))),
    );
    expect(reopened._tag === 'Failure' ? reopened.failure.reason : reopened).toBe('store-missing');
  });
});
