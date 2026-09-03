import { describe, expect, test } from 'bun:test';
import { PLATFORM_MIGRATIONS, validatePlatformMigrations } from './migrations';

describe('platform migration registry', () => {
  test('uses an explicit strictly increasing ordinal sequence', () => {
    expect(PLATFORM_MIGRATIONS.map(({ id, ordinal }) => ({ id, ordinal }))).toEqual([
      { id: '0001_platform_schema_metadata', ordinal: 1 },
      { id: '0002_identity_kernel', ordinal: 2 },
      { id: '0003_domain_authorization', ordinal: 3 },
      { id: '0004_shared_authentication_and_device_enrollment', ordinal: 4 },
      { id: '0005_db_native_agent_memory', ordinal: 5 },
      { id: '0006_memory_import_state_binding', ordinal: 6 },
      { id: '0007_authorized_memory_search', ordinal: 7 },
      { id: '0008_device_outbox_replication', ordinal: 8 },
    ]);
    expect(validatePlatformMigrations(PLATFORM_MIGRATIONS)).toBe(PLATFORM_MIGRATIONS);
  });

  test('rejects duplicate identifiers, duplicate ordinals, and implicit ordering', () => {
    const invalidRegistries = [
      [
        { id: '0001_valid', ordinal: 1, up: 'SELECT 1' },
        { id: '0001_valid', ordinal: 2, up: 'SELECT 2' },
      ],
      [
        { id: '0001_valid', ordinal: 1, up: 'SELECT 1' },
        { id: '0002_valid', ordinal: 1, up: 'SELECT 2' },
      ],
      [
        { id: '0002_valid', ordinal: 2, up: 'SELECT 2' },
        { id: '0001_valid', ordinal: 1, up: 'SELECT 1' },
      ],
    ] as const;

    for (const registry of invalidRegistries) {
      expect(() => validatePlatformMigrations(registry)).toThrow(
        expect.objectContaining({ code: 'migration-registry-invalid' }),
      );
    }
  });
});
