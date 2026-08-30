import { describe, expect, test } from 'bun:test';
import {
  parseMemoryItemId,
  parseMemoryRevisionId,
  parseProjectId,
  parseSpaceId,
} from '@ai-usage/platform-core/identity';
import {
  assertMemorySearchPageBounds,
  MEMORY_SEARCH_CHUNKER_VERSION,
  MemorySearchValidationError,
  normalizeMemorySearchParameters,
} from './search';

const spaceId = parseSpaceId('019d0000-0000-7000-8000-000000000001');
const projectId = parseProjectId('019d0000-0000-7000-8000-000000000002');

describe('Memory search contract', () => {
  test('normalizes active lexical search and produces an order-independent filter fingerprint', () => {
    const first = normalizeMemorySearchParameters({
      kinds: ['pitfall', 'command'],
      limit: 10,
      projectId,
      query: '  pnpm check  ',
      spaceId,
      trust: ['harvest-accepted', 'explicit'],
    });
    const second = normalizeMemorySearchParameters({
      kinds: ['command', 'pitfall'],
      limit: 10,
      projectId,
      query: 'pnpm check',
      spaceId,
      trust: ['explicit', 'harvest-accepted'],
    });

    expect(first).toMatchObject({
      cursor: null,
      historyMode: 'exclude',
      matchingMode: 'hybrid',
      query: 'pnpm check',
      statuses: ['active'],
    });
    expect(first.queryFingerprint).toBe(second.queryFingerprint);
  });

  test('requires an explicit history mode and explicit status selection', () => {
    expect(() =>
      normalizeMemorySearchParameters({ limit: 10, query: 'old guidance', spaceId, statuses: ['superseded'] }),
    ).toThrow(MemorySearchValidationError);
    expect(() =>
      normalizeMemorySearchParameters({ historyMode: 'include', limit: 10, query: 'old guidance', spaceId }),
    ).toThrow(MemorySearchValidationError);
    expect(
      normalizeMemorySearchParameters({
        historyMode: 'include',
        limit: 10,
        query: 'old guidance',
        spaceId,
        statuses: ['superseded'],
      }).statuses,
    ).toEqual(['superseded']);
  });

  test('rejects unbounded input and output', () => {
    expect(() => normalizeMemorySearchParameters({ limit: 26, query: 'memory', spaceId })).toThrow(
      MemorySearchValidationError,
    );
    expect(() =>
      assertMemorySearchPageBounds({
        items: [
          {
            chunkerVersion: MEMORY_SEARCH_CHUNKER_VERSION,
            contentHash: 'a'.repeat(64),
            guidance: [],
            id: parseMemoryItemId('019d0000-0000-7000-8000-000000000003'),
            kind: 'decision',
            matchedBecause: [],
            projectId: null,
            provenance: [],
            rank: { exact: 0, lexical: 1, total: 1, trigram: 0 },
            resourceKind: 'memory',
            revisionId: parseMemoryRevisionId('019d0000-0000-7000-8000-000000000004'),
            revisionNumber: 1,
            sensitivity: 'normal',
            status: 'active',
            summary: 'x'.repeat(4097),
            title: 'Bounded result',
            trust: 'explicit',
          },
        ],
        nextCursor: null,
        queryFingerprint: 'b'.repeat(64),
        rankingVersion: 'synthetic-v1',
        total: 1,
      }),
    ).toThrow(MemorySearchValidationError);
  });
});
