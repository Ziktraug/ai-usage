import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import type {
  CaptureContextId,
  DeviceId,
  Instant,
  MemoryItemId,
  MemoryRevisionId,
  PersonId,
  ProjectId,
  SpaceId,
} from '@ai-usage/platform-core/identity';
import {
  MEMORY_REPLICATION_STREAM_ID,
  parseReplicationEventId,
  type ReplicationAck,
} from '@ai-usage/replication-protocol';
import { createSqliteReplicationOutbox, ReplicationOutboxError } from '.';

const deviceId = '20000000-0000-4000-8000-000000000001' as DeviceId;
const personId = '20000000-0000-4000-8000-000000000002' as PersonId;
const spaceId = '20000000-0000-4000-8000-000000000003' as SpaceId;
const projectId = '20000000-0000-4000-8000-000000000004' as ProjectId;
const captureContextId = '20000000-0000-4000-8000-000000000005' as CaptureContextId;
const itemId = '20000000-0000-4000-8000-000000000006' as MemoryItemId;
const revisionOneId = '20000000-0000-4000-8000-000000000007' as MemoryRevisionId;
const revisionTwoId = '20000000-0000-4000-8000-000000000008' as MemoryRevisionId;
const instant = '2026-08-30T09:00:00.000Z' as Instant;
const later = '2026-08-30T09:01:00.000Z' as Instant;

const captureContext = {
  deviceId,
  id: captureContextId,
  personId,
  projectId,
  scmAccountId: null,
  scmInstallationId: null,
  source: 'explicit' as const,
  spaceId,
};

const payload = (revisionId: MemoryRevisionId, revisionNumber: number, title: string) => ({
  guidance: ['Publish asynchronously.'],
  itemId,
  itemKind: 'decision' as const,
  kind: 'memory-item-revision-upsert' as const,
  projectId,
  revisionCreatedAt: instant,
  revisionId,
  revisionNumber,
  scope: 'project' as const,
  sensitivity: 'normal' as const,
  status: 'active' as const,
  structuredContent: { reviewed: true },
  summary: 'An accepted Memory fact.',
  title,
  trust: 'explicit' as const,
});

const createOutbox = () => {
  const database = new Database(':memory:');
  database.exec('PRAGMA foreign_keys = ON');
  const outbox = createSqliteReplicationOutbox(database);
  outbox.initialize({ createdAt: instant, deviceId, streamId: MEMORY_REPLICATION_STREAM_ID });
  return { database, outbox };
};

const enqueue = (
  outbox: ReturnType<typeof createSqliteReplicationOutbox>,
  eventIdValue: string,
  revisionId: MemoryRevisionId,
  revisionNumber: number,
  title: string,
) =>
  outbox.enqueue({
    captureContext,
    changeKind: 'memory-item-revision-upsert',
    enqueuedAt: instant,
    eventId: parseReplicationEventId(eventIdValue),
    factKey: `memory-item:${itemId}`,
    payload: payload(revisionId, revisionNumber, title),
  });

const ackFor = (
  batch: NonNullable<ReturnType<ReturnType<typeof createOutbox>['outbox']['claimReady']>>['batch'],
): ReplicationAck => ({
  acceptedThroughGeneration: batch.toGenerationInclusive,
  appliedAt: later,
  appliedBatchId: batch.batchId,
  appliedEventIds: batch.events.map(({ eventId }) => eventId),
  counts: { applied: batch.events.length, duplicate: 0, projected: batch.events.length, tombstoned: 0 },
  deviceId: batch.deviceId,
  protocolVersion: 1,
  streamId: batch.streamId,
  warnings: [],
});

describe('SQLite replication outbox', () => {
  test('installs every state and retry field before enqueue and rolls back with the source transaction', () => {
    const { database, outbox } = createOutbox();
    const columns = database.query('PRAGMA table_info(replication_outbox_events)').all() as Array<{ name: string }>;
    expect(columns.map(({ name }) => name)).toEqual([
      'event_id',
      'generation',
      'fact_key',
      'content_hash',
      'change_kind',
      'payload',
      'state',
      'enqueued_at',
      'attempt_count',
      'next_attempt_at',
      'last_error_code',
      'acknowledged_at',
    ]);

    database.exec('BEGIN IMMEDIATE');
    enqueue(outbox, '20000000-0000-4000-8000-000000000009', revisionOneId, 1, 'Initial');
    database.exec('ROLLBACK');
    expect(outbox.status().pending).toBe(0);
    database.close();
  });

  test('assigns monotone generations and keeps fact, event, and content identities separate', () => {
    const { database, outbox } = createOutbox();
    const first = enqueue(outbox, '20000000-0000-4000-8000-000000000009', revisionOneId, 1, 'Initial');
    const exactRetry = enqueue(outbox, '20000000-0000-4000-8000-000000000009', revisionOneId, 1, 'Initial');
    const enrichment = enqueue(outbox, '20000000-0000-4000-8000-00000000000a', revisionTwoId, 2, 'Corrected');

    expect(exactRetry.event).toEqual(first.event);
    expect(Number(enrichment.event.generation)).toBe(2);
    expect(enrichment.event.factKey).toBe(first.event.factKey);
    expect(enrichment.event.eventId).not.toBe(first.event.eventId);
    expect(enrichment.event.contentHash).not.toBe(first.event.contentHash);
    expect(() => enqueue(outbox, '20000000-0000-4000-8000-000000000009', revisionTwoId, 2, 'Conflict')).toThrow(
      ReplicationOutboxError,
    );
    database.close();
  });

  test('claims, retries, recovers leases, blocks visibly, and never reopens acknowledged history', () => {
    const { database, outbox } = createOutbox();
    enqueue(outbox, '20000000-0000-4000-8000-000000000009', revisionOneId, 1, 'Initial');
    const firstClaim = outbox.claimReady({ maximumEvents: 100, now: instant });
    expect(firstClaim?.attemptCount).toBe(1);
    if (!firstClaim) {
      throw new Error('expected claim');
    }
    const retryAt = outbox.retry({ batch: firstClaim.batch, errorCode: 'unreachable', now: instant, random: () => 0 });
    expect(String(retryAt)).toBe('2026-08-30T09:00:00.750Z');
    expect(outbox.claimReady({ maximumEvents: 100, now: instant })).toBeNull();

    const retryClaim = outbox.claimReady({ maximumEvents: 100, now: later });
    expect(retryClaim?.batch.batchId).toBe(firstClaim.batch.batchId);
    expect(outbox.recoverInFlight(later)).toBe(1);
    const recoveredClaim = outbox.claimReady({ maximumEvents: 100, now: later });
    if (!recoveredClaim) {
      throw new Error('expected recovered claim');
    }
    outbox.acknowledge(recoveredClaim.batch, ackFor(recoveredClaim.batch));
    expect(outbox.status()).toMatchObject({ acknowledged: 1, acknowledgedThroughGeneration: 1, pending: 0 });
    expect(() => outbox.retry({ batch: recoveredClaim.batch, errorCode: 'unreachable', now: later })).toThrow(
      ReplicationOutboxError,
    );

    enqueue(outbox, '20000000-0000-4000-8000-00000000000a', revisionTwoId, 2, 'Corrected');
    const blockedClaim = outbox.claimReady({ maximumEvents: 100, now: later });
    if (!blockedClaim) {
      throw new Error('expected blocked claim');
    }
    outbox.block({ batch: blockedClaim.batch, errorCode: 'capture-context-forbidden', now: later });
    expect(outbox.status()).toMatchObject({ acknowledged: 1, blocked: 1, pending: 0 });
    expect(outbox.listHistory()).toEqual([
      expect.objectContaining({ generation: 2, state: 'blocked' }),
      expect.objectContaining({ generation: 1, state: 'acknowledged' }),
    ]);
    expect(JSON.stringify(outbox.status())).not.toContain('accepted Memory');
    database.close();
  });

  test('rejects a stored identity change', () => {
    const { database, outbox } = createOutbox();
    expect(() =>
      outbox.initialize({
        createdAt: instant,
        deviceId: '20000000-0000-4000-8000-000000000099' as DeviceId,
        streamId: MEMORY_REPLICATION_STREAM_ID,
      }),
    ).toThrow(ReplicationOutboxError);
    database.close();
  });
});
