import type { SpaceId } from '@ai-usage/platform-core/identity';
import type { Pool, PoolClient } from 'pg';
import { asPlatformStoreError, PlatformStoreError } from '../errors';

interface ActiveSpaceRow {
  readonly active_space_id: unknown;
}

export const withPlatformSpaceTransaction = async <Value>(
  pool: Pool,
  spaceId: SpaceId,
  operation: string,
  run: (client: PoolClient) => Promise<Value>,
): Promise<Value> => {
  const client = await pool.connect().catch(() => {
    throw new PlatformStoreError('connection-failed', operation);
  });
  try {
    await client.query('BEGIN');
    const context = await client.query<ActiveSpaceRow>(
      "SELECT set_config('ai_usage.active_space_id', $1, TRUE) AS active_space_id",
      [spaceId],
    );
    if (context.rows[0]?.active_space_id !== spaceId) {
      throw new PlatformStoreError('validation-failed', `${operation}-space-context`);
    }
    const value = await run(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw asPlatformStoreError(error, 'validation-failed', operation);
  } finally {
    client.release();
  }
};
