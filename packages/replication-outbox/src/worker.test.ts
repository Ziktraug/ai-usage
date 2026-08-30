import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
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
import { createSqliteReplicationOutbox } from '.';
import { type ReplicationWorkerOutboxPort, runReplicationWorkerCycle } from './worker';

const instant = '2026-08-30T10:00:00.000Z' as Instant;
const deviceId = '30000000-0000-4000-8000-000000000001' as DeviceId;
const captureContextId = '30000000-0000-4000-8000-000000000002' as CaptureContextId;
const itemId = '30000000-0000-4000-8000-000000000003' as MemoryItemId;

const setup = () => {
  const database = new Database(':memory:');
  const local = createSqliteReplicationOutbox(database);
  local.initialize({ createdAt: instant, deviceId, streamId: MEMORY_REPLICATION_STREAM_ID });
  local.enqueue({
    captureContext: {
      deviceId,
      id: captureContextId,
      personId: '30000000-0000-4000-8000-000000000004' as PersonId,
      projectId: '30000000-0000-4000-8000-000000000005' as ProjectId,
      scmAccountId: null,
      scmInstallationId: null,
      source: 'explicit',
      spaceId: '30000000-0000-4000-8000-000000000006' as SpaceId,
    },
    changeKind: 'memory-item-revision-upsert',
    enqueuedAt: instant,
    eventId: parseReplicationEventId('30000000-0000-4000-8000-000000000007'),
    factKey: `memory-item:${itemId}`,
    payload: {
      guidance: [],
      itemId,
      itemKind: 'decision',
      kind: 'memory-item-revision-upsert',
      projectId: '30000000-0000-4000-8000-000000000005' as ProjectId,
      revisionCreatedAt: instant,
      revisionId: '30000000-0000-4000-8000-000000000008' as MemoryRevisionId,
      revisionNumber: 1,
      scope: 'project',
      sensitivity: 'normal',
      status: 'active',
      structuredContent: {},
      summary: '',
      title: 'Worker fixture',
      trust: 'explicit',
    },
  });
  const port: ReplicationWorkerOutboxPort = {
    acknowledge: async (batch, ack) => local.acknowledge(batch, ack),
    block: async (input) => local.block(input),
    claimReady: async (input) => local.claimReady(input),
    retry: async (input) => local.retry(input),
    status: async () => local.status(),
  };
  return { database, local, port };
};

test('retries the exact batch after a lost ACK and applies it once', async () => {
  const { database, port } = setup();
  const seenBatchIds: string[] = [];
  let serverApplyCount = 0;
  const first = await runReplicationWorkerCycle({
    clock: () => new Date(instant),
    outbox: port,
    random: () => 0,
    transport: {
      publish: (batch) => {
        seenBatchIds.push(batch.batchId);
        serverApplyCount += 1;
        return Promise.reject(new Error('ACK lost after commit'));
      },
    },
  });
  expect(first.kind).toBe('retry-scheduled');

  const second = await runReplicationWorkerCycle({
    clock: () => new Date('2026-08-30T10:01:00.000Z'),
    outbox: port,
    transport: {
      publish: (batch) => {
        seenBatchIds.push(batch.batchId);
        const ack: ReplicationAck = {
          acceptedThroughGeneration: batch.toGenerationInclusive,
          appliedAt: '2026-08-30T10:01:00.000Z' as Instant,
          appliedBatchId: batch.batchId,
          appliedEventIds: batch.events.map(({ eventId }) => eventId),
          counts: { applied: 0, duplicate: 1, projected: 0, tombstoned: 0 },
          deviceId: batch.deviceId,
          protocolVersion: 1,
          streamId: batch.streamId,
          warnings: [],
        };
        return Promise.resolve({ ack, kind: 'ack' });
      },
    },
  });
  expect(second.kind).toBe('acknowledged');
  expect(seenBatchIds[1]).toBe(seenBatchIds[0]);
  expect(serverApplyCount).toBe(1);
  database.close();
});

test('makes policy failures visible and stops the generation stream', async () => {
  const { database, local, port } = setup();
  const result = await runReplicationWorkerCycle({
    clock: () => new Date(instant),
    outbox: port,
    transport: {
      publish: () => Promise.resolve({ kind: 'problem', problem: { code: 'capture-context-forbidden' } }),
    },
  });
  expect(result).toMatchObject({ kind: 'blocked', reason: 'capture-context-forbidden' });
  expect(local.status()).toMatchObject({ blocked: 1, inFlight: 0, pending: 0 });
  database.close();
});
