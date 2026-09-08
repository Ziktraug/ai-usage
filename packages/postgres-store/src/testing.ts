import type { SpaceId } from '@ai-usage/platform-core/identity';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { pgTable, text } from 'drizzle-orm/pg-core';
import { Pool, type QueryResultRow } from 'pg';
import { asPlatformStoreError, PlatformStoreError } from './errors';
import { installPlatformStoreFactory, type PlatformStoreFactory } from './internal/factory-injection';
import { runPlatformMigrations } from './internal/migration-runner';
import { withPlatformSpaceTransaction } from './internal/space-transaction';
import type { PlatformMigrationRunOptions, PlatformMigrationRunResult } from './migrations';

const contractFixtureTable = pgTable('platform_contract_fixture', {
  id: text('id').primaryKey(),
  state: text('state').notNull(),
});

export type PlatformContractFixtureState = 'blocked' | 'ready';

export interface PlatformContractFixture {
  readonly id: string;
  readonly state: PlatformContractFixtureState;
}

interface TableNameRow extends QueryResultRow {
  readonly table_name: unknown;
}

export interface PlatformTestingDatabase {
  readonly close: () => Promise<void>;
  readonly createContractFixture: () => Promise<void>;
  readonly insertContractFixture: (fixture: { readonly id: string; readonly state: string }) => Promise<void>;
  readonly listPublicTables: () => Promise<readonly string[]>;
  readonly query: (sql: string, parameters?: readonly unknown[]) => Promise<void>;
  readonly queryRowCount: (sql: string, parameters?: readonly unknown[]) => Promise<number>;
  readonly queryRowCountInSpace: (spaceId: SpaceId, sql: string, parameters?: readonly unknown[]) => Promise<number>;
  readonly readContractFixture: (id: string) => Promise<PlatformContractFixture>;
  readonly runMigrations: (options: PlatformMigrationRunOptions) => Promise<PlatformMigrationRunResult>;
  readonly withSpaceContext: (
    spaceId: SpaceId,
    run: (query: (sql: string, parameters?: readonly unknown[]) => Promise<void>) => Promise<void>,
  ) => Promise<void>;
}

const mapContractFixture = (value: unknown): PlatformContractFixture => {
  if (!(typeof value === 'object' && value !== null && 'id' in value && 'state' in value)) {
    throw new PlatformStoreError('validation-failed', 'map-contract-fixture');
  }
  if (typeof value.id !== 'string' || (value.state !== 'blocked' && value.state !== 'ready')) {
    throw new PlatformStoreError('validation-failed', 'map-contract-fixture');
  }
  return { id: value.id, state: value.state };
};

export const createPlatformTestingDatabase = (databaseUrl: string): PlatformTestingDatabase => {
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  const database = drizzle({ client: pool });
  let closeOperation: Promise<void> | undefined;

  const testingDatabase: PlatformTestingDatabase = {
    close: (): Promise<void> => {
      closeOperation ??= pool.end().catch(() => {
        throw new PlatformStoreError('shutdown-failed', 'close-testing-database');
      });
      return closeOperation;
    },
    createContractFixture: async (): Promise<void> => {
      try {
        await pool.query(`
          CREATE TABLE platform_contract_fixture (
            id TEXT PRIMARY KEY,
            state TEXT NOT NULL
          )
        `);
      } catch (error) {
        throw asPlatformStoreError(error, 'migration-failed', 'create-contract-fixture');
      }
    },
    insertContractFixture: async (fixture: { readonly id: string; readonly state: string }): Promise<void> => {
      try {
        await pool.query('INSERT INTO platform_contract_fixture (id, state) VALUES ($1, $2)', [
          fixture.id,
          fixture.state,
        ]);
      } catch (error) {
        throw asPlatformStoreError(error, 'migration-failed', 'insert-contract-fixture');
      }
    },
    listPublicTables: async (): Promise<readonly string[]> => {
      try {
        const result = await pool.query<TableNameRow>(`
          SELECT table_name
          FROM information_schema.tables
          WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
          ORDER BY table_name ASC
        `);
        return result.rows.map((row) => {
          if (typeof row.table_name !== 'string') {
            throw new PlatformStoreError('validation-failed', 'map-public-table');
          }
          return row.table_name;
        });
      } catch (error) {
        throw asPlatformStoreError(error, 'readiness-failed', 'list-public-tables');
      }
    },
    query: async (sql: string, parameters: readonly unknown[] = []): Promise<void> => {
      await pool.query(sql, [...parameters]);
    },
    queryRowCount: async (sql: string, parameters: readonly unknown[] = []): Promise<number> => {
      const result = await pool.query(sql, [...parameters]);
      return result.rowCount ?? 0;
    },
    queryRowCountInSpace: (spaceId, sql, parameters = []): Promise<number> =>
      withPlatformSpaceTransaction(pool, spaceId, 'testing-space-row-count', async (client) => {
        const result = await client.query(sql, [...parameters]);
        return result.rowCount ?? 0;
      }),
    readContractFixture: async (id: string): Promise<PlatformContractFixture> => {
      try {
        const rows = await database
          .select({ id: contractFixtureTable.id, state: contractFixtureTable.state })
          .from(contractFixtureTable)
          .where(eq(contractFixtureTable.id, id))
          .limit(1);
        const row: unknown = rows[0];
        if (row === undefined) {
          throw new PlatformStoreError('validation-failed', 'read-contract-fixture');
        }
        return mapContractFixture(row);
      } catch (error) {
        throw asPlatformStoreError(error, 'readiness-failed', 'read-contract-fixture');
      }
    },
    runMigrations: (options: PlatformMigrationRunOptions): Promise<PlatformMigrationRunResult> =>
      runPlatformMigrations(pool, options),
    withSpaceContext: (spaceId, run): Promise<void> =>
      withPlatformSpaceTransaction(pool, spaceId, 'testing-space-context', (client) =>
        run((sql, parameters = []) => client.query(sql, [...parameters]).then(() => undefined)),
      ),
  };

  return Object.freeze(testingDatabase);
};

export const installPlatformStoreFactoryForTesting = (factory: PlatformStoreFactory): (() => void) =>
  installPlatformStoreFactory(factory);

export type { PlatformStoreFactory } from './internal/factory-injection';
export type {
  PlatformMigration,
  PlatformMigrationMode,
  PlatformMigrationRunOptions,
  PlatformMigrationRunResult,
  PlatformMigrationTrace,
} from './migrations';
