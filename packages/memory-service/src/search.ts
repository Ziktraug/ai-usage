import { createHash } from 'node:crypto';
import type { AuthorizedResourceScope } from '@ai-usage/authorization-contract';
import type {
  Instant,
  MemoryItemId,
  MemoryObservationId,
  MemoryRevisionId,
  ProjectId,
  SpaceId,
} from '@ai-usage/platform-core/identity';
import {
  parseInstant,
  parseMemoryItemId,
  parseMemoryObservationId,
  parseMemoryRevisionId,
  parseProjectId,
} from '@ai-usage/platform-core/identity';
import {
  type MemoryItemStatus,
  type MemoryKind,
  type MemoryObservationSourceKind,
  type MemorySensitivity,
  type MemoryTrust,
  memoryKinds,
} from './domain';

export const MEMORY_SEARCH_CONTRACT_VERSION = 'memory-search-v1' as const;
export const MEMORY_SEARCH_CHUNKER_VERSION = 'memory-search-chunker-v1' as const;
export const MEMORY_SEARCH_RANKING_VERSION = 'memory-search-lexical-v1' as const;
const MEMORY_CONTENT_HASH_PATTERN = /^[0-9a-f]{64}$/u;

export const memorySearchBounds = Object.freeze({
  cursorLifetimeMs: 5 * 60 * 1000,
  maxCursorBytes: 4096,
  maxExplanationExcerptCharacters: 384,
  maxExplanationsPerResult: 8,
  maxGuidanceCharacters: 2048,
  maxGuidanceItemsPerResult: 16,
  maxLimit: 25,
  maxProvenancePerResult: 8,
  maxQueryBytes: 2048,
  maxQueryCharacters: 512,
  maxQueryTerms: 32,
  maxResultBytes: 32 * 1024,
  maxResponseBytes: 128 * 1024,
  maxSummaryCharacters: 4096,
  maxTitleCharacters: 512,
  timeoutMs: 2000,
});

export const memorySearchMatchingModes = ['hybrid', 'literal'] as const;
export type MemorySearchMatchingMode = (typeof memorySearchMatchingModes)[number];

export const memorySearchHistoryModes = ['exclude', 'include'] as const;
export type MemorySearchHistoryMode = (typeof memorySearchHistoryModes)[number];

const memoryItemStatuses = [
  'active',
  'archived',
  'rejected',
  'superseded',
] as const satisfies readonly MemoryItemStatus[];
const memoryTrustValues = ['explicit', 'harvest-accepted'] as const satisfies readonly MemoryTrust[];

export interface MemorySearchParameters {
  readonly cursor?: string | null;
  readonly historyMode?: MemorySearchHistoryMode;
  readonly includeSpaceWide?: boolean;
  readonly kinds?: readonly MemoryKind[];
  readonly limit: number;
  readonly matchingMode?: MemorySearchMatchingMode;
  readonly projectId?: ProjectId | null;
  readonly query: string;
  readonly spaceId: SpaceId;
  readonly statuses?: readonly MemoryItemStatus[];
  readonly trust?: readonly MemoryTrust[];
}

export interface NormalizedMemorySearchParameters {
  readonly cursor: string | null;
  readonly historyMode: MemorySearchHistoryMode;
  readonly includeSpaceWide: boolean;
  readonly kinds: readonly MemoryKind[];
  readonly limit: number;
  readonly matchingMode: MemorySearchMatchingMode;
  readonly projectId: ProjectId | null;
  readonly query: string;
  readonly queryFingerprint: string;
  readonly spaceId: SpaceId;
  readonly statuses: readonly MemoryItemStatus[];
  readonly trust: readonly MemoryTrust[];
}

export type MemorySearchMatchField = 'guidance' | 'structured-content' | 'summary' | 'title';
export type MemorySearchMatchKind = 'exact' | 'fuzzy' | 'lexical' | 'prefix';

export interface MemorySearchMatchExplanation {
  readonly excerpt: string;
  readonly field: MemorySearchMatchField;
  readonly kind: MemorySearchMatchKind;
}

export interface BoundedMemoryProvenanceSummary {
  readonly observationId: MemoryObservationId;
  readonly observedAt: Instant;
  readonly sensitivity: MemorySensitivity;
  readonly sourceKind: MemoryObservationSourceKind;
  readonly verification: 'accepted-proposal-evidence';
}

export interface MemorySearchRank {
  readonly exact: number;
  readonly lexical: number;
  readonly total: number;
  readonly trigram: number;
}

export interface MemorySearchResult {
  readonly chunkerVersion: typeof MEMORY_SEARCH_CHUNKER_VERSION;
  readonly contentHash: string;
  readonly guidance: readonly string[];
  readonly id: MemoryItemId;
  readonly kind: MemoryKind;
  readonly matchedBecause: readonly MemorySearchMatchExplanation[];
  readonly projectId: ProjectId | null;
  readonly provenance: readonly BoundedMemoryProvenanceSummary[];
  readonly rank: MemorySearchRank;
  readonly resourceKind: 'memory';
  readonly revisionId: MemoryRevisionId;
  readonly revisionNumber: number;
  readonly sensitivity: MemorySensitivity;
  readonly status: MemoryItemStatus;
  readonly summary: string;
  readonly title: string;
  readonly trust: MemoryTrust;
}

export interface MemorySearchPage {
  readonly items: readonly MemorySearchResult[];
  readonly nextCursor: string | null;
  readonly queryFingerprint: string;
  readonly rankingVersion: string;
  readonly total: number;
}

export interface SearchMemoryRepositoryQuery extends NormalizedMemorySearchParameters {
  readonly authorizationScope: AuthorizedResourceScope;
  readonly deadlineEpochMs: number;
  readonly nowEpochMs: number;
  readonly signal?: AbortSignal;
}

export class MemorySearchValidationError extends Error {
  readonly field: string;

  constructor(field: string) {
    super('The Memory search value is invalid.');
    this.name = 'MemorySearchValidationError';
    this.field = field;
  }
}

const uniqueSorted = <Value extends string>(
  values: readonly Value[] | undefined,
  allowed: ReadonlySet<Value>,
  fallback: readonly Value[],
  field: string,
): readonly Value[] => {
  const selected = values ?? fallback;
  if (selected.length === 0 || selected.some((value) => !allowed.has(value))) {
    throw new MemorySearchValidationError(field);
  }
  return Object.freeze([...new Set(selected)].sort());
};

const fingerprintFor = (input: Omit<NormalizedMemorySearchParameters, 'cursor' | 'queryFingerprint'>): string =>
  createHash('sha256').update(JSON.stringify(input)).digest('hex');

export const normalizeMemorySearchParameters = (input: MemorySearchParameters): NormalizedMemorySearchParameters => {
  const query = input.query.trim();
  if (
    query.length === 0 ||
    [...query].length > memorySearchBounds.maxQueryCharacters ||
    Buffer.byteLength(query, 'utf8') > memorySearchBounds.maxQueryBytes ||
    query.includes('\0')
  ) {
    throw new MemorySearchValidationError('query');
  }
  if (!Number.isSafeInteger(input.limit) || input.limit <= 0 || input.limit > memorySearchBounds.maxLimit) {
    throw new MemorySearchValidationError('limit');
  }
  if (
    input.cursor !== undefined &&
    input.cursor !== null &&
    (input.cursor.length === 0 || Buffer.byteLength(input.cursor, 'utf8') > memorySearchBounds.maxCursorBytes)
  ) {
    throw new MemorySearchValidationError('cursor');
  }
  const matchingMode = input.matchingMode ?? 'hybrid';
  if (!memorySearchMatchingModes.includes(matchingMode)) {
    throw new MemorySearchValidationError('matchingMode');
  }
  const historyMode = input.historyMode ?? 'exclude';
  if (!memorySearchHistoryModes.includes(historyMode)) {
    throw new MemorySearchValidationError('historyMode');
  }
  if (input.projectId === null && input.includeSpaceWide === true) {
    throw new MemorySearchValidationError('includeSpaceWide');
  }
  const kinds = uniqueSorted(input.kinds, new Set(memoryKinds), memoryKinds, 'kinds');
  const statuses = uniqueSorted(input.statuses, new Set(memoryItemStatuses), ['active'], 'statuses');
  if (statuses.some((status) => status !== 'active') && historyMode !== 'include') {
    throw new MemorySearchValidationError('historyMode');
  }
  if (historyMode === 'include' && input.statuses === undefined) {
    throw new MemorySearchValidationError('statuses');
  }
  const trust = uniqueSorted(input.trust, new Set(memoryTrustValues), memoryTrustValues, 'trust');
  const normalizedWithoutCursor = {
    historyMode,
    includeSpaceWide: input.includeSpaceWide ?? false,
    kinds,
    limit: input.limit,
    matchingMode,
    projectId: input.projectId ?? null,
    query,
    spaceId: input.spaceId,
    statuses,
    trust,
  };
  return Object.freeze({
    ...normalizedWithoutCursor,
    cursor: input.cursor ?? null,
    queryFingerprint: fingerprintFor(normalizedWithoutCursor),
  });
};

const validRank = (rank: MemorySearchRank): boolean =>
  [rank.exact, rank.lexical, rank.total, rank.trigram].every((value) => Number.isFinite(value) && value >= 0);

export const assertMemorySearchPageBounds = (page: MemorySearchPage): void => {
  if (
    page.items.length > memorySearchBounds.maxLimit ||
    !Number.isSafeInteger(page.total) ||
    page.total < page.items.length ||
    page.queryFingerprint.length !== 64 ||
    page.rankingVersion.length === 0 ||
    page.rankingVersion.length > 128 ||
    (page.nextCursor !== null && Buffer.byteLength(page.nextCursor, 'utf8') > memorySearchBounds.maxCursorBytes)
  ) {
    throw new MemorySearchValidationError('page');
  }
  for (const result of page.items) {
    if (
      result.title.length > memorySearchBounds.maxTitleCharacters ||
      result.summary.length > memorySearchBounds.maxSummaryCharacters ||
      result.guidance.length > memorySearchBounds.maxGuidanceItemsPerResult ||
      result.guidance.some((entry) => entry.length > memorySearchBounds.maxGuidanceCharacters) ||
      result.matchedBecause.length > memorySearchBounds.maxExplanationsPerResult ||
      result.matchedBecause.some(
        (explanation) => explanation.excerpt.length > memorySearchBounds.maxExplanationExcerptCharacters,
      ) ||
      result.provenance.length > memorySearchBounds.maxProvenancePerResult ||
      result.contentHash.length !== 64 ||
      !validRank(result.rank) ||
      Buffer.byteLength(JSON.stringify(result), 'utf8') > memorySearchBounds.maxResultBytes
    ) {
      throw new MemorySearchValidationError('result');
    }
  }
  if (Buffer.byteLength(JSON.stringify(page), 'utf8') > memorySearchBounds.maxResponseBytes) {
    throw new MemorySearchValidationError('response');
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};

const wireText = (value: unknown, maximum: number, field: string): string => {
  if (typeof value !== 'string' || value.length > maximum || value.includes('\0')) {
    throw new MemorySearchValidationError(field);
  }
  return value;
};

const wireNumber = (value: unknown, field: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new MemorySearchValidationError(field);
  }
  return value;
};

const parseSearchExplanation = (value: unknown): MemorySearchMatchExplanation => {
  if (
    !(
      isRecord(value) &&
      hasExactKeys(value, ['excerpt', 'field', 'kind']) &&
      ['guidance', 'structured-content', 'summary', 'title'].includes(String(value.field)) &&
      ['exact', 'fuzzy', 'lexical', 'prefix'].includes(String(value.kind))
    )
  ) {
    throw new MemorySearchValidationError('matchedBecause');
  }
  return {
    excerpt: wireText(value.excerpt, memorySearchBounds.maxExplanationExcerptCharacters, 'matchedBecause'),
    field: value.field as MemorySearchMatchField,
    kind: value.kind as MemorySearchMatchKind,
  };
};

const sourceKinds = new Set<MemoryObservationSourceKind>([
  'agent',
  'commit',
  'file',
  'import',
  'pull-request',
  'session',
  'user',
]);

const parseSearchProvenance = (value: unknown): BoundedMemoryProvenanceSummary => {
  if (
    !(
      isRecord(value) &&
      hasExactKeys(value, ['observationId', 'observedAt', 'sensitivity', 'sourceKind', 'verification']) &&
      (value.sensitivity === 'normal' || value.sensitivity === 'sensitive') &&
      typeof value.sourceKind === 'string' &&
      sourceKinds.has(value.sourceKind as MemoryObservationSourceKind) &&
      value.verification === 'accepted-proposal-evidence'
    )
  ) {
    throw new MemorySearchValidationError('provenance');
  }
  return {
    observationId: parseMemoryObservationId(value.observationId),
    observedAt: parseInstant(value.observedAt),
    sensitivity: value.sensitivity,
    sourceKind: value.sourceKind as MemoryObservationSourceKind,
    verification: value.verification,
  };
};

const parseSearchRank = (value: unknown): MemorySearchRank => {
  if (!(isRecord(value) && hasExactKeys(value, ['exact', 'lexical', 'total', 'trigram']))) {
    throw new MemorySearchValidationError('rank');
  }
  return {
    exact: wireNumber(value.exact, 'rank'),
    lexical: wireNumber(value.lexical, 'rank'),
    total: wireNumber(value.total, 'rank'),
    trigram: wireNumber(value.trigram, 'rank'),
  };
};

const parseSearchResult = (value: unknown): MemorySearchResult => {
  if (
    !(
      isRecord(value) &&
      hasExactKeys(value, [
        'chunkerVersion',
        'contentHash',
        'guidance',
        'id',
        'kind',
        'matchedBecause',
        'projectId',
        'provenance',
        'rank',
        'resourceKind',
        'revisionId',
        'revisionNumber',
        'sensitivity',
        'status',
        'summary',
        'title',
        'trust',
      ]) &&
      value.chunkerVersion === MEMORY_SEARCH_CHUNKER_VERSION &&
      typeof value.contentHash === 'string' &&
      MEMORY_CONTENT_HASH_PATTERN.test(value.contentHash) &&
      Array.isArray(value.guidance) &&
      value.guidance.length <= memorySearchBounds.maxGuidanceItemsPerResult &&
      typeof value.kind === 'string' &&
      memoryKinds.includes(value.kind as MemoryKind) &&
      Array.isArray(value.matchedBecause) &&
      value.matchedBecause.length <= memorySearchBounds.maxExplanationsPerResult &&
      (value.projectId === null || typeof value.projectId === 'string') &&
      Array.isArray(value.provenance) &&
      value.provenance.length <= memorySearchBounds.maxProvenancePerResult &&
      value.resourceKind === 'memory' &&
      Number.isSafeInteger(value.revisionNumber) &&
      Number(value.revisionNumber) > 0 &&
      (value.sensitivity === 'normal' || value.sensitivity === 'sensitive') &&
      memoryItemStatuses.includes(value.status as MemoryItemStatus) &&
      memoryTrustValues.includes(value.trust as MemoryTrust)
    )
  ) {
    throw new MemorySearchValidationError('result');
  }
  return {
    chunkerVersion: value.chunkerVersion,
    contentHash: value.contentHash,
    guidance: value.guidance.map((entry) => wireText(entry, memorySearchBounds.maxGuidanceCharacters, 'guidance')),
    id: parseMemoryItemId(value.id),
    kind: value.kind as MemoryKind,
    matchedBecause: value.matchedBecause.map(parseSearchExplanation),
    projectId: value.projectId === null ? null : parseProjectId(value.projectId),
    provenance: value.provenance.map(parseSearchProvenance),
    rank: parseSearchRank(value.rank),
    resourceKind: value.resourceKind,
    revisionId: parseMemoryRevisionId(value.revisionId),
    revisionNumber: Number(value.revisionNumber),
    sensitivity: value.sensitivity,
    status: value.status as MemoryItemStatus,
    summary: wireText(value.summary, memorySearchBounds.maxSummaryCharacters, 'summary'),
    title: wireText(value.title, memorySearchBounds.maxTitleCharacters, 'title'),
    trust: value.trust as MemoryTrust,
  };
};

export const parseMemorySearchPage = (value: unknown): MemorySearchPage => {
  if (
    !(
      isRecord(value) &&
      hasExactKeys(value, ['items', 'nextCursor', 'queryFingerprint', 'rankingVersion', 'total']) &&
      Array.isArray(value.items) &&
      value.items.length <= memorySearchBounds.maxLimit &&
      (value.nextCursor === null || typeof value.nextCursor === 'string') &&
      typeof value.queryFingerprint === 'string' &&
      typeof value.rankingVersion === 'string' &&
      Number.isSafeInteger(value.total)
    )
  ) {
    throw new MemorySearchValidationError('page');
  }
  const page: MemorySearchPage = {
    items: value.items.map(parseSearchResult),
    nextCursor: value.nextCursor,
    queryFingerprint: value.queryFingerprint,
    rankingVersion: value.rankingVersion,
    total: Number(value.total),
  };
  assertMemorySearchPageBounds(page);
  return page;
};
