import { createHash } from 'node:crypto';
import type { AuthorizationPrincipal } from '@ai-usage/authorization-contract';
import type {
  CaptureContextId,
  Instant,
  MemoryImportId,
  MemoryItemId,
  MemoryObservationId,
  MemoryProposalId,
  MemoryRelationId,
  MemoryRevisionId,
  PersonId,
  ProjectId,
  SpaceId,
} from '@ai-usage/platform-core/identity';
import {
  parseInstant,
  parseMemoryItemId,
  parseMemoryObservationId,
  parseMemoryRevisionId,
  parsePersonId,
  parseProjectId,
  parseSpaceId,
} from '@ai-usage/platform-core/identity';
import type {
  MemoryFactTombstonePayload,
  MemoryItemRevisionUpsertPayload,
  ReplicationEventId,
} from '@ai-usage/replication-protocol';

export const MEMORY_REDACTION_RULE_SET_VERSION = 'memory-redaction-v1' as const;

export const memoryKinds = [
  'decision',
  'pattern',
  'pitfall',
  'command',
  'constraint',
  'handoff',
  'lesson',
  'preference',
] as const;

export type MemoryKind = (typeof memoryKinds)[number];
export type MemoryScope = 'person' | 'project' | 'space';
export type MemorySensitivity = 'normal' | 'sensitive';
export type MemoryTrust = 'explicit' | 'harvest-accepted';
export type MemoryItemStatus = 'active' | 'archived' | 'rejected' | 'superseded';
export type MemoryProposalStatus = 'accepted' | 'pending' | 'rejected' | 'superseded';
export type MemoryRelationKind =
  | 'applies-to'
  | 'contradicts'
  | 'derived-from'
  | 'related-to'
  | 'supersedes'
  | 'supports';
export type MemoryObservationSourceKind = 'agent' | 'commit' | 'file' | 'import' | 'pull-request' | 'session' | 'user';

export type MemoryJsonValue =
  | boolean
  | null
  | number
  | string
  | readonly MemoryJsonValue[]
  | { readonly [key: string]: MemoryJsonValue };

export type StructuredObservation = MemoryJsonValue;
export type MemoryPrincipalRef = AuthorizationPrincipal;

export class MemoryDomainValidationError extends Error {
  readonly field: string;

  constructor(field: string) {
    super('The Memory domain value is invalid.');
    this.name = 'MemoryDomainValidationError';
    this.field = field;
  }
}

export interface MemoryObservation {
  readonly captureContextId: CaptureContextId | null;
  readonly content: StructuredObservation;
  readonly contentHash: string;
  readonly createdByPrincipal: MemoryPrincipalRef;
  readonly fingerprint: string;
  readonly id: MemoryObservationId;
  readonly observedAt: Instant;
  readonly owningSpaceId: SpaceId;
  readonly projectId: ProjectId | null;
  readonly redactionRuleSetVersion: typeof MEMORY_REDACTION_RULE_SET_VERSION;
  readonly sensitivity: MemorySensitivity;
  readonly sourceKind: MemoryObservationSourceKind;
  readonly sourceLocator: string | null;
}

export interface MemoryProposal {
  readonly guidance: readonly string[];
  readonly id: MemoryProposalId;
  readonly owningSpaceId: SpaceId;
  readonly projectId: ProjectId | null;
  readonly proposedByPrincipal: MemoryPrincipalRef;
  readonly proposedKind: MemoryKind;
  readonly reviewedAt: Instant | null;
  readonly reviewedByPersonId: PersonId | null;
  readonly reviewReason: string | null;
  readonly sensitivity: MemorySensitivity;
  readonly status: MemoryProposalStatus;
  readonly structuredContent: MemoryJsonValue;
  readonly summary: string;
  readonly title: string;
  readonly trustCandidate: MemoryTrust;
}

export interface MemoryItem {
  readonly currentRevisionId: MemoryRevisionId;
  readonly id: MemoryItemId;
  readonly kind: MemoryKind;
  readonly owningSpaceId: SpaceId;
  readonly projectId: ProjectId | null;
  readonly scope: MemoryScope;
  readonly sensitivity: MemorySensitivity;
  readonly status: MemoryItemStatus;
  readonly trust: MemoryTrust;
}

export interface MemoryRevision {
  readonly createdAt: Instant;
  readonly createdByPrincipal: MemoryPrincipalRef;
  readonly guidance: readonly string[];
  readonly id: MemoryRevisionId;
  readonly memoryItemId: MemoryItemId;
  readonly reason: string | null;
  readonly revisionNumber: number;
  readonly structuredContent: MemoryJsonValue;
  readonly summary: string;
  readonly title: string;
}

export interface MemoryRelation {
  readonly createdAt: Instant;
  readonly createdByPrincipal: MemoryPrincipalRef;
  readonly fromMemoryItemId: MemoryItemId;
  readonly id: MemoryRelationId;
  readonly kind: MemoryRelationKind;
  readonly owningSpaceId: SpaceId;
  readonly reason: string | null;
  readonly toMemoryItemId: MemoryItemId;
}

export interface MemoryImport {
  readonly confirmedAt: Instant | null;
  readonly confirmedByPersonId: PersonId | null;
  readonly contentHash: string;
  readonly createdAt: Instant;
  readonly destinationProjectId: ProjectId | null;
  readonly destinationSpaceId: SpaceId;
  readonly fingerprint: string;
  readonly id: MemoryImportId;
  readonly previewProof: string;
  readonly sourceKind: 'legacy-jsonl' | 'legacy-markdown';
  readonly sourceLocator: string;
  readonly status: 'confirmed' | 'previewed' | 'quarantined' | 'stale';
}

export interface ReplicationOutboxEvent {
  readonly changeKind: 'memory-fact-tombstone' | 'memory-item-revision-upsert';
  readonly enqueuedAt: Instant;
  readonly eventId: ReplicationEventId;
  readonly factKey: string;
  readonly owningSpaceId: SpaceId;
  readonly payload: MemoryFactTombstonePayload | MemoryItemRevisionUpsertPayload;
  readonly projectId: ProjectId | null;
}

export interface MemoryItemResult {
  readonly item: MemoryItem;
  readonly revision: MemoryRevision;
}

export interface CurrentMemoryItemResult extends MemoryItemResult {}

export interface MemoryItemPage {
  readonly items: readonly CurrentMemoryItemResult[];
  readonly nextCursor: string | null;
}

export interface MemoryProposalObservationSource {
  readonly id: MemoryObservationId;
  readonly observedAt: Instant;
  readonly sensitivity: MemorySensitivity;
  readonly sourceKind: MemoryObservationSourceKind;
  readonly sourceLocator: string | null;
}

export interface MemoryProposalReview {
  readonly observationSources: readonly MemoryProposalObservationSource[];
  readonly proposal: MemoryProposal;
}

export interface MemoryProposalPage {
  readonly items: readonly MemoryProposalReview[];
  readonly nextCursor: string | null;
}

export interface MemoryExportItem {
  readonly item: MemoryItem;
  readonly provenance: readonly MemoryProposalObservationSource[];
  readonly relations: readonly MemoryExportRelation[];
  readonly revisions: readonly MemoryRevision[];
}

export interface MemoryExportRelation {
  readonly kind: MemoryRelationKind;
  readonly reason: string | null;
  readonly toMemoryItemId: MemoryItemId;
}

export interface MemoryExportSnapshot {
  readonly items: readonly MemoryExportItem[];
  readonly spaceId: SpaceId;
}

const isMemoryJsonObject = (value: MemoryJsonValue): value is { readonly [key: string]: MemoryJsonValue } =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export const parseMemoryJsonValue = (value: unknown, field = 'memoryJson'): MemoryJsonValue => {
  let nodes = 0;
  const visit = (entry: unknown, depth: number): MemoryJsonValue => {
    nodes += 1;
    if (nodes > 10_000 || depth > 32) {
      throw new MemoryDomainValidationError(field);
    }
    if (entry === null || typeof entry === 'string' || typeof entry === 'boolean') {
      return entry;
    }
    if (typeof entry === 'number') {
      if (!Number.isFinite(entry)) {
        throw new MemoryDomainValidationError(field);
      }
      return entry;
    }
    if (Array.isArray(entry)) {
      return entry.map((item) => visit(item, depth + 1));
    }
    if (typeof entry !== 'object' || Object.getPrototypeOf(entry) !== Object.prototype) {
      throw new MemoryDomainValidationError(field);
    }
    const result: Record<string, MemoryJsonValue> = {};
    for (const [key, item] of Object.entries(entry)) {
      if (key.length === 0 || key.length > 256) {
        throw new MemoryDomainValidationError(field);
      }
      result[key] = visit(item, depth + 1);
    }
    return result;
  };
  return visit(value, 0);
};

const normalizeJson = (value: MemoryJsonValue): MemoryJsonValue => {
  if (Array.isArray(value)) {
    return value.map(normalizeJson);
  }
  if (isMemoryJsonObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, normalizeJson(value[key] ?? null)]),
    );
  }
  return value;
};

export const stableMemoryJson = (value: MemoryJsonValue): string => JSON.stringify(normalizeJson(value));

export const memoryContentHash = (value: MemoryJsonValue): string =>
  createHash('sha256').update(stableMemoryJson(value)).digest('hex');

export const memoryFingerprint = (value: MemoryJsonValue): string => memoryContentHash(value);

export const memoryObservationIdForFingerprint = (spaceId: SpaceId, fingerprint: string): MemoryObservationId => {
  const digest = createHash('sha256').update(`${spaceId}:${fingerprint}`).digest('hex');
  const uuid = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-8${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
  return parseMemoryObservationId(uuid);
};

const isWireRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasWireKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};

const wireText = (value: unknown, maximum: number, field: string, allowEmpty = false): string => {
  if (
    typeof value !== 'string' ||
    (!allowEmpty && value.length === 0) ||
    value.length > maximum ||
    value.includes('\0')
  ) {
    throw new MemoryDomainValidationError(field);
  }
  return value;
};

const parseMemoryPrincipal = (value: unknown): MemoryPrincipalRef => {
  if (!(isWireRecord(value) && typeof value.kind === 'string')) {
    throw new MemoryDomainValidationError('createdByPrincipal');
  }
  if (value.kind === 'person' && hasWireKeys(value, ['kind', 'personId'])) {
    return { kind: 'person', personId: parsePersonId(value.personId) };
  }
  if (value.kind === 'service' && hasWireKeys(value, ['id', 'kind'])) {
    return { id: wireText(value.id, 256, 'createdByPrincipal'), kind: 'service' };
  }
  throw new MemoryDomainValidationError('createdByPrincipal');
};

export const parseMemoryItemResult = (value: unknown): MemoryItemResult => {
  if (!(isWireRecord(value) && hasWireKeys(value, ['item', 'revision']))) {
    throw new MemoryDomainValidationError('memoryItemResult');
  }
  const itemValue = value.item;
  const revisionValue = value.revision;
  if (
    !(
      isWireRecord(itemValue) &&
      hasWireKeys(itemValue, [
        'currentRevisionId',
        'id',
        'kind',
        'owningSpaceId',
        'projectId',
        'scope',
        'sensitivity',
        'status',
        'trust',
      ]) &&
      typeof itemValue.kind === 'string' &&
      memoryKinds.includes(itemValue.kind as MemoryKind) &&
      (itemValue.projectId === null || typeof itemValue.projectId === 'string') &&
      ['person', 'project', 'space'].includes(String(itemValue.scope)) &&
      (itemValue.sensitivity === 'normal' || itemValue.sensitivity === 'sensitive') &&
      ['active', 'archived', 'rejected', 'superseded'].includes(String(itemValue.status)) &&
      (itemValue.trust === 'explicit' || itemValue.trust === 'harvest-accepted')
    )
  ) {
    throw new MemoryDomainValidationError('memoryItemResult.item');
  }
  if (
    !(
      isWireRecord(revisionValue) &&
      hasWireKeys(revisionValue, [
        'createdAt',
        'createdByPrincipal',
        'guidance',
        'id',
        'memoryItemId',
        'reason',
        'revisionNumber',
        'structuredContent',
        'summary',
        'title',
      ]) &&
      Array.isArray(revisionValue.guidance) &&
      revisionValue.guidance.length <= 64 &&
      (revisionValue.reason === null || typeof revisionValue.reason === 'string') &&
      Number.isSafeInteger(revisionValue.revisionNumber) &&
      Number(revisionValue.revisionNumber) > 0
    )
  ) {
    throw new MemoryDomainValidationError('memoryItemResult.revision');
  }
  const item: MemoryItem = {
    currentRevisionId: parseMemoryRevisionId(itemValue.currentRevisionId),
    id: parseMemoryItemId(itemValue.id),
    kind: itemValue.kind as MemoryKind,
    owningSpaceId: parseSpaceId(itemValue.owningSpaceId),
    projectId: itemValue.projectId === null ? null : parseProjectId(itemValue.projectId),
    scope: itemValue.scope as MemoryScope,
    sensitivity: itemValue.sensitivity,
    status: itemValue.status as MemoryItemStatus,
    trust: itemValue.trust,
  };
  const revision: MemoryRevision = {
    createdAt: parseInstant(revisionValue.createdAt),
    createdByPrincipal: parseMemoryPrincipal(revisionValue.createdByPrincipal),
    guidance: revisionValue.guidance.map((entry) => wireText(entry, 4096, 'memoryItemResult.revision.guidance')),
    id: parseMemoryRevisionId(revisionValue.id),
    memoryItemId: parseMemoryItemId(revisionValue.memoryItemId),
    reason:
      revisionValue.reason === null ? null : wireText(revisionValue.reason, 4096, 'memoryItemResult.revision.reason'),
    revisionNumber: Number(revisionValue.revisionNumber),
    structuredContent: parseMemoryJsonValue(revisionValue.structuredContent, 'memoryItemResult.structuredContent'),
    summary: wireText(revisionValue.summary, 16_384, 'memoryItemResult.revision.summary', true),
    title: wireText(revisionValue.title, 512, 'memoryItemResult.revision.title'),
  };
  if (item.id !== revision.memoryItemId) {
    throw new MemoryDomainValidationError('memoryItemResult.identity');
  }
  return { item, revision };
};

export const parseCurrentMemoryItemResult = (value: unknown): CurrentMemoryItemResult => {
  const result = parseMemoryItemResult(value);
  if (result.item.currentRevisionId !== result.revision.id) {
    throw new MemoryDomainValidationError('memoryItemResult.currentRevision');
  }
  return result;
};

export const memoryRevisionContent = (
  revision: Pick<MemoryRevision, 'guidance' | 'structuredContent' | 'summary' | 'title'>,
): MemoryJsonValue => ({
  guidance: revision.guidance,
  structuredContent: revision.structuredContent,
  summary: revision.summary,
  title: revision.title,
});
