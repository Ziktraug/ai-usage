import {
  parseMemoryItemId,
  parseMemoryRevisionId,
  parseProjectId,
  parseSpaceId,
  type SpaceId,
} from '@ai-usage/platform-core/identity';
import { type MemoryProjectContext, memoryProjectContextBounds } from './application';
import { type MemoryItemResult, memoryKinds, parseCurrentMemoryItemResult, parseMemoryItemResult } from './domain';
import {
  type MemorySearchParameters,
  type NormalizedMemorySearchParameters,
  normalizeMemorySearchParameters,
} from './search';

export type MemorySearchReadRequest = Omit<MemorySearchParameters, 'spaceId'>;

export interface MemoryItemReadRequest {
  readonly itemId: ReturnType<typeof parseMemoryItemId>;
  readonly revisionId?: ReturnType<typeof parseMemoryRevisionId>;
}

export interface MemoryProjectContextReadRequest {
  readonly limit: number;
  readonly projectId: ReturnType<typeof parseProjectId>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasOnlyKeys = (value: Record<string, unknown>, allowed: readonly string[]): boolean =>
  Object.keys(value).every((key) => allowed.includes(key));

const hasExactKeys = (value: Record<string, unknown>, expected: readonly string[]): boolean =>
  Object.keys(value).length === expected.length && expected.every((key) => Object.hasOwn(value, key));

const optionalStringArray = (value: unknown): readonly string[] | undefined => {
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error('Memory read request array is invalid.');
  }
  return value;
};

export const parseMemorySearchReadRequest = (value: unknown, spaceId: SpaceId): NormalizedMemorySearchParameters => {
  if (
    !(
      isRecord(value) &&
      hasOnlyKeys(value, [
        'cursor',
        'historyMode',
        'includeSpaceWide',
        'kinds',
        'limit',
        'matchingMode',
        'projectId',
        'query',
        'statuses',
        'trust',
      ]) &&
      typeof value.query === 'string' &&
      typeof value.limit === 'number' &&
      (value.cursor === undefined || value.cursor === null || typeof value.cursor === 'string') &&
      (value.historyMode === undefined || value.historyMode === 'exclude' || value.historyMode === 'include') &&
      (value.includeSpaceWide === undefined || typeof value.includeSpaceWide === 'boolean') &&
      (value.matchingMode === undefined || value.matchingMode === 'hybrid' || value.matchingMode === 'literal') &&
      (value.projectId === undefined || value.projectId === null || typeof value.projectId === 'string')
    )
  ) {
    throw new Error('Memory search read request is invalid.');
  }
  const kinds = optionalStringArray(value.kinds);
  if (kinds?.some((kind) => !memoryKinds.includes(kind as (typeof memoryKinds)[number]))) {
    throw new Error('Memory search kinds are invalid.');
  }
  const statuses = optionalStringArray(value.statuses);
  const trust = optionalStringArray(value.trust);
  return normalizeMemorySearchParameters({
    ...(value.cursor === undefined ? {} : { cursor: value.cursor }),
    ...(value.historyMode === undefined ? {} : { historyMode: value.historyMode }),
    ...(value.includeSpaceWide === undefined ? {} : { includeSpaceWide: value.includeSpaceWide }),
    ...(kinds === undefined ? {} : { kinds: kinds as (typeof memoryKinds)[number][] }),
    limit: value.limit,
    ...(value.matchingMode === undefined ? {} : { matchingMode: value.matchingMode }),
    ...(value.projectId === undefined
      ? {}
      : { projectId: value.projectId === null ? null : parseProjectId(value.projectId) }),
    query: value.query,
    spaceId,
    ...(statuses === undefined ? {} : { statuses: statuses as ('active' | 'archived' | 'rejected' | 'superseded')[] }),
    ...(trust === undefined ? {} : { trust: trust as ('explicit' | 'harvest-accepted')[] }),
  });
};

export const parseMemoryItemReadRequest = (value: unknown): MemoryItemReadRequest => {
  if (!(isRecord(value) && hasOnlyKeys(value, ['itemId', 'revisionId']) && Object.hasOwn(value, 'itemId'))) {
    throw new Error('Memory item read request is invalid.');
  }
  return {
    itemId: parseMemoryItemId(value.itemId),
    ...(value.revisionId === undefined ? {} : { revisionId: parseMemoryRevisionId(value.revisionId) }),
  };
};

export const parseMemoryProjectContextReadRequest = (value: unknown): MemoryProjectContextReadRequest => {
  if (
    !(
      isRecord(value) &&
      hasExactKeys(value, ['limit', 'projectId']) &&
      Number.isSafeInteger(value.limit) &&
      Number(value.limit) > 0 &&
      Number(value.limit) <= memoryProjectContextBounds.maxItems
    )
  ) {
    throw new Error('Memory Project context read request is invalid.');
  }
  return { limit: Number(value.limit), projectId: parseProjectId(value.projectId) };
};

export const parseMemoryItemReadResult = (value: unknown): MemoryItemResult => parseMemoryItemResult(value);

export const parseMemoryProjectContext = (value: unknown): MemoryProjectContext => {
  if (
    !(
      isRecord(value) &&
      hasExactKeys(value, ['items', 'projectId', 'spaceId', 'truncated']) &&
      Array.isArray(value.items) &&
      value.items.length <= memoryProjectContextBounds.maxItems &&
      typeof value.truncated === 'boolean'
    )
  ) {
    throw new Error('Memory Project context response is invalid.');
  }
  const projectId = parseProjectId(value.projectId);
  const spaceId = parseSpaceId(value.spaceId);
  const items = value.items.map(parseCurrentMemoryItemResult);
  if (
    items.some(
      ({ item }) => item.owningSpaceId !== spaceId || (item.projectId !== null && item.projectId !== projectId),
    )
  ) {
    throw new Error('Memory Project context response scope is invalid.');
  }
  return {
    items,
    projectId,
    spaceId,
    truncated: value.truncated,
  };
};

export { parseMemorySearchPage } from './search';
