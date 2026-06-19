import { describe, expect, test } from 'bun:test';
import { UsageStoreError, type ImportResult } from './index';

describe('usage-store public boundary', () => {
  test('keeps import results count based for UI state', () => {
    const result: ImportResult = {
      deleted: 0,
      inserted: 1,
      superseded: 0,
      unchanged: 2,
      updated: 3,
      warnings: 0,
    };

    expect(result.inserted + result.updated + result.unchanged).toBe(6);
  });

  test('uses a typed public error', () => {
    const error = new UsageStoreError({
      message: 'Cannot import this machine as a peer',
      operation: 'importPeerMergeBundle',
      reason: 'self-import',
    });

    expect(error._tag).toBe('UsageStoreError');
  });
});
