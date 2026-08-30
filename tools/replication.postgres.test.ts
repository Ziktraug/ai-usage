import { describe, expect, test } from 'bun:test';
import { createDeviceEnrollmentService } from '@ai-usage/identity/device-enrollment';
import { createDeploymentTokenKey, createDeploymentTokenKeyRing } from '@ai-usage/identity/device-tokens';
import { createCaptureContextId, createPersonId, createSpaceId, instantNow } from '@ai-usage/platform-core/identity';
import { createPlatformTestingDatabase } from '@ai-usage/postgres-store/testing';
import { createPlatformStore } from '@ai-usage/postgres-store/writer';
import {
  createReplicationBatch,
  createReplicationBatchId,
  createReplicationEvent,
  createReplicationEventId,
  parseReplicationGeneration,
  replicationAckProof,
  USAGE_REPLICATION_STREAM_ID,
} from '@ai-usage/replication-protocol';
import { startPostgresCluster } from './pg-harness';

const runPostgresTests = process.env.AI_USAGE_RUN_POSTGRES_TESTS === '1';
const observedAt = instantNow(() => new Date('2026-08-30T12:00:00.000Z'));

if (runPostgresTests) {
  describe('PostgreSQL replication ingest', () => {
    test('applies immutable events idempotently with generation, conflict, projection, and revocation fences', async () => {
      const cluster = await startPostgresCluster('replication-ingest');
      const store = await createPlatformStore({
        connectTimeoutMs: 5000,
        databaseUrl: cluster.url,
        migrationMode: 'apply',
        poolSize: 8,
        queryTimeoutMs: 5000,
        tlsMode: 'disable',
      });
      const database = createPlatformTestingDatabase(cluster.url);
      try {
        const personId = createPersonId();
        const spaceId = createSpaceId();
        await store.identity.createPersonalIdentity({
          person: { displayName: 'Replication owner', id: personId, personalSpaceId: spaceId, status: 'active' },
          space: { createdAt: observedAt, displayName: 'Replication space', id: spaceId, kind: 'personal' },
        });
        const key = createDeploymentTokenKey(Buffer.alloc(32, 71).toString('base64url'), 1);
        const devices = createDeviceEnrollmentService({
          authorizer: store.authorization,
          clock: () => new Date(observedAt),
          keyRing: createDeploymentTokenKeyRing([key], 1),
          store: store.devices,
        });
        const grant = await devices.requestEnrollmentGrant({
          context: { activeSpaceId: spaceId, trustedDevice: false },
          label: 'Replication laptop',
          principal: { kind: 'person', personId },
        });
        if (grant.kind !== 'success') {
          throw new Error('Expected Device enrollment grant.');
        }
        const exchanged = await devices.exchangeEnrollmentGrant(grant.value.token);
        if (exchanged.kind !== 'success') {
          throw new Error('Expected Device enrollment exchange.');
        }
        const context = {
          deviceId: exchanged.value.device.id,
          id: createCaptureContextId(),
          personId,
          projectId: null,
          scmAccountId: null,
          scmInstallationId: null,
          source: 'personal-fallback' as const,
          spaceId,
        };
        await store.identity.saveCaptureContext(context);
        const authenticated = {
          authenticatedCredentialId: exchanged.value.credential.id,
          authenticatedDevice: exchanged.value.device,
        } as const;
        const factKey = `device:${exchanged.value.device.id}`;
        const firstEvent = createReplicationEvent({
          captureContextId: context.id,
          changeKind: 'device-fact-upsert',
          eventId: createReplicationEventId(),
          factKey,
          generation: parseReplicationGeneration(1),
          payload: {
            deviceId: exchanged.value.device.id,
            kind: 'device-fact-upsert',
            label: 'Replication laptop',
            lastSeenAt: observedAt,
            status: 'active',
          },
        });
        const firstBatch = createReplicationBatch({
          batchId: createReplicationBatchId(),
          captureContexts: [context],
          deviceId: exchanged.value.device.id,
          events: [firstEvent],
          fromGenerationExclusive: parseReplicationGeneration(0),
          streamId: USAGE_REPLICATION_STREAM_ID,
          toGenerationInclusive: parseReplicationGeneration(1),
        });

        const duplicates = await Promise.all([
          store.replication.applyBatch({ ...authenticated, batch: firstBatch }),
          store.replication.applyBatch({ ...authenticated, batch: firstBatch }),
        ]);
        expect(duplicates).toEqual([
          expect.objectContaining({
            ack: expect.objectContaining({ counts: { applied: 1, duplicate: 0, projected: 1, tombstoned: 0 } }),
            kind: 'ack',
          }),
          expect.objectContaining({
            ack: expect.objectContaining({ counts: { applied: 1, duplicate: 0, projected: 1, tombstoned: 0 } }),
            kind: 'ack',
          }),
        ]);
        const firstAck = duplicates[0]?.kind === 'ack' ? duplicates[0].ack : null;
        if (!firstAck) {
          throw new Error('Expected initial replication ACK.');
        }
        expect(await database.queryRowCount('SELECT 1 FROM replication_event_receipts')).toBe(1);
        expect(await database.queryRowCount('SELECT 1 FROM replicated_fact_projections')).toBe(1);
        expect(await database.queryRowCount('SELECT 1 FROM replication_batch_receipts')).toBe(1);

        const secondEvent = createReplicationEvent({
          captureContextId: context.id,
          changeKind: 'device-fact-upsert',
          eventId: createReplicationEventId(),
          factKey,
          generation: parseReplicationGeneration(2),
          payload: {
            deviceId: exchanged.value.device.id,
            kind: 'device-fact-upsert',
            label: 'Replication laptop renamed',
            lastSeenAt: observedAt,
            status: 'active',
          },
        });
        const secondBatch = createReplicationBatch({
          batchId: createReplicationBatchId(),
          captureContexts: [context],
          deviceId: exchanged.value.device.id,
          events: [secondEvent],
          fromGenerationExclusive: parseReplicationGeneration(1),
          previousAckProof: replicationAckProof(firstAck),
          streamId: USAGE_REPLICATION_STREAM_ID,
          toGenerationInclusive: parseReplicationGeneration(2),
        });
        const second = await store.replication.applyBatch({ ...authenticated, batch: secondBatch });
        expect(second).toMatchObject({
          ack: { counts: { applied: 1, duplicate: 0, projected: 1, tombstoned: 0 } },
          kind: 'ack',
        });
        if (second.kind !== 'ack') {
          throw new Error('Expected enrichment ACK.');
        }

        const tombstoneEvent = createReplicationEvent({
          captureContextId: context.id,
          changeKind: 'usage-session-tombstone',
          eventId: createReplicationEventId(),
          factKey,
          generation: parseReplicationGeneration(3),
          payload: { kind: 'usage-session-tombstone', reasonCode: 'source-deleted', tombstonedAt: observedAt },
        });
        const tombstoneBatch = createReplicationBatch({
          batchId: createReplicationBatchId(),
          captureContexts: [context],
          deviceId: exchanged.value.device.id,
          events: [tombstoneEvent],
          fromGenerationExclusive: parseReplicationGeneration(2),
          previousAckProof: replicationAckProof(second.ack),
          streamId: USAGE_REPLICATION_STREAM_ID,
          toGenerationInclusive: parseReplicationGeneration(3),
        });
        expect(await store.replication.applyBatch({ ...authenticated, batch: tombstoneBatch })).toMatchObject({
          ack: { counts: { applied: 1, duplicate: 0, projected: 1, tombstoned: 1 } },
          kind: 'ack',
        });
        expect(
          await database.queryRowCount(
            `SELECT 1 FROM replicated_fact_projections
             WHERE fact_key = $1 AND status = 'tombstone' AND current_event_id = $2`,
            [factKey, tombstoneEvent.eventId],
          ),
        ).toBe(1);
        expect(
          await database.queryRowCount('SELECT 1 FROM replication_event_receipts WHERE fact_key = $1', [factKey]),
        ).toBe(3);

        const gapEvent = createReplicationEvent({
          captureContextId: context.id,
          changeKind: 'device-fact-upsert',
          eventId: createReplicationEventId(),
          factKey,
          generation: parseReplicationGeneration(5),
          payload: {
            deviceId: exchanged.value.device.id,
            kind: 'device-fact-upsert',
            label: 'Gap',
            lastSeenAt: observedAt,
            status: 'active',
          },
        });
        const gapBatch = createReplicationBatch({
          batchId: createReplicationBatchId(),
          captureContexts: [context],
          deviceId: exchanged.value.device.id,
          events: [gapEvent],
          fromGenerationExclusive: parseReplicationGeneration(4),
          streamId: USAGE_REPLICATION_STREAM_ID,
          toGenerationInclusive: parseReplicationGeneration(5),
        });
        expect(await store.replication.applyBatch({ ...authenticated, batch: gapBatch })).toEqual({
          kind: 'problem',
          problem: { code: 'generation-gap', expectedGeneration: parseReplicationGeneration(3) },
        });

        const overlapEvent = createReplicationEvent({
          captureContextId: context.id,
          changeKind: 'device-fact-upsert',
          eventId: createReplicationEventId(),
          factKey,
          generation: parseReplicationGeneration(1),
          payload: {
            deviceId: exchanged.value.device.id,
            kind: 'device-fact-upsert',
            label: 'Conflicting overlap',
            lastSeenAt: observedAt,
            status: 'active',
          },
        });
        const overlapBatch = createReplicationBatch({
          batchId: createReplicationBatchId(),
          captureContexts: [context],
          deviceId: exchanged.value.device.id,
          events: [overlapEvent],
          fromGenerationExclusive: parseReplicationGeneration(0),
          streamId: USAGE_REPLICATION_STREAM_ID,
          toGenerationInclusive: parseReplicationGeneration(1),
        });
        expect(await store.replication.applyBatch({ ...authenticated, batch: overlapBatch })).toEqual({
          kind: 'problem',
          problem: { code: 'overlap-conflict' },
        });

        const reusedEvent = createReplicationEvent({
          captureContextId: context.id,
          changeKind: 'device-fact-upsert',
          eventId: secondEvent.eventId,
          factKey,
          generation: parseReplicationGeneration(4),
          payload: {
            deviceId: exchanged.value.device.id,
            kind: 'device-fact-upsert',
            label: 'Reused event ID',
            lastSeenAt: observedAt,
            status: 'active',
          },
        });
        const reusedEventBatch = createReplicationBatch({
          batchId: createReplicationBatchId(),
          captureContexts: [context],
          deviceId: exchanged.value.device.id,
          events: [reusedEvent],
          fromGenerationExclusive: parseReplicationGeneration(3),
          streamId: USAGE_REPLICATION_STREAM_ID,
          toGenerationInclusive: parseReplicationGeneration(4),
        });
        expect(await store.replication.applyBatch({ ...authenticated, batch: reusedEventBatch })).toEqual({
          kind: 'problem',
          problem: { code: 'event-id-conflict' },
        });

        const batchIdConflict = createReplicationBatch({
          batchId: tombstoneBatch.batchId,
          captureContexts: [context],
          deviceId: exchanged.value.device.id,
          events: [reusedEvent],
          fromGenerationExclusive: parseReplicationGeneration(3),
          streamId: USAGE_REPLICATION_STREAM_ID,
          toGenerationInclusive: parseReplicationGeneration(4),
        });
        expect(await store.replication.applyBatch({ ...authenticated, batch: batchIdConflict })).toEqual({
          kind: 'problem',
          problem: { code: 'batch-id-conflict' },
        });

        const forbiddenBatch = createReplicationBatch({
          batchId: createReplicationBatchId(),
          captureContexts: [{ ...context, source: 'unassigned' }],
          deviceId: exchanged.value.device.id,
          events: [
            createReplicationEvent({
              captureContextId: context.id,
              changeKind: 'device-fact-upsert',
              eventId: createReplicationEventId(),
              factKey,
              generation: parseReplicationGeneration(4),
              payload: {
                deviceId: exchanged.value.device.id,
                kind: 'device-fact-upsert',
                label: 'Forbidden context',
                lastSeenAt: observedAt,
                status: 'active',
              },
            }),
          ],
          fromGenerationExclusive: parseReplicationGeneration(3),
          streamId: USAGE_REPLICATION_STREAM_ID,
          toGenerationInclusive: parseReplicationGeneration(4),
        });
        expect(await store.replication.applyBatch({ ...authenticated, batch: forbiddenBatch })).toEqual({
          kind: 'problem',
          problem: { code: 'capture-context-forbidden' },
        });
        expect(await database.queryRowCount('SELECT 1 FROM replication_event_receipts')).toBe(3);

        await expect(
          database.query('UPDATE replication_event_receipts SET fact_key = $1 WHERE event_id = $2', [
            'mutated',
            firstEvent.eventId,
          ]),
        ).rejects.toBeDefined();
        await expect(
          devices.revokeDevice({
            context: { activeSpaceId: spaceId, trustedDevice: false },
            deviceId: exchanged.value.device.id,
            principal: { kind: 'person', personId },
          }),
        ).resolves.toMatchObject({ kind: 'success' });
        expect(await store.replication.applyBatch({ ...authenticated, batch: reusedEventBatch })).toEqual({
          kind: 'problem',
          problem: { code: 'revoked' },
        });
      } finally {
        await database.close().catch(() => undefined);
        await store.close().catch(() => undefined);
        await cluster.stop();
      }
    }, 30_000);
  });
} else {
  // biome-ignore lint/suspicious/noSkippedTests: PostgreSQL integration requires the repository-owned PostgreSQL 17 binaries.
  describe.skip('PostgreSQL replication ingest', () => {
    test('requires AI_USAGE_RUN_POSTGRES_TESTS=1', () => undefined);
  });
}
