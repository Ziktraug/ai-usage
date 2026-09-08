import { describe, expect, test } from 'bun:test';
import { createDeviceEnrollmentService } from '@ai-usage/identity/device-enrollment';
import { createDeploymentTokenKey, createDeploymentTokenKeyRing } from '@ai-usage/identity/device-tokens';
import {
  createCaptureContextId,
  createPersonId,
  createProjectId,
  createSpaceId,
  instantNow,
  type ProjectId,
} from '@ai-usage/platform-core/identity';
import { createPlatformTestingDatabase } from '@ai-usage/postgres-store/testing';
import { createPlatformStore } from '@ai-usage/postgres-store/writer';
import {
  createReplicationBatch,
  createReplicationBatchId,
  createReplicationEvent,
  createReplicationEventId,
  parseReplicationGeneration,
  type ReplicationAck,
  type ReplicationEvent,
  replicationAckProof,
  USAGE_REPLICATION_STREAM_ID,
} from '@ai-usage/replication-protocol';
import { startPostgresCluster } from './pg-harness';

const runPostgresTests = process.env.AI_USAGE_RUN_POSTGRES_TESTS === '1';
const observedAt = instantNow(() => new Date('2026-08-30T12:00:00.000Z'));

/** Creates a Person with a personal Space and enrolls one Device for them. */
const enrollContributor = async (
  store: Awaited<ReturnType<typeof createPlatformStore>>,
  devices: ReturnType<typeof createDeviceEnrollmentService>,
  displayName: string,
) => {
  const personId = createPersonId();
  const personalSpaceId = createSpaceId();
  await store.identity.createPersonalIdentity({
    person: { displayName, id: personId, personalSpaceId, status: 'active' },
    space: {
      createdAt: observedAt,
      displayName: `${displayName} space`,
      id: personalSpaceId,
      kind: 'personal',
    },
  });
  const grant = await devices.requestEnrollmentGrant({
    context: { activeSpaceId: personalSpaceId, trustedDevice: false },
    label: `${displayName} laptop`,
    principal: { kind: 'person', personId },
  });
  if (grant.kind !== 'success') {
    throw new Error(`Expected Device enrollment grant for ${displayName}.`);
  }
  const exchanged = await devices.exchangeEnrollmentGrant(grant.value.token);
  if (exchanged.kind !== 'success') {
    throw new Error(`Expected Device enrollment exchange for ${displayName}.`);
  }
  return {
    authenticated: {
      authenticatedCredentialId: exchanged.value.credential.id,
      authenticatedDevice: exchanged.value.device,
    },
    deviceId: exchanged.value.device.id,
    personId,
    token: exchanged.value.token,
  };
};

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
          role: 'collaborator',
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

    test('requires contribution-level authority for organization capture contexts', async () => {
      const cluster = await startPostgresCluster('replication-contribution-authority');
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
        const adminPersonId = createPersonId();
        const adminSpaceId = createSpaceId();
        const organizationSpaceId = createSpaceId();
        const organizationProjectId = createProjectId();
        await store.identity.createPersonalIdentity({
          person: {
            displayName: 'Organization admin',
            id: adminPersonId,
            personalSpaceId: adminSpaceId,
            status: 'active',
          },
          space: { createdAt: observedAt, displayName: 'Admin personal space', id: adminSpaceId, kind: 'personal' },
        });
        await database.query(
          `INSERT INTO spaces (id, kind, display_name, created_at)
           VALUES ($1, 'organization', 'Contribution authority organization', $2)`,
          [organizationSpaceId, observedAt],
        );
        await store.authorization.administration.createOrganizationWithAdmin({
          actorPersonId: adminPersonId,
          createdAt: observedAt,
          spaceId: organizationSpaceId,
        });
        await store.identity.createProject({
          displayName: 'Contribution authority project',
          id: organizationProjectId,
          kind: 'local',
          owningSpaceId: organizationSpaceId,
          repositoryId: null,
          repositorySubpath: null,
          status: 'active',
        });
        const key = createDeploymentTokenKey(Buffer.alloc(32, 73).toString('base64url'), 1);
        const devices = createDeviceEnrollmentService({
          authorizer: store.authorization,
          clock: () => new Date(observedAt),
          keyRing: createDeploymentTokenKeyRing([key], 1),
          store: store.devices,
        });

        const enrollPerson = (displayName: string) => enrollContributor(store, devices, displayName);
        const publishOrganizationSession = async (
          person: Awaited<ReturnType<typeof enrollPerson>>,
          projectId: typeof organizationProjectId | null,
          sessionName: string,
        ) => {
          const context = {
            deviceId: person.deviceId,
            id: createCaptureContextId(),
            personId: person.personId,
            projectId,
            scmAccountId: null,
            scmInstallationId: null,
            source: projectId === null ? ('explicit' as const) : ('project-rule' as const),
            spaceId: organizationSpaceId,
          };
          const event = createReplicationEvent({
            captureContextId: context.id,
            changeKind: 'usage-session-upsert',
            eventId: createReplicationEventId(),
            factKey: `usage-session:${sessionName}`,
            generation: parseReplicationGeneration(1),
            payload: {
              harness: 'codex',
              kind: 'usage-session-upsert',
              model: 'gpt-5',
              observedAt,
              projectId,
              sourceFingerprint: 'd'.repeat(64),
              sourceSessionId: sessionName,
              status: 'active',
              tokenTotal: 10,
            },
          });
          const batch = createReplicationBatch({
            batchId: createReplicationBatchId(),
            captureContexts: [context],
            deviceId: person.deviceId,
            events: [event],
            fromGenerationExclusive: parseReplicationGeneration(0),
            streamId: USAGE_REPLICATION_STREAM_ID,
            toGenerationInclusive: parseReplicationGeneration(1),
          });
          const result = await store.replication.applyBatch({ ...person.authenticated, batch });
          const contextRows = await database.queryRowCountInSpace(
            organizationSpaceId,
            'SELECT 1 FROM capture_contexts WHERE id = $1',
            [context.id],
          );
          const projectionRows = await database.queryRowCountInSpace(
            organizationSpaceId,
            'SELECT 1 FROM replicated_fact_projections WHERE fact_key = $1',
            [event.factKey],
          );
          const receiptRows = await database.queryRowCount(
            'SELECT 1 FROM replication_event_receipts WHERE device_id = $1',
            [person.deviceId],
          );
          return { contextRows, projectionRows, receiptRows, result };
        };

        const viewer = await enrollPerson('Project viewer');
        await store.authorization.administration.grantProjectAccess({
          actorPersonId: adminPersonId,
          expiresAt: null,
          grantedAt: observedAt,
          grantId: crypto.randomUUID(),
          projectId: organizationProjectId,
          role: 'viewer',
          spaceId: organizationSpaceId,
          subject: { kind: 'person', personId: viewer.personId },
        });
        expect(await publishOrganizationSession(viewer, organizationProjectId, 'viewer-session')).toEqual({
          contextRows: 0,
          projectionRows: 0,
          receiptRows: 0,
          result: { kind: 'problem', problem: { code: 'capture-context-forbidden' } },
        });

        const auditor = await enrollPerson('Usage auditor');
        await database.withSpaceContext(organizationSpaceId, (query) =>
          query(
            `INSERT INTO space_memberships (space_id, person_id, role, status, created_at)
             VALUES ($1, $2, 'usage-auditor', 'active', $3)`,
            [organizationSpaceId, auditor.personId, observedAt],
          ),
        );
        expect(await publishOrganizationSession(auditor, null, 'auditor-session')).toEqual({
          contextRows: 0,
          projectionRows: 0,
          receiptRows: 0,
          result: { kind: 'problem', problem: { code: 'capture-context-forbidden' } },
        });
        expect(await publishOrganizationSession(auditor, organizationProjectId, 'auditor-project-session')).toEqual({
          contextRows: 0,
          projectionRows: 0,
          receiptRows: 0,
          result: { kind: 'problem', problem: { code: 'capture-context-forbidden' } },
        });

        const collaborator = await enrollPerson('Project collaborator');
        await store.authorization.administration.grantProjectAccess({
          actorPersonId: adminPersonId,
          expiresAt: null,
          grantedAt: observedAt,
          grantId: crypto.randomUUID(),
          projectId: organizationProjectId,
          role: 'collaborator',
          spaceId: organizationSpaceId,
          subject: { kind: 'person', personId: collaborator.personId },
        });
        expect(
          await publishOrganizationSession(collaborator, organizationProjectId, 'collaborator-session'),
        ).toMatchObject({
          contextRows: 1,
          projectionRows: 1,
          receiptRows: 1,
          result: { ack: { counts: { applied: 1, duplicate: 0, projected: 1, tombstoned: 0 } }, kind: 'ack' },
        });
      } finally {
        await database.close().catch(() => undefined);
        await store.close().catch(() => undefined);
        await cluster.stop();
      }
    }, 30_000);

    test('binds a fact projection to the Device that first published it', async () => {
      const cluster = await startPostgresCluster('replication-fact-owner');
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
        const adminPersonId = createPersonId();
        const adminSpaceId = createSpaceId();
        const organizationSpaceId = createSpaceId();
        const projectAId = createProjectId();
        const projectBId = createProjectId();
        await store.identity.createPersonalIdentity({
          person: {
            displayName: 'Fact owner organization admin',
            id: adminPersonId,
            personalSpaceId: adminSpaceId,
            status: 'active',
          },
          space: { createdAt: observedAt, displayName: 'Fact owner admin space', id: adminSpaceId, kind: 'personal' },
        });
        await database.query(
          `INSERT INTO spaces (id, kind, display_name, created_at)
           VALUES ($1, 'organization', 'Fact owner organization', $2)`,
          [organizationSpaceId, observedAt],
        );
        await store.authorization.administration.createOrganizationWithAdmin({
          actorPersonId: adminPersonId,
          createdAt: observedAt,
          spaceId: organizationSpaceId,
        });
        for (const [id, displayName] of [
          [projectAId, 'Fact owner project A'],
          [projectBId, 'Fact owner project B'],
        ] as const) {
          await store.identity.createProject({
            displayName,
            id,
            kind: 'local',
            owningSpaceId: organizationSpaceId,
            repositoryId: null,
            repositorySubpath: null,
            status: 'active',
          });
        }
        const key = createDeploymentTokenKey(Buffer.alloc(32, 74).toString('base64url'), 1);
        const devices = createDeviceEnrollmentService({
          authorizer: store.authorization,
          clock: () => new Date(observedAt),
          keyRing: createDeploymentTokenKeyRing([key], 1),
          store: store.devices,
        });
        const grantCollaborator = (personId: ReturnType<typeof createPersonId>, projectId: ProjectId) =>
          store.authorization.administration.grantProjectAccess({
            actorPersonId: adminPersonId,
            expiresAt: null,
            grantedAt: observedAt,
            grantId: crypto.randomUUID(),
            projectId,
            role: 'collaborator',
            spaceId: organizationSpaceId,
            subject: { kind: 'person', personId },
          });
        const publisher = await enrollContributor(store, devices, 'Fact publisher');
        await grantCollaborator(publisher.personId, projectAId);
        await grantCollaborator(publisher.personId, projectBId);
        const contributor = await enrollContributor(store, devices, 'Project B contributor');
        await grantCollaborator(contributor.personId, projectBId);

        type Contributor = Awaited<ReturnType<typeof enrollContributor>>;
        const factKey = 'usage-session:shared-fact-key';
        const projectContext = (person: Contributor, projectId: ProjectId) => ({
          deviceId: person.deviceId,
          id: createCaptureContextId(),
          personId: person.personId,
          projectId,
          scmAccountId: null,
          scmInstallationId: null,
          source: 'project-rule' as const,
          spaceId: organizationSpaceId,
        });
        const sessionUpsert = (
          context: ReturnType<typeof projectContext>,
          generation: number,
          sessionName: string,
          key = factKey,
        ): ReplicationEvent =>
          createReplicationEvent({
            captureContextId: context.id,
            changeKind: 'usage-session-upsert',
            eventId: createReplicationEventId(),
            factKey: key,
            generation: parseReplicationGeneration(generation),
            payload: {
              harness: 'codex',
              kind: 'usage-session-upsert',
              model: 'gpt-5',
              observedAt,
              projectId: context.projectId,
              sourceFingerprint: 'e'.repeat(64),
              sourceSessionId: sessionName,
              status: 'active',
              tokenTotal: 10 * generation,
            },
          });
        const sessionTombstone = (context: ReturnType<typeof projectContext>, generation: number): ReplicationEvent =>
          createReplicationEvent({
            captureContextId: context.id,
            changeKind: 'usage-session-tombstone',
            eventId: createReplicationEventId(),
            factKey,
            generation: parseReplicationGeneration(generation),
            payload: { kind: 'usage-session-tombstone', reasonCode: 'source-deleted', tombstonedAt: observedAt },
          });
        const publish = (
          person: Contributor,
          context: ReturnType<typeof projectContext>,
          event: ReplicationEvent,
          previousAck?: ReplicationAck,
        ) =>
          store.replication.applyBatch({
            ...person.authenticated,
            batch: createReplicationBatch({
              batchId: createReplicationBatchId(),
              captureContexts: [context],
              deviceId: person.deviceId,
              events: [event],
              fromGenerationExclusive: parseReplicationGeneration(event.generation - 1),
              ...(previousAck === undefined ? {} : { previousAckProof: replicationAckProof(previousAck) }),
              streamId: USAGE_REPLICATION_STREAM_ID,
              toGenerationInclusive: event.generation,
            }),
          });
        const projectionRows = (
          deviceId: Contributor['deviceId'],
          projectId: ProjectId,
          event: ReplicationEvent,
          status: 'active' | 'tombstone',
        ) =>
          database.queryRowCountInSpace(
            organizationSpaceId,
            `SELECT 1 FROM replicated_fact_projections
             WHERE fact_key = $1 AND device_id = $2 AND project_id = $3 AND current_event_id = $4
               AND status = $5 AND content_hash = $6 AND payload = $7::JSONB`,
            [factKey, deviceId, projectId, event.eventId, status, event.contentHash, JSON.stringify(event.payload)],
          );
        const deviceRows = async (deviceId: Contributor['deviceId']) => ({
          batchReceipts: await database.queryRowCount('SELECT 1 FROM replication_batch_receipts WHERE device_id = $1', [
            deviceId,
          ]),
          eventIdentities: await database.queryRowCount(
            'SELECT 1 FROM replication_event_identities WHERE device_id = $1',
            [deviceId],
          ),
          eventReceipts: await database.queryRowCount('SELECT 1 FROM replication_event_receipts WHERE device_id = $1', [
            deviceId,
          ]),
          streamStates: await database.queryRowCount('SELECT 1 FROM replication_stream_states WHERE device_id = $1', [
            deviceId,
          ]),
        });

        const publisherContextA = projectContext(publisher, projectAId);
        const firstEvent = sessionUpsert(publisherContextA, 1, 'publisher-project-a');
        const first = await publish(publisher, publisherContextA, firstEvent);
        expect(first).toMatchObject({
          ack: { counts: { applied: 1, duplicate: 0, projected: 1, tombstoned: 0 } },
          kind: 'ack',
        });
        if (first.kind !== 'ack') {
          throw new Error('Expected the first fact-owner ACK.');
        }
        expect(await projectionRows(publisher.deviceId, projectAId, firstEvent, 'active')).toBe(1);

        // Another Device with contribution authority in the same Space (Project B
        // collaborator) reuses the publisher's fact key: neither an upsert nor a
        // tombstone may touch the projection, and the rejected batches leave no
        // receipt, identity, context, or stream state behind.
        const contributorContextB = projectContext(contributor, projectBId);
        expect(
          await publish(contributor, contributorContextB, sessionUpsert(contributorContextB, 1, 'contributor-b')),
        ).toEqual({ kind: 'problem', problem: { code: 'fact-owner-conflict' } });
        expect(await publish(contributor, contributorContextB, sessionTombstone(contributorContextB, 1))).toEqual({
          kind: 'problem',
          problem: { code: 'fact-owner-conflict' },
        });
        expect(await projectionRows(publisher.deviceId, projectAId, firstEvent, 'active')).toBe(1);
        expect(await deviceRows(contributor.deviceId)).toEqual({
          batchReceipts: 0,
          eventIdentities: 0,
          eventReceipts: 0,
          streamStates: 0,
        });
        expect(
          await database.queryRowCountInSpace(organizationSpaceId, 'SELECT 1 FROM capture_contexts WHERE id = $1', [
            contributorContextB.id,
          ]),
        ).toBe(0);
        expect(
          await database.queryRowCountInSpace(organizationSpaceId, 'SELECT 1 FROM replicated_fact_projections'),
        ).toBe(1);

        // The contributor's generation was not advanced server-side: its own
        // fact still publishes at generation 1 through the same context.
        expect(
          await publish(
            contributor,
            contributorContextB,
            sessionUpsert(contributorContextB, 1, 'contributor-own', 'usage-session:contributor-own'),
          ),
        ).toMatchObject({
          ack: { acceptedThroughGeneration: 1, counts: { applied: 1, duplicate: 0, projected: 1, tombstoned: 0 } },
          kind: 'ack',
        });

        // The owning Device re-assigns the same fact to Project B, then tombstones it.
        const publisherContextB = projectContext(publisher, projectBId);
        const reassigned = sessionUpsert(publisherContextB, 2, 'publisher-project-b');
        const second = await publish(publisher, publisherContextB, reassigned, first.ack);
        expect(second).toMatchObject({
          ack: { counts: { applied: 1, duplicate: 0, projected: 1, tombstoned: 0 } },
          kind: 'ack',
        });
        if (second.kind !== 'ack') {
          throw new Error('Expected the re-assignment ACK.');
        }
        expect(await projectionRows(publisher.deviceId, projectBId, reassigned, 'active')).toBe(1);

        const tombstone = sessionTombstone(publisherContextB, 3);
        expect(await publish(publisher, publisherContextB, tombstone, second.ack)).toMatchObject({
          ack: { counts: { applied: 1, duplicate: 0, projected: 1, tombstoned: 1 } },
          kind: 'ack',
        });
        expect(await projectionRows(publisher.deviceId, projectBId, tombstone, 'tombstone')).toBe(1);
        expect(
          await database.queryRowCountInSpace(
            organizationSpaceId,
            'SELECT 1 FROM replication_event_receipts WHERE fact_key = $1 AND device_id = $2',
            [factKey, publisher.deviceId],
          ),
        ).toBe(3);
        expect(
          await database.queryRowCountInSpace(
            organizationSpaceId,
            'SELECT 1 FROM replication_event_receipts WHERE fact_key = $1',
            [factKey],
          ),
        ).toBe(3);
      } finally {
        await database.close().catch(() => undefined);
        await store.close().catch(() => undefined);
        await cluster.stop();
      }
    }, 30_000);

    test('rejects publication while the owner Person of an authenticated Device is suspended', async () => {
      const cluster = await startPostgresCluster('replication-suspended-owner');
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
        const key = createDeploymentTokenKey(Buffer.alloc(32, 75).toString('base64url'), 1);
        const devices = createDeviceEnrollmentService({
          authorizer: store.authorization,
          clock: () => new Date(observedAt),
          keyRing: createDeploymentTokenKeyRing([key], 1),
          store: store.devices,
        });
        const owner = await enrollContributor(store, devices, 'Suspended publisher');
        const personalSpaceId = owner.authenticated.authenticatedDevice.owningSpaceId;
        const organizationSpaceId = createSpaceId();
        await database.query(
          `INSERT INTO spaces (id, kind, display_name, created_at)
           VALUES ($1, 'organization', 'Suspended owner organization', $2)`,
          [organizationSpaceId, observedAt],
        );
        await store.authorization.administration.createOrganizationWithAdmin({
          actorPersonId: owner.personId,
          createdAt: observedAt,
          spaceId: organizationSpaceId,
        });
        const contextIn = (spaceId: typeof organizationSpaceId) => ({
          deviceId: owner.deviceId,
          id: createCaptureContextId(),
          personId: owner.personId,
          projectId: null,
          scmAccountId: null,
          scmInstallationId: null,
          source: spaceId === personalSpaceId ? ('personal-fallback' as const) : ('explicit' as const),
          spaceId,
        });
        const publish = (context: ReturnType<typeof contextIn>, generation: number, sessionName: string) =>
          store.replication.applyBatch({
            ...owner.authenticated,
            batch: createReplicationBatch({
              batchId: createReplicationBatchId(),
              captureContexts: [context],
              deviceId: owner.deviceId,
              events: [
                createReplicationEvent({
                  captureContextId: context.id,
                  changeKind: 'usage-session-upsert',
                  eventId: createReplicationEventId(),
                  factKey: `usage-session:${sessionName}`,
                  generation: parseReplicationGeneration(generation),
                  payload: {
                    harness: 'codex',
                    kind: 'usage-session-upsert',
                    model: 'gpt-5',
                    observedAt,
                    projectId: null,
                    sourceFingerprint: 'f'.repeat(64),
                    sourceSessionId: sessionName,
                    status: 'active',
                    tokenTotal: 10,
                  },
                }),
              ],
              fromGenerationExclusive: parseReplicationGeneration(generation - 1),
              streamId: USAGE_REPLICATION_STREAM_ID,
              toGenerationInclusive: parseReplicationGeneration(generation),
            }),
          });
        const serverState = async () => ({
          acceptedGenerations: await database.queryRowCount(
            'SELECT 1 FROM replication_stream_states WHERE device_id = $1 AND accepted_through_generation = 1',
            [owner.deviceId],
          ),
          batchReceipts: await database.queryRowCount('SELECT 1 FROM replication_batch_receipts WHERE device_id = $1', [
            owner.deviceId,
          ]),
          eventReceipts: await database.queryRowCount('SELECT 1 FROM replication_event_receipts WHERE device_id = $1', [
            owner.deviceId,
          ]),
          organizationProjections: await database.queryRowCount(
            'SELECT 1 FROM replicated_fact_projections WHERE space_id = $1',
            [organizationSpaceId],
          ),
          personalProjections: await database.queryRowCount(
            'SELECT 1 FROM replicated_fact_projections WHERE space_id = $1',
            [personalSpaceId],
          ),
        });

        const organizationContext = contextIn(organizationSpaceId);
        expect(await publish(organizationContext, 1, 'before-suspension')).toMatchObject({
          ack: { acceptedThroughGeneration: 1 },
          kind: 'ack',
        });
        const publishedState = {
          acceptedGenerations: 1,
          batchReceipts: 1,
          eventReceipts: 1,
          organizationProjections: 1,
          personalProjections: 0,
        };
        expect(await serverState()).toEqual(publishedState);

        // The owner is suspended after the Device authenticated. Its membership,
        // Device, and credential stay in place, yet neither the organization nor
        // the personal Space may receive facts, and the rejected batches leave no
        // receipt, Capture Context, projection, or generation change behind.
        await database.query("UPDATE people SET status = 'suspended' WHERE id = $1", [owner.personId]);
        await expect(devices.authenticateDevice(owner.token)).resolves.toMatchObject({
          error: { code: 'identity-revoked' },
          kind: 'error',
        });
        const suspendedOrganizationContext = contextIn(organizationSpaceId);
        const suspendedPersonalContext = contextIn(personalSpaceId);
        expect(await publish(suspendedOrganizationContext, 2, 'suspended-organization')).toEqual({
          kind: 'problem',
          problem: { code: 'revoked' },
        });
        expect(await publish(suspendedPersonalContext, 2, 'suspended-personal')).toEqual({
          kind: 'problem',
          problem: { code: 'revoked' },
        });
        expect(await serverState()).toEqual(publishedState);
        expect(
          await database.queryRowCount('SELECT 1 FROM capture_contexts WHERE id = ANY($1::UUID[])', [
            [suspendedOrganizationContext.id, suspendedPersonalContext.id],
          ]),
        ).toBe(0);

        await database.query("UPDATE people SET status = 'active' WHERE id = $1", [owner.personId]);
        await expect(devices.authenticateDevice(owner.token)).resolves.toMatchObject({ kind: 'success' });
        expect(await publish(suspendedOrganizationContext, 2, 'after-reactivation')).toMatchObject({
          ack: { acceptedThroughGeneration: 2 },
          kind: 'ack',
        });
        expect(await serverState()).toEqual({
          acceptedGenerations: 0,
          batchReceipts: 2,
          eventReceipts: 2,
          organizationProjections: 2,
          personalProjections: 0,
        });
      } finally {
        await database.close().catch(() => undefined);
        await store.close().catch(() => undefined);
        await cluster.stop();
      }
    }, 30_000);
  });
}
