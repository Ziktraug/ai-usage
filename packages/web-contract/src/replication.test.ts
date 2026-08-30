import { describe, expect, test } from 'bun:test';
import { parseReplicationStatus } from './replication';

const connectedStatus = {
  kind: 'replication-status',
  lastDiagnostic: {
    code: 'retry-scheduled',
    problemCode: 'server-unavailable',
    streamId: 'memory-v1',
  },
  memory: {
    acknowledged: 7,
    acknowledgedThroughGeneration: 7,
    blocked: 0,
    inFlight: 0,
    lastAcknowledgedAt: '2026-08-30T08:00:00.000Z',
    lastErrorCode: 'server-unavailable',
    nextRetryAt: '2026-08-30T08:01:00.000Z',
    oldestUnacknowledgedAt: '2026-08-30T07:59:00.000Z',
    pending: 1,
    streamId: 'memory-v1',
  },
  mode: 'connected',
  runtimeState: 'waiting',
  usage: {
    acknowledged: 14,
    acknowledgedThroughGeneration: 14,
    blocked: 0,
    inFlight: 0,
    lastAcknowledgedAt: '2026-08-30T08:00:30.000Z',
    lastErrorCode: null,
    nextRetryAt: null,
    oldestUnacknowledgedAt: null,
    pending: 0,
    streamId: 'usage-v1',
  },
} as const;

describe('replication status Web contract', () => {
  test('accepts the closed content-free connected status', () => {
    expect(parseReplicationStatus(connectedStatus)).toEqual(connectedStatus);
  });

  test('accepts only the exact disabled local-only state', () => {
    const localOnly = {
      kind: 'replication-status',
      lastDiagnostic: null,
      memory: null,
      mode: 'local-only',
      runtimeState: 'disabled',
      usage: null,
    } as const;
    expect(parseReplicationStatus(localOnly)).toEqual(localOnly);
    expect(() => parseReplicationStatus({ ...localOnly, runtimeState: 'waiting' })).toThrow();
    expect(() => parseReplicationStatus({ ...localOnly, pending: 1 })).toThrow();
  });

  test('rejects swapped streams, noncanonical timestamps, and unbounded error codes', () => {
    expect(() =>
      parseReplicationStatus({
        ...connectedStatus,
        memory: { ...connectedStatus.memory, streamId: 'usage-v1' },
      }),
    ).toThrow();
    expect(() =>
      parseReplicationStatus({
        ...connectedStatus,
        memory: { ...connectedStatus.memory, lastAcknowledgedAt: '2026-08-30T08:00:00Z' },
      }),
    ).toThrow();
    expect(() =>
      parseReplicationStatus({
        ...connectedStatus,
        memory: { ...connectedStatus.memory, lastErrorCode: 'x'.repeat(129) },
      }),
    ).toThrow();
  });
});
