import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import { asPlatformStoreError, PlatformStoreError } from '../errors';
import type { PlatformReadiness, PlatformStoreReader } from '../reader';
import { PLATFORM_SCHEMA_METADATA_KEY, PLATFORM_SCHEMA_VERSION } from '../schema';
import { platformSchemaMetadataTable } from './schema-definition';

const decimalIntegerPattern = /^\d+$/u;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const mapReadinessRow = (row: unknown): PlatformReadiness => {
  if (!isRecord(row) || row.key !== PLATFORM_SCHEMA_METADATA_KEY || typeof row.value !== 'string') {
    throw new PlatformStoreError('validation-failed', 'map-schema-metadata');
  }
  if (!(row.updatedAt instanceof Date) || Number.isNaN(row.updatedAt.getTime())) {
    throw new PlatformStoreError('validation-failed', 'map-schema-metadata');
  }
  if (!decimalIntegerPattern.test(row.value)) {
    throw new PlatformStoreError('validation-failed', 'map-schema-metadata');
  }
  const schemaVersion = Number(row.value);
  if (schemaVersion !== PLATFORM_SCHEMA_VERSION) {
    throw new PlatformStoreError('migration-incompatible', 'verify-schema-metadata');
  }
  return { schemaVersion, status: 'ready' };
};

export const createPlatformStoreReader = (pool: Pool): PlatformStoreReader => {
  const database = drizzle({ client: pool });

  return Object.freeze({
    checkReadiness: async (): Promise<PlatformReadiness> => {
      try {
        await pool.query('SELECT 1');
        const rows = await database
          .select({
            key: platformSchemaMetadataTable.key,
            updatedAt: platformSchemaMetadataTable.updatedAt,
            value: platformSchemaMetadataTable.value,
          })
          .from(platformSchemaMetadataTable)
          .where(eq(platformSchemaMetadataTable.key, PLATFORM_SCHEMA_METADATA_KEY))
          .limit(1);
        const row: unknown = rows[0];
        if (row === undefined) {
          throw new PlatformStoreError('migration-incompatible', 'read-schema-metadata');
        }
        return mapReadinessRow(row);
      } catch (error) {
        throw asPlatformStoreError(error, 'readiness-failed', 'check-store-readiness');
      }
    },
  });
};
