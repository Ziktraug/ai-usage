import { createHash } from 'node:crypto';
import type {
  AuthorizationPermission,
  AuthorizationPrincipal,
  AuthorizationRequestContext,
  AuthorizationResource,
  Authorizer,
} from '@ai-usage/authorization-contract';
import {
  createMemoryItemId,
  createMemoryProposalId,
  createMemoryRelationId,
  createMemoryRevisionId,
  instantNow,
  type MemoryImportId,
  type MemoryItemId,
  type MemoryObservationId,
  type MemoryProposalId,
  type MemoryRevisionId,
  type PersonId,
  type ProjectId,
  parseMemoryImportId,
  parseMemoryItemId,
  parseMemoryProposalId,
  parseMemoryRelationId,
  parseMemoryRevisionId,
  type SpaceId,
} from '@ai-usage/platform-core/identity';
import { createReplicationEventId } from '@ai-usage/replication-protocol';
import {
  type MemoryItem,
  type MemoryItemPage,
  type MemoryItemResult,
  type MemoryJsonValue,
  type MemoryKind,
  type MemoryObservation,
  type MemoryObservationSourceKind,
  type MemoryProposal,
  type MemoryProposalPage,
  type MemoryRelation,
  type MemoryRelationKind,
  type MemoryRevision,
  type MemoryScope,
  type MemorySensitivity,
  type MemoryTrust,
  memoryContentHash,
  memoryObservationIdForFingerprint,
  parseMemoryJsonValue,
  type ReplicationOutboxEvent,
  type StructuredObservation,
} from './domain';
import { serializeMemoryExport } from './export';
import {
  type LegacyMemoryImportSource,
  type MemoryExportArtifact,
  type MemoryExportFormat,
  type MemoryImportConfirmation,
  type MemoryImportEffectCounts,
  type MemoryImportIssue,
  type MemoryImportPreview,
  type ParsedLegacyMemoryRecord,
  type ParsedLegacyMemorySource,
  parseLegacyMemoryImportSource,
} from './migration';
import { redactMemoryValue } from './redaction';
import {
  type MemoryAuditEvent,
  type MemoryRepository,
  MemoryRepositoryError,
  type PurgeMemoryItemInput,
} from './repository';
import {
  type MemorySearchPage,
  type MemorySearchParameters,
  MemorySearchValidationError,
  memorySearchBounds,
  normalizeMemorySearchParameters,
} from './search';

const memoryRevisionReplicationEvent = (
  item: MemoryItem,
  revision: MemoryRevision,
  enqueuedAt: ReturnType<typeof instantNow>,
): ReplicationOutboxEvent | null => {
  if (item.sensitivity !== 'normal') {
    return null;
  }
  return {
    changeKind: 'memory-item-revision-upsert',
    enqueuedAt,
    eventId: createReplicationEventId(),
    factKey: `memory-item:${item.id}`,
    owningSpaceId: item.owningSpaceId,
    payload: {
      guidance: revision.guidance,
      itemId: item.id,
      itemKind: item.kind,
      kind: 'memory-item-revision-upsert',
      projectId: item.projectId,
      revisionCreatedAt: revision.createdAt,
      revisionId: revision.id,
      revisionNumber: revision.revisionNumber,
      scope: item.scope,
      sensitivity: 'normal',
      status: item.status,
      structuredContent: revision.structuredContent,
      summary: revision.summary,
      title: revision.title,
      trust: item.trust,
    },
    projectId: item.projectId,
  };
};

const memoryTombstoneReplicationEvent = (
  item: MemoryItem,
  tombstonedAt: ReturnType<typeof instantNow>,
  reasonCode = 'superseded',
): ReplicationOutboxEvent | null => {
  if (item.sensitivity !== 'normal') {
    return null;
  }
  return {
    changeKind: 'memory-fact-tombstone',
    enqueuedAt: tombstonedAt,
    eventId: createReplicationEventId(),
    factKey: `memory-item:${item.id}`,
    owningSpaceId: item.owningSpaceId,
    payload: {
      itemId: item.id,
      kind: 'memory-fact-tombstone',
      reasonCode,
      tombstonedAt,
    },
    projectId: item.projectId,
  };
};

export type MemoryApplicationErrorCode =
  | 'authorization-denied'
  | 'authorization-unavailable'
  | 'cancelled'
  | 'conflict'
  | 'invalid-input'
  | 'not-found'
  | 'stale'
  | 'timeout'
  | 'unavailable';

export interface MemoryApplicationError {
  readonly code: MemoryApplicationErrorCode;
  readonly operation: MemoryApplicationOperation;
}

export interface MemoryApplicationFailure {
  readonly error: MemoryApplicationError;
  readonly kind: 'error';
}

export type MemoryApplicationResult<Value> =
  | MemoryApplicationFailure
  | { readonly kind: 'success'; readonly value: Value };

export type MemoryApplicationOperation =
  | 'accept-proposal'
  | 'confirm-memory-import'
  | 'create-proposal'
  | 'create-relation'
  | 'export-memory'
  | 'get-memory-item'
  | 'get-project-context'
  | 'list-memory-items'
  | 'list-pending-proposals'
  | 'preview-memory-import'
  | 'purge-memory-item'
  | 'record-observation'
  | 'reject-proposal'
  | 'revise-memory-item'
  | 'search-memory'
  | 'supersede-memory-item';

interface MemoryCommandContext {
  readonly authorization: AuthorizationRequestContext;
  readonly principal: AuthorizationPrincipal;
}

export interface RecordMemoryObservationCommand extends MemoryCommandContext {
  readonly captureContextId: MemoryObservation['captureContextId'];
  readonly content: StructuredObservation;
  readonly fingerprint: string;
  readonly observedAt?: MemoryObservation['observedAt'];
  readonly projectId: ProjectId | null;
  readonly sensitivity: MemorySensitivity;
  readonly sourceKind: MemoryObservationSourceKind;
  readonly sourceLocator: string | null;
}

export interface CreateMemoryProposalCommand extends MemoryCommandContext {
  readonly guidance: readonly string[];
  readonly observationIds: readonly MemoryObservationId[];
  readonly projectId: ProjectId | null;
  readonly proposedKind: MemoryKind;
  readonly sensitivity: MemorySensitivity;
  readonly structuredContent: MemoryJsonValue;
  readonly summary: string;
  readonly title: string;
  readonly trustCandidate: MemoryTrust;
}

export interface AcceptMemoryProposalCommand extends MemoryCommandContext {
  readonly edits?: {
    readonly guidance: readonly string[];
    readonly sensitivity: MemorySensitivity;
    readonly structuredContent: MemoryJsonValue;
    readonly summary: string;
    readonly title: string;
  };
  readonly proposalId: MemoryProposalId;
  readonly scope: MemoryScope;
  readonly spaceId: SpaceId;
}

export interface RejectMemoryProposalCommand extends MemoryCommandContext {
  readonly proposalId: MemoryProposalId;
  readonly reason: string;
  readonly spaceId: SpaceId;
}

export interface ReviseMemoryItemCommand extends MemoryCommandContext {
  readonly expectedCurrentRevisionId: MemoryRevisionId;
  readonly guidance: readonly string[];
  readonly itemId: MemoryItemId;
  readonly reason: string;
  readonly spaceId: SpaceId;
  readonly structuredContent: MemoryJsonValue;
  readonly summary: string;
  readonly title: string;
}

export interface SupersedeMemoryItemCommand extends MemoryCommandContext {
  readonly itemId: MemoryItemId;
  readonly reason: string;
  readonly spaceId: SpaceId;
}

export interface PurgeMemoryItemCommand extends MemoryCommandContext {
  readonly itemId: MemoryItemId;
  readonly spaceId: SpaceId;
}

export interface CreateMemoryRelationCommand extends MemoryCommandContext {
  readonly fromMemoryItemId: MemoryItemId;
  readonly kind: MemoryRelationKind;
  readonly reason: string | null;
  readonly spaceId: SpaceId;
  readonly toMemoryItemId: MemoryItemId;
}

export interface GetMemoryItemQuery extends MemoryCommandContext {
  readonly itemId: MemoryItemId;
  readonly revisionId?: MemoryRevisionId | null;
  readonly spaceId: SpaceId;
}

export interface ListMemoryItemsApplicationQuery extends MemoryCommandContext {
  readonly cursor?: string | null;
  readonly pageSize: number;
  readonly projectId?: ProjectId | null;
  readonly spaceId: SpaceId;
  readonly status?: MemoryItem['status'];
}

export interface ListPendingMemoryProposalsQuery extends MemoryCommandContext {
  readonly cursor?: string | null;
  readonly pageSize: number;
  readonly spaceId: SpaceId;
}

export interface PreviewMemoryImportCommand extends MemoryCommandContext {
  readonly destinationProjectId: ProjectId | null;
  readonly destinationSpaceId: SpaceId;
  readonly source: LegacyMemoryImportSource;
}

export interface ConfirmMemoryImportCommand extends PreviewMemoryImportCommand {
  readonly importId: MemoryImportId;
  readonly previewProof: string;
}

export interface ExportMemoryQuery extends MemoryCommandContext {
  readonly format: MemoryExportFormat;
  readonly projectId?: ProjectId | null;
  readonly spaceId: SpaceId;
}

export interface SearchMemoryApplicationQuery extends MemoryCommandContext, MemorySearchParameters {
  readonly signal?: AbortSignal;
}

export const memoryProjectContextBounds = Object.freeze({
  maxItems: 32,
  maxScannedItems: 500,
  pageSize: 100,
});

export interface GetMemoryProjectContextQuery extends MemoryCommandContext {
  readonly limit: number;
  readonly projectId: ProjectId;
  readonly signal?: AbortSignal;
  readonly spaceId: SpaceId;
}

export interface MemoryProjectContext {
  readonly items: readonly MemoryItemResult[];
  readonly projectId: ProjectId;
  readonly spaceId: SpaceId;
  readonly truncated: boolean;
}

export interface MemoryApplicationService {
  readonly acceptProposal: (command: AcceptMemoryProposalCommand) => Promise<MemoryApplicationResult<MemoryItemResult>>;
  readonly confirmMemoryImport: (
    command: ConfirmMemoryImportCommand,
  ) => Promise<MemoryApplicationResult<MemoryImportConfirmation>>;
  readonly createProposal: (command: CreateMemoryProposalCommand) => Promise<MemoryApplicationResult<MemoryProposalId>>;
  readonly createRelation: (command: CreateMemoryRelationCommand) => Promise<MemoryApplicationResult<void>>;
  readonly exportMemory: (query: ExportMemoryQuery) => Promise<MemoryApplicationResult<MemoryExportArtifact>>;
  readonly getMemoryItem: (query: GetMemoryItemQuery) => Promise<MemoryApplicationResult<MemoryItemResult>>;
  readonly getProjectContext: (
    query: GetMemoryProjectContextQuery,
  ) => Promise<MemoryApplicationResult<MemoryProjectContext>>;
  readonly listMemoryItems: (
    query: ListMemoryItemsApplicationQuery,
  ) => Promise<MemoryApplicationResult<MemoryItemPage>>;
  readonly listPendingProposals: (
    query: ListPendingMemoryProposalsQuery,
  ) => Promise<MemoryApplicationResult<MemoryProposalPage>>;
  readonly previewMemoryImport: (
    command: PreviewMemoryImportCommand,
  ) => Promise<MemoryApplicationResult<MemoryImportPreview>>;
  readonly purgeMemoryItem: (command: PurgeMemoryItemCommand) => Promise<MemoryApplicationResult<void>>;
  readonly recordObservation: (
    command: RecordMemoryObservationCommand,
  ) => Promise<MemoryApplicationResult<{ readonly created: boolean; readonly id: MemoryObservationId }>>;
  readonly rejectProposal: (command: RejectMemoryProposalCommand) => Promise<MemoryApplicationResult<void>>;
  readonly reviseMemoryItem: (command: ReviseMemoryItemCommand) => Promise<MemoryApplicationResult<MemoryItemResult>>;
  readonly searchMemory: (query: SearchMemoryApplicationQuery) => Promise<MemoryApplicationResult<MemorySearchPage>>;
  readonly supersedeMemoryItem: (command: SupersedeMemoryItemCommand) => Promise<MemoryApplicationResult<void>>;
}

const fingerprintPattern = /^[0-9a-f]{64}$/u;
const maximumGuidanceItems = 64;
const maximumStructuredBytes = 256 * 1024;

const errorResult = (
  operation: MemoryApplicationOperation,
  code: MemoryApplicationErrorCode,
): MemoryApplicationFailure => ({ error: { code, operation }, kind: 'error' });

const success = <Value>(value: Value): MemoryApplicationResult<Value> => ({ kind: 'success', value });

const personIdFor = (principal: AuthorizationPrincipal): PersonId | null =>
  principal.kind === 'person' ? principal.personId : null;

const validText = (value: string, maximumLength: number, allowEmpty = false): boolean =>
  (allowEmpty || value.length > 0) && value.length <= maximumLength && value.trim() === value;

const validGuidance = (value: readonly string[]): boolean =>
  value.length <= maximumGuidanceItems && value.every((entry) => validText(entry, 4096));

const validJson = (value: MemoryJsonValue): boolean => {
  try {
    return Buffer.byteLength(JSON.stringify(parseMemoryJsonValue(value)), 'utf8') <= maximumStructuredBytes;
  } catch {
    return false;
  }
};

const projectContextKindOrder = new Map<MemoryKind, number>([
  ['constraint', 0],
  ['decision', 1],
  ['pitfall', 2],
  ['command', 3],
]);

const validateDraft = (input: {
  readonly guidance: readonly string[];
  readonly structuredContent: MemoryJsonValue;
  readonly summary: string;
  readonly title: string;
}): boolean =>
  validText(input.title, 512) &&
  validText(input.summary, 16_384, true) &&
  validGuidance(input.guidance) &&
  validJson(input.structuredContent);

const draftValue = (input: {
  readonly guidance: readonly string[];
  readonly structuredContent: MemoryJsonValue;
  readonly summary: string;
  readonly title: string;
}): MemoryJsonValue => ({
  guidance: input.guidance,
  structuredContent: input.structuredContent,
  summary: input.summary,
  title: input.title,
});

const isMemoryJsonObject = (value: MemoryJsonValue): value is { readonly [key: string]: MemoryJsonValue } =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const redactDraft = (
  input: {
    readonly guidance: readonly string[];
    readonly structuredContent: MemoryJsonValue;
    readonly summary: string;
    readonly title: string;
  },
  sensitivity: MemorySensitivity,
) => {
  const redacted = redactMemoryValue(draftValue(input), sensitivity);
  const value = redacted.value;
  if (!isMemoryJsonObject(value)) {
    throw new Error('Redacted Memory draft is invalid.');
  }
  const guidance = value.guidance;
  if (!(Array.isArray(guidance) && guidance.every((entry) => typeof entry === 'string'))) {
    throw new Error('Redacted Memory guidance is invalid.');
  }
  if (typeof value.title !== 'string' || typeof value.summary !== 'string' || value.structuredContent === undefined) {
    throw new Error('Redacted Memory draft is invalid.');
  }
  return {
    guidance,
    sensitivity: redacted.sensitivity,
    structuredContent: value.structuredContent,
    summary: value.summary,
    title: value.title,
  };
};

const audit = (
  action: string,
  actor: AuthorizationPrincipal,
  recordedAt: ReturnType<typeof instantNow>,
  result: MemoryAuditEvent['result'],
  spaceId: SpaceId,
  subjectId: string,
  subjectType: MemoryAuditEvent['subjectType'],
): MemoryAuditEvent => ({ action, actor, recordedAt, result, spaceId, subjectId, subjectType });

const mapRepositoryError = (
  operation: MemoryApplicationOperation,
  repositoryError: unknown,
): MemoryApplicationFailure => {
  if (!(repositoryError instanceof MemoryRepositoryError)) {
    return errorResult(operation, 'unavailable');
  }
  const code: MemoryApplicationErrorCode =
    repositoryError.code === 'invalid-input' ? 'invalid-input' : repositoryError.code;
  return errorResult(operation, code);
};

const deterministicMigrationUuid = (kind: string, spaceId: SpaceId, fingerprint: string): string => {
  const digest = createHash('sha256').update(`${kind}:${spaceId}:${fingerprint}`).digest('hex');
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-8${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
};

const importIdFor = (spaceId: SpaceId, fingerprint: string): MemoryImportId =>
  parseMemoryImportId(deterministicMigrationUuid('memory-import', spaceId, fingerprint));

const proposalIdFor = (spaceId: SpaceId, fingerprint: string): MemoryProposalId =>
  parseMemoryProposalId(deterministicMigrationUuid('memory-proposal', spaceId, fingerprint));

const itemIdFor = (spaceId: SpaceId, fingerprint: string): MemoryItemId =>
  parseMemoryItemId(deterministicMigrationUuid('memory-item', spaceId, fingerprint));

const revisionIdFor = (spaceId: SpaceId, fingerprint: string): MemoryRevisionId =>
  parseMemoryRevisionId(deterministicMigrationUuid('memory-revision', spaceId, fingerprint));

const relationIdFor = (spaceId: SpaceId, fingerprint: string): ReturnType<typeof parseMemoryRelationId> =>
  parseMemoryRelationId(deterministicMigrationUuid('memory-relation', spaceId, fingerprint));

type MutableMemoryImportEffectCounts = {
  -readonly [Key in keyof MemoryImportEffectCounts]: MemoryImportEffectCounts[Key];
};

const emptyImportEffects = (): MutableMemoryImportEffectCounts => ({
  acceptedItems: 0,
  duplicateRecords: 0,
  observations: 0,
  pendingProposals: 0,
  rejectedProposals: 0,
  relations: 0,
  sensitiveRecords: 0,
  supersededItems: 0,
});

interface ImportRelationPlan {
  readonly from: ParsedLegacyMemoryRecord;
  readonly to: ParsedLegacyMemoryRecord;
}

interface ImportAnalysis {
  readonly effects: MemoryImportEffectCounts;
  readonly issues: readonly MemoryImportIssue[];
  readonly relations: readonly ImportRelationPlan[];
}

const analyzeImport = (
  parsed: ParsedLegacyMemorySource,
  destinationProjectId: ProjectId | null,
  duplicateFingerprints: ReadonlySet<string>,
): ImportAnalysis => {
  const issues = [...parsed.issues];
  const recordsByLegacyId = new Map<string, ParsedLegacyMemoryRecord>();
  for (const [index, record] of parsed.records.entries()) {
    if (recordsByLegacyId.has(record.legacyId)) {
      issues.push({ code: 'invalid-relation', documentIndex: index, recordIndex: null });
    } else {
      recordsByLegacyId.set(record.legacyId, record);
    }
    if (record.scope === 'repo' && destinationProjectId === null) {
      issues.push({ code: 'missing-project', documentIndex: index, recordIndex: null });
    }
  }
  const relations: ImportRelationPlan[] = [];
  const relationKeys = new Set<string>();
  for (const [index, record] of parsed.records.entries()) {
    for (const targetId of record.supersedes) {
      const target = recordsByLegacyId.get(targetId);
      if (
        !target ||
        record.origin !== 'durable' ||
        record.status === 'rejected' ||
        target.origin !== 'durable' ||
        target.status === 'rejected' ||
        record.fingerprint === target.fingerprint
      ) {
        issues.push({ code: 'invalid-relation', documentIndex: index, recordIndex: null });
        continue;
      }
      const key = `${record.fingerprint}:${target.fingerprint}`;
      if (!relationKeys.has(key)) {
        relationKeys.add(key);
        relations.push({ from: record, to: target });
      }
    }
  }
  const effects = emptyImportEffects();
  for (const record of parsed.records) {
    if (duplicateFingerprints.has(record.fingerprint)) {
      effects.duplicateRecords += 1;
      continue;
    }
    effects.observations += 1;
    if (record.sensitivity === 'sensitive') {
      effects.sensitiveRecords += 1;
    }
    if (record.origin === 'inbox') {
      effects.pendingProposals += 1;
    } else if (record.status === 'rejected') {
      effects.rejectedProposals += 1;
    } else {
      effects.acceptedItems += 1;
      if (record.status === 'superseded') {
        effects.supersededItems += 1;
      }
    }
  }
  effects.relations = relations.filter(
    ({ from, to }) => !(duplicateFingerprints.has(from.fingerprint) && duplicateFingerprints.has(to.fingerprint)),
  ).length;
  if (issues.length > 0) {
    return {
      effects: {
        ...emptyImportEffects(),
        duplicateRecords: effects.duplicateRecords,
        sensitiveRecords: effects.sensitiveRecords,
      },
      issues: issues.slice(0, 100),
      relations,
    };
  }
  return { effects, issues: [], relations };
};

const projectIdForImportedRecord = (
  record: ParsedLegacyMemoryRecord,
  destinationProjectId: ProjectId | null,
): ProjectId | null => (record.scope === 'global' ? null : destinationProjectId);

const redactedSourceLocator = (record: ParsedLegacyMemoryRecord): string => {
  const redacted = redactMemoryValue(record.sourceLocator, record.sensitivity).value;
  if (typeof redacted !== 'string' || redacted.length === 0 || redacted.length > 4096) {
    throw new Error('Redacted Memory import source locator is invalid.');
  }
  return redacted;
};

const importedPersistenceRecord = (
  record: ParsedLegacyMemoryRecord,
  destinationProjectId: ProjectId | null,
  spaceId: SpaceId,
  principal: AuthorizationPrincipal,
  reviewerPersonId: PersonId,
  confirmedAt: ReturnType<typeof instantNow>,
) => {
  const projectId = projectIdForImportedRecord(record, destinationProjectId);
  const observationId = memoryObservationIdForFingerprint(spaceId, record.fingerprint);
  const proposalId = proposalIdFor(spaceId, record.fingerprint);
  const draft = redactDraft(record, record.sensitivity);
  const rawObservation = parseMemoryJsonValue({
    guidance: record.guidance,
    legacyId: record.legacyId,
    origin: record.origin,
    provenance: record.provenance,
    scope: record.scope,
    status: record.status,
    structuredContent: record.structuredContent,
    summary: record.summary,
    title: record.title,
    trust: record.trust,
  });
  const redactedObservation = redactMemoryValue(rawObservation, record.sensitivity);
  const observation: MemoryObservation = {
    captureContextId: null,
    content: redactedObservation.value,
    contentHash: memoryContentHash(redactedObservation.value),
    createdByPrincipal: principal,
    fingerprint: record.fingerprint,
    id: observationId,
    observedAt: record.createdAt,
    owningSpaceId: spaceId,
    projectId,
    redactionRuleSetVersion: 'memory-redaction-v1',
    sensitivity: redactedObservation.sensitivity,
    sourceKind: 'import',
    sourceLocator: redactedSourceLocator(record),
  };
  let proposalStatus: MemoryProposal['status'] = 'accepted';
  if (record.origin === 'inbox') {
    proposalStatus = 'pending';
  } else if (record.status === 'rejected') {
    proposalStatus = 'rejected';
  }
  const reviewed = proposalStatus !== 'pending';
  let reviewReason: string | null = null;
  if (proposalStatus === 'accepted') {
    reviewReason = 'Imported prior accepted legacy Memory.';
  } else if (proposalStatus === 'rejected') {
    reviewReason = 'Imported prior rejected legacy Memory.';
  }
  const proposal: MemoryProposal = {
    guidance: draft.guidance,
    id: proposalId,
    owningSpaceId: spaceId,
    projectId,
    proposedByPrincipal: principal,
    proposedKind: record.kind,
    reviewedAt: reviewed ? confirmedAt : null,
    reviewedByPersonId: reviewed ? reviewerPersonId : null,
    reviewReason,
    sensitivity: draft.sensitivity,
    status: proposalStatus,
    structuredContent: draft.structuredContent,
    summary: draft.summary,
    title: draft.title,
    trustCandidate: record.trust,
  };
  if (proposalStatus !== 'accepted') {
    return { item: null, observation, outboxEvent: null, proposal, revision: null };
  }
  const itemId = itemIdFor(spaceId, record.fingerprint);
  const revisionId = revisionIdFor(spaceId, record.fingerprint);
  const revision = {
    createdAt: record.createdAt,
    createdByPrincipal: principal,
    guidance: draft.guidance,
    id: revisionId,
    memoryItemId: itemId,
    reason: 'Imported from accepted legacy Memory.',
    revisionNumber: 1,
    structuredContent: draft.structuredContent,
    summary: draft.summary,
    title: draft.title,
  } as const;
  const item: MemoryItem = {
    currentRevisionId: revisionId,
    id: itemId,
    kind: record.kind,
    owningSpaceId: spaceId,
    projectId,
    scope: record.scope === 'repo' ? 'project' : 'space',
    sensitivity: draft.sensitivity,
    status: record.status === 'superseded' || record.status === 'archived' ? record.status : 'active',
    trust: record.trust,
  };
  const outboxEvent = memoryRevisionReplicationEvent(item, revision, confirmedAt);
  return { item, observation, outboxEvent, proposal, revision };
};

const importedRelations = (
  plans: readonly ImportRelationPlan[],
  spaceId: SpaceId,
  principal: AuthorizationPrincipal,
  createdAt: ReturnType<typeof instantNow>,
): readonly MemoryRelation[] =>
  plans.map(({ from, to }) => ({
    createdAt,
    createdByPrincipal: principal,
    fromMemoryItemId: itemIdFor(spaceId, from.fingerprint),
    id: relationIdFor(spaceId, `${from.fingerprint}:${to.fingerprint}:supersedes`),
    kind: 'supersedes',
    owningSpaceId: spaceId,
    reason: 'Imported legacy supersession relation.',
    toMemoryItemId: itemIdFor(spaceId, to.fingerprint),
  }));

const redactedImportLocator = (value: string): string | null => {
  if (!validText(value, 4096)) {
    return null;
  }
  const redacted = redactMemoryValue(value, 'normal').value;
  return typeof redacted === 'string' && validText(redacted, 4096) ? redacted : null;
};

export const createMemoryApplicationService = (
  authorizer: Authorizer,
  repository: MemoryRepository,
  clock: () => Date = () => new Date(),
): MemoryApplicationService => {
  const authorize = async (
    operation: MemoryApplicationOperation,
    permission: AuthorizationPermission,
    principal: AuthorizationPrincipal,
    context: AuthorizationRequestContext,
    resource: AuthorizationResource,
    subjectType: MemoryAuditEvent['subjectType'],
  ): Promise<MemoryApplicationFailure | null> => {
    const decision = await authorizer.check({ context, permission, principal, resource });
    if (decision.kind === 'allow') {
      return null;
    }
    const code = decision.kind === 'deny' ? 'authorization-denied' : 'authorization-unavailable';
    const deniedAudit = audit(
      permission,
      principal,
      instantNow(clock),
      'denied',
      resource.spaceId,
      resource.id,
      subjectType,
    );
    await repository.recordAuditEvent(deniedAudit).catch(() => undefined);
    return errorResult(operation, code);
  };

  const service: MemoryApplicationService = {
    acceptProposal: async (command) => {
      const operation = 'accept-proposal';
      const denied = await authorize(
        operation,
        'accept_memory',
        command.principal,
        command.authorization,
        { id: command.proposalId, kind: 'memory', spaceId: command.spaceId },
        'memory-proposal',
      );
      if (denied) {
        return denied;
      }
      const reviewerPersonId = personIdFor(command.principal);
      if (reviewerPersonId === null) {
        return errorResult(operation, 'authorization-denied');
      }
      try {
        const proposal = await repository.getProposal(command.spaceId, command.proposalId);
        if (!proposal) {
          return errorResult(operation, 'not-found');
        }
        if (proposal.status !== 'pending') {
          return errorResult(operation, 'conflict');
        }
        const source = command.edits ?? proposal;
        if (!validateDraft(source)) {
          return errorResult(operation, 'invalid-input');
        }
        const requestedSensitivity = command.edits?.sensitivity ?? proposal.sensitivity;
        const draft = redactDraft(source, requestedSensitivity);
        const reviewedAt = instantNow(clock);
        const itemId = createMemoryItemId();
        const revisionId = createMemoryRevisionId();
        const revision = {
          createdAt: reviewedAt,
          createdByPrincipal: command.principal,
          guidance: draft.guidance,
          id: revisionId,
          memoryItemId: itemId,
          reason: command.edits ? 'edited-during-acceptance' : null,
          revisionNumber: 1,
          structuredContent: draft.structuredContent,
          summary: draft.summary,
          title: draft.title,
        } as const;
        const item: MemoryItem = {
          currentRevisionId: revisionId,
          id: itemId,
          kind: proposal.proposedKind,
          owningSpaceId: command.spaceId,
          projectId: proposal.projectId,
          scope: command.scope,
          sensitivity: draft.sensitivity,
          status: 'active',
          trust: proposal.trustCandidate,
        };
        const outboxEvent = memoryRevisionReplicationEvent(item, revision, reviewedAt);
        const result = await repository.acceptProposal({
          audit: audit(
            'accept-memory-proposal',
            command.principal,
            reviewedAt,
            'applied',
            command.spaceId,
            itemId,
            'memory-item',
          ),
          item,
          outboxEvent,
          proposalId: command.proposalId,
          reviewedAt,
          reviewerPersonId,
          revision,
        });
        return success(result);
      } catch (error) {
        return mapRepositoryError(operation, error);
      }
    },
    confirmMemoryImport: async (command) => {
      const operation = 'confirm-memory-import';
      const parsed = parseLegacyMemoryImportSource(command.source);
      const expectedImportId = importIdFor(command.destinationSpaceId, parsed.fingerprint);
      if (command.importId !== expectedImportId || !fingerprintPattern.test(command.previewProof)) {
        return errorResult(operation, 'invalid-input');
      }
      const denied = await authorize(
        operation,
        'manage_memory',
        command.principal,
        command.authorization,
        { id: command.importId, kind: 'memory', spaceId: command.destinationSpaceId },
        'memory-import',
      );
      if (denied) {
        return denied;
      }
      const reviewerPersonId = personIdFor(command.principal);
      if (reviewerPersonId === null) {
        return errorResult(operation, 'authorization-denied');
      }
      const analysis = analyzeImport(parsed, command.destinationProjectId, new Set());
      if (analysis.issues.length > 0) {
        return errorResult(operation, 'invalid-input');
      }
      try {
        const confirmedAt = instantNow(clock);
        const records = parsed.records.map((record) =>
          importedPersistenceRecord(
            record,
            command.destinationProjectId,
            command.destinationSpaceId,
            command.principal,
            reviewerPersonId,
            confirmedAt,
          ),
        );
        const result = await repository.confirmImport({
          audit: audit(
            'confirm-memory-import',
            command.principal,
            confirmedAt,
            'applied',
            command.destinationSpaceId,
            command.importId,
            'memory-import',
          ),
          confirmedAt,
          confirmedByPersonId: reviewerPersonId,
          importId: command.importId,
          previewProof: command.previewProof,
          records,
          relations: importedRelations(analysis.relations, command.destinationSpaceId, command.principal, confirmedAt),
          spaceId: command.destinationSpaceId,
        });
        if (result.kind === 'stale') {
          return errorResult(operation, 'stale');
        }
        if (result.kind === 'quarantined') {
          return errorResult(operation, 'invalid-input');
        }
        const imported = new Set(result.kind === 'confirmed' ? result.importedObservationFingerprints : []);
        const duplicateFingerprints = new Set(
          parsed.records.filter((record) => !imported.has(record.fingerprint)).map((record) => record.fingerprint),
        );
        const confirmedAnalysis = analyzeImport(parsed, command.destinationProjectId, duplicateFingerprints);
        return success({ effects: confirmedAnalysis.effects, importId: command.importId, kind: 'confirmed' });
      } catch (error) {
        return mapRepositoryError(operation, error);
      }
    },
    createProposal: async (command) => {
      const operation = 'create-proposal';
      const proposalId = createMemoryProposalId();
      const spaceId = command.authorization.activeSpaceId;
      const resource: AuthorizationResource = command.projectId
        ? { id: command.projectId, kind: 'project', spaceId }
        : { id: spaceId, kind: 'space', spaceId };
      const denied = await authorize(
        operation,
        'propose_memory',
        command.principal,
        command.authorization,
        resource,
        'memory-proposal',
      );
      if (denied) {
        return denied;
      }
      if (
        !validateDraft(command) ||
        (command.trustCandidate === 'harvest-accepted' && command.observationIds.length === 0)
      ) {
        return errorResult(operation, 'invalid-input');
      }
      try {
        const redacted = redactDraft(command, command.sensitivity);
        const proposal: MemoryProposal = {
          guidance: redacted.guidance,
          id: proposalId,
          owningSpaceId: spaceId,
          projectId: command.projectId,
          proposedByPrincipal: command.principal,
          proposedKind: command.proposedKind,
          reviewedAt: null,
          reviewedByPersonId: null,
          reviewReason: null,
          sensitivity: redacted.sensitivity,
          status: 'pending',
          structuredContent: redacted.structuredContent,
          summary: redacted.summary,
          title: redacted.title,
          trustCandidate: command.trustCandidate,
        };
        const created = await repository.createProposal({
          audit: audit(
            'create-memory-proposal',
            command.principal,
            instantNow(clock),
            'applied',
            spaceId,
            proposalId,
            'memory-proposal',
          ),
          observationIds: command.observationIds,
          proposal,
        });
        return success(created);
      } catch (error) {
        return mapRepositoryError(operation, error);
      }
    },
    createRelation: async (command) => {
      const operation = 'create-relation';
      const denied = await authorize(
        operation,
        'manage_memory',
        command.principal,
        command.authorization,
        { id: command.fromMemoryItemId, kind: 'memory', spaceId: command.spaceId },
        'memory-relation',
      );
      if (denied) {
        return denied;
      }
      if (
        command.fromMemoryItemId === command.toMemoryItemId ||
        (command.reason !== null && !validText(command.reason, 4096))
      ) {
        return errorResult(operation, 'invalid-input');
      }
      try {
        const createdAt = instantNow(clock);
        const relationId = createMemoryRelationId();
        await repository.createRelation(
          {
            createdAt,
            createdByPrincipal: command.principal,
            fromMemoryItemId: command.fromMemoryItemId,
            id: relationId,
            kind: command.kind,
            owningSpaceId: command.spaceId,
            reason: command.reason,
            toMemoryItemId: command.toMemoryItemId,
          },
          audit(
            'create-memory-relation',
            command.principal,
            createdAt,
            'applied',
            command.spaceId,
            relationId,
            'memory-relation',
          ),
        );
        return success(undefined);
      } catch (error) {
        return mapRepositoryError(operation, error);
      }
    },
    exportMemory: async (query) => {
      const operation = 'export-memory';
      const authorizationScope = await authorizer.materializeResourceScope({
        context: query.authorization,
        permission: 'view_memory',
        principal: query.principal,
        resourceKind: 'memory',
      });
      if (authorizationScope.kind === 'error') {
        return errorResult(operation, 'authorization-unavailable');
      }
      try {
        const snapshot = await repository.exportMemory({
          authorizationScope,
          ...(query.projectId === undefined ? {} : { projectId: query.projectId }),
          spaceId: query.spaceId,
        });
        const artifact = serializeMemoryExport(snapshot, query.format);
        await repository.recordAuditEvent(
          audit(
            'export-memory',
            query.principal,
            instantNow(clock),
            'allowed',
            query.spaceId,
            query.spaceId,
            'memory-item',
          ),
        );
        return success(artifact);
      } catch (error) {
        return mapRepositoryError(operation, error);
      }
    },
    getMemoryItem: async (query) => {
      const operation = 'get-memory-item';
      const denied = await authorize(
        operation,
        'view_memory',
        query.principal,
        query.authorization,
        { id: query.itemId, kind: 'memory', spaceId: query.spaceId },
        'memory-item',
      );
      if (denied) {
        return denied;
      }
      try {
        const result = await repository.getItem(query.spaceId, query.itemId, query.revisionId);
        if (!result) {
          return errorResult(operation, 'not-found');
        }
        await repository.recordAuditEvent(
          audit(
            'view-memory-item',
            query.principal,
            instantNow(clock),
            'allowed',
            query.spaceId,
            query.itemId,
            'memory-item',
          ),
        );
        return success(result);
      } catch (error) {
        return mapRepositoryError(operation, error);
      }
    },
    getProjectContext: async (query) => {
      const operation = 'get-project-context';
      if (
        query.spaceId !== query.authorization.activeSpaceId ||
        !Number.isSafeInteger(query.limit) ||
        query.limit <= 0 ||
        query.limit > memoryProjectContextBounds.maxItems
      ) {
        return errorResult(operation, 'invalid-input');
      }
      if (query.signal?.aborted) {
        return errorResult(operation, 'cancelled');
      }
      const authorizationScope = await authorizer.materializeResourceScope({
        context: query.authorization,
        permission: 'view_memory',
        principal: query.principal,
        resourceKind: 'memory',
      });
      if (authorizationScope.kind === 'error') {
        return errorResult(operation, 'authorization-unavailable');
      }
      try {
        const candidates: MemoryItemResult[] = [];
        let cursor: string | null = null;
        let scannedItems = 0;
        do {
          query.signal?.throwIfAborted();
          const pageSize = Math.min(
            memoryProjectContextBounds.pageSize,
            memoryProjectContextBounds.maxScannedItems - scannedItems,
          );
          const page = await repository.listItems({
            authorizationScope,
            ...(cursor === null ? {} : { cursor }),
            pageSize,
            spaceId: query.spaceId,
            status: 'active',
          });
          scannedItems += page.items.length;
          candidates.push(
            ...page.items.filter(
              ({ item }) =>
                projectContextKindOrder.has(item.kind) &&
                (item.projectId === query.projectId || (item.projectId === null && item.scope !== 'project')),
            ),
          );
          cursor = page.nextCursor;
        } while (cursor !== null && scannedItems < memoryProjectContextBounds.maxScannedItems);
        const ordered = candidates.sort((left, right) => {
          const kindDifference =
            (projectContextKindOrder.get(left.item.kind) ?? Number.MAX_SAFE_INTEGER) -
            (projectContextKindOrder.get(right.item.kind) ?? Number.MAX_SAFE_INTEGER);
          if (kindDifference !== 0) {
            return kindDifference;
          }
          const leftScope = left.item.projectId === query.projectId ? 0 : 1;
          const rightScope = right.item.projectId === query.projectId ? 0 : 1;
          return leftScope - rightScope || left.item.id.localeCompare(right.item.id);
        });
        const items = ordered.slice(0, query.limit);
        await repository.recordAuditEvent(
          audit(
            'get-project-context',
            query.principal,
            instantNow(clock),
            'allowed',
            query.spaceId,
            query.projectId,
            'memory-item',
          ),
        );
        return success({
          items,
          projectId: query.projectId,
          spaceId: query.spaceId,
          truncated: cursor !== null || ordered.length > items.length,
        });
      } catch (error) {
        if (query.signal?.aborted) {
          return errorResult(operation, 'cancelled');
        }
        return mapRepositoryError(operation, error);
      }
    },
    listMemoryItems: async (query) => {
      const operation = 'list-memory-items';
      if (!Number.isSafeInteger(query.pageSize) || query.pageSize <= 0 || query.pageSize > 100) {
        return errorResult(operation, 'invalid-input');
      }
      const authorizationScope = await authorizer.materializeResourceScope({
        context: query.authorization,
        permission: 'view_memory',
        principal: query.principal,
        resourceKind: 'memory',
      });
      if (authorizationScope.kind === 'error') {
        return errorResult(operation, 'authorization-unavailable');
      }
      try {
        const result = await repository.listItems({
          authorizationScope,
          ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
          pageSize: query.pageSize,
          ...(query.projectId === undefined ? {} : { projectId: query.projectId }),
          spaceId: query.spaceId,
          ...(query.status === undefined ? {} : { status: query.status }),
        });
        await repository.recordAuditEvent(
          audit(
            'list-memory-items',
            query.principal,
            instantNow(clock),
            'allowed',
            query.spaceId,
            query.spaceId,
            'memory-item',
          ),
        );
        return success(result);
      } catch (error) {
        return mapRepositoryError(operation, error);
      }
    },
    listPendingProposals: async (query) => {
      const operation = 'list-pending-proposals';
      if (!Number.isSafeInteger(query.pageSize) || query.pageSize <= 0 || query.pageSize > 100) {
        return errorResult(operation, 'invalid-input');
      }
      const authorizationScope = await authorizer.materializeResourceScope({
        context: query.authorization,
        permission: 'view_memory',
        principal: query.principal,
        resourceKind: 'memory',
      });
      if (authorizationScope.kind === 'error') {
        return errorResult(operation, 'authorization-unavailable');
      }
      try {
        const result = await repository.listProposals({
          authorizationScope,
          ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
          pageSize: query.pageSize,
          spaceId: query.spaceId,
          status: 'pending',
        });
        await repository.recordAuditEvent(
          audit(
            'list-pending-memory-proposals',
            query.principal,
            instantNow(clock),
            'allowed',
            query.spaceId,
            query.spaceId,
            'memory-proposal',
          ),
        );
        return success(result);
      } catch (error) {
        return mapRepositoryError(operation, error);
      }
    },
    previewMemoryImport: async (command) => {
      const operation = 'preview-memory-import';
      const parsed = parseLegacyMemoryImportSource(command.source);
      const importId = importIdFor(command.destinationSpaceId, parsed.fingerprint);
      const denied = await authorize(
        operation,
        'manage_memory',
        command.principal,
        command.authorization,
        { id: importId, kind: 'memory', spaceId: command.destinationSpaceId },
        'memory-import',
      );
      if (denied) {
        return denied;
      }
      if (personIdFor(command.principal) === null) {
        return errorResult(operation, 'authorization-denied');
      }
      const sourceLocator = redactedImportLocator(command.source.sourceLocator);
      if (!sourceLocator) {
        return errorResult(operation, 'invalid-input');
      }
      const initialAnalysis = analyzeImport(parsed, command.destinationProjectId, new Set());
      try {
        const createdAt = instantNow(clock);
        const result = await repository.previewImport({
          audit: audit(
            'preview-memory-import',
            command.principal,
            createdAt,
            'applied',
            command.destinationSpaceId,
            importId,
            'memory-import',
          ),
          contentHash: parsed.contentHash,
          createdAt,
          destinationProjectId: command.destinationProjectId,
          destinationSpaceId: command.destinationSpaceId,
          fingerprint: parsed.fingerprint,
          id: importId,
          observationFingerprints: parsed.records.map((record) => record.fingerprint),
          sourceKind: command.source.sourceKind,
          sourceLocator,
          status: initialAnalysis.issues.length > 0 ? 'quarantined' : 'previewed',
        });
        const analysis = analyzeImport(
          parsed,
          command.destinationProjectId,
          new Set(result.duplicateObservationFingerprints),
        );
        let status: MemoryImportPreview['status'] = 'previewed';
        if (result.alreadyConfirmed || result.memoryImport.status === 'confirmed') {
          status = 'confirmed';
        } else if (result.memoryImport.status === 'quarantined') {
          status = 'quarantined';
        }
        return success({
          alreadyConfirmed: result.alreadyConfirmed,
          effects: analysis.effects,
          importId: result.memoryImport.id,
          issues: analysis.issues,
          previewProof: result.memoryImport.previewProof,
          status,
        });
      } catch (error) {
        return mapRepositoryError(operation, error);
      }
    },
    purgeMemoryItem: async (command) => {
      const operation = 'purge-memory-item';
      const denied = await authorize(
        operation,
        'manage_memory',
        command.principal,
        command.authorization,
        { id: command.itemId, kind: 'memory', spaceId: command.spaceId },
        'memory-item',
      );
      if (denied) {
        return denied;
      }
      try {
        const current = await repository.getItem(command.spaceId, command.itemId);
        if (!current) {
          return errorResult(operation, 'not-found');
        }
        const purgedAt = instantNow(clock);
        const input: PurgeMemoryItemInput = {
          audit: audit(
            'purge-memory-item',
            command.principal,
            purgedAt,
            'applied',
            command.spaceId,
            command.itemId,
            'memory-item',
          ),
          itemId: command.itemId,
          outboxEvent: memoryTombstoneReplicationEvent(current.item, purgedAt, 'privacy-purged'),
          spaceId: command.spaceId,
        };
        await repository.purgeItem(input);
        return success(undefined);
      } catch (error) {
        return mapRepositoryError(operation, error);
      }
    },
    recordObservation: async (command) => {
      const operation = 'record-observation';
      const spaceId = command.authorization.activeSpaceId;
      const resource: AuthorizationResource = command.projectId
        ? { id: command.projectId, kind: 'project', spaceId }
        : { id: spaceId, kind: 'space', spaceId };
      const denied = await authorize(
        operation,
        'propose_memory',
        command.principal,
        command.authorization,
        resource,
        'memory-observation',
      );
      if (denied) {
        return denied;
      }
      if (
        !(fingerprintPattern.test(command.fingerprint) && validJson(command.content)) ||
        (command.sourceLocator !== null && !validText(command.sourceLocator, 4096))
      ) {
        return errorResult(operation, 'invalid-input');
      }
      try {
        const redacted = redactMemoryValue(command.content, command.sensitivity);
        const observationId = memoryObservationIdForFingerprint(spaceId, command.fingerprint);
        const observedAt = command.observedAt ?? instantNow(clock);
        const observation: MemoryObservation = {
          captureContextId: command.captureContextId,
          content: redacted.value,
          contentHash: memoryContentHash(redacted.value),
          createdByPrincipal: command.principal,
          fingerprint: command.fingerprint,
          id: observationId,
          observedAt,
          owningSpaceId: spaceId,
          projectId: command.projectId,
          redactionRuleSetVersion: redacted.ruleSetVersion,
          sensitivity: redacted.sensitivity,
          sourceKind: command.sourceKind,
          sourceLocator: command.sourceLocator,
        };
        return success(
          await repository.recordObservation({
            audit: audit(
              'record-memory-observation',
              command.principal,
              instantNow(clock),
              'applied',
              spaceId,
              observationId,
              'memory-observation',
            ),
            observation,
          }),
        );
      } catch (error) {
        return mapRepositoryError(operation, error);
      }
    },
    rejectProposal: async (command) => {
      const operation = 'reject-proposal';
      const denied = await authorize(
        operation,
        'accept_memory',
        command.principal,
        command.authorization,
        { id: command.proposalId, kind: 'memory', spaceId: command.spaceId },
        'memory-proposal',
      );
      if (denied) {
        return denied;
      }
      const reviewerPersonId = personIdFor(command.principal);
      if (reviewerPersonId === null || !validText(command.reason, 4096)) {
        return errorResult(operation, reviewerPersonId === null ? 'authorization-denied' : 'invalid-input');
      }
      try {
        const reviewedAt = instantNow(clock);
        await repository.rejectProposal({
          audit: audit(
            'reject-memory-proposal',
            command.principal,
            reviewedAt,
            'rejected',
            command.spaceId,
            command.proposalId,
            'memory-proposal',
          ),
          proposalId: command.proposalId,
          reason: command.reason,
          reviewedAt,
          reviewerPersonId,
          spaceId: command.spaceId,
        });
        return success(undefined);
      } catch (error) {
        return mapRepositoryError(operation, error);
      }
    },
    reviseMemoryItem: async (command) => {
      const operation = 'revise-memory-item';
      const denied = await authorize(
        operation,
        'manage_memory',
        command.principal,
        command.authorization,
        { id: command.itemId, kind: 'memory', spaceId: command.spaceId },
        'memory-item',
      );
      if (denied) {
        return denied;
      }
      if (!(validateDraft(command) && validText(command.reason, 4096))) {
        return errorResult(operation, 'invalid-input');
      }
      try {
        const current = await repository.getItem(command.spaceId, command.itemId);
        if (!current) {
          return errorResult(operation, 'not-found');
        }
        const draft = redactDraft(command, current.item.sensitivity);
        const createdAt = instantNow(clock);
        const revision = {
          createdAt,
          createdByPrincipal: command.principal,
          guidance: draft.guidance,
          id: createMemoryRevisionId(),
          memoryItemId: command.itemId,
          reason: command.reason,
          revisionNumber: current.revision.revisionNumber + 1,
          structuredContent: draft.structuredContent,
          summary: draft.summary,
          title: draft.title,
        } as const;
        const revisedItem: MemoryItem = {
          ...current.item,
          currentRevisionId: revision.id,
          sensitivity: draft.sensitivity,
        };
        let outboxEvent: ReplicationOutboxEvent | null = null;
        if (current.item.sensitivity === 'normal') {
          outboxEvent =
            draft.sensitivity === 'normal'
              ? memoryRevisionReplicationEvent(revisedItem, revision, createdAt)
              : memoryTombstoneReplicationEvent(current.item, createdAt, 'sensitivity-changed');
        }
        const updatedRevision = await repository.reviseItem({
          audit: audit(
            'revise-memory-item',
            command.principal,
            createdAt,
            'applied',
            command.spaceId,
            command.itemId,
            'memory-item',
          ),
          expectedCurrentRevisionId: command.expectedCurrentRevisionId,
          outboxEvent,
          revision,
          sensitivity: draft.sensitivity,
          spaceId: command.spaceId,
        });
        return success({
          item: { ...revisedItem, currentRevisionId: updatedRevision.id },
          revision: updatedRevision,
        });
      } catch (error) {
        return mapRepositoryError(operation, error);
      }
    },
    searchMemory: async (query) => {
      const operation = 'search-memory';
      if (query.spaceId !== query.authorization.activeSpaceId) {
        return errorResult(operation, 'invalid-input');
      }
      if (query.signal?.aborted) {
        return errorResult(operation, 'cancelled');
      }
      let normalized: ReturnType<typeof normalizeMemorySearchParameters>;
      try {
        normalized = normalizeMemorySearchParameters(query);
      } catch (error) {
        return errorResult(operation, error instanceof MemorySearchValidationError ? 'invalid-input' : 'unavailable');
      }
      const permission: AuthorizationPermission =
        normalized.historyMode === 'include' ? 'manage_memory' : 'view_memory';
      const authorizationScope = await authorizer.materializeResourceScope({
        context: query.authorization,
        permission,
        principal: query.principal,
        resourceKind: 'memory',
      });
      if (authorizationScope.kind === 'error') {
        return errorResult(operation, 'authorization-unavailable');
      }
      const nowEpochMs = clock().getTime();
      try {
        const page = await repository.searchItems({
          ...normalized,
          authorizationScope,
          deadlineEpochMs: nowEpochMs + memorySearchBounds.timeoutMs,
          nowEpochMs,
          ...(query.signal === undefined ? {} : { signal: query.signal }),
        });
        await repository.recordAuditEvent(
          audit(
            'search-memory',
            query.principal,
            instantNow(clock),
            'allowed',
            query.spaceId,
            query.spaceId,
            'memory-item',
          ),
        );
        return success(page);
      } catch (error) {
        return mapRepositoryError(operation, error);
      }
    },
    supersedeMemoryItem: async (command) => {
      const operation = 'supersede-memory-item';
      const denied = await authorize(
        operation,
        'manage_memory',
        command.principal,
        command.authorization,
        { id: command.itemId, kind: 'memory', spaceId: command.spaceId },
        'memory-item',
      );
      if (denied) {
        return denied;
      }
      if (!validText(command.reason, 4096)) {
        return errorResult(operation, 'invalid-input');
      }
      try {
        const supersededAt = instantNow(clock);
        const current = await repository.getItem(command.spaceId, command.itemId);
        if (!current) {
          return errorResult(operation, 'not-found');
        }
        await repository.supersedeItem({
          audit: audit(
            'supersede-memory-item',
            command.principal,
            supersededAt,
            'applied',
            command.spaceId,
            command.itemId,
            'memory-item',
          ),
          itemId: command.itemId,
          outboxEvent: memoryTombstoneReplicationEvent(current.item, supersededAt),
          reason: command.reason,
          spaceId: command.spaceId,
          supersededAt,
        });
        return success(undefined);
      } catch (error) {
        return mapRepositoryError(operation, error);
      }
    },
  };
  return Object.freeze(service);
};
