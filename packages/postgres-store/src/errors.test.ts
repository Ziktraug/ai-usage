import { describe, expect, test } from 'bun:test';
import { DatabaseError } from 'pg';
import { PlatformStoreError, platformStoreFailureDiagnostic } from './errors';

const databaseError = (code: string | undefined, message: string): DatabaseError => {
  const error = new DatabaseError(message, message.length, 'error');
  if (code !== undefined) {
    error.code = code;
  }
  error.detail = 'Key (account_id)=(subject-quoted-from-a-row) already exists.';
  return error;
};

describe('platformStoreFailureDiagnostic', () => {
  test('reports the code, the operation and the SQLSTATE PostgreSQL refused with, never its text', () => {
    const refusal = databaseError(
      'IA003',
      'authentication_provider_accounts holds 1 (provider_id, account_id) key(s) with more than one row',
    );
    const diagnostic = platformStoreFailureDiagnostic(
      new PlatformStoreError('migration-failed', 'apply-migration', { cause: refusal }),
    );

    expect(diagnostic).toEqual({ code: 'migration-failed', operation: 'apply-migration', sqlState: 'IA003' });
    expect(JSON.stringify(diagnostic)).not.toContain('authentication_provider_accounts');
    expect(JSON.stringify(diagnostic)).not.toContain('subject-quoted-from-a-row');
  });

  test('omits the SQLSTATE when PostgreSQL did not refuse the operation', () => {
    const failures: readonly PlatformStoreError[] = [
      new PlatformStoreError('migration-required', 'verify-migrations'),
      // A socket error carries a five-letter code that is not a SQLSTATE.
      new PlatformStoreError('connection-failed', 'connect-for-migrations', {
        cause: Object.assign(new Error('write EPIPE postgresql://operator:secret@db.example.invalid'), {
          code: 'EPIPE',
        }),
      }),
      new PlatformStoreError('migration-failed', 'apply-migration', { cause: { code: 'IA003' } }),
      new PlatformStoreError('migration-failed', 'apply-migration', { cause: databaseError(undefined, 'no code') }),
      new PlatformStoreError('migration-failed', 'apply-migration', {
        cause: databaseError('not a sqlstate', 'malformed code'),
      }),
    ];

    expect(failures.map(platformStoreFailureDiagnostic)).toEqual([
      { code: 'migration-required', operation: 'verify-migrations' },
      { code: 'connection-failed', operation: 'connect-for-migrations' },
      { code: 'migration-failed', operation: 'apply-migration' },
      { code: 'migration-failed', operation: 'apply-migration' },
      { code: 'migration-failed', operation: 'apply-migration' },
    ]);
  });
});
