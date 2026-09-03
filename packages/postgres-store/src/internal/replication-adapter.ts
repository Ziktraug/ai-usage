import {
  type CaptureContextId,
  instantNow,
  type ProjectId,
  parseCaptureContextId,
  parseDeviceId,
  parsePersonId,
  parseProjectId,
  parseScmAccountId,
  parseScmInstallationId,
  parseSpaceId,
  type SpaceId,
} from '@ai-usage/platform-core/identity';
import {
  type CaptureContextSnapshot,
  parseReplicationAck,
  parseReplicationBatch,
  parseReplicationGeneration,
  type ReplicationAck,
  type ReplicationBatch,
  type ReplicationEvent,
  type ReplicationGeneration,
  type ReplicationProblem,
  replicationAckProof,
  replicationHash,
} from '@ai-usage/replication-protocol';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { PlatformStoreError } from '../errors';
import type { ApplyReplicationBatchResult, PlatformReplicationStore } from '../replication';
import { authorizationScopeSql } from './authorization-query';
import { withPlatformSpaceTransaction } from './space-transaction';

const replicationHashPattern = /^[0-9a-f]{64}$/u;

interface BatchReceiptRow extends QueryResultRow {
  readonly idempotency_key: unknown;
  readonly request_hash: unknown;
  readonly stored_ack: unknown;
}

interface CaptureContextRow extends QueryResultRow {
  readonly device_id: unknown;
  readonly id: unknown;
  readonly person_id: unknown;
  readonly project_id: unknown;
  readonly scm_account_id: unknown;
  readonly scm_installation_id: unknown;
  readonly source: unknown;
  readonly space_id: unknown;
}

interface EventReceiptRow extends QueryResultRow {
  readonly capture_context_id: unknown;
  readonly change_kind: unknown;
  readonly content_hash: unknown;
  readonly event_id: unknown;
  readonly fact_key: unknown;
  readonly generation: unknown;
}

interface EventIdentityRow extends QueryResultRow {
  readonly event_hash: unknown;
}

interface GenerationRow extends QueryResultRow {
  readonly accepted_through_generation: unknown;
  readonly last_ack_proof: unknown;
}

interface IdRow extends QueryResultRow {
  readonly id: unknown;
}

type ReplicationProblemResult = Extract<ApplyReplicationBatchResult, { readonly kind: 'problem' }>;

class ReplicationProblemRollback extends PlatformStoreError {
  readonly result: ReplicationProblemResult;

  constructor(result: ReplicationProblemResult) {
    super('validation-failed', 'rollback-replication-problem');
    this.name = 'ReplicationProblemRollback';
    this.result = result;
  }
}

const problem = (
  code: ReplicationProblem['code'],
  expectedGeneration?: ReplicationGeneration,
): ReplicationProblemResult => ({
  kind: 'problem',
  problem: {
    code,
    ...(expectedGeneration === undefined ? {} : { expectedGeneration }),
  },
});

const integer = (value: unknown, field: string): number => {
  const parsed = typeof value === 'string' ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || (parsed as number) < 0) {
    throw new PlatformStoreError('validation-failed', `map-${field}`);
  }
  return parsed as number;
};

const optionalId = <Value>(value: unknown, parse: (candidate: unknown) => Value): Value | null =>
  value === null ? null : parse(value);

const activateSpace = async (client: PoolClient, spaceId: SpaceId): Promise<void> => {
  const result = await client.query<{ readonly active_space_id: unknown }>(
    "SELECT set_config('ai_usage.active_space_id', $1, TRUE) AS active_space_id",
    [spaceId],
  );
  if (result.rows[0]?.active_space_id !== spaceId) {
    throw new PlatformStoreError('validation-failed', 'activate-replication-space');
  }
};

const mapCaptureContext = (row: CaptureContextRow): CaptureContextSnapshot => {
  if (
    row.source !== 'explicit' &&
    row.source !== 'personal-fallback' &&
    row.source !== 'project-rule' &&
    row.source !== 'unassigned'
  ) {
    throw new PlatformStoreError('validation-failed', 'map-capture-context-source');
  }
  return {
    deviceId: parseDeviceId(row.device_id),
    id: parseCaptureContextId(row.id),
    personId: parsePersonId(row.person_id),
    projectId: optionalId(row.project_id, parseProjectId),
    scmAccountId: optionalId(row.scm_account_id, parseScmAccountId),
    scmInstallationId: optionalId(row.scm_installation_id, parseScmInstallationId),
    source: row.source,
    spaceId: parseSpaceId(row.space_id),
  };
};

const sameCaptureContext = (left: CaptureContextSnapshot, right: CaptureContextSnapshot): boolean =>
  left.deviceId === right.deviceId &&
  left.id === right.id &&
  left.personId === right.personId &&
  left.projectId === right.projectId &&
  left.scmAccountId === right.scmAccountId &&
  left.scmInstallationId === right.scmInstallationId &&
  left.source === right.source &&
  left.spaceId === right.spaceId;

const payloadProjectId = (event: ReplicationEvent): ProjectId | null | undefined =>
  'projectId' in event.payload ? event.payload.projectId : undefined;

const streamAcceptsEvent = (batch: ReplicationBatch, event: ReplicationEvent): boolean =>
  (batch.streamId === 'usage-v1' ? !event.changeKind.startsWith('memory-') : event.changeKind.startsWith('memory-')) &&
  (event.payload.kind !== 'device-fact-upsert' || event.payload.deviceId === batch.deviceId);

const eventMatchesReceipt = (event: ReplicationEvent, receipt: EventReceiptRow): boolean =>
  receipt.event_id === event.eventId &&
  integer(receipt.generation, 'replication-event-generation') === event.generation &&
  receipt.fact_key === event.factKey &&
  receipt.content_hash === event.contentHash &&
  receipt.change_kind === event.changeKind &&
  receipt.capture_context_id === event.captureContextId;

const readBatchReceipt = async (client: PoolClient, batch: ReplicationBatch): Promise<BatchReceiptRow | undefined> => {
  const result = await client.query<BatchReceiptRow>(
    `SELECT idempotency_key, request_hash, stored_ack
     FROM replication_batch_receipts
     WHERE device_id = $1 AND stream_id = $2 AND batch_id = $3`,
    [batch.deviceId, batch.streamId, batch.batchId],
  );
  return result.rows[0];
};

const priorBatchResult = (
  row: BatchReceiptRow,
  batch: ReplicationBatch,
  requestHash: string,
): ApplyReplicationBatchResult => {
  if (row.idempotency_key !== batch.idempotencyKey || row.request_hash !== requestHash) {
    return problem('batch-id-conflict');
  }
  try {
    return { ack: parseReplicationAck(row.stored_ack), kind: 'ack' };
  } catch {
    throw new PlatformStoreError('validation-failed', 'map-replication-batch-ack');
  }
};

const credentialIsCurrent = async (
  client: PoolClient,
  input: Parameters<PlatformReplicationStore['applyBatch']>[0],
): Promise<boolean> => {
  const result = await client.query<IdRow>(
    `SELECT credential.id
     FROM device_credentials credential
     INNER JOIN devices device
       ON device.id = credential.device_id AND device.space_id = credential.space_id
     WHERE credential.id = $1
       AND credential.device_id = $2
       AND credential.space_id = $3
       AND credential.revoked_at IS NULL
       AND device.owner_person_id = $4
       AND device.status = 'active'
     FOR UPDATE OF credential, device`,
    [
      input.authenticatedCredentialId,
      input.authenticatedDevice.id,
      input.authenticatedDevice.owningSpaceId,
      input.authenticatedDevice.ownerPersonId,
    ],
  );
  return result.rows.length === 1;
};

const authorizeSpaceContext = async (client: PoolClient, context: CaptureContextSnapshot): Promise<boolean> => {
  const result = await client.query<IdRow>(
    `SELECT space.id
     FROM spaces space
     WHERE space.id = $1
       AND (
         EXISTS (
           SELECT 1 FROM people owner
           WHERE owner.id = $2
             AND owner.personal_space_id = space.id
             AND owner.status = 'active'
         )
         OR EXISTS (
           SELECT 1
           FROM organizations organization
           INNER JOIN space_memberships membership ON membership.space_id = organization.space_id
           WHERE organization.space_id = space.id
             AND organization.status = 'active'
             AND membership.person_id = $2
             AND membership.status = 'active'
         )
       )`,
    [context.spaceId, context.personId],
  );
  return result.rows.length === 1;
};

const authorizeProjectContext = async (client: PoolClient, context: CaptureContextSnapshot): Promise<boolean> => {
  if (context.projectId === null) {
    return authorizeSpaceContext(client, context);
  }
  const query = authorizationScopeSql('view_project', 'project');
  if (!query) {
    throw new PlatformStoreError('validation-failed', 'resolve-replication-project-scope');
  }
  const result = await client.query<IdRow>(`SELECT id FROM (${query}) scope WHERE id = $4::UUID LIMIT 1`, [
    context.spaceId,
    context.personId,
    true,
    context.projectId,
  ]);
  return result.rows.length === 1;
};

const scmContextIsBound = async (client: PoolClient, context: CaptureContextSnapshot): Promise<boolean> => {
  if (context.scmAccountId !== null) {
    const account = await client.query<IdRow>('SELECT id FROM scm_accounts WHERE id = $1 AND person_id = $2', [
      context.scmAccountId,
      context.personId,
    ]);
    if (account.rows.length !== 1) {
      return false;
    }
  }
  if (context.scmInstallationId !== null) {
    const installation = await client.query<IdRow>(
      `SELECT id FROM scm_installations
       WHERE id = $1 AND space_id = $2 AND status = 'active'`,
      [context.scmInstallationId, context.spaceId],
    );
    if (installation.rows.length !== 1) {
      return false;
    }
  }
  return true;
};

const validateCaptureContexts = async (
  client: PoolClient,
  input: Parameters<PlatformReplicationStore['applyBatch']>[0],
  batch: ReplicationBatch,
): Promise<Map<CaptureContextId, CaptureContextSnapshot> | null> => {
  const contexts = new Map<CaptureContextId, CaptureContextSnapshot>();
  const authorizedProjects = new Map<string, boolean>();
  for (const snapshot of batch.captureContexts) {
    if (
      snapshot.deviceId !== input.authenticatedDevice.id ||
      snapshot.personId !== input.authenticatedDevice.ownerPersonId
    ) {
      return null;
    }
    await activateSpace(client, snapshot.spaceId);
    let result = await client.query<CaptureContextRow>(
      `SELECT id, device_id, person_id, space_id, project_id, scm_account_id, scm_installation_id, source
       FROM capture_contexts
       WHERE id = $1 AND space_id = $2`,
      [snapshot.id, snapshot.spaceId],
    );
    const existing = result.rows[0];
    if (existing && !sameCaptureContext(snapshot, mapCaptureContext(existing))) {
      return null;
    }
    const authorizationKey = `${snapshot.spaceId}:${snapshot.projectId ?? ''}`;
    let authorized = authorizedProjects.get(authorizationKey);
    if (authorized === undefined) {
      authorized = await authorizeProjectContext(client, snapshot);
      authorizedProjects.set(authorizationKey, authorized);
    }
    if (!(authorized && (await scmContextIsBound(client, snapshot)))) {
      return null;
    }
    if (!existing) {
      await client.query(
        `INSERT INTO capture_contexts
           (id, device_id, person_id, space_id, project_id, scm_account_id, scm_installation_id, source)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (id) DO NOTHING`,
        [
          snapshot.id,
          snapshot.deviceId,
          snapshot.personId,
          snapshot.spaceId,
          snapshot.projectId,
          snapshot.scmAccountId,
          snapshot.scmInstallationId,
          snapshot.source,
        ],
      );
      result = await client.query<CaptureContextRow>(
        `SELECT id, device_id, person_id, space_id, project_id, scm_account_id, scm_installation_id, source
         FROM capture_contexts
         WHERE id = $1 AND space_id = $2`,
        [snapshot.id, snapshot.spaceId],
      );
      const created = result.rows[0];
      if (!(created && sameCaptureContext(snapshot, mapCaptureContext(created)))) {
        return null;
      }
    }
    contexts.set(snapshot.id, snapshot);
  }
  for (const event of batch.events) {
    const context = contexts.get(event.captureContextId);
    const projectId = payloadProjectId(event);
    if (
      !(context && streamAcceptsEvent(batch, event)) ||
      (projectId !== undefined && projectId !== context.projectId)
    ) {
      return null;
    }
  }
  return contexts;
};

const lockReplicationStream = async (client: PoolClient, batch: ReplicationBatch): Promise<void> => {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${batch.deviceId}:${batch.streamId}`]);
};

const readGeneration = async (
  client: PoolClient,
  batch: ReplicationBatch,
): Promise<{
  readonly accepted: ReplicationGeneration;
  readonly ackProof: string | null;
  readonly exists: boolean;
}> => {
  const result = await client.query<GenerationRow>(
    `SELECT accepted_through_generation, last_ack_proof
     FROM replication_stream_states
     WHERE device_id = $1 AND stream_id = $2
     FOR UPDATE`,
    [batch.deviceId, batch.streamId],
  );
  const row = result.rows[0];
  if (!row) {
    return { accepted: parseReplicationGeneration(0), ackProof: null, exists: false };
  }
  if (
    row.last_ack_proof !== null &&
    (typeof row.last_ack_proof !== 'string' || !replicationHashPattern.test(row.last_ack_proof))
  ) {
    throw new PlatformStoreError('validation-failed', 'map-replication-ack-proof');
  }
  return {
    accepted: parseReplicationGeneration(integer(row.accepted_through_generation, 'replication-generation')),
    ackProof: row.last_ack_proof as string | null,
    exists: true,
  };
};

const validateOverlap = async (
  client: PoolClient,
  batch: ReplicationBatch,
  accepted: ReplicationGeneration,
  contexts: ReadonlyMap<CaptureContextId, CaptureContextSnapshot>,
): Promise<boolean> => {
  for (const event of batch.events) {
    if (event.generation > accepted) {
      break;
    }
    const context = contexts.get(event.captureContextId);
    if (!context) {
      return false;
    }
    await activateSpace(client, context.spaceId);
    const result = await client.query<EventReceiptRow>(
      `SELECT event_id, generation, fact_key, content_hash, change_kind, capture_context_id
       FROM replication_event_receipts
       WHERE device_id = $1 AND stream_id = $2 AND generation = $3`,
      [batch.deviceId, batch.streamId, event.generation],
    );
    const receipt = result.rows[0];
    if (!(receipt && eventMatchesReceipt(event, receipt))) {
      return false;
    }
  }
  return true;
};

const readEventIdentityHash = async (
  client: PoolClient,
  batch: ReplicationBatch,
  event: ReplicationEvent,
  owningSpaceId: SpaceId,
): Promise<string | null> => {
  await activateSpace(client, owningSpaceId);
  const result = await client.query<EventIdentityRow>(
    `SELECT event_hash
     FROM replication_event_identities
     WHERE device_id = $1 AND stream_id = $2 AND event_id = $3`,
    [batch.deviceId, batch.streamId, event.eventId],
  );
  const value = result.rows[0]?.event_hash;
  if (value === undefined) {
    return null;
  }
  if (typeof value !== 'string' || !replicationHashPattern.test(value)) {
    throw new PlatformStoreError('validation-failed', 'map-replication-event-identity');
  }
  return value;
};

const reserveEventId = async (
  client: PoolClient,
  batch: ReplicationBatch,
  event: ReplicationEvent,
  owningSpaceId: SpaceId,
): Promise<void> => {
  await activateSpace(client, owningSpaceId);
  await client.query(
    `INSERT INTO replication_event_identities (device_id, space_id, stream_id, event_id, event_hash)
     VALUES ($1, $2, $3, $4, $5)`,
    [batch.deviceId, owningSpaceId, batch.streamId, event.eventId, replicationHash(event)],
  );
};

const insertEventAndProjection = async (
  client: PoolClient,
  batch: ReplicationBatch,
  event: ReplicationEvent,
  context: CaptureContextSnapshot,
  owningSpaceId: SpaceId,
  appliedAt: string,
): Promise<void> => {
  await reserveEventId(client, batch, event, owningSpaceId);
  await activateSpace(client, context.spaceId);
  await client.query(
    `INSERT INTO replication_event_receipts
       (device_id, space_id, stream_id, event_id, generation, fact_key, content_hash,
        change_kind, capture_context_id, project_id, payload, received_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::JSONB, $12)`,
    [
      batch.deviceId,
      context.spaceId,
      batch.streamId,
      event.eventId,
      event.generation,
      event.factKey,
      event.contentHash,
      event.changeKind,
      event.captureContextId,
      context.projectId,
      JSON.stringify(event.payload),
      appliedAt,
    ],
  );
  const status = event.changeKind.endsWith('-tombstone') ? 'tombstone' : 'active';
  await client.query(
    `INSERT INTO replicated_fact_projections
       (space_id, fact_key, device_id, stream_id, current_event_id, current_generation,
        content_hash, change_kind, capture_context_id, project_id, status, payload, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::JSONB, $13)
     ON CONFLICT (space_id, fact_key) DO UPDATE SET
       device_id = EXCLUDED.device_id,
       stream_id = EXCLUDED.stream_id,
       current_event_id = EXCLUDED.current_event_id,
       current_generation = EXCLUDED.current_generation,
       content_hash = EXCLUDED.content_hash,
       change_kind = EXCLUDED.change_kind,
       capture_context_id = EXCLUDED.capture_context_id,
       project_id = EXCLUDED.project_id,
       status = EXCLUDED.status,
       payload = EXCLUDED.payload,
       updated_at = EXCLUDED.updated_at`,
    [
      context.spaceId,
      event.factKey,
      batch.deviceId,
      batch.streamId,
      event.eventId,
      event.generation,
      event.contentHash,
      event.changeKind,
      event.captureContextId,
      context.projectId,
      status,
      JSON.stringify(event.payload),
      appliedAt,
    ],
  );
};

const storeBatchReceipt = async (
  client: PoolClient,
  batch: ReplicationBatch,
  spaceId: string,
  requestHash: string,
  ack: ReplicationAck,
): Promise<void> => {
  await client.query(
    `INSERT INTO replication_batch_receipts
       (device_id, space_id, stream_id, batch_id, idempotency_key, request_hash,
        from_generation_exclusive, to_generation_inclusive, stored_ack, applied_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::JSONB, $10)`,
    [
      batch.deviceId,
      spaceId,
      batch.streamId,
      batch.batchId,
      batch.idempotencyKey,
      requestHash,
      batch.fromGenerationExclusive,
      batch.toGenerationInclusive,
      JSON.stringify(ack),
      ack.appliedAt,
    ],
  );
};

const applyAuthorizedBatch = async (
  client: PoolClient,
  input: Parameters<PlatformReplicationStore['applyBatch']>[0],
  batch: ReplicationBatch,
  requestHash: string,
  contexts: ReadonlyMap<CaptureContextId, CaptureContextSnapshot>,
): Promise<ApplyReplicationBatchResult> => {
  await activateSpace(client, input.authenticatedDevice.owningSpaceId);
  await lockReplicationStream(client, batch);
  const priorReceipt = await readBatchReceipt(client, batch);
  if (priorReceipt) {
    return priorBatchResult(priorReceipt, batch, requestHash);
  }
  const generation = await readGeneration(client, batch);
  if (batch.fromGenerationExclusive > generation.accepted) {
    return problem('generation-gap', generation.accepted);
  }
  if (
    batch.fromGenerationExclusive === generation.accepted &&
    batch.previousAckProof !== undefined &&
    (generation.ackProof === null || batch.previousAckProof !== generation.ackProof)
  ) {
    return problem('overlap-conflict');
  }
  for (const event of batch.events) {
    const existingHash = await readEventIdentityHash(client, batch, event, input.authenticatedDevice.owningSpaceId);
    if (existingHash !== null && existingHash !== replicationHash(event)) {
      return problem('event-id-conflict');
    }
  }
  if (!(await validateOverlap(client, batch, generation.accepted, contexts))) {
    return problem('overlap-conflict');
  }

  const newEvents = batch.events.filter(({ generation: eventGeneration }) => eventGeneration > generation.accepted);
  for (const event of newEvents) {
    const context = contexts.get(event.captureContextId);
    const existingHash = await readEventIdentityHash(client, batch, event, input.authenticatedDevice.owningSpaceId);
    if (!(context && existingHash === null)) {
      return problem('event-id-conflict');
    }
  }

  const appliedAt = instantNow();
  for (const event of newEvents) {
    const context = contexts.get(event.captureContextId);
    if (!context) {
      throw new PlatformStoreError('validation-failed', 'resolve-replication-event-context');
    }
    await insertEventAndProjection(client, batch, event, context, input.authenticatedDevice.owningSpaceId, appliedAt);
  }
  const ack = parseReplicationAck({
    acceptedThroughGeneration: batch.toGenerationInclusive,
    appliedAt,
    appliedBatchId: batch.batchId,
    appliedEventIds: batch.events.map(({ eventId }) => eventId),
    counts: {
      applied: newEvents.length,
      duplicate: batch.events.length - newEvents.length,
      projected: newEvents.length,
      tombstoned: newEvents.filter(({ changeKind }) => changeKind.endsWith('-tombstone')).length,
    },
    deviceId: batch.deviceId,
    protocolVersion: batch.protocolVersion,
    streamId: batch.streamId,
    warnings: [],
  });
  await activateSpace(client, input.authenticatedDevice.owningSpaceId);
  await storeBatchReceipt(client, batch, input.authenticatedDevice.owningSpaceId, requestHash, ack);
  const proof = replicationAckProof(ack);
  if (newEvents.length > 0) {
    if (generation.exists) {
      await client.query(
        `UPDATE replication_stream_states
         SET accepted_through_generation = $3, last_ack_proof = $4, updated_at = $5
         WHERE device_id = $1 AND stream_id = $2`,
        [batch.deviceId, batch.streamId, batch.toGenerationInclusive, proof, appliedAt],
      );
    } else {
      await client.query(
        `INSERT INTO replication_stream_states
           (device_id, space_id, stream_id, accepted_through_generation, last_ack_proof, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          batch.deviceId,
          input.authenticatedDevice.owningSpaceId,
          batch.streamId,
          batch.toGenerationInclusive,
          proof,
          appliedAt,
        ],
      );
    }
  } else if (batch.toGenerationInclusive === generation.accepted) {
    await client.query(
      `UPDATE replication_stream_states
       SET last_ack_proof = $3, updated_at = $4
       WHERE device_id = $1 AND stream_id = $2`,
      [batch.deviceId, batch.streamId, proof, appliedAt],
    );
  }
  return { ack, kind: 'ack' };
};

export const createPlatformReplicationStore = (pool: Pool): PlatformReplicationStore => ({
  applyBatch: async (input): Promise<ApplyReplicationBatchResult> => {
    let batch: ReplicationBatch;
    try {
      batch = parseReplicationBatch(input.batch);
    } catch {
      return problem('invalid-batch');
    }
    if (batch.deviceId !== input.authenticatedDevice.id || input.authenticatedDevice.status !== 'active') {
      return problem('unauthenticated');
    }
    const requestHash = replicationHash(batch);
    try {
      return await withPlatformSpaceTransaction(
        pool,
        input.authenticatedDevice.owningSpaceId,
        'apply-replication-batch',
        async (client) => {
          if (!(await credentialIsCurrent(client, input))) {
            throw new ReplicationProblemRollback(problem('revoked'));
          }
          const contexts = await validateCaptureContexts(client, input, batch);
          if (!contexts) {
            throw new ReplicationProblemRollback(problem('capture-context-forbidden'));
          }
          const result = await applyAuthorizedBatch(client, input, batch, requestHash, contexts);
          if (result.kind === 'problem') {
            throw new ReplicationProblemRollback(result);
          }
          return result;
        },
      );
    } catch (error) {
      if (error instanceof ReplicationProblemRollback) {
        return error.result;
      }
      return problem('server-unavailable');
    }
  },
});
