import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { asPlatformStoreError, PlatformStoreError } from '../errors';
import {
  PLATFORM_MIGRATIONS,
  type PlatformMigration,
  type PlatformMigrationRunOptions,
  type PlatformMigrationRunResult,
  validatePlatformMigrations,
} from '../migrations';

const MIGRATION_LOCK_NAMESPACE = 1_095_325_523;
const MIGRATION_LOCK_ID = 1_347_177_812;

const createLedgerSql = `
  CREATE TABLE IF NOT EXISTS platform_migrations (
    id TEXT PRIMARY KEY,
    ordinal INTEGER NOT NULL UNIQUE,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )
`;

interface AppliedMigrationRow extends QueryResultRow {
  readonly id: unknown;
  readonly ordinal: unknown;
}

interface AdvisoryUnlockRow extends QueryResultRow {
  readonly unlocked: unknown;
}

interface AppliedMigration {
  readonly id: string;
  readonly ordinal: number;
}

const mapAppliedRows = (rows: readonly AppliedMigrationRow[]): readonly AppliedMigration[] =>
  rows.map((row) => {
    if (typeof row.id !== 'string' || typeof row.ordinal !== 'number' || !Number.isSafeInteger(row.ordinal)) {
      throw new PlatformStoreError('migration-incompatible', 'read-migration-ledger');
    }
    return { id: row.id, ordinal: row.ordinal };
  });

const assertAppliedPrefix = (applied: readonly AppliedMigration[], compiled: readonly PlatformMigration[]): void => {
  if (applied.length > compiled.length) {
    throw new PlatformStoreError('migration-incompatible', 'verify-migration-ledger');
  }
  for (const [index, row] of applied.entries()) {
    const expected = compiled[index];
    if (!expected || row.id !== expected.id || row.ordinal !== expected.ordinal) {
      throw new PlatformStoreError('migration-incompatible', 'verify-migration-ledger');
    }
  }
};

const acquireMigrationLock = async (client: PoolClient): Promise<void> => {
  await client.query('SELECT pg_advisory_lock($1, $2)', [MIGRATION_LOCK_NAMESPACE, MIGRATION_LOCK_ID]);
};

const releaseMigrationLock = async (client: PoolClient): Promise<void> => {
  const result = await client.query<AdvisoryUnlockRow>('SELECT pg_advisory_unlock($1, $2) AS unlocked', [
    MIGRATION_LOCK_NAMESPACE,
    MIGRATION_LOCK_ID,
  ]);
  if (result.rows[0]?.unlocked !== true) {
    throw new PlatformStoreError('migration-failed', 'release-migration-lock');
  }
};

const applyMigration = async (client: PoolClient, migration: PlatformMigration): Promise<void> => {
  await client.query('BEGIN');
  try {
    await client.query(migration.up);
    await client.query('INSERT INTO platform_migrations (id, ordinal) VALUES ($1, $2)', [
      migration.id,
      migration.ordinal,
    ]);
    await client.query('COMMIT');
  } catch {
    await client.query('ROLLBACK').catch(() => undefined);
    throw new PlatformStoreError('migration-failed', 'apply-migration');
  }
};

const runWithClient = async (
  client: PoolClient,
  compiled: readonly PlatformMigration[],
  options: PlatformMigrationRunOptions,
): Promise<PlatformMigrationRunResult> => {
  let lockHeld = false;
  let result: PlatformMigrationRunResult | undefined;
  let failure: unknown;

  try {
    await acquireMigrationLock(client);
    lockHeld = true;
    options.onTrace?.({ type: 'lock-acquired' });
    await client.query(createLedgerSql);

    const ledger = await client.query<AppliedMigrationRow>(
      'SELECT id, ordinal FROM platform_migrations ORDER BY ordinal ASC',
    );
    const applied = mapAppliedRows(ledger.rows);
    assertAppliedPrefix(applied, compiled);

    const pending = compiled.slice(applied.length);
    if (options.mode === 'verify' && pending.length > 0) {
      throw new PlatformStoreError('migration-required', 'verify-migrations');
    }

    const appliedIds: string[] = [];
    for (const migration of pending) {
      await applyMigration(client, migration);
      appliedIds.push(migration.id);
      options.onTrace?.({ id: migration.id, ordinal: migration.ordinal, type: 'migration-applied' });
    }

    result = {
      appliedIds,
      currentOrdinal: compiled.at(-1)?.ordinal ?? 0,
    };
  } catch (error) {
    failure = asPlatformStoreError(error, 'migration-failed', 'run-migrations');
  } finally {
    if (lockHeld) {
      try {
        await releaseMigrationLock(client);
        options.onTrace?.({ type: 'lock-released' });
      } catch (error) {
        failure ??= asPlatformStoreError(error, 'migration-failed', 'release-migration-lock');
      }
    }
  }

  if (failure) {
    throw failure;
  }
  if (!result) {
    throw new PlatformStoreError('migration-failed', 'run-migrations');
  }
  return result;
};

export const runPlatformMigrations = async (
  pool: Pool,
  options: PlatformMigrationRunOptions,
): Promise<PlatformMigrationRunResult> => {
  const compiled = validatePlatformMigrations(options.migrations ?? PLATFORM_MIGRATIONS);
  let client: PoolClient;
  try {
    client = await pool.connect();
  } catch {
    throw new PlatformStoreError('connection-failed', 'connect-for-migrations');
  }

  try {
    return await runWithClient(client, compiled, options);
  } finally {
    client.release();
  }
};
