import {
  type CaptureContextId,
  type DeviceId,
  type Instant,
  parseDeviceId,
  parseInstant,
} from '@ai-usage/platform-core/identity';
import {
  type CaptureContextSnapshot,
  canonicalReplicationJson,
  createReplicationBatch,
  createReplicationEvent,
  parseCaptureContextSnapshot,
  parseReplicationAck,
  parseReplicationBatchId,
  parseReplicationEvent,
  parseReplicationGeneration,
  parseReplicationPayload,
  parseReplicationStreamId,
  type ReplicationAck,
  type ReplicationBatch,
  type ReplicationChangeKind,
  type ReplicationEvent,
  type ReplicationEventId,
  type ReplicationPayload,
  type ReplicationStreamId,
  replicationAckProof,
  replicationHash,
} from '@ai-usage/replication-protocol';

export type ReplicationOutboxEventState = 'acknowledged' | 'blocked' | 'in-flight' | 'pending';

export const replicationOutboxSchemaSql = `
  CREATE TABLE IF NOT EXISTS replication_outbox_state (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    device_id TEXT NOT NULL,
    stream_id TEXT NOT NULL CHECK (stream_id IN ('usage-v1', 'memory-v1')),
    next_generation INTEGER NOT NULL CHECK (next_generation > 0),
    acknowledged_through_generation INTEGER NOT NULL DEFAULT 0
      CHECK (acknowledged_through_generation >= 0),
    previous_ack_proof TEXT CHECK (previous_ack_proof IS NULL OR length(previous_ack_proof) = 64),
    last_acknowledged_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS replication_outbox_events (
    event_id             TEXT PRIMARY KEY,
    generation           INTEGER NOT NULL CHECK (generation > 0),
    fact_key             TEXT NOT NULL CHECK (length(fact_key) BETWEEN 1 AND 512),
    content_hash         TEXT NOT NULL CHECK (length(content_hash) = 64),
    change_kind          TEXT NOT NULL,
    payload              TEXT NOT NULL CHECK (json_valid(payload)),
    state                TEXT NOT NULL CHECK (
      state IN ('pending', 'in-flight', 'acknowledged', 'blocked')
    ),
    enqueued_at          TEXT NOT NULL,
    attempt_count        INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    next_attempt_at      TEXT,
    last_error_code      TEXT CHECK (last_error_code IS NULL OR length(last_error_code) BETWEEN 1 AND 128),
    acknowledged_at      TEXT,
    UNIQUE (generation, fact_key, content_hash),
    CHECK (
      (state = 'acknowledged' AND acknowledged_at IS NOT NULL)
      OR (state <> 'acknowledged' AND acknowledged_at IS NULL)
    )
  ) STRICT;

  CREATE INDEX IF NOT EXISTS idx_replication_outbox_ready
    ON replication_outbox_events(state, next_attempt_at, generation);
  CREATE INDEX IF NOT EXISTS idx_replication_outbox_fact_history
    ON replication_outbox_events(fact_key, generation);
`;

export type ReplicationSqliteBinding = bigint | boolean | null | number | string | Uint8Array;

export interface ReplicationSqliteStatement {
  readonly all: (...parameters: ReplicationSqliteBinding[]) => unknown[];
  readonly get: (...parameters: ReplicationSqliteBinding[]) => unknown;
  readonly run: (...parameters: ReplicationSqliteBinding[]) => unknown;
}

export interface ReplicationSqliteDatabase {
  readonly exec: (sql: string) => unknown;
  readonly inTransaction: boolean;
  readonly query: (sql: string) => ReplicationSqliteStatement;
}

export type ReplicationOutboxErrorCode =
  | 'ack-invalid'
  | 'batch-state-conflict'
  | 'event-conflict'
  | 'identity-mismatch'
  | 'not-initialized'
  | 'schema-invalid'
  | 'stored-value-invalid';

export class ReplicationOutboxError extends Error {
  readonly code: ReplicationOutboxErrorCode;
  readonly operation: string;

  constructor(code: ReplicationOutboxErrorCode, operation: string) {
    super('The replication outbox operation failed.');
    this.name = 'ReplicationOutboxError';
    this.code = code;
    this.operation = operation;
  }
}

export interface ReplicationOutboxIdentity {
  readonly createdAt: Instant;
  readonly deviceId: DeviceId;
  readonly streamId: ReplicationStreamId;
}

export interface EnqueueReplicationOutboxEventInput {
  readonly captureContext: CaptureContextSnapshot;
  readonly changeKind: ReplicationChangeKind;
  readonly enqueuedAt: Instant;
  readonly eventId: ReplicationEventId;
  readonly factKey: string;
  readonly payload: ReplicationPayload;
}

export interface ReplicationOutboxEventRecord {
  readonly acknowledgedAt: Instant | null;
  readonly attemptCount: number;
  readonly captureContext: CaptureContextSnapshot;
  readonly enqueuedAt: Instant;
  readonly event: ReplicationEvent;
  readonly lastErrorCode: string | null;
  readonly nextAttemptAt: Instant | null;
  readonly state: ReplicationOutboxEventState;
}

export interface ClaimedReplicationBatch {
  readonly attemptCount: number;
  readonly batch: ReplicationBatch;
  readonly eventIds: readonly ReplicationEventId[];
}

export interface ClaimReplicationBatchInput {
  readonly maximumEvents: number;
  readonly now: Instant;
}

export interface FailReplicationBatchInput {
  readonly batch: ReplicationBatch;
  readonly errorCode: string;
  readonly now: Instant;
  readonly random?: () => number;
  readonly retryAfterSeconds?: number;
}

export interface ReplicationOutboxStatus {
  readonly acknowledged: number;
  readonly acknowledgedThroughGeneration: number;
  readonly blocked: number;
  readonly inFlight: number;
  readonly lastAcknowledgedAt: Instant | null;
  readonly lastErrorCode: string | null;
  readonly nextRetryAt: Instant | null;
  readonly oldestUnacknowledgedAt: Instant | null;
  readonly pending: number;
  readonly streamId: ReplicationStreamId;
}

export interface ReplicationOutboxHistoryItem {
  readonly acknowledgedAt: Instant | null;
  readonly changeKind: ReplicationChangeKind;
  readonly contentHash: string;
  readonly enqueuedAt: Instant;
  readonly eventId: ReplicationEventId;
  readonly factKey: string;
  readonly generation: number;
  readonly state: ReplicationOutboxEventState;
}

interface StateRow {
  readonly acknowledged_through_generation: unknown;
  readonly device_id: unknown;
  readonly last_acknowledged_at: unknown;
  readonly next_generation: unknown;
  readonly previous_ack_proof: unknown;
  readonly stream_id: unknown;
}

interface EventRow {
  readonly acknowledged_at: unknown;
  readonly attempt_count: unknown;
  readonly change_kind: unknown;
  readonly content_hash: unknown;
  readonly enqueued_at: unknown;
  readonly event_id: unknown;
  readonly fact_key: unknown;
  readonly generation: unknown;
  readonly last_error_code: unknown;
  readonly next_attempt_at: unknown;
  readonly payload: unknown;
  readonly state: unknown;
}

interface CountRow {
  readonly acknowledged: unknown;
  readonly blocked: unknown;
  readonly in_flight: unknown;
  readonly last_error_code: unknown;
  readonly next_retry_at: unknown;
  readonly oldest_unacknowledged_at: unknown;
  readonly pending: unknown;
}

interface StoredPayloadEnvelope {
  readonly captureContext: CaptureContextSnapshot;
  readonly payload: ReplicationPayload;
}

const hashPattern = /^[0-9a-f]{64}$/u;
const errorCodePattern = /^[a-z0-9][a-z0-9-]{0,127}$/u;

const changes = (result: unknown): number => {
  if (
    typeof result !== 'object' ||
    result === null ||
    !('changes' in result) ||
    typeof result.changes !== 'number' ||
    !Number.isSafeInteger(result.changes)
  ) {
    throw new ReplicationOutboxError('stored-value-invalid', 'read-write-count');
  }
  return result.changes;
};

const requiredInteger = (value: unknown, field: string, minimum = 0): number => {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new ReplicationOutboxError('stored-value-invalid', `read-${field}`);
  }
  return value as number;
};

const requiredString = (value: unknown, field: string): string => {
  if (typeof value !== 'string') {
    throw new ReplicationOutboxError('stored-value-invalid', `read-${field}`);
  }
  return value;
};

const optionalInstant = (value: unknown, field: string): Instant | null => {
  if (value === null) {
    return null;
  }
  try {
    return parseInstant(value, field);
  } catch {
    throw new ReplicationOutboxError('stored-value-invalid', `read-${field}`);
  }
};

const eventState = (value: unknown): ReplicationOutboxEventState => {
  if (value !== 'acknowledged' && value !== 'blocked' && value !== 'in-flight' && value !== 'pending') {
    throw new ReplicationOutboxError('stored-value-invalid', 'read-event-state');
  }
  return value;
};

const stateRow = (database: ReplicationSqliteDatabase): StateRow => {
  const row = database
    .query(
      `SELECT device_id, stream_id, next_generation, acknowledged_through_generation,
              previous_ack_proof, last_acknowledged_at
       FROM replication_outbox_state WHERE singleton = 1`,
    )
    .get() as StateRow | null;
  if (!row) {
    throw new ReplicationOutboxError('not-initialized', 'read-state');
  }
  return row;
};

const parseStoredEnvelope = (value: unknown): StoredPayloadEnvelope => {
  if (typeof value !== 'string') {
    throw new ReplicationOutboxError('stored-value-invalid', 'read-payload');
  }
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed) ||
      !('captureContext' in parsed) ||
      !('payload' in parsed) ||
      Object.keys(parsed).length !== 2
    ) {
      throw new Error('invalid envelope');
    }
    return {
      captureContext: parseCaptureContextSnapshot(parsed.captureContext),
      payload: parseReplicationPayload(parsed.payload),
    };
  } catch {
    throw new ReplicationOutboxError('stored-value-invalid', 'read-payload');
  }
};

const mapEventRow = (row: EventRow): ReplicationOutboxEventRecord => {
  const envelope = parseStoredEnvelope(row.payload);
  try {
    return {
      acknowledgedAt: optionalInstant(row.acknowledged_at, 'acknowledgedAt'),
      attemptCount: requiredInteger(row.attempt_count, 'attemptCount'),
      captureContext: envelope.captureContext,
      enqueuedAt: parseInstant(row.enqueued_at, 'enqueuedAt'),
      event: parseReplicationEvent({
        captureContextId: envelope.captureContext.id,
        changeKind: row.change_kind,
        contentHash: row.content_hash,
        eventId: row.event_id,
        factKey: row.fact_key,
        generation: row.generation,
        payload: envelope.payload,
      }),
      lastErrorCode: row.last_error_code === null ? null : requiredString(row.last_error_code, 'lastErrorCode'),
      nextAttemptAt: optionalInstant(row.next_attempt_at, 'nextAttemptAt'),
      state: eventState(row.state),
    };
  } catch (error) {
    if (error instanceof ReplicationOutboxError) {
      throw error;
    }
    throw new ReplicationOutboxError('stored-value-invalid', 'map-event');
  }
};

const eventSelection = `
  SELECT event_id, generation, fact_key, content_hash, change_kind, payload, state,
         enqueued_at, attempt_count, next_attempt_at, last_error_code, acknowledged_at
  FROM replication_outbox_events
`;

const withImmediateTransaction = <Value>(database: ReplicationSqliteDatabase, run: () => Value): Value => {
  if (database.inTransaction) {
    return run();
  }
  database.exec('BEGIN IMMEDIATE');
  try {
    const value = run();
    database.exec('COMMIT');
    return value;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
};

const batchIdForEvents = (
  deviceId: DeviceId,
  streamId: ReplicationStreamId,
  eventIds: readonly ReplicationEventId[],
) => {
  const hex = replicationHash({ deviceId, eventIds, streamId }).slice(0, 32).split('');
  hex[12] = '5';
  const variant = Number.parseInt(hex[16] ?? '0', 16);
  hex[16] = ((variant % 4) + 8).toString(16);
  const compact = hex.join('');
  return parseReplicationBatchId(
    `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`,
  );
};

const assertErrorCode = (value: string): string => {
  if (!errorCodePattern.test(value)) {
    throw new ReplicationOutboxError('stored-value-invalid', 'validate-error-code');
  }
  return value;
};

const ensureIdentity = (
  database: ReplicationSqliteDatabase,
): {
  readonly acknowledgedThroughGeneration: number;
  readonly deviceId: DeviceId;
  readonly lastAcknowledgedAt: Instant | null;
  readonly nextGeneration: number;
  readonly previousAckProof: string | null;
  readonly streamId: ReplicationStreamId;
} => {
  const row = stateRow(database);
  try {
    const proof = row.previous_ack_proof;
    if (proof !== null && (typeof proof !== 'string' || !hashPattern.test(proof))) {
      throw new Error('invalid proof');
    }
    return {
      acknowledgedThroughGeneration: requiredInteger(
        row.acknowledged_through_generation,
        'acknowledgedThroughGeneration',
      ),
      deviceId: parseDeviceId(row.device_id),
      lastAcknowledgedAt: optionalInstant(row.last_acknowledged_at, 'lastAcknowledgedAt'),
      nextGeneration: requiredInteger(row.next_generation, 'nextGeneration', 1),
      previousAckProof: proof,
      streamId: parseReplicationStreamId(row.stream_id),
    };
  } catch (error) {
    if (error instanceof ReplicationOutboxError) {
      throw error;
    }
    throw new ReplicationOutboxError('stored-value-invalid', 'map-state');
  }
};

export interface SqliteReplicationOutbox {
  readonly acknowledge: (batch: ReplicationBatch, ack: ReplicationAck) => void;
  readonly block: (input: Omit<FailReplicationBatchInput, 'random' | 'retryAfterSeconds'>) => void;
  readonly claimReady: (input: ClaimReplicationBatchInput) => ClaimedReplicationBatch | null;
  readonly enqueue: (input: EnqueueReplicationOutboxEventInput) => ReplicationOutboxEventRecord;
  readonly initialize: (identity: ReplicationOutboxIdentity) => void;
  readonly listHistory: (maximumItems?: number) => readonly ReplicationOutboxHistoryItem[];
  readonly recoverInFlight: (recoveredAt: Instant) => number;
  readonly retry: (input: FailReplicationBatchInput) => Instant;
  readonly status: () => ReplicationOutboxStatus;
}

export const computeReplicationRetryAt = (
  now: Instant,
  attemptCount: number,
  random: () => number = Math.random,
  retryAfterSeconds?: number,
): Instant => {
  const boundedAttempt = Math.min(Math.max(Math.trunc(attemptCount), 1), 20);
  const exponentialMs = Math.min(1000 * 2 ** (boundedAttempt - 1), 60 * 60 * 1000);
  const sample = Math.min(Math.max(random(), 0), 1);
  const jitteredMs = Math.round(exponentialMs * (0.75 + sample * 0.5));
  const safeRetryAfterMs =
    retryAfterSeconds === undefined ? 0 : Math.min(Math.max(Math.trunc(retryAfterSeconds), 0), 24 * 60 * 60) * 1000;
  return parseInstant(new Date(Date.parse(now) + Math.max(jitteredMs, safeRetryAfterMs)).toISOString(), 'retryAt');
};

export const createSqliteReplicationOutbox = (database: ReplicationSqliteDatabase): SqliteReplicationOutbox => {
  const initialize = (identity: ReplicationOutboxIdentity): void => {
    withImmediateTransaction(database, () => {
      database.exec(replicationOutboxSchemaSql);
      const existing = database
        .query('SELECT device_id, stream_id FROM replication_outbox_state WHERE singleton = 1')
        .get() as { readonly device_id: unknown; readonly stream_id: unknown } | null;
      if (existing) {
        if (existing.device_id !== identity.deviceId || existing.stream_id !== identity.streamId) {
          throw new ReplicationOutboxError('identity-mismatch', 'initialize');
        }
        return;
      }
      const maximum = database.query('SELECT MAX(generation) AS generation FROM replication_outbox_events').get() as {
        readonly generation: unknown;
      } | null;
      const nextGeneration =
        maximum?.generation === null ? 1 : requiredInteger(maximum?.generation, 'generation', 0) + 1;
      database
        .query(
          `INSERT INTO replication_outbox_state
             (singleton, device_id, stream_id, next_generation, acknowledged_through_generation,
              previous_ack_proof, last_acknowledged_at, created_at, updated_at)
           VALUES (1, ?, ?, ?, 0, NULL, NULL, ?, ?)`,
        )
        .run(identity.deviceId, identity.streamId, nextGeneration, identity.createdAt, identity.createdAt);
    });
  };

  const enqueue = (input: EnqueueReplicationOutboxEventInput): ReplicationOutboxEventRecord =>
    withImmediateTransaction(database, () => {
      const identity = ensureIdentity(database);
      if (input.captureContext.deviceId !== identity.deviceId) {
        throw new ReplicationOutboxError('identity-mismatch', 'enqueue');
      }
      const event = createReplicationEvent({
        captureContextId: input.captureContext.id,
        changeKind: input.changeKind,
        eventId: input.eventId,
        factKey: input.factKey,
        generation: parseReplicationGeneration(identity.nextGeneration),
        payload: input.payload,
      });
      const existing = database.query(`${eventSelection} WHERE event_id = ?`).get(event.eventId) as EventRow | null;
      if (existing) {
        const mapped = mapEventRow(existing);
        if (
          mapped.event.factKey !== event.factKey ||
          mapped.event.contentHash !== event.contentHash ||
          canonicalReplicationJson(mapped.captureContext) !== canonicalReplicationJson(input.captureContext)
        ) {
          throw new ReplicationOutboxError('event-conflict', 'enqueue');
        }
        return mapped;
      }
      const sameContent = database
        .query(`${eventSelection} WHERE fact_key = ? AND content_hash = ? ORDER BY generation DESC LIMIT 1`)
        .get(event.factKey, event.contentHash) as EventRow | null;
      if (sameContent) {
        throw new ReplicationOutboxError('event-conflict', 'enqueue-duplicate-content');
      }
      database
        .query(
          `INSERT INTO replication_outbox_events
             (event_id, generation, fact_key, content_hash, change_kind, payload, state,
              enqueued_at, attempt_count, next_attempt_at, last_error_code, acknowledged_at)
           VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, 0, NULL, NULL, NULL)`,
        )
        .run(
          event.eventId,
          event.generation,
          event.factKey,
          event.contentHash,
          event.changeKind,
          canonicalReplicationJson({ captureContext: input.captureContext, payload: event.payload }),
          input.enqueuedAt,
        );
      if (
        changes(
          database
            .query(
              `UPDATE replication_outbox_state
               SET next_generation = next_generation + 1, updated_at = ?
               WHERE singleton = 1 AND next_generation = ?`,
            )
            .run(input.enqueuedAt, identity.nextGeneration),
        ) !== 1
      ) {
        throw new ReplicationOutboxError('batch-state-conflict', 'advance-generation');
      }
      const stored = database.query(`${eventSelection} WHERE event_id = ?`).get(event.eventId) as EventRow | null;
      if (!stored) {
        throw new ReplicationOutboxError('stored-value-invalid', 'read-enqueued-event');
      }
      return mapEventRow(stored);
    });

  const recoverInFlight = (_recoveredAt: Instant): number =>
    withImmediateTransaction(database, () => {
      ensureIdentity(database);
      return changes(
        database
          .query(
            `UPDATE replication_outbox_events
             SET state = 'pending', next_attempt_at = NULL, last_error_code = 'lease-recovered'
             WHERE state = 'in-flight'`,
          )
          .run(),
      );
    });

  const claimReady = (input: ClaimReplicationBatchInput): ClaimedReplicationBatch | null =>
    withImmediateTransaction(database, () => {
      const maximumEvents = Math.trunc(input.maximumEvents);
      if (maximumEvents <= 0 || maximumEvents > 100) {
        throw new ReplicationOutboxError('batch-state-conflict', 'claim-limit');
      }
      const identity = ensureIdentity(database);
      const rows = database
        .query(
          `${eventSelection}
           WHERE generation > ?
           ORDER BY generation ASC
           LIMIT ?`,
        )
        .all(identity.acknowledgedThroughGeneration, maximumEvents + 1) as EventRow[];
      if (rows.length === 0) {
        return null;
      }
      const selected: ReplicationOutboxEventRecord[] = [];
      let expectedGeneration = identity.acknowledgedThroughGeneration + 1;
      let initialAttemptCount: number | undefined;
      for (const row of rows) {
        const record = mapEventRow(row);
        if (record.event.generation !== expectedGeneration) {
          throw new ReplicationOutboxError('batch-state-conflict', 'claim-generation-gap');
        }
        if (
          record.state !== 'pending' ||
          (record.nextAttemptAt !== null && Date.parse(record.nextAttemptAt) > Date.parse(input.now))
        ) {
          break;
        }
        initialAttemptCount ??= record.attemptCount;
        if (record.attemptCount !== initialAttemptCount || selected.length >= maximumEvents) {
          break;
        }
        selected.push(record);
        expectedGeneration += 1;
      }
      if (selected.length === 0) {
        return null;
      }
      const eventIds = selected.map(({ event }) => event.eventId);
      const placeholders = eventIds.map(() => '?').join(', ');
      const changed = changes(
        database
          .query(
            `UPDATE replication_outbox_events
             SET state = 'in-flight', attempt_count = attempt_count + 1,
                 next_attempt_at = NULL, last_error_code = NULL
             WHERE event_id IN (${placeholders}) AND state = 'pending'`,
          )
          .run(...eventIds),
      );
      if (changed !== selected.length) {
        throw new ReplicationOutboxError('batch-state-conflict', 'claim-update');
      }
      const contexts = new Map<CaptureContextId, CaptureContextSnapshot>();
      for (const record of selected) {
        const prior = contexts.get(record.captureContext.id);
        if (prior && canonicalReplicationJson(prior) !== canonicalReplicationJson(record.captureContext)) {
          throw new ReplicationOutboxError('event-conflict', 'claim-capture-context');
        }
        contexts.set(record.captureContext.id, record.captureContext);
      }
      const fromGenerationExclusive = parseReplicationGeneration(identity.acknowledgedThroughGeneration);
      const toGenerationInclusive = selected.at(-1)?.event.generation;
      if (toGenerationInclusive === undefined) {
        throw new ReplicationOutboxError('batch-state-conflict', 'claim-empty');
      }
      const batch = createReplicationBatch({
        batchId: batchIdForEvents(identity.deviceId, identity.streamId, eventIds),
        captureContexts: [...contexts.values()],
        deviceId: identity.deviceId,
        events: selected.map(({ event }) => event),
        fromGenerationExclusive,
        ...(identity.previousAckProof === null ? {} : { previousAckProof: identity.previousAckProof }),
        streamId: identity.streamId,
        toGenerationInclusive,
      });
      return {
        attemptCount: (initialAttemptCount ?? 0) + 1,
        batch,
        eventIds,
      };
    });

  const acknowledge = (batch: ReplicationBatch, ackValue: ReplicationAck): void => {
    withImmediateTransaction(database, () => {
      const identity = ensureIdentity(database);
      const ack = parseReplicationAck(ackValue);
      const expectedIds = batch.events.map(({ eventId }) => eventId);
      if (
        ack.deviceId !== identity.deviceId ||
        ack.streamId !== identity.streamId ||
        ack.appliedBatchId !== batch.batchId ||
        ack.acceptedThroughGeneration !== batch.toGenerationInclusive ||
        ack.appliedEventIds.length !== expectedIds.length ||
        ack.appliedEventIds.some((eventId, index) => eventId !== expectedIds[index]) ||
        ack.counts.applied + ack.counts.duplicate !== expectedIds.length
      ) {
        throw new ReplicationOutboxError('ack-invalid', 'acknowledge');
      }
      const placeholders = expectedIds.map(() => '?').join(', ');
      if (
        changes(
          database
            .query(
              `UPDATE replication_outbox_events
               SET state = 'acknowledged', acknowledged_at = ?, next_attempt_at = NULL, last_error_code = NULL
               WHERE event_id IN (${placeholders}) AND state = 'in-flight'`,
            )
            .run(ack.appliedAt, ...expectedIds),
        ) !== expectedIds.length
      ) {
        throw new ReplicationOutboxError('batch-state-conflict', 'acknowledge-events');
      }
      if (
        changes(
          database
            .query(
              `UPDATE replication_outbox_state
               SET acknowledged_through_generation = ?, previous_ack_proof = ?,
                   last_acknowledged_at = ?, updated_at = ?
               WHERE singleton = 1 AND acknowledged_through_generation = ?`,
            )
            .run(
              ack.acceptedThroughGeneration,
              replicationAckProof(ack),
              ack.appliedAt,
              ack.appliedAt,
              batch.fromGenerationExclusive,
            ),
        ) !== 1
      ) {
        throw new ReplicationOutboxError('batch-state-conflict', 'acknowledge-state');
      }
    });
  };

  const retry = (input: FailReplicationBatchInput): Instant =>
    withImmediateTransaction(database, () => {
      ensureIdentity(database);
      const attemptRow = database
        .query(
          `SELECT MAX(attempt_count) AS attempt_count
           FROM replication_outbox_events
           WHERE generation BETWEEN ? AND ? AND state = 'in-flight'`,
        )
        .get(input.batch.fromGenerationExclusive + 1, input.batch.toGenerationInclusive) as {
        readonly attempt_count: unknown;
      } | null;
      const attemptCount = requiredInteger(attemptRow?.attempt_count, 'attemptCount', 1);
      const retryAt = computeReplicationRetryAt(input.now, attemptCount, input.random, input.retryAfterSeconds);
      const eventIds = input.batch.events.map(({ eventId }) => eventId);
      const placeholders = eventIds.map(() => '?').join(', ');
      if (
        changes(
          database
            .query(
              `UPDATE replication_outbox_events
               SET state = 'pending', next_attempt_at = ?, last_error_code = ?
               WHERE event_id IN (${placeholders}) AND state = 'in-flight'`,
            )
            .run(retryAt, assertErrorCode(input.errorCode), ...eventIds),
        ) !== eventIds.length
      ) {
        throw new ReplicationOutboxError('batch-state-conflict', 'retry');
      }
      return retryAt;
    });

  const block = (input: Omit<FailReplicationBatchInput, 'random' | 'retryAfterSeconds'>): void => {
    withImmediateTransaction(database, () => {
      ensureIdentity(database);
      const eventIds = input.batch.events.map(({ eventId }) => eventId);
      const placeholders = eventIds.map(() => '?').join(', ');
      if (
        changes(
          database
            .query(
              `UPDATE replication_outbox_events
               SET state = 'blocked', next_attempt_at = NULL, last_error_code = ?
               WHERE event_id IN (${placeholders}) AND state = 'in-flight'`,
            )
            .run(assertErrorCode(input.errorCode), ...eventIds),
        ) !== eventIds.length
      ) {
        throw new ReplicationOutboxError('batch-state-conflict', 'block');
      }
    });
  };

  const status = (): ReplicationOutboxStatus => {
    const identity = ensureIdentity(database);
    const row = database
      .query(
        `SELECT
           SUM(CASE WHEN state = 'pending' THEN 1 ELSE 0 END) AS pending,
           SUM(CASE WHEN state = 'in-flight' THEN 1 ELSE 0 END) AS in_flight,
           SUM(CASE WHEN state = 'acknowledged' THEN 1 ELSE 0 END) AS acknowledged,
           SUM(CASE WHEN state = 'blocked' THEN 1 ELSE 0 END) AS blocked,
           MIN(CASE WHEN state = 'pending' THEN next_attempt_at END) AS next_retry_at,
           MIN(CASE WHEN state <> 'acknowledged' THEN enqueued_at END) AS oldest_unacknowledged_at,
           (SELECT last_error_code FROM replication_outbox_events
            WHERE last_error_code IS NOT NULL ORDER BY generation DESC LIMIT 1) AS last_error_code
         FROM replication_outbox_events`,
      )
      .get() as CountRow | null;
    return Object.freeze({
      acknowledged: requiredInteger(row?.acknowledged ?? 0, 'acknowledged'),
      acknowledgedThroughGeneration: identity.acknowledgedThroughGeneration,
      blocked: requiredInteger(row?.blocked ?? 0, 'blocked'),
      inFlight: requiredInteger(row?.in_flight ?? 0, 'inFlight'),
      lastAcknowledgedAt: identity.lastAcknowledgedAt,
      lastErrorCode: row?.last_error_code === null ? null : requiredString(row?.last_error_code, 'lastErrorCode'),
      nextRetryAt: optionalInstant(row?.next_retry_at ?? null, 'nextRetryAt'),
      oldestUnacknowledgedAt: optionalInstant(row?.oldest_unacknowledged_at ?? null, 'oldestUnacknowledgedAt'),
      pending: requiredInteger(row?.pending ?? 0, 'pending'),
      streamId: identity.streamId,
    });
  };

  const listHistory = (maximumItems = 100): readonly ReplicationOutboxHistoryItem[] => {
    const limit = Math.trunc(maximumItems);
    if (limit <= 0 || limit > 1000) {
      throw new ReplicationOutboxError('stored-value-invalid', 'history-limit');
    }
    ensureIdentity(database);
    const rows = database.query(`${eventSelection} ORDER BY generation DESC LIMIT ?`).all(limit) as EventRow[];
    return rows.map((row) => {
      const record = mapEventRow(row);
      return Object.freeze({
        acknowledgedAt: record.acknowledgedAt,
        changeKind: record.event.changeKind,
        contentHash: record.event.contentHash,
        enqueuedAt: record.enqueuedAt,
        eventId: record.event.eventId,
        factKey: record.event.factKey,
        generation: record.event.generation,
        state: record.state,
      });
    });
  };

  return Object.freeze({
    acknowledge,
    block,
    claimReady,
    enqueue,
    initialize,
    listHistory,
    recoverInFlight,
    retry,
    status,
  });
};
