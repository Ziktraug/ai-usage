import { describe, expect, test } from 'bun:test';
import type { ReplicationStatus, ReplicationStreamStatus } from '@ai-usage/web-contract/replication';
import {
  presentReplicationStatus,
  presentReplicationStream,
  replicationDiagnosticLabel,
} from './replication-status-model';

const stream = (overrides: Partial<ReplicationStreamStatus> = {}): ReplicationStreamStatus => ({
  acknowledged: 3,
  acknowledgedThroughGeneration: 3,
  blocked: 0,
  inFlight: 0,
  lastAcknowledgedAt: '2026-08-30T08:00:00.000Z',
  lastErrorCode: null,
  nextRetryAt: null,
  oldestUnacknowledgedAt: null,
  pending: 0,
  streamId: 'usage-v1',
  ...overrides,
});

const connected = (overrides: Partial<ReplicationStatus> = {}): ReplicationStatus => ({
  kind: 'replication-status',
  lastDiagnostic: null,
  memory: null,
  mode: 'connected',
  runtimeState: 'waiting',
  usage: stream(),
  ...overrides,
});

describe('replication status presentation', () => {
  test('distinguishes local-only, publishing, queued, blocked, and stopped runtime states', () => {
    expect(
      presentReplicationStatus({
        kind: 'replication-status',
        lastDiagnostic: null,
        memory: null,
        mode: 'local-only',
        runtimeState: 'disabled',
        usage: null,
      }),
    ).toMatchObject({ label: 'Local only', tone: 'info' });
    expect(presentReplicationStatus(connected({ runtimeState: 'publishing' }))).toMatchObject({
      label: 'Publishing',
      tone: 'ok',
    });
    expect(presentReplicationStatus(connected({ usage: stream({ pending: 1 }) }))).toMatchObject({
      label: 'Waiting to publish',
      tone: 'warning',
    });
    expect(presentReplicationStatus(connected({ usage: stream({ blocked: 1 }) }))).toMatchObject({
      label: 'Blocked',
      tone: 'danger',
    });
    expect(presentReplicationStatus(connected({ runtimeState: 'disposed' }))).toMatchObject({
      label: 'Stopped',
      tone: 'warning',
    });
  });

  test('presents each stream without hiding published history', () => {
    expect(presentReplicationStream(stream())).toMatchObject({ label: 'Published', tone: 'ok' });
    expect(presentReplicationStream(stream({ inFlight: 1 }))).toMatchObject({ label: 'Publishing', tone: 'ok' });
    expect(presentReplicationStream(stream({ pending: 2 }))).toMatchObject({ label: 'Queued', tone: 'warning' });
    expect(presentReplicationStream(stream({ blocked: 1 }))).toMatchObject({ label: 'Blocked', tone: 'danger' });
  });

  test('maps closed diagnostics to bounded operator-facing explanations', () => {
    expect(
      replicationDiagnosticLabel({ code: 'retry-scheduled', problemCode: 'rate-limited', streamId: 'usage-v1' }),
    ).toBe('A retry is scheduled after a temporary failure. (rate-limited)');
    expect(replicationDiagnosticLabel(null)).toBeUndefined();
  });
});
