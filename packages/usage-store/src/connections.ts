import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Effect } from 'effect';
import {
  isBusyStoreCause,
  previewStaleError,
  UsageStoreError,
  type UsageStoreErrorReason,
  usageStoreError,
  usageStorePreviewReadError,
  usageStoreReadError,
} from './errors';
import {
  hasExactUsageLocalMachineSchema,
  migrate,
  USAGE_STORE_SCHEMA_VERSION,
  UsageStoreSchemaTooNewError,
} from './migration';
import {
  inspectPrivateStoreForConfirmation,
  type PrivateStoreConfirmationIdentity,
  preparePrivateStoreFile,
  revalidatePrivateStoreForConfirmation,
} from './private-storage';
import { assertServedReportSchema } from './served-revision';
import { createTrackedSqliteDatabase, type RawSqliteDatabase, type SqliteDatabase } from './sqlite-database';

const USAGE_STORE_READER_BUSY_TIMEOUT_MS = 1000;

export interface InitializeUsageStoreInput {
  readonly dbPath: string;
}

export interface CheckpointUsageStoreInput {
  readonly dbPath: string;
  readonly mode?: 'passive' | 'truncate';
}

export interface CheckpointUsageStoreResult {
  readonly busy: number;
  readonly checkpointedFrames: number;
  readonly logFrames: number;
}

export interface QuiesceUsageStoreForShutdownInput {
  readonly dbPath: string;
}

// Report captures and the served-query catalog sort the full revision payload (tens of MB).
// SQLite's default page cache (~2 MB) makes every such sort spill a temp B-tree to disk; a
// 64 MB cache plus in-memory temp storage keeps those sorts entirely in RAM.
const USAGE_STORE_PAGE_CACHE_KIB = 65_536;

const applySortCapacityPragmas = (db: SqliteDatabase): void => {
  db.exec(`PRAGMA cache_size = -${USAGE_STORE_PAGE_CACHE_KIB}`);
  db.exec('PRAGMA temp_store = MEMORY');
};

const ensureWalJournalMode = (db: SqliteDatabase): void => {
  const journalMode = db.query('PRAGMA journal_mode').get() as { journal_mode?: unknown };
  if (journalMode.journal_mode !== 'wal') {
    db.exec('PRAGMA journal_mode = WAL');
  }
};

const migrationFailureReason = (cause: unknown): UsageStoreErrorReason => {
  if (cause instanceof UsageStoreSchemaTooNewError) {
    return 'schema-too-new';
  }
  // Lock contention (another writer holding the store when `BEGIN IMMEDIATE` runs) is not a fault of the
  // migration: it keeps the `storage-failure` every other open failure carries.
  return isBusyStoreCause(cause) ? 'storage-failure' : 'migration-failure';
};

// `migrate()` knows neither the path nor the operation, so its failures are typed here: a newer store is
// `schema-too-new`, lock contention is `storage-failure`, any other failure raised while migrating is
// `migration-failure`. Exported for its test only; not part of the package interface.
export const migrateWriterDatabase = (db: SqliteDatabase, dbPath: string): boolean => {
  try {
    return migrate(db);
  } catch (cause) {
    throw usageStoreError('openUsageStoreWriter', dbPath, cause, migrationFailureReason(cause));
  }
};

const openUsageStoreWriterDatabase = (dbPath: string): Effect.Effect<SqliteDatabase, UsageStoreError> =>
  Effect.tryPromise({
    try: async () => {
      preparePrivateStoreFile(dbPath);
      const { Database } = await import('bun:sqlite');
      const db = createTrackedSqliteDatabase(new Database(dbPath) as unknown as RawSqliteDatabase);
      try {
        db.exec('PRAGMA busy_timeout = 5000');
        ensureWalJournalMode(db);
        // NORMAL only relaxes durability of the most recent commits; the store is rebuilt from
        // local session files, so WAL integrity is the property that matters here.
        db.exec('PRAGMA synchronous = NORMAL');
        applySortCapacityPragmas(db);
        db.exec('PRAGMA foreign_keys = ON');
        const schemaChanged = migrateWriterDatabase(db, dbPath);
        if (schemaChanged) {
          db.exec('PRAGMA wal_checkpoint(PASSIVE)');
        }
        db.clearStatements();
        preparePrivateStoreFile(dbPath);
        return db;
      } catch (cause) {
        try {
          db.close(true);
        } catch {
          // The setup or migration failure remains authoritative.
        }
        throw cause;
      }
    },
    catch: (cause) =>
      cause instanceof UsageStoreError
        ? cause
        : usageStoreError('openUsageStoreWriter', dbPath, cause, 'storage-failure'),
  });

const assertUsageLocalMachineSchema = (db: SqliteDatabase, dbPath: string, operation: string): void => {
  const columns = db.query('PRAGMA table_info(usage_local_machine)').all() as Array<{
    name: string;
    notnull: number;
    pk: number;
    type: string;
  }>;
  const expected = [
    { name: 'singleton', notnull: 0, pk: 1, type: 'INTEGER' },
    { name: 'machine_id', notnull: 1, pk: 0, type: 'TEXT' },
    { name: 'machine_label', notnull: 1, pk: 0, type: 'TEXT' },
    { name: 'updated_at', notnull: 1, pk: 0, type: 'TEXT' },
  ];
  const compatible =
    columns.length === expected.length &&
    columns.every((column, index) => {
      const expectedColumn = expected[index];
      return (
        expectedColumn !== undefined &&
        column.name === expectedColumn.name &&
        column.notnull === expectedColumn.notnull &&
        column.pk === expectedColumn.pk &&
        column.type.toUpperCase() === expectedColumn.type
      );
    });
  if (!(compatible && hasExactUsageLocalMachineSchema(db))) {
    throw usageStoreError(operation, dbPath, 'The local machine projection schema is invalid.', 'corrupt');
  }
};

interface OpenReadOnlyUsageStoreOptions {
  readonly immutable: boolean;
  readonly operation: string;
}

const openValidatedReadOnlyUsageStore = async (
  dbPath: string,
  options: OpenReadOnlyUsageStoreOptions,
): Promise<SqliteDatabase> => {
  const identity = inspectPrivateStoreForConfirmation(dbPath);
  const { constants, Database } = await import('bun:sqlite');
  // Bun's options object does not expose SQLITE_OPEN_URI or NOFOLLOW, so pass the documented SQLite flags
  // directly and use an explicit mode=ro URI. Ordinary SQLite locking keeps reader snapshots consistent.
  // biome-ignore lint/suspicious/noBitwiseOperators: SQLite open flags are a documented bitmask API.
  const flags = constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_URI | constants.SQLITE_OPEN_NOFOLLOW;
  // `SQLITE_OPEN_NOFOLLOW` rejects any symlink component, not only a symlink at
  // the database leaf. macOS exposes its private temporary directory through
  // `/var` -> `/private/var`, so canonicalize the parent of the already-inspected
  // file before opening it. Keeping the leaf name out of realpath means NOFOLLOW
  // still rejects a leaf swapped to a symlink. The identity revalidation below
  // binds the original path to the exact device/inode inspected above.
  const canonicalParent = fs.realpathSync.native(path.dirname(dbPath));
  const fileUrl = pathToFileURL(path.join(canonicalParent, path.basename(dbPath)));
  fileUrl.searchParams.set('mode', 'ro');
  if (options.immutable) {
    // With no committed WAL frames, immutable mode prevents a preview from creating WAL/SHM sidecars.
    // The confirmation token detects a concurrent writer before the eventual mutation.
    fileUrl.searchParams.set('immutable', '1');
  }
  const db = createTrackedSqliteDatabase(new Database(fileUrl.href, flags) as unknown as RawSqliteDatabase);
  try {
    db.exec(`PRAGMA busy_timeout = ${USAGE_STORE_READER_BUSY_TIMEOUT_MS}`);
    applySortCapacityPragmas(db);
    db.exec('PRAGMA query_only = ON');
    db.exec('PRAGMA foreign_keys = ON');
    revalidatePrivateStoreForConfirmation(dbPath, identity);
    const schemaVersion = db.query('PRAGMA user_version').get() as { user_version: number };
    if (schemaVersion.user_version < USAGE_STORE_SCHEMA_VERSION) {
      throw usageStoreError(
        options.operation,
        dbPath,
        `Usage store schema ${schemaVersion.user_version} is older than required schema ${USAGE_STORE_SCHEMA_VERSION}`,
        'schema-too-old',
      );
    }
    if (schemaVersion.user_version > USAGE_STORE_SCHEMA_VERSION) {
      throw usageStoreError(
        options.operation,
        dbPath,
        `Usage store schema ${schemaVersion.user_version} is newer than supported schema ${USAGE_STORE_SCHEMA_VERSION}`,
        'schema-too-new',
      );
    }
    assertUsageLocalMachineSchema(db, dbPath, options.operation);
    assertServedReportSchema(db);
    db.clearStatements();
    return db;
  } catch (cause) {
    try {
      db.close(true);
    } catch {
      // The setup or validation failure remains authoritative.
    }
    throw cause;
  }
};

const openUsageStoreReaderDatabase = (dbPath: string): Effect.Effect<SqliteDatabase, UsageStoreError> =>
  Effect.tryPromise({
    try: async () => {
      const databaseStat = fs.lstatSync(dbPath, { throwIfNoEntry: false });
      if (!databaseStat) {
        throw usageStoreError('openUsageStoreReader', dbPath, 'Usage store does not exist', 'store-missing');
      }
      return await openValidatedReadOnlyUsageStore(dbPath, {
        immutable: false,
        operation: 'openUsageStoreReader',
      });
    },
    catch: (cause) => usageStoreReadError('openUsageStoreReader', dbPath, cause),
  });

const openUsageStorePreviewDatabase = (dbPath: string): Effect.Effect<SqliteDatabase, UsageStoreError> =>
  Effect.tryPromise({
    try: async () => {
      const walExists = fs.lstatSync(`${dbPath}-wal`, { throwIfNoEntry: false }) !== undefined;
      const sharedMemoryExists = fs.lstatSync(`${dbPath}-shm`, { throwIfNoEntry: false }) !== undefined;
      if (walExists && !sharedMemoryExists) {
        throw usageStoreError(
          'openUsageStorePreview',
          dbPath,
          'Cannot preview a WAL-backed usage store without a pre-existing shared-memory sidecar.',
          'preview-unavailable',
        );
      }
      return await openValidatedReadOnlyUsageStore(dbPath, {
        immutable: !walExists,
        operation: 'openUsageStorePreview',
      });
    },
    catch: (cause) => usageStorePreviewReadError('openUsageStorePreview', dbPath, cause),
  });

interface ConfirmationUsageStoreResource {
  readonly db: SqliteDatabase;
  readonly identity: PrivateStoreConfirmationIdentity;
}

const openConfirmationUsageStoreDatabase = (
  dbPath: string,
): Effect.Effect<ConfirmationUsageStoreResource, UsageStoreError> =>
  Effect.tryPromise({
    try: async () => {
      const identity = inspectPrivateStoreForConfirmation(dbPath);
      const { Database } = await import('bun:sqlite');
      const db = createTrackedSqliteDatabase(
        new Database(dbPath, { create: false, readwrite: true }) as unknown as RawSqliteDatabase,
      );
      try {
        db.exec('PRAGMA busy_timeout = 5000');
        db.exec('PRAGMA synchronous = NORMAL');
        applySortCapacityPragmas(db);
        db.exec('PRAGMA foreign_keys = ON');
        revalidatePrivateStoreForConfirmation(dbPath, identity);
        return { db, identity };
      } catch (cause) {
        try {
          db.close(true);
        } catch {
          // The validation or setup failure remains authoritative.
        }
        throw cause;
      }
    },
    catch: (cause) => (cause instanceof UsageStoreError ? cause : previewStaleError(cause)),
  });

const closeUsageStoreDatabase = (dbPath: string, db: SqliteDatabase): Effect.Effect<void> =>
  Effect.try({
    try: () => db.close(true),
    catch: (cause) => usageStoreError('closeUsageStore', dbPath, cause, 'storage-failure'),
  }).pipe(Effect.ignore);

const closeUsageStoreWriterDatabase = (dbPath: string, db: SqliteDatabase): Effect.Effect<void> =>
  Effect.try({
    try: () => db.close(true),
    catch: (cause) => usageStoreError('closeUsageStoreWriter', dbPath, cause, 'storage-failure'),
  }).pipe(Effect.ignore);

type UsageStoreConnection = <A>(
  dbPath: string,
  use: (db: SqliteDatabase) => Effect.Effect<A, UsageStoreError>,
) => Effect.Effect<A, UsageStoreError>;

/** A fixture's own connections for one store path: an in-memory or reduced-schema database, counted opens. */
export interface UsageStoreConnectionsForTesting {
  readonly withUsageStoreReader?: UsageStoreConnection;
  readonly withUsageStoreWriter?: UsageStoreConnection;
}

const connectionsForTesting = new Map<string, UsageStoreConnectionsForTesting>();

/** Test seam: route the reader and writer of one store path through a fixture. Package internal. */
export const setUsageStoreConnectionsForTesting = (
  dbPath: string,
  connections: UsageStoreConnectionsForTesting,
): void => {
  connectionsForTesting.set(dbPath, connections);
};

export const resetUsageStoreConnectionsForTesting = (): void => {
  connectionsForTesting.clear();
};

export const withUsageStoreWriter = <A>(
  dbPath: string,
  use: (db: SqliteDatabase) => Effect.Effect<A, UsageStoreError>,
): Effect.Effect<A, UsageStoreError> => {
  const fixture = connectionsForTesting.get(dbPath)?.withUsageStoreWriter;
  if (fixture) {
    return fixture(dbPath, use);
  }
  return Effect.acquireUseRelease(openUsageStoreWriterDatabase(dbPath), use, (db) =>
    closeUsageStoreWriterDatabase(dbPath, db),
  );
};

export const withUsageStoreReader = <A>(
  dbPath: string,
  use: (db: SqliteDatabase) => Effect.Effect<A, UsageStoreError>,
): Effect.Effect<A, UsageStoreError> => {
  const fixture = connectionsForTesting.get(dbPath)?.withUsageStoreReader;
  if (fixture) {
    return fixture(dbPath, use);
  }
  return Effect.acquireUseRelease(openUsageStoreReaderDatabase(dbPath), use, (db) =>
    closeUsageStoreDatabase(dbPath, db),
  );
};

const withUsageStorePreviewReader = <A>(
  dbPath: string,
  use: (db: SqliteDatabase) => Effect.Effect<A, UsageStoreError>,
): Effect.Effect<A, UsageStoreError> =>
  Effect.acquireUseRelease(openUsageStorePreviewDatabase(dbPath), use, (db) => closeUsageStoreDatabase(dbPath, db));

export const withUsageStorePreview = <A>(
  dbPath: string,
  use: (db: SqliteDatabase) => Effect.Effect<A, UsageStoreError>,
): Effect.Effect<A, UsageStoreError> =>
  Effect.try({
    try: () => fs.lstatSync(dbPath, { throwIfNoEntry: false }),
    catch: (cause) => usageStoreError('previewPeerMergeBundle', dbPath, cause, 'storage-failure'),
  }).pipe(
    Effect.flatMap((databaseStat) =>
      databaseStat ? withUsageStorePreviewReader(dbPath, use) : withUsageStoreWriter(dbPath, use),
    ),
  );

export const withConfirmationUsageStore = <A>(
  dbPath: string,
  use: (resource: ConfirmationUsageStoreResource) => Effect.Effect<A, UsageStoreError>,
): Effect.Effect<A, UsageStoreError> =>
  Effect.acquireUseRelease(openConfirmationUsageStoreDatabase(dbPath), use, ({ db }) =>
    closeUsageStoreWriterDatabase(dbPath, db),
  );

export const initializeUsageStore = (input: InitializeUsageStoreInput): Effect.Effect<number, UsageStoreError> =>
  withUsageStoreWriter(input.dbPath, (database) =>
    Effect.sync(() => {
      const record = database.query('PRAGMA user_version').get() as { user_version?: unknown } | null;
      if (record?.user_version !== USAGE_STORE_SCHEMA_VERSION) {
        throw new Error('Usage store migration did not install the expected schema version');
      }
      return USAGE_STORE_SCHEMA_VERSION;
    }),
  );

export const checkpointUsageStore = (
  input: CheckpointUsageStoreInput,
): Effect.Effect<CheckpointUsageStoreResult, UsageStoreError> =>
  withUsageStoreWriter(input.dbPath, (database) =>
    Effect.try({
      try: () => {
        const checkpointMode = input.mode === 'truncate' ? 'TRUNCATE' : 'PASSIVE';
        const record = database.query(`PRAGMA wal_checkpoint(${checkpointMode})`).get() as {
          busy?: unknown;
          checkpointed?: unknown;
          log?: unknown;
        } | null;
        const busy = record?.busy;
        const checkpointed = record?.checkpointed;
        const log = record?.log;
        if (!(Number.isSafeInteger(busy) && Number.isSafeInteger(checkpointed) && Number.isSafeInteger(log))) {
          throw new Error('SQLite returned an invalid WAL checkpoint result');
        }
        return {
          busy: Number(busy),
          checkpointedFrames: Number(checkpointed),
          logFrames: Number(log),
        };
      },
      catch: (cause) => usageStoreError('checkpointUsageStore', input.dbPath, cause, 'storage-failure'),
    }),
  );

export const quiesceUsageStoreForShutdown = (
  input: QuiesceUsageStoreForShutdownInput,
): Effect.Effect<void, UsageStoreError> =>
  withUsageStoreWriter(input.dbPath, (database) =>
    Effect.try({
      try: () => {
        database.query('PRAGMA wal_checkpoint(TRUNCATE)').get();
        database.clearStatements();
        const journalMode = database.query('PRAGMA journal_mode = DELETE').get() as {
          journal_mode?: unknown;
        } | null;
        if (journalMode?.journal_mode !== 'delete') {
          throw new Error('SQLite did not enter DELETE journal mode during store quiescence');
        }
      },
      catch: (cause) => usageStoreError('quiesceUsageStoreForShutdown', input.dbPath, cause, 'storage-failure'),
    }),
  );
