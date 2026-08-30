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
  canonicalReplicationJson,
  createReplicationBatch,
  createReplicationEvent,
  MEMORY_REPLICATION_STREAM_ID,
  parseReplicationBatch,
  parseReplicationBatchId,
  parseReplicationEventId,
  parseReplicationGeneration,
  ReplicationProtocolError,
  replicationHash,
} from '.';

const deviceId = '10000000-0000-4000-8000-000000000001' as DeviceId;
const personId = '10000000-0000-4000-8000-000000000002' as PersonId;
const spaceId = '10000000-0000-4000-8000-000000000003' as SpaceId;
const projectId = '10000000-0000-4000-8000-000000000004' as ProjectId;
const captureContextId = '10000000-0000-4000-8000-000000000005' as CaptureContextId;
const itemId = '10000000-0000-4000-8000-000000000006' as MemoryItemId;
const revisionOneId = '10000000-0000-4000-8000-000000000007' as MemoryRevisionId;
const revisionTwoId = '10000000-0000-4000-8000-000000000008' as MemoryRevisionId;
const eventOneId = parseReplicationEventId('10000000-0000-4000-8000-000000000009');
const eventTwoId = parseReplicationEventId('10000000-0000-4000-8000-00000000000a');
const batchId = parseReplicationBatchId('10000000-0000-4000-8000-00000000000b');
const instant = '2026-08-30T08:00:00.000Z' as Instant;

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

const revisionPayload = (revisionId: MemoryRevisionId, revisionNumber: number, title: string) => ({
  guidance: ['Keep fact, event, and content identities separate.'],
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
  structuredContent: { source: 'reviewed' },
  summary: 'A reviewed replication decision.',
  title,
  trust: 'explicit' as const,
});

describe('replication protocol identities and canonical content', () => {
  test('canonicalizes object keys and hashes equivalent values identically', () => {
    expect(canonicalReplicationJson({ beta: 2, alpha: { delta: true, charlie: null } })).toBe(
      canonicalReplicationJson({ alpha: { charlie: null, delta: true }, beta: 2 }),
    );
    expect(replicationHash({ beta: 2, alpha: 1 })).toBe(replicationHash({ alpha: 1, beta: 2 }));
  });

  test('keeps retries stable and enrichment on the same logical fact immutable', () => {
    const first = createReplicationEvent({
      captureContextId,
      changeKind: 'memory-item-revision-upsert',
      eventId: eventOneId,
      factKey: `memory-item:${itemId}`,
      generation: parseReplicationGeneration(1),
      payload: revisionPayload(revisionOneId, 1, 'Initial'),
    });
    const retry = createReplicationEvent({
      captureContextId,
      changeKind: first.changeKind,
      eventId: first.eventId,
      factKey: first.factKey,
      generation: first.generation,
      payload: first.payload,
    });
    const enrichment = createReplicationEvent({
      captureContextId,
      changeKind: 'memory-item-revision-upsert',
      eventId: eventTwoId,
      factKey: first.factKey,
      generation: parseReplicationGeneration(2),
      payload: revisionPayload(revisionTwoId, 2, 'Corrected'),
    });

    expect(retry).toEqual(first);
    expect(enrichment.factKey).toBe(first.factKey);
    expect(enrichment.eventId).not.toBe(first.eventId);
    expect(enrichment.contentHash).not.toBe(first.contentHash);
  });

  test('makes a tombstone an explicit new content version', () => {
    const tombstone = createReplicationEvent({
      captureContextId,
      changeKind: 'memory-fact-tombstone',
      eventId: eventTwoId,
      factKey: `memory-item:${itemId}`,
      generation: parseReplicationGeneration(2),
      payload: {
        itemId,
        kind: 'memory-fact-tombstone',
        reasonCode: 'privacy-purge',
        tombstonedAt: instant,
      },
    });
    expect(tombstone.payload.kind).toBe('memory-fact-tombstone');
    expect(tombstone.contentHash).toHaveLength(64);
  });
});

describe('replication batch validation', () => {
  const firstEvent = createReplicationEvent({
    captureContextId,
    changeKind: 'memory-item-revision-upsert',
    eventId: eventOneId,
    factKey: `memory-item:${itemId}`,
    generation: parseReplicationGeneration(1),
    payload: revisionPayload(revisionOneId, 1, 'Initial'),
  });

  test('rebuilds an exact batch with a stable idempotency key', () => {
    const batch = createReplicationBatch({
      batchId,
      captureContexts: [captureContext],
      deviceId,
      events: [firstEvent],
      fromGenerationExclusive: parseReplicationGeneration(0),
      streamId: MEMORY_REPLICATION_STREAM_ID,
      toGenerationInclusive: parseReplicationGeneration(1),
    });
    expect(parseReplicationBatch(JSON.parse(JSON.stringify(batch)))).toEqual(batch);
    expect(
      createReplicationBatch({
        batchId,
        captureContexts: [captureContext],
        deviceId,
        events: [firstEvent],
        fromGenerationExclusive: parseReplicationGeneration(0),
        streamId: MEMORY_REPLICATION_STREAM_ID,
        toGenerationInclusive: parseReplicationGeneration(1),
      }).idempotencyKey,
    ).toBe(batch.idempotencyKey);
  });

  test('rejects gaps, undeclared capture contexts, extra keys, and content mutation', () => {
    expect(() =>
      createReplicationBatch({
        batchId,
        captureContexts: [captureContext],
        deviceId,
        events: [{ ...firstEvent, generation: parseReplicationGeneration(2) }],
        fromGenerationExclusive: parseReplicationGeneration(0),
        streamId: MEMORY_REPLICATION_STREAM_ID,
        toGenerationInclusive: parseReplicationGeneration(1),
      }),
    ).toThrow(ReplicationProtocolError);

    const batch = createReplicationBatch({
      batchId,
      captureContexts: [captureContext],
      deviceId,
      events: [firstEvent],
      fromGenerationExclusive: parseReplicationGeneration(0),
      streamId: MEMORY_REPLICATION_STREAM_ID,
      toGenerationInclusive: parseReplicationGeneration(1),
    });
    expect(() => parseReplicationBatch({ ...batch, unexpected: true })).toThrow(ReplicationProtocolError);
    expect(() =>
      parseReplicationBatch({
        ...batch,
        events: [{ ...firstEvent, payload: { ...firstEvent.payload, title: 'Changed without a new hash' } }],
      }),
    ).toThrow(ReplicationProtocolError);
  });
});
