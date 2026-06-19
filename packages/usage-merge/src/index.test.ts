import { describe, expect, test } from 'bun:test';
import { lanIdentityFromMachine, UsageMergeError, USAGE_MERGE_PROTOCOL, USAGE_MERGE_PROTOCOL_VERSION } from './index';

describe('usage-merge public boundary', () => {
  test('adapts ai-usage machines into generic LAN identities', () => {
    expect(lanIdentityFromMachine({ id: 'machine-a', label: 'Machine A' })).toEqual({
      id: 'machine-a',
      label: 'Machine A',
      protocol: USAGE_MERGE_PROTOCOL,
      version: USAGE_MERGE_PROTOCOL_VERSION,
    });
  });

  test('uses a typed public error', () => {
    const error = new UsageMergeError({
      message: 'Cannot merge this machine into itself',
      operation: 'mergePeer',
      reason: 'self-merge',
    });

    expect(error._tag).toBe('UsageMergeError');
  });
});
