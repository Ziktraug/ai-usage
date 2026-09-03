import { describe, expect, test } from 'bun:test';
import { createDeviceEnrollmentService } from '@ai-usage/identity/device-enrollment';
import { createDeploymentTokenKey, createDeploymentTokenKeyRing } from '@ai-usage/identity/device-tokens';
import {
  createCaptureContextId,
  createPersonId,
  createProjectId,
  createSpaceId,
  instantNow,
} from '@ai-usage/platform-core/identity';
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

        const gapContext = { ...context, id: createCaptureContextId() };
        const gapEvent = createReplicationEvent({
          captureContextId: gapContext.id,
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
          captureContexts: [gapContext],
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
        expect(await database.queryRowCount('SELECT 1 FROM capture_contexts WHERE id = $1', [gapContext.id])).toBe(0);

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

        const batchConflictId = createReplicationBatchId();
        const batchConflictEventOne = createReplicationEvent({
          captureContextId: context.id,
          changeKind: 'device-fact-upsert',
          eventId: createReplicationEventId(),
          factKey,
          generation: parseReplicationGeneration(4),
          payload: {
            deviceId: exchanged.value.device.id,
            kind: 'device-fact-upsert',
            label: 'Concurrent batch winner one',
            lastSeenAt: observedAt,
            status: 'active',
          },
        });
        const batchConflictEventTwo = createReplicationEvent({
          captureContextId: context.id,
          changeKind: 'device-fact-upsert',
          eventId: createReplicationEventId(),
          factKey,
          generation: parseReplicationGeneration(4),
          payload: {
            deviceId: exchanged.value.device.id,
            kind: 'device-fact-upsert',
            label: 'Concurrent batch winner two',
            lastSeenAt: observedAt,
            status: 'active',
          },
        });
        const batchConflictOne = createReplicationBatch({
          batchId: batchConflictId,
          captureContexts: [context],
          deviceId: exchanged.value.device.id,
          events: [batchConflictEventOne],
          fromGenerationExclusive: parseReplicationGeneration(3),
          streamId: USAGE_REPLICATION_STREAM_ID,
          toGenerationInclusive: parseReplicationGeneration(4),
        });
        const batchConflictTwo = createReplicationBatch({
          batchId: batchConflictId,
          captureContexts: [context],
          deviceId: exchanged.value.device.id,
          events: [batchConflictEventTwo],
          fromGenerationExclusive: parseReplicationGeneration(3),
          streamId: USAGE_REPLICATION_STREAM_ID,
          toGenerationInclusive: parseReplicationGeneration(4),
        });
        const concurrentBatchResults = await Promise.all([
          store.replication.applyBatch({ ...authenticated, batch: batchConflictOne }),
          store.replication.applyBatch({ ...authenticated, batch: batchConflictTwo }),
        ]);
        expect(concurrentBatchResults.filter(({ kind }) => kind === 'ack')).toHaveLength(1);
        expect(concurrentBatchResults.find(({ kind }) => kind === 'problem')).toEqual({
          kind: 'problem',
          problem: { code: 'batch-id-conflict' },
        });

        const sharedEventId = createReplicationEventId();
        const eventConflictOne = createReplicationEvent({
          captureContextId: context.id,
          changeKind: 'device-fact-upsert',
          eventId: sharedEventId,
          factKey,
          generation: parseReplicationGeneration(5),
          payload: {
            deviceId: exchanged.value.device.id,
            kind: 'device-fact-upsert',
            label: 'Concurrent event winner one',
            lastSeenAt: observedAt,
            status: 'active',
          },
        });
        const eventConflictTwo = createReplicationEvent({
          captureContextId: context.id,
          changeKind: 'device-fact-upsert',
          eventId: sharedEventId,
          factKey,
          generation: parseReplicationGeneration(5),
          payload: {
            deviceId: exchanged.value.device.id,
            kind: 'device-fact-upsert',
            label: 'Concurrent event winner two',
            lastSeenAt: observedAt,
            status: 'active',
          },
        });
        const eventConflictBatchOne = createReplicationBatch({
          batchId: createReplicationBatchId(),
          captureContexts: [context],
          deviceId: exchanged.value.device.id,
          events: [eventConflictOne],
          fromGenerationExclusive: parseReplicationGeneration(4),
          streamId: USAGE_REPLICATION_STREAM_ID,
          toGenerationInclusive: parseReplicationGeneration(5),
        });
        const eventConflictBatchTwo = createReplicationBatch({
          batchId: createReplicationBatchId(),
          captureContexts: [context],
          deviceId: exchanged.value.device.id,
          events: [eventConflictTwo],
          fromGenerationExclusive: parseReplicationGeneration(4),
          streamId: USAGE_REPLICATION_STREAM_ID,
          toGenerationInclusive: parseReplicationGeneration(5),
        });
        const concurrentEventResults = await Promise.all([
          store.replication.applyBatch({ ...authenticated, batch: eventConflictBatchOne }),
          store.replication.applyBatch({ ...authenticated, batch: eventConflictBatchTwo }),
        ]);
        expect(concurrentEventResults.filter(({ kind }) => kind === 'ack')).toHaveLength(1);
        expect(concurrentEventResults.find(({ kind }) => kind === 'problem')).toEqual({
          kind: 'problem',
          problem: { code: 'event-id-conflict' },
        });
        expect(await database.queryRowCount('SELECT 1 FROM replication_event_identities')).toBe(5);
        expect(await database.queryRowCount('SELECT 1 FROM replication_event_receipts')).toBe(5);
        expect(await database.queryRowCount('SELECT 1 FROM replication_batch_receipts')).toBe(5);

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
              generation: parseReplicationGeneration(6),
              payload: {
                deviceId: exchanged.value.device.id,
                kind: 'device-fact-upsert',
                label: 'Forbidden context',
                lastSeenAt: observedAt,
                status: 'active',
              },
            }),
          ],
          fromGenerationExclusive: parseReplicationGeneration(5),
          streamId: USAGE_REPLICATION_STREAM_ID,
          toGenerationInclusive: parseReplicationGeneration(6),
        });
        expect(await store.replication.applyBatch({ ...authenticated, batch: forbiddenBatch })).toEqual({
          kind: 'problem',
          problem: { code: 'capture-context-forbidden' },
        });
        expect(await database.queryRowCount('SELECT 1 FROM replication_event_receipts')).toBe(5);

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
        expect(await store.replication.applyBatch({ ...authenticated, batch: eventConflictBatchOne })).toEqual({
          kind: 'problem',
          problem: { code: 'revoked' },
        });
      } finally {
        await database.close().catch(() => undefined);
        await store.close().catch(() => undefined);
        await cluster.stop();
      }
    }, 30_000);

    test('accepts one Device batch containing independently authorized personal and organization contexts', async () => {
      const cluster = await startPostgresCluster('replication-multi-space-contexts');
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
        const personalSpaceId = createSpaceId();
        const organizationSpaceId = createSpaceId();
        const organizationProjectId = createProjectId();
        await store.identity.createPersonalIdentity({
          person: {
            displayName: 'Multi-space replication owner',
            id: personId,
            personalSpaceId,
            status: 'active',
          },
          space: {
            createdAt: observedAt,
            displayName: 'Personal replication space',
            id: personalSpaceId,
            kind: 'personal',
          },
        });
        await database.query(
          `INSERT INTO spaces (id, kind, display_name, created_at)
           VALUES ($1, 'organization', 'Organization replication space', $2)`,
          [organizationSpaceId, observedAt],
        );
        await store.authorization.administration.createOrganizationWithAdmin({
          actorPersonId: personId,
          createdAt: observedAt,
          spaceId: organizationSpaceId,
        });
        await store.identity.createProject({
          displayName: 'Organization replication project',
          id: organizationProjectId,
          kind: 'local',
          owningSpaceId: organizationSpaceId,
          repositoryId: null,
          repositorySubpath: null,
          status: 'active',
        });
        await store.authorization.administration.grantProjectAccess({
          actorPersonId: personId,
          expiresAt: null,
          grantedAt: observedAt,
          grantId: crypto.randomUUID(),
          projectId: organizationProjectId,
          role: 'viewer',
          spaceId: organizationSpaceId,
          subject: { kind: 'person', personId },
        });
        const key = createDeploymentTokenKey(Buffer.alloc(32, 72).toString('base64url'), 1);
        const devices = createDeviceEnrollmentService({
          authorizer: store.authorization,
          clock: () => new Date(observedAt),
          keyRing: createDeploymentTokenKeyRing([key], 1),
          store: store.devices,
        });
        const grant = await devices.requestEnrollmentGrant({
          context: { activeSpaceId: personalSpaceId, trustedDevice: false },
          label: 'Multi-space laptop',
          principal: { kind: 'person', personId },
        });
        if (grant.kind !== 'success') {
          throw new Error('Expected multi-space Device enrollment grant.');
        }
        const exchanged = await devices.exchangeEnrollmentGrant(grant.value.token);
        if (exchanged.kind !== 'success') {
          throw new Error('Expected multi-space Device enrollment exchange.');
        }
        const personalContext = {
          deviceId: exchanged.value.device.id,
          id: createCaptureContextId(),
          personId,
          projectId: null,
          scmAccountId: null,
          scmInstallationId: null,
          source: 'personal-fallback' as const,
          spaceId: personalSpaceId,
        };
        const organizationContext = {
          deviceId: exchanged.value.device.id,
          id: createCaptureContextId(),
          personId,
          projectId: organizationProjectId,
          scmAccountId: null,
          scmInstallationId: null,
          source: 'project-rule' as const,
          spaceId: organizationSpaceId,
        };
        await store.identity.saveCaptureContext(personalContext);
        await store.identity.saveCaptureContext(organizationContext);
        const personalEvent = createReplicationEvent({
          captureContextId: personalContext.id,
          changeKind: 'usage-session-upsert',
          eventId: createReplicationEventId(),
          factKey: 'usage-session:personal',
          generation: parseReplicationGeneration(1),
          payload: {
            harness: 'codex',
            kind: 'usage-session-upsert',
            model: 'gpt-5',
            observedAt,
            projectId: null,
            sourceFingerprint: 'a'.repeat(64),
            sourceSessionId: 'personal-session',
            status: 'active',
            tokenTotal: 10,
          },
        });
        const organizationEvent = createReplicationEvent({
          captureContextId: organizationContext.id,
          changeKind: 'usage-session-upsert',
          eventId: createReplicationEventId(),
          factKey: 'usage-session:organization',
          generation: parseReplicationGeneration(2),
          payload: {
            harness: 'codex',
            kind: 'usage-session-upsert',
            model: 'gpt-5',
            observedAt,
            projectId: organizationProjectId,
            sourceFingerprint: 'b'.repeat(64),
            sourceSessionId: 'organization-session',
            status: 'active',
            tokenTotal: 20,
          },
        });
        const batch = createReplicationBatch({
          batchId: createReplicationBatchId(),
          captureContexts: [personalContext, organizationContext],
          deviceId: exchanged.value.device.id,
          events: [personalEvent, organizationEvent],
          fromGenerationExclusive: parseReplicationGeneration(0),
          streamId: USAGE_REPLICATION_STREAM_ID,
          toGenerationInclusive: parseReplicationGeneration(2),
        });
        const accepted = await store.replication.applyBatch({
          authenticatedCredentialId: exchanged.value.credential.id,
          authenticatedDevice: exchanged.value.device,
          batch,
        });
        expect(accepted).toMatchObject({
          ack: { counts: { applied: 2, duplicate: 0, projected: 2, tombstoned: 0 } },
          kind: 'ack',
        });
        if (accepted.kind !== 'ack') {
          throw new Error('Expected multi-space replication ACK.');
        }
        expect(
          await database.queryRowCountInSpace(
            personalSpaceId,
            'SELECT 1 FROM replicated_fact_projections WHERE fact_key = $1',
            [personalEvent.factKey],
          ),
        ).toBe(1);
        expect(
          await database.queryRowCountInSpace(
            organizationSpaceId,
            'SELECT 1 FROM replicated_fact_projections WHERE fact_key = $1',
            [organizationEvent.factKey],
          ),
        ).toBe(1);
        expect(
          await database.queryRowCount(
            'SELECT 1 FROM replication_stream_states WHERE device_id = $1 AND space_id = $2',
            [exchanged.value.device.id, personalSpaceId],
          ),
        ).toBe(1);
        expect(
          await database.queryRowCount(
            'SELECT 1 FROM replication_stream_states WHERE device_id = $1 AND space_id = $2',
            [exchanged.value.device.id, organizationSpaceId],
          ),
        ).toBe(0);

        const reusedAcrossSpaces = createReplicationEvent({
          captureContextId: personalContext.id,
          changeKind: 'usage-session-upsert',
          eventId: organizationEvent.eventId,
          factKey: 'usage-session:cross-space-event-id-conflict',
          generation: parseReplicationGeneration(3),
          payload: {
            harness: 'codex',
            kind: 'usage-session-upsert',
            model: 'gpt-5',
            observedAt,
            projectId: null,
            sourceFingerprint: 'c'.repeat(64),
            sourceSessionId: 'cross-space-event-id-conflict',
            status: 'active',
            tokenTotal: 30,
          },
        });
        const collisionBatch = createReplicationBatch({
          batchId: createReplicationBatchId(),
          captureContexts: [personalContext],
          deviceId: exchanged.value.device.id,
          events: [reusedAcrossSpaces],
          fromGenerationExclusive: parseReplicationGeneration(2),
          previousAckProof: replicationAckProof(accepted.ack),
          streamId: USAGE_REPLICATION_STREAM_ID,
          toGenerationInclusive: parseReplicationGeneration(3),
        });
        expect(
          await store.replication.applyBatch({
            authenticatedCredentialId: exchanged.value.credential.id,
            authenticatedDevice: exchanged.value.device,
            batch: collisionBatch,
          }),
        ).toEqual({ kind: 'problem', problem: { code: 'event-id-conflict' } });
        expect(await database.queryRowCount('SELECT 1 FROM replication_event_receipts')).toBe(2);
      } finally {
        await database.close().catch(() => undefined);
        await store.close().catch(() => undefined);
        await cluster.stop();
      }
    }, 30_000);
  });
}
