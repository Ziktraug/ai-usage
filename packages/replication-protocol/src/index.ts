import { createHash } from 'node:crypto';
import {
  type CaptureContextId,
  type CheckoutId,
  type DeviceId,
  type Instant,
  type MemoryItemId,
  type MemoryObservationId,
  type MemoryProposalId,
  type MemoryRelationId,
  type MemoryRevisionId,
  type PersonId,
  type ProjectId,
  parseCaptureContextId,
  parseCheckoutId,
  parseDeviceId,
  parseInstant,
  parseMemoryItemId,
  parseMemoryObservationId,
  parseMemoryProposalId,
  parseMemoryRelationId,
  parseMemoryRevisionId,
  parsePersonId,
  parseProjectId,
  parseRepositoryId,
  parseScmAccountId,
  parseScmInstallationId,
  parseSpaceId,
  type RepositoryId,
  type ScmAccountId,
  type ScmInstallationId,
  type SpaceId,
} from '@ai-usage/platform-core/identity';

declare const replicationIdentityBrand: unique symbol;
declare const replicationGenerationBrand: unique symbol;

type ReplicationIdentity<Kind extends string> = string & {
  readonly [replicationIdentityBrand]: Kind;
};

export type ReplicationBatchId = ReplicationIdentity<'batch'>;
export type ReplicationEventId = ReplicationIdentity<'event'>;
export type ReplicationStreamId = ReplicationIdentity<'stream'>;
export type ReplicationGeneration = number & {
  readonly [replicationGenerationBrand]: true;
};

export const REPLICATION_PROTOCOL_VERSION = 1 as const;
export const USAGE_REPLICATION_STREAM_ID = 'usage-v1' as ReplicationStreamId;
export const MEMORY_REPLICATION_STREAM_ID = 'memory-v1' as ReplicationStreamId;

export const replicationBounds = Object.freeze({
  batchBytes: 1024 * 1024,
  captureContextsPerBatch: 100,
  eventsPerBatch: 100,
  factKeyBytes: 512,
  payloadBytes: 64 * 1024,
  warningCount: 100,
});

export type ReplicationJsonValue =
  | boolean
  | null
  | number
  | string
  | readonly ReplicationJsonValue[]
  | { readonly [key: string]: ReplicationJsonValue };

export interface CaptureContextSnapshot {
  readonly deviceId: DeviceId;
  readonly id: CaptureContextId;
  readonly personId: PersonId;
  readonly projectId: ProjectId | null;
  readonly scmAccountId: ScmAccountId | null;
  readonly scmInstallationId: ScmInstallationId | null;
  readonly source: 'explicit' | 'personal-fallback' | 'project-rule' | 'unassigned';
  readonly spaceId: SpaceId;
}

export interface UsageSessionUpsertPayload {
  readonly harness: string;
  readonly kind: 'usage-session-upsert';
  readonly model: string;
  readonly observedAt: Instant;
  readonly projectId: ProjectId | null;
  readonly sourceFingerprint: string;
  readonly sourceSessionId: string | null;
  readonly status: 'active' | 'deleted' | 'superseded';
  readonly tokenTotal: number;
}

export interface UsageSessionTombstonePayload {
  readonly kind: 'usage-session-tombstone';
  readonly reasonCode: string;
  readonly tombstonedAt: Instant;
}

export interface DeviceFactUpsertPayload {
  readonly deviceId: DeviceId;
  readonly kind: 'device-fact-upsert';
  readonly label: string;
  readonly lastSeenAt: Instant | null;
  readonly status: 'active' | 'pending' | 'revoked';
}

export interface CheckoutFactUpsertPayload {
  readonly checkoutId: CheckoutId;
  readonly kind: 'checkout-fact-upsert';
  readonly lastObservedAt: Instant;
  readonly projectId: ProjectId | null;
  readonly repositoryId: RepositoryId | null;
  readonly resolutionStatus: 'ambiguous' | 'candidate' | 'resolved' | 'unassigned';
  readonly status: 'available' | 'missing' | 'unknown';
}

export interface CheckoutFactTombstonePayload {
  readonly checkoutId: CheckoutId;
  readonly kind: 'checkout-fact-tombstone';
  readonly reasonCode: string;
  readonly tombstonedAt: Instant;
}

export interface MemoryObservationUpsertPayload {
  readonly content: ReplicationJsonValue;
  readonly kind: 'memory-observation-upsert';
  readonly observationId: MemoryObservationId;
  readonly observedAt: Instant;
  readonly projectId: ProjectId | null;
  readonly sensitivity: 'normal';
  readonly sourceKind: 'agent' | 'commit' | 'file' | 'import' | 'pull-request' | 'session' | 'user';
}

export interface MemoryProposalUpsertPayload {
  readonly guidance: readonly string[];
  readonly kind: 'memory-proposal-upsert';
  readonly projectId: ProjectId | null;
  readonly proposalId: MemoryProposalId;
  readonly proposedKind: MemoryFactKind;
  readonly sensitivity: 'normal';
  readonly status: 'accepted' | 'rejected' | 'superseded';
  readonly structuredContent: ReplicationJsonValue;
  readonly summary: string;
  readonly title: string;
  readonly trust: 'explicit' | 'harvest-accepted';
}

export type MemoryFactKind =
  | 'command'
  | 'constraint'
  | 'decision'
  | 'handoff'
  | 'lesson'
  | 'pattern'
  | 'pitfall'
  | 'preference';

export interface MemoryItemRevisionUpsertPayload {
  readonly guidance: readonly string[];
  readonly itemId: MemoryItemId;
  readonly itemKind: MemoryFactKind;
  readonly kind: 'memory-item-revision-upsert';
  readonly projectId: ProjectId | null;
  readonly revisionCreatedAt: Instant;
  readonly revisionId: MemoryRevisionId;
  readonly revisionNumber: number;
  readonly scope: 'person' | 'project' | 'space';
  readonly sensitivity: 'normal';
  readonly status: 'active' | 'archived' | 'rejected' | 'superseded';
  readonly structuredContent: ReplicationJsonValue;
  readonly summary: string;
  readonly title: string;
  readonly trust: 'explicit' | 'harvest-accepted';
}

export interface MemoryRelationUpsertPayload {
  readonly createdAt: Instant;
  readonly fromMemoryItemId: MemoryItemId;
  readonly kind: 'memory-relation-upsert';
  readonly relationId: MemoryRelationId;
  readonly relationKind: 'applies-to' | 'contradicts' | 'derived-from' | 'related-to' | 'supersedes' | 'supports';
  readonly toMemoryItemId: MemoryItemId;
}

export interface MemoryFactTombstonePayload {
  readonly itemId: MemoryItemId;
  readonly kind: 'memory-fact-tombstone';
  readonly reasonCode: string;
  readonly tombstonedAt: Instant;
}

export type ReplicationPayload =
  | CheckoutFactTombstonePayload
  | CheckoutFactUpsertPayload
  | DeviceFactUpsertPayload
  | MemoryFactTombstonePayload
  | MemoryItemRevisionUpsertPayload
  | MemoryObservationUpsertPayload
  | MemoryProposalUpsertPayload
  | MemoryRelationUpsertPayload
  | UsageSessionTombstonePayload
  | UsageSessionUpsertPayload;

export type ReplicationChangeKind = ReplicationPayload['kind'];

export interface ReplicationEvent {
  readonly captureContextId: CaptureContextId;
  readonly changeKind: ReplicationChangeKind;
  readonly contentHash: string;
  readonly eventId: ReplicationEventId;
  readonly factKey: string;
  readonly generation: ReplicationGeneration;
  readonly payload: ReplicationPayload;
}

export interface ReplicationBatch {
  readonly batchId: ReplicationBatchId;
  readonly captureContexts: readonly CaptureContextSnapshot[];
  readonly deviceId: DeviceId;
  readonly events: readonly ReplicationEvent[];
  readonly fromGenerationExclusive: ReplicationGeneration;
  readonly idempotencyKey: string;
  readonly previousAckProof?: string;
  readonly protocolVersion: typeof REPLICATION_PROTOCOL_VERSION;
  readonly streamId: ReplicationStreamId;
  readonly toGenerationInclusive: ReplicationGeneration;
}

export interface BoundedApplyCounts {
  readonly applied: number;
  readonly duplicate: number;
  readonly projected: number;
  readonly tombstoned: number;
}

export interface BoundedReplicationWarning {
  readonly code: string;
  readonly eventId?: ReplicationEventId;
}

export interface ReplicationAck {
  readonly acceptedThroughGeneration: ReplicationGeneration;
  readonly appliedAt: Instant;
  readonly appliedBatchId: ReplicationBatchId;
  readonly appliedEventIds: readonly ReplicationEventId[];
  readonly counts: BoundedApplyCounts;
  readonly deviceId: DeviceId;
  readonly protocolVersion: typeof REPLICATION_PROTOCOL_VERSION;
  readonly streamId: ReplicationStreamId;
  readonly warnings: readonly BoundedReplicationWarning[];
}

export type ReplicationProblemCode =
  | 'batch-id-conflict'
  | 'capture-context-forbidden'
  | 'event-id-conflict'
  | 'generation-gap'
  | 'invalid-batch'
  | 'overlap-conflict'
  | 'protocol-incompatible'
  | 'rate-limited'
  | 'request-too-large'
  | 'revoked'
  | 'server-unavailable'
  | 'unauthenticated';

export interface ReplicationProblem {
  readonly code: ReplicationProblemCode;
  readonly expectedGeneration?: ReplicationGeneration;
  readonly retryAfterSeconds?: number;
}

export class ReplicationProtocolError extends Error {
  readonly code: 'bounds-exceeded' | 'hash-mismatch' | 'invalid-value' | 'unsupported-version';
  readonly field: string;

  constructor(code: 'bounds-exceeded' | 'hash-mismatch' | 'invalid-value' | 'unsupported-version', field: string) {
    super('The replication protocol value is invalid.');
    this.name = 'ReplicationProtocolError';
    this.code = code;
    this.field = field;
  }
}

const canonicalUuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const hashPattern = /^[0-9a-f]{64}$/u;
const streamIdPattern = /^(?:memory|usage)-v1$/u;
const codePattern = /^[a-z0-9][a-z0-9-]{0,127}$/u;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const exactKeys = (
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void => {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  if (required.some((key) => !(key in value)) || keys.some((key) => !allowed.has(key))) {
    throw new ReplicationProtocolError('invalid-value', 'keys');
  }
};

const recordValue = (value: unknown, field: string): Record<string, unknown> => {
  if (!isRecord(value)) {
    throw new ReplicationProtocolError('invalid-value', field);
  }
  return value;
};

const boundedText = (value: unknown, field: string, maximum: number, minimum = 1): string => {
  if (typeof value !== 'string' || value.length < minimum || value.length > maximum) {
    throw new ReplicationProtocolError('invalid-value', field);
  }
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 31 || codePoint === 127) {
      throw new ReplicationProtocolError('invalid-value', field);
    }
  }
  return value;
};

const optionalId = <Value>(value: unknown, parse: (candidate: unknown) => Value): Value | null =>
  value === null ? null : parse(value);

const integer = (value: unknown, field: string, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number => {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new ReplicationProtocolError('invalid-value', field);
  }
  return value as number;
};

export const parseReplicationGeneration = (value: unknown, field = 'generation'): ReplicationGeneration =>
  integer(value, field, 0) as ReplicationGeneration;

const parseUuidIdentity = <Kind extends string>(value: unknown, field: string): ReplicationIdentity<Kind> => {
  if (typeof value !== 'string' || !canonicalUuidPattern.test(value)) {
    throw new ReplicationProtocolError('invalid-value', field);
  }
  return value as ReplicationIdentity<Kind>;
};

export const parseReplicationBatchId = (value: unknown): ReplicationBatchId =>
  parseUuidIdentity<'batch'>(value, 'batchId');

export const parseReplicationEventId = (value: unknown): ReplicationEventId =>
  parseUuidIdentity<'event'>(value, 'eventId');

export const parseReplicationStreamId = (value: unknown): ReplicationStreamId => {
  if (typeof value !== 'string' || !streamIdPattern.test(value)) {
    throw new ReplicationProtocolError('invalid-value', 'streamId');
  }
  return value as ReplicationStreamId;
};

export const createReplicationBatchId = (): ReplicationBatchId => parseReplicationBatchId(crypto.randomUUID());

export const createReplicationEventId = (): ReplicationEventId => parseReplicationEventId(crypto.randomUUID());

export const replicationEventIdForSeed = (seed: unknown): ReplicationEventId => {
  const hex = replicationHash(seed).slice(0, 32).split('');
  hex[12] = '5';
  const variant = Number.parseInt(hex[16] ?? '0', 16);
  hex[16] = ((variant % 4) + 8).toString(16);
  const compact = hex.join('');
  return parseReplicationEventId(
    `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`,
  );
};

const parseHash = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || !hashPattern.test(value)) {
    throw new ReplicationProtocolError('invalid-value', field);
  }
  return value;
};

const jsonValue = (value: unknown, field: string): ReplicationJsonValue => {
  let nodes = 0;
  const visit = (candidate: unknown, depth: number): ReplicationJsonValue => {
    nodes += 1;
    if (nodes > 10_000 || depth > 32) {
      throw new ReplicationProtocolError('bounds-exceeded', field);
    }
    if (candidate === null || typeof candidate === 'boolean' || typeof candidate === 'string') {
      return candidate;
    }
    if (typeof candidate === 'number') {
      if (!Number.isFinite(candidate)) {
        throw new ReplicationProtocolError('invalid-value', field);
      }
      return candidate;
    }
    if (Array.isArray(candidate)) {
      return candidate.map((item) => visit(item, depth + 1));
    }
    const object = recordValue(candidate, field);
    const result: Record<string, ReplicationJsonValue> = {};
    for (const [key, item] of Object.entries(object)) {
      if (key.length === 0 || key.length > 256) {
        throw new ReplicationProtocolError('invalid-value', field);
      }
      result[key] = visit(item, depth + 1);
    }
    return result;
  };
  return visit(value, 0);
};

export const parseReplicationJsonValue = (value: unknown, field = 'json'): ReplicationJsonValue =>
  jsonValue(value, field);

const canonicalize = (value: ReplicationJsonValue): string => {
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`;
  }
  const object = value as { readonly [key: string]: ReplicationJsonValue };
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(object[key] as ReplicationJsonValue)}`)
    .join(',')}}`;
};

export const canonicalReplicationJson = (value: unknown): string => canonicalize(jsonValue(value, 'json'));

export const replicationHash = (value: unknown): string =>
  createHash('sha256').update(canonicalReplicationJson(value)).digest('hex');

export const replicationEventContentHash = (
  changeKind: ReplicationChangeKind,
  captureContextId: CaptureContextId,
  payload: ReplicationPayload,
): string => replicationHash({ captureContextId, changeKind, payload });

const parseEnum = <Value extends string>(value: unknown, values: ReadonlySet<Value>, field: string): Value => {
  if (typeof value !== 'string' || !values.has(value as Value)) {
    throw new ReplicationProtocolError('invalid-value', field);
  }
  return value as Value;
};

const memoryKinds = new Set<MemoryFactKind>([
  'command',
  'constraint',
  'decision',
  'handoff',
  'lesson',
  'pattern',
  'pitfall',
  'preference',
]);

const guidance = (value: unknown): readonly string[] => {
  if (!Array.isArray(value) || value.length > 64) {
    throw new ReplicationProtocolError('bounds-exceeded', 'payload.guidance');
  }
  return value.map((item) => boundedText(item, 'payload.guidance', 4096, 0));
};

export const parseReplicationPayload = (value: unknown): ReplicationPayload => {
  const payload = recordValue(value, 'payload');
  const kind = payload.kind;
  switch (kind) {
    case 'usage-session-upsert': {
      exactKeys(payload, [
        'kind',
        'harness',
        'model',
        'observedAt',
        'projectId',
        'sourceFingerprint',
        'sourceSessionId',
        'status',
        'tokenTotal',
      ]);
      return {
        harness: boundedText(payload.harness, 'payload.harness', 128),
        kind,
        model: boundedText(payload.model, 'payload.model', 256),
        observedAt: parseInstant(payload.observedAt, 'payload.observedAt'),
        projectId: optionalId(payload.projectId, parseProjectId),
        sourceFingerprint: parseHash(payload.sourceFingerprint, 'payload.sourceFingerprint'),
        sourceSessionId:
          payload.sourceSessionId === null
            ? null
            : boundedText(payload.sourceSessionId, 'payload.sourceSessionId', 512),
        status: parseEnum(payload.status, new Set(['active', 'deleted', 'superseded']), 'payload.status'),
        tokenTotal: integer(payload.tokenTotal, 'payload.tokenTotal', 0),
      };
    }
    case 'usage-session-tombstone': {
      exactKeys(payload, ['kind', 'reasonCode', 'tombstonedAt']);
      return {
        kind,
        reasonCode: boundedText(payload.reasonCode, 'payload.reasonCode', 128),
        tombstonedAt: parseInstant(payload.tombstonedAt, 'payload.tombstonedAt'),
      };
    }
    case 'device-fact-upsert': {
      exactKeys(payload, ['kind', 'deviceId', 'label', 'lastSeenAt', 'status']);
      return {
        deviceId: parseDeviceId(payload.deviceId),
        kind,
        label: boundedText(payload.label, 'payload.label', 256),
        lastSeenAt: payload.lastSeenAt === null ? null : parseInstant(payload.lastSeenAt, 'payload.lastSeenAt'),
        status: parseEnum(payload.status, new Set(['active', 'pending', 'revoked']), 'payload.status'),
      };
    }
    case 'checkout-fact-upsert': {
      exactKeys(payload, [
        'kind',
        'checkoutId',
        'lastObservedAt',
        'projectId',
        'repositoryId',
        'resolutionStatus',
        'status',
      ]);
      return {
        checkoutId: parseCheckoutId(payload.checkoutId),
        kind,
        lastObservedAt: parseInstant(payload.lastObservedAt, 'payload.lastObservedAt'),
        projectId: optionalId(payload.projectId, parseProjectId),
        repositoryId: optionalId(payload.repositoryId, parseRepositoryId),
        resolutionStatus: parseEnum(
          payload.resolutionStatus,
          new Set(['ambiguous', 'candidate', 'resolved', 'unassigned']),
          'payload.resolutionStatus',
        ),
        status: parseEnum(payload.status, new Set(['available', 'missing', 'unknown']), 'payload.status'),
      };
    }
    case 'checkout-fact-tombstone': {
      exactKeys(payload, ['kind', 'checkoutId', 'reasonCode', 'tombstonedAt']);
      return {
        checkoutId: parseCheckoutId(payload.checkoutId),
        kind,
        reasonCode: boundedText(payload.reasonCode, 'payload.reasonCode', 128),
        tombstonedAt: parseInstant(payload.tombstonedAt, 'payload.tombstonedAt'),
      };
    }
    case 'memory-observation-upsert': {
      exactKeys(payload, ['kind', 'content', 'observationId', 'observedAt', 'projectId', 'sensitivity', 'sourceKind']);
      if (payload.sensitivity !== 'normal') {
        throw new ReplicationProtocolError('invalid-value', 'payload.sensitivity');
      }
      return {
        content: jsonValue(payload.content, 'payload.content'),
        kind,
        observationId: parseMemoryObservationId(payload.observationId),
        observedAt: parseInstant(payload.observedAt, 'payload.observedAt'),
        projectId: optionalId(payload.projectId, parseProjectId),
        sensitivity: 'normal',
        sourceKind: parseEnum(
          payload.sourceKind,
          new Set(['agent', 'commit', 'file', 'import', 'pull-request', 'session', 'user']),
          'payload.sourceKind',
        ),
      };
    }
    case 'memory-proposal-upsert': {
      exactKeys(payload, [
        'kind',
        'guidance',
        'projectId',
        'proposalId',
        'proposedKind',
        'sensitivity',
        'status',
        'structuredContent',
        'summary',
        'title',
        'trust',
      ]);
      if (payload.sensitivity !== 'normal') {
        throw new ReplicationProtocolError('invalid-value', 'payload.sensitivity');
      }
      return {
        guidance: guidance(payload.guidance),
        kind,
        projectId: optionalId(payload.projectId, parseProjectId),
        proposalId: parseMemoryProposalId(payload.proposalId),
        proposedKind: parseEnum(payload.proposedKind, memoryKinds, 'payload.proposedKind'),
        sensitivity: 'normal',
        status: parseEnum(payload.status, new Set(['accepted', 'rejected', 'superseded']), 'payload.status'),
        structuredContent: jsonValue(payload.structuredContent, 'payload.structuredContent'),
        summary: boundedText(payload.summary, 'payload.summary', 16_384, 0),
        title: boundedText(payload.title, 'payload.title', 512),
        trust: parseEnum(payload.trust, new Set(['explicit', 'harvest-accepted']), 'payload.trust'),
      };
    }
    case 'memory-item-revision-upsert': {
      exactKeys(payload, [
        'kind',
        'guidance',
        'itemId',
        'itemKind',
        'projectId',
        'revisionCreatedAt',
        'revisionId',
        'revisionNumber',
        'scope',
        'sensitivity',
        'status',
        'structuredContent',
        'summary',
        'title',
        'trust',
      ]);
      if (payload.sensitivity !== 'normal') {
        throw new ReplicationProtocolError('invalid-value', 'payload.sensitivity');
      }
      return {
        guidance: guidance(payload.guidance),
        itemId: parseMemoryItemId(payload.itemId),
        itemKind: parseEnum(payload.itemKind, memoryKinds, 'payload.itemKind'),
        kind,
        projectId: optionalId(payload.projectId, parseProjectId),
        revisionCreatedAt: parseInstant(payload.revisionCreatedAt, 'payload.revisionCreatedAt'),
        revisionId: parseMemoryRevisionId(payload.revisionId),
        revisionNumber: integer(payload.revisionNumber, 'payload.revisionNumber', 1),
        scope: parseEnum(payload.scope, new Set(['person', 'project', 'space']), 'payload.scope'),
        sensitivity: 'normal',
        status: parseEnum(payload.status, new Set(['active', 'archived', 'rejected', 'superseded']), 'payload.status'),
        structuredContent: jsonValue(payload.structuredContent, 'payload.structuredContent'),
        summary: boundedText(payload.summary, 'payload.summary', 16_384, 0),
        title: boundedText(payload.title, 'payload.title', 512),
        trust: parseEnum(payload.trust, new Set(['explicit', 'harvest-accepted']), 'payload.trust'),
      };
    }
    case 'memory-relation-upsert': {
      exactKeys(payload, ['kind', 'createdAt', 'fromMemoryItemId', 'relationId', 'relationKind', 'toMemoryItemId']);
      return {
        createdAt: parseInstant(payload.createdAt, 'payload.createdAt'),
        fromMemoryItemId: parseMemoryItemId(payload.fromMemoryItemId),
        kind,
        relationId: parseMemoryRelationId(payload.relationId),
        relationKind: parseEnum(
          payload.relationKind,
          new Set(['applies-to', 'contradicts', 'derived-from', 'related-to', 'supersedes', 'supports']),
          'payload.relationKind',
        ),
        toMemoryItemId: parseMemoryItemId(payload.toMemoryItemId),
      };
    }
    case 'memory-fact-tombstone': {
      exactKeys(payload, ['kind', 'itemId', 'reasonCode', 'tombstonedAt']);
      return {
        itemId: parseMemoryItemId(payload.itemId),
        kind,
        reasonCode: boundedText(payload.reasonCode, 'payload.reasonCode', 128),
        tombstonedAt: parseInstant(payload.tombstonedAt, 'payload.tombstonedAt'),
      };
    }
    default:
      throw new ReplicationProtocolError('invalid-value', 'payload.kind');
  }
};

export const parseCaptureContextSnapshot = (value: unknown): CaptureContextSnapshot => {
  const context = recordValue(value, 'captureContext');
  exactKeys(context, [
    'deviceId',
    'id',
    'personId',
    'projectId',
    'scmAccountId',
    'scmInstallationId',
    'source',
    'spaceId',
  ]);
  return {
    deviceId: parseDeviceId(context.deviceId),
    id: parseCaptureContextId(context.id),
    personId: parsePersonId(context.personId),
    projectId: optionalId(context.projectId, parseProjectId),
    scmAccountId: optionalId(context.scmAccountId, parseScmAccountId),
    scmInstallationId: optionalId(context.scmInstallationId, parseScmInstallationId),
    source: parseEnum(
      context.source,
      new Set(['explicit', 'personal-fallback', 'project-rule', 'unassigned']),
      'captureContext.source',
    ),
    spaceId: parseSpaceId(context.spaceId),
  };
};

export interface CreateReplicationEventInput {
  readonly captureContextId: CaptureContextId;
  readonly changeKind: ReplicationChangeKind;
  readonly eventId: ReplicationEventId;
  readonly factKey: string;
  readonly generation: ReplicationGeneration;
  readonly payload: ReplicationPayload;
}

export const createReplicationEvent = (input: CreateReplicationEventInput): ReplicationEvent => {
  const payload = parseReplicationPayload(input.payload);
  if (payload.kind !== input.changeKind) {
    throw new ReplicationProtocolError('invalid-value', 'changeKind');
  }
  const event: ReplicationEvent = {
    captureContextId: parseCaptureContextId(input.captureContextId),
    changeKind: input.changeKind,
    contentHash: replicationEventContentHash(input.changeKind, input.captureContextId, payload),
    eventId: parseReplicationEventId(input.eventId),
    factKey: boundedText(input.factKey, 'factKey', replicationBounds.factKeyBytes),
    generation: parseReplicationGeneration(input.generation),
    payload,
  };
  if (new TextEncoder().encode(canonicalReplicationJson(event.payload)).byteLength > replicationBounds.payloadBytes) {
    throw new ReplicationProtocolError('bounds-exceeded', 'payload');
  }
  return Object.freeze(event);
};

export const parseReplicationEvent = (value: unknown): ReplicationEvent => {
  const event = recordValue(value, 'event');
  exactKeys(event, ['captureContextId', 'changeKind', 'contentHash', 'eventId', 'factKey', 'generation', 'payload']);
  const payload = parseReplicationPayload(event.payload);
  if (event.changeKind !== payload.kind) {
    throw new ReplicationProtocolError('invalid-value', 'event.changeKind');
  }
  const parsed = createReplicationEvent({
    captureContextId: parseCaptureContextId(event.captureContextId),
    changeKind: payload.kind,
    eventId: parseReplicationEventId(event.eventId),
    factKey: boundedText(event.factKey, 'event.factKey', replicationBounds.factKeyBytes),
    generation: parseReplicationGeneration(event.generation, 'event.generation'),
    payload,
  });
  if (parseHash(event.contentHash, 'event.contentHash') !== parsed.contentHash) {
    throw new ReplicationProtocolError('hash-mismatch', 'event.contentHash');
  }
  return parsed;
};

type ReplicationBatchWithoutIdempotencyKey = Omit<ReplicationBatch, 'idempotencyKey' | 'protocolVersion'>;

export const replicationBatchIdempotencyKey = (batch: ReplicationBatchWithoutIdempotencyKey): string =>
  replicationHash({
    batchId: batch.batchId,
    captureContexts: batch.captureContexts,
    deviceId: batch.deviceId,
    events: batch.events,
    fromGenerationExclusive: batch.fromGenerationExclusive,
    previousAckProof: batch.previousAckProof ?? null,
    protocolVersion: REPLICATION_PROTOCOL_VERSION,
    streamId: batch.streamId,
    toGenerationInclusive: batch.toGenerationInclusive,
  });

const validateBatchSemantics = (batch: ReplicationBatch): ReplicationBatch => {
  if (batch.events.length === 0 || batch.events.length > replicationBounds.eventsPerBatch) {
    throw new ReplicationProtocolError('bounds-exceeded', 'events');
  }
  if (batch.captureContexts.length === 0 || batch.captureContexts.length > replicationBounds.captureContextsPerBatch) {
    throw new ReplicationProtocolError('bounds-exceeded', 'captureContexts');
  }
  if (batch.toGenerationInclusive - batch.fromGenerationExclusive !== batch.events.length) {
    throw new ReplicationProtocolError('invalid-value', 'generationRange');
  }
  const eventIds = new Set<string>();
  const contextIds = new Set<string>();
  for (const context of batch.captureContexts) {
    if (context.deviceId !== batch.deviceId || contextIds.has(context.id)) {
      throw new ReplicationProtocolError('invalid-value', 'captureContexts');
    }
    contextIds.add(context.id);
  }
  for (const [index, event] of batch.events.entries()) {
    if (
      event.generation !== batch.fromGenerationExclusive + index + 1 ||
      eventIds.has(event.eventId) ||
      !contextIds.has(event.captureContextId)
    ) {
      throw new ReplicationProtocolError('invalid-value', 'events');
    }
    eventIds.add(event.eventId);
  }
  if (replicationBatchIdempotencyKey(batch) !== batch.idempotencyKey) {
    throw new ReplicationProtocolError('hash-mismatch', 'idempotencyKey');
  }
  if (new TextEncoder().encode(canonicalReplicationJson(batch)).byteLength > replicationBounds.batchBytes) {
    throw new ReplicationProtocolError('bounds-exceeded', 'batch');
  }
  return Object.freeze(batch);
};

export const createReplicationBatch = (input: ReplicationBatchWithoutIdempotencyKey): ReplicationBatch => {
  const normalized: ReplicationBatchWithoutIdempotencyKey = {
    batchId: parseReplicationBatchId(input.batchId),
    captureContexts: input.captureContexts.map(parseCaptureContextSnapshot),
    deviceId: parseDeviceId(input.deviceId),
    events: input.events.map(parseReplicationEvent),
    fromGenerationExclusive: parseReplicationGeneration(input.fromGenerationExclusive, 'fromGenerationExclusive'),
    ...(input.previousAckProof === undefined
      ? {}
      : { previousAckProof: parseHash(input.previousAckProof, 'previousAckProof') }),
    streamId: parseReplicationStreamId(input.streamId),
    toGenerationInclusive: parseReplicationGeneration(input.toGenerationInclusive, 'toGenerationInclusive'),
  };
  return validateBatchSemantics({
    ...normalized,
    idempotencyKey: replicationBatchIdempotencyKey(normalized),
    protocolVersion: REPLICATION_PROTOCOL_VERSION,
  });
};

export const parseReplicationBatch = (value: unknown): ReplicationBatch => {
  const batch = recordValue(value, 'batch');
  exactKeys(
    batch,
    [
      'batchId',
      'captureContexts',
      'deviceId',
      'events',
      'fromGenerationExclusive',
      'idempotencyKey',
      'protocolVersion',
      'streamId',
      'toGenerationInclusive',
    ],
    ['previousAckProof'],
  );
  if (batch.protocolVersion !== REPLICATION_PROTOCOL_VERSION) {
    throw new ReplicationProtocolError('unsupported-version', 'protocolVersion');
  }
  if (!(Array.isArray(batch.captureContexts) && Array.isArray(batch.events))) {
    throw new ReplicationProtocolError('invalid-value', 'batch');
  }
  const parsed: ReplicationBatch = {
    batchId: parseReplicationBatchId(batch.batchId),
    captureContexts: batch.captureContexts.map(parseCaptureContextSnapshot),
    deviceId: parseDeviceId(batch.deviceId),
    events: batch.events.map(parseReplicationEvent),
    fromGenerationExclusive: parseReplicationGeneration(batch.fromGenerationExclusive, 'fromGenerationExclusive'),
    idempotencyKey: parseHash(batch.idempotencyKey, 'idempotencyKey'),
    ...(batch.previousAckProof === undefined
      ? {}
      : { previousAckProof: parseHash(batch.previousAckProof, 'previousAckProof') }),
    protocolVersion: REPLICATION_PROTOCOL_VERSION,
    streamId: parseReplicationStreamId(batch.streamId),
    toGenerationInclusive: parseReplicationGeneration(batch.toGenerationInclusive, 'toGenerationInclusive'),
  };
  return validateBatchSemantics(parsed);
};

const parseApplyCounts = (value: unknown): BoundedApplyCounts => {
  const counts = recordValue(value, 'counts');
  exactKeys(counts, ['applied', 'duplicate', 'projected', 'tombstoned']);
  return {
    applied: integer(counts.applied, 'counts.applied', 0, replicationBounds.eventsPerBatch),
    duplicate: integer(counts.duplicate, 'counts.duplicate', 0, replicationBounds.eventsPerBatch),
    projected: integer(counts.projected, 'counts.projected', 0, replicationBounds.eventsPerBatch),
    tombstoned: integer(counts.tombstoned, 'counts.tombstoned', 0, replicationBounds.eventsPerBatch),
  };
};

const parseWarning = (value: unknown): BoundedReplicationWarning => {
  const warning = recordValue(value, 'warning');
  exactKeys(warning, ['code'], ['eventId']);
  if (typeof warning.code !== 'string' || !codePattern.test(warning.code)) {
    throw new ReplicationProtocolError('invalid-value', 'warning.code');
  }
  return {
    code: warning.code,
    ...(warning.eventId === undefined ? {} : { eventId: parseReplicationEventId(warning.eventId) }),
  };
};

export const parseReplicationAck = (value: unknown): ReplicationAck => {
  const ack = recordValue(value, 'ack');
  exactKeys(ack, [
    'acceptedThroughGeneration',
    'appliedAt',
    'appliedBatchId',
    'appliedEventIds',
    'counts',
    'deviceId',
    'protocolVersion',
    'streamId',
    'warnings',
  ]);
  if (ack.protocolVersion !== REPLICATION_PROTOCOL_VERSION) {
    throw new ReplicationProtocolError('unsupported-version', 'protocolVersion');
  }
  if (!(Array.isArray(ack.appliedEventIds) && Array.isArray(ack.warnings))) {
    throw new ReplicationProtocolError('invalid-value', 'ack');
  }
  if (
    ack.appliedEventIds.length > replicationBounds.eventsPerBatch ||
    ack.warnings.length > replicationBounds.warningCount
  ) {
    throw new ReplicationProtocolError('bounds-exceeded', 'ack');
  }
  return Object.freeze({
    acceptedThroughGeneration: parseReplicationGeneration(ack.acceptedThroughGeneration, 'acceptedThroughGeneration'),
    appliedAt: parseInstant(ack.appliedAt, 'appliedAt'),
    appliedBatchId: parseReplicationBatchId(ack.appliedBatchId),
    appliedEventIds: ack.appliedEventIds.map(parseReplicationEventId),
    counts: parseApplyCounts(ack.counts),
    deviceId: parseDeviceId(ack.deviceId),
    protocolVersion: REPLICATION_PROTOCOL_VERSION,
    streamId: parseReplicationStreamId(ack.streamId),
    warnings: ack.warnings.map(parseWarning),
  });
};

export const replicationAckProof = (ack: ReplicationAck): string => replicationHash(parseReplicationAck(ack));

const problemCodes = new Set<ReplicationProblemCode>([
  'batch-id-conflict',
  'capture-context-forbidden',
  'event-id-conflict',
  'generation-gap',
  'invalid-batch',
  'overlap-conflict',
  'protocol-incompatible',
  'rate-limited',
  'request-too-large',
  'revoked',
  'server-unavailable',
  'unauthenticated',
]);

export const parseReplicationProblem = (value: unknown): ReplicationProblem => {
  const problem = recordValue(value, 'problem');
  exactKeys(problem, ['code'], ['expectedGeneration', 'retryAfterSeconds']);
  return Object.freeze({
    code: parseEnum(problem.code, problemCodes, 'problem.code'),
    ...(problem.expectedGeneration === undefined
      ? {}
      : { expectedGeneration: parseReplicationGeneration(problem.expectedGeneration, 'problem.expectedGeneration') }),
    ...(problem.retryAfterSeconds === undefined
      ? {}
      : { retryAfterSeconds: integer(problem.retryAfterSeconds, 'problem.retryAfterSeconds', 0, 86_400) }),
  });
};
