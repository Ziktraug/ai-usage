import { describe, expect, test } from 'bun:test';
import { PlatformStoreError } from '../errors';
import { replicationPersistenceProblem } from './replication-adapter';

const databaseError = (code: unknown): Error => Object.assign(new Error('database failure'), { code });

describe('replicationPersistenceProblem', () => {
  test('classifies PostgreSQL unstorable-character failures as a terminal invalid batch', () => {
    for (const sqlState of ['22P05', '22021']) {
      expect(replicationPersistenceProblem(databaseError(sqlState))).toEqual({
        kind: 'problem',
        problem: { code: 'invalid-batch' },
      });
    }
  });

  test('leaves every other failure on the retryable outage path', () => {
    const failures: readonly unknown[] = [
      new Error('connection reset'),
      databaseError('23505'),
      databaseError('40001'),
      databaseError('ECONNRESET'),
      databaseError(22_021),
      databaseError(undefined),
      new PlatformStoreError('validation-failed', 'apply-replication-batch'),
      null,
      undefined,
      '22P05',
      { code: '22P05', kind: 'not-an-error' },
    ];
    for (const failure of failures.slice(0, -1)) {
      expect(replicationPersistenceProblem(failure)).toBeNull();
    }
    // A bare object carrying a SQLSTATE is still classified: pg raises plain
    // DatabaseError instances, and the shape, not the prototype, is the contract.
    expect(replicationPersistenceProblem(failures.at(-1))).toEqual({
      kind: 'problem',
      problem: { code: 'invalid-batch' },
    });
  });
});
