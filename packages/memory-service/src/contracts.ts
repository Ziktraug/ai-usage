import {
  parseCheckoutId,
  parseDeviceId,
  parseInstant,
  parseMemoryItemId,
  parseMemoryObservationId,
  parseMemoryProposalId,
  parseMemoryRevisionId,
  parseProjectId,
  parseRepositoryId,
  parseSpaceId,
  type SpaceId,
} from '@ai-usage/platform-core/identity';
import type {
  CheckoutResolutionAction,
  CheckoutResolutionActionResult,
  CheckoutResolutionReview,
} from '@ai-usage/project-registry/review';
import {
  type MemoryJsonValue,
  type MemoryKind,
  type MemoryScope,
  type MemorySensitivity,
  type MemoryTrust,
  parseMemoryJsonValue,
} from './domain';

export const MEMORY_SERVICE_PROTOCOL_VERSION = 1 as const;

export const memoryServiceBounds = Object.freeze({
  maxCandidatesPerReview: 32,
  maxErrorResponseBytes: 4096,
  maxRendezvousBytes: 2048,
  maxProposalObservationSources: 100,
  maxProposals: 100,
  maxRequestBytes: 256 * 1024,
  maxResponseBytes: 256 * 1024,
  maxReviews: 100,
  requestTimeoutMs: 5000,
});

export type MemoryServiceErrorCode =
  | 'authentication-failed'
  | 'authorization-unavailable'
  | 'forbidden'
  | 'invalid-request'
  | 'invalid-response'
  | 'not-found'
  | 'protocol-mismatch'
  | 'request-too-large'
  | 'service-unavailable';

export interface MemoryResolutionReviewSnapshot {
  readonly reviews: readonly CheckoutResolutionReview[];
  readonly spaceId: SpaceId;
}

export interface MemoryProposalReviewWire {
  readonly guidance: readonly string[];
  readonly observationSources: readonly {
    readonly id: ReturnType<typeof parseMemoryObservationId>;
    readonly observedAt: ReturnType<typeof parseInstant>;
    readonly sensitivity: MemorySensitivity;
    readonly sourceKind: 'agent' | 'commit' | 'file' | 'import' | 'pull-request' | 'session' | 'user';
    readonly sourceLocator: string | null;
  }[];
  readonly projectId: ReturnType<typeof parseProjectId> | null;
  readonly proposalId: ReturnType<typeof parseMemoryProposalId>;
  readonly proposedByKind: 'person' | 'service';
  readonly proposedKind: MemoryKind;
  readonly sensitivity: MemorySensitivity;
  readonly structuredContent: MemoryJsonValue;
  readonly summary: string;
  readonly title: string;
  readonly trustCandidate: MemoryTrust;
}

export interface MemoryProposalReviewSnapshot {
  readonly nextCursor: string | null;
  readonly proposals: readonly MemoryProposalReviewWire[];
  readonly spaceId: SpaceId;
}

export type MemoryProposalReviewAction =
  | {
      readonly edits?: {
        readonly guidance: readonly string[];
        readonly sensitivity: MemorySensitivity;
        readonly structuredContent: MemoryJsonValue;
        readonly summary: string;
        readonly title: string;
      };
      readonly kind: 'accept';
      readonly proposalId: ReturnType<typeof parseMemoryProposalId>;
      readonly scope: MemoryScope;
      readonly spaceId: SpaceId;
    }
  | {
      readonly kind: 'reject';
      readonly proposalId: ReturnType<typeof parseMemoryProposalId>;
      readonly reason: string;
      readonly spaceId: SpaceId;
    };

export type MemoryProposalReviewActionResult =
  | {
      readonly itemId: ReturnType<typeof parseMemoryItemId>;
      readonly kind: 'accepted';
      readonly revisionId: ReturnType<typeof parseMemoryRevisionId>;
    }
  | { readonly kind: 'rejected'; readonly proposalId: ReturnType<typeof parseMemoryProposalId> };

export interface MemoryServiceErrorResponse {
  readonly error: {
    readonly code: MemoryServiceErrorCode;
    readonly message: string;
  };
  readonly ok: false;
  readonly protocolVersion: typeof MEMORY_SERVICE_PROTOCOL_VERSION;
}

export interface MemoryServiceSuccessResponse<Value> {
  readonly data: Value;
  readonly ok: true;
  readonly protocolVersion: typeof MEMORY_SERVICE_PROTOCOL_VERSION;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const localLabelPattern = /^checkout:[0-9a-f]{8}$/u;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};

const boundedText = (value: unknown, maximum: number): string => {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || value.includes('\0')) {
    throw new Error('Memory service text is invalid.');
  }
  return value;
};

const boundedPossiblyEmptyText = (value: unknown, maximum: number): string => {
  if (typeof value !== 'string' || value.length > maximum || value.includes('\0')) {
    throw new Error('Memory service text is invalid.');
  }
  return value;
};

const memoryKindValues = new Set<MemoryKind>([
  'decision',
  'pattern',
  'pitfall',
  'command',
  'constraint',
  'handoff',
  'lesson',
  'preference',
]);
const sourceKindValues = new Set<MemoryProposalReviewWire['observationSources'][number]['sourceKind']>([
  'agent',
  'commit',
  'file',
  'import',
  'pull-request',
  'session',
  'user',
]);

const parseGuidance = (value: unknown): readonly string[] => {
  if (!Array.isArray(value) || value.length > 64) {
    throw new Error('Memory proposal guidance is invalid.');
  }
  return value.map((entry) => boundedText(entry, 4096));
};

const parseSensitivity = (value: unknown): MemorySensitivity => {
  if (value !== 'normal' && value !== 'sensitive') {
    throw new Error('Memory proposal sensitivity is invalid.');
  }
  return value;
};

const parseProposalObservationSource = (value: unknown): MemoryProposalReviewWire['observationSources'][number] => {
  if (
    !(
      isRecord(value) &&
      hasExactKeys(value, ['id', 'observedAt', 'sensitivity', 'sourceKind', 'sourceLocator']) &&
      typeof value.sourceKind === 'string' &&
      sourceKindValues.has(value.sourceKind as MemoryProposalReviewWire['observationSources'][number]['sourceKind']) &&
      (value.sourceLocator === null || typeof value.sourceLocator === 'string')
    )
  ) {
    throw new Error('Memory proposal source is invalid.');
  }
  return {
    id: parseMemoryObservationId(value.id),
    observedAt: parseInstant(value.observedAt),
    sensitivity: parseSensitivity(value.sensitivity),
    sourceKind: value.sourceKind as MemoryProposalReviewWire['observationSources'][number]['sourceKind'],
    sourceLocator: value.sourceLocator === null ? null : boundedText(value.sourceLocator, 4096),
  };
};

export const parseMemoryProposalReview = (value: unknown): MemoryProposalReviewWire => {
  if (
    !(
      isRecord(value) &&
      hasExactKeys(value, [
        'guidance',
        'observationSources',
        'projectId',
        'proposalId',
        'proposedByKind',
        'proposedKind',
        'sensitivity',
        'structuredContent',
        'summary',
        'title',
        'trustCandidate',
      ]) &&
      Array.isArray(value.observationSources) &&
      value.observationSources.length <= memoryServiceBounds.maxProposalObservationSources &&
      typeof value.proposedKind === 'string' &&
      memoryKindValues.has(value.proposedKind as MemoryKind) &&
      (value.proposedByKind === 'person' || value.proposedByKind === 'service') &&
      (value.trustCandidate === 'explicit' || value.trustCandidate === 'harvest-accepted') &&
      (value.projectId === null || typeof value.projectId === 'string')
    )
  ) {
    throw new Error('Memory proposal review is invalid.');
  }
  return {
    guidance: parseGuidance(value.guidance),
    observationSources: value.observationSources.map(parseProposalObservationSource),
    projectId: value.projectId === null ? null : parseProjectId(value.projectId),
    proposalId: parseMemoryProposalId(value.proposalId),
    proposedByKind: value.proposedByKind,
    proposedKind: value.proposedKind as MemoryKind,
    sensitivity: parseSensitivity(value.sensitivity),
    structuredContent: parseMemoryJsonValue(value.structuredContent, 'proposal.structuredContent'),
    summary: boundedPossiblyEmptyText(value.summary, 16_384),
    title: boundedText(value.title, 512),
    trustCandidate: value.trustCandidate,
  };
};

export const parseMemoryProposalReviewSnapshot = (value: unknown): MemoryProposalReviewSnapshot => {
  if (
    !(
      isRecord(value) &&
      hasExactKeys(value, ['nextCursor', 'proposals', 'spaceId']) &&
      Array.isArray(value.proposals) &&
      value.proposals.length <= memoryServiceBounds.maxProposals &&
      (value.nextCursor === null || typeof value.nextCursor === 'string')
    )
  ) {
    throw new Error('Memory proposal review snapshot is invalid.');
  }
  return {
    nextCursor: value.nextCursor === null ? null : boundedText(value.nextCursor, 4096),
    proposals: value.proposals.map(parseMemoryProposalReview),
    spaceId: parseSpaceId(value.spaceId),
  };
};

const parseProposalEdits = (
  value: unknown,
): NonNullable<Extract<MemoryProposalReviewAction, { kind: 'accept' }>['edits']> => {
  if (!(isRecord(value) && hasExactKeys(value, ['guidance', 'sensitivity', 'structuredContent', 'summary', 'title']))) {
    throw new Error('Memory proposal edits are invalid.');
  }
  return {
    guidance: parseGuidance(value.guidance),
    sensitivity: parseSensitivity(value.sensitivity),
    structuredContent: parseMemoryJsonValue(value.structuredContent, 'proposal.edits.structuredContent'),
    summary: boundedPossiblyEmptyText(value.summary, 16_384),
    title: boundedText(value.title, 512),
  };
};

export const parseMemoryProposalReviewAction = (value: unknown): MemoryProposalReviewAction => {
  if (!(isRecord(value) && typeof value.kind === 'string')) {
    throw new Error('Memory proposal action is invalid.');
  }
  if (
    value.kind === 'accept' &&
    (hasExactKeys(value, ['kind', 'proposalId', 'scope', 'spaceId']) ||
      hasExactKeys(value, ['edits', 'kind', 'proposalId', 'scope', 'spaceId'])) &&
    (value.scope === 'person' || value.scope === 'project' || value.scope === 'space')
  ) {
    return {
      ...('edits' in value ? { edits: parseProposalEdits(value.edits) } : {}),
      kind: value.kind,
      proposalId: parseMemoryProposalId(value.proposalId),
      scope: value.scope,
      spaceId: parseSpaceId(value.spaceId),
    };
  }
  if (value.kind === 'reject' && hasExactKeys(value, ['kind', 'proposalId', 'reason', 'spaceId'])) {
    return {
      kind: value.kind,
      proposalId: parseMemoryProposalId(value.proposalId),
      reason: boundedText(value.reason, 4096),
      spaceId: parseSpaceId(value.spaceId),
    };
  }
  throw new Error('Memory proposal action is invalid.');
};

export const parseMemoryProposalReviewActionResult = (value: unknown): MemoryProposalReviewActionResult => {
  if (!(isRecord(value) && typeof value.kind === 'string')) {
    throw new Error('Memory proposal action result is invalid.');
  }
  if (value.kind === 'accepted' && hasExactKeys(value, ['itemId', 'kind', 'revisionId'])) {
    return {
      itemId: parseMemoryItemId(value.itemId),
      kind: value.kind,
      revisionId: parseMemoryRevisionId(value.revisionId),
    };
  }
  if (value.kind === 'rejected' && hasExactKeys(value, ['kind', 'proposalId'])) {
    return { kind: value.kind, proposalId: parseMemoryProposalId(value.proposalId) };
  }
  throw new Error('Memory proposal action result is invalid.');
};

const parseCandidate = (value: unknown): CheckoutResolutionReview['candidateMatches'][number] => {
  if (!(isRecord(value) && hasExactKeys(value, ['canonicalLabel', 'repositoryId']))) {
    throw new Error('Memory resolution candidate is invalid.');
  }
  return {
    canonicalLabel: boundedText(value.canonicalLabel, 2048),
    repositoryId: parseRepositoryId(value.repositoryId),
  };
};

export const parseCheckoutResolutionReview = (value: unknown): CheckoutResolutionReview => {
  if (
    !(
      isRecord(value) &&
      hasExactKeys(value, [
        'candidateMatches',
        'checkoutId',
        'destinationSpaceId',
        'deviceId',
        'deviceLabel',
        'localLabel',
        'normalizedRemote',
        'status',
      ]) &&
      Array.isArray(value.candidateMatches) &&
      value.candidateMatches.length <= memoryServiceBounds.maxCandidatesPerReview &&
      (value.status === 'ambiguous' || value.status === 'candidate' || value.status === 'unassigned') &&
      (value.normalizedRemote === null || typeof value.normalizedRemote === 'string')
    )
  ) {
    throw new Error('Memory resolution review is invalid.');
  }
  const localLabel = boundedText(value.localLabel, 64);
  if (!localLabelPattern.test(localLabel)) {
    throw new Error('Memory resolution review label is invalid.');
  }
  const normalizedRemote = value.normalizedRemote === null ? null : boundedText(value.normalizedRemote, 2048);
  return {
    candidateMatches: value.candidateMatches.map(parseCandidate),
    checkoutId: parseCheckoutId(value.checkoutId),
    destinationSpaceId: parseSpaceId(value.destinationSpaceId),
    deviceId: parseDeviceId(value.deviceId),
    deviceLabel: boundedText(value.deviceLabel, 256),
    localLabel,
    normalizedRemote,
    status: value.status,
  };
};

export const parseMemoryResolutionReviewSnapshot = (value: unknown): MemoryResolutionReviewSnapshot => {
  if (
    !(
      isRecord(value) &&
      hasExactKeys(value, ['reviews', 'spaceId']) &&
      Array.isArray(value.reviews) &&
      value.reviews.length <= memoryServiceBounds.maxReviews
    )
  ) {
    throw new Error('Memory resolution review snapshot is invalid.');
  }
  const spaceId = parseSpaceId(value.spaceId);
  const reviews = value.reviews.map(parseCheckoutResolutionReview);
  if (reviews.some((review) => review.destinationSpaceId !== spaceId)) {
    throw new Error('Memory resolution review Space is invalid.');
  }
  return { reviews, spaceId };
};

export const parseCheckoutResolutionAction = (value: unknown): CheckoutResolutionAction => {
  if (!(isRecord(value) && typeof value.kind === 'string')) {
    throw new Error('Memory resolution action is invalid.');
  }
  if (value.kind === 'create-project') {
    if (!hasExactKeys(value, ['checkoutId', 'displayName', 'kind', 'spaceId'])) {
      throw new Error('Memory resolution action is invalid.');
    }
    const displayName = boundedText(value.displayName, 256).trim();
    if (displayName.length === 0) {
      throw new Error('Memory resolution Project name is invalid.');
    }
    return {
      checkoutId: parseCheckoutId(value.checkoutId),
      displayName,
      kind: value.kind,
      spaceId: parseSpaceId(value.spaceId),
    };
  }
  if (value.kind === 'link') {
    if (
      !hasExactKeys(value, ['checkoutId', 'kind', 'projectId', 'repositoryId', 'spaceId']) ||
      (value.projectId !== null && !(typeof value.projectId === 'string' && uuidPattern.test(value.projectId)))
    ) {
      throw new Error('Memory resolution action is invalid.');
    }
    return {
      checkoutId: parseCheckoutId(value.checkoutId),
      kind: value.kind,
      projectId: value.projectId === null ? null : parseProjectId(value.projectId),
      repositoryId: parseRepositoryId(value.repositoryId),
      spaceId: parseSpaceId(value.spaceId),
    };
  }
  if (value.kind === 'leave-unassigned') {
    if (!hasExactKeys(value, ['checkoutId', 'kind', 'spaceId'])) {
      throw new Error('Memory resolution action is invalid.');
    }
    return {
      checkoutId: parseCheckoutId(value.checkoutId),
      kind: value.kind,
      spaceId: parseSpaceId(value.spaceId),
    };
  }
  throw new Error('Memory resolution action is invalid.');
};

export const parseCheckoutResolutionActionResult = (value: unknown): CheckoutResolutionActionResult => {
  if (!(isRecord(value) && typeof value.kind === 'string')) {
    throw new Error('Memory resolution action result is invalid.');
  }
  if (value.kind === 'project-created' && hasExactKeys(value, ['kind', 'projectId'])) {
    return { kind: value.kind, projectId: parseProjectId(value.projectId) };
  }
  if (
    value.kind === 'linked' &&
    hasExactKeys(value, ['kind', 'projectId', 'repositoryId']) &&
    (value.projectId === null || typeof value.projectId === 'string')
  ) {
    return {
      kind: value.kind,
      projectId: value.projectId === null ? null : parseProjectId(value.projectId),
      repositoryId: parseRepositoryId(value.repositoryId),
    };
  }
  if (value.kind === 'left-unassigned' && hasExactKeys(value, ['kind'])) {
    return { kind: value.kind };
  }
  throw new Error('Memory resolution action result is invalid.');
};

export const parseMemoryServiceResponse = <Value>(
  value: unknown,
  parseData: (data: unknown) => Value,
): MemoryServiceSuccessResponse<Value> | MemoryServiceErrorResponse => {
  if (!(isRecord(value) && value.protocolVersion === MEMORY_SERVICE_PROTOCOL_VERSION)) {
    throw new Error('Memory service protocol response is invalid.');
  }
  if (value.ok === true && hasExactKeys(value, ['data', 'ok', 'protocolVersion'])) {
    return { data: parseData(value.data), ok: true, protocolVersion: MEMORY_SERVICE_PROTOCOL_VERSION };
  }
  if (
    value.ok === false &&
    hasExactKeys(value, ['error', 'ok', 'protocolVersion']) &&
    isRecord(value.error) &&
    hasExactKeys(value.error, ['code', 'message']) &&
    typeof value.error.code === 'string' &&
    typeof value.error.message === 'string' &&
    [
      'authentication-failed',
      'authorization-unavailable',
      'forbidden',
      'invalid-request',
      'invalid-response',
      'not-found',
      'protocol-mismatch',
      'request-too-large',
      'service-unavailable',
    ].includes(value.error.code)
  ) {
    return {
      error: {
        code: value.error.code as MemoryServiceErrorCode,
        message: boundedText(value.error.message, 512),
      },
      ok: false,
      protocolVersion: MEMORY_SERVICE_PROTOCOL_VERSION,
    };
  }
  throw new Error('Memory service protocol response is invalid.');
};
