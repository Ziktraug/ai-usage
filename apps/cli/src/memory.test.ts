import { describe, expect, test } from 'bun:test';
import { parseMemorySearchPage } from '@ai-usage/memory-service/search';
import { MEMORY_RETRIEVED_DATA_NOTICE, renderMemorySearch } from './memory';

const page = parseMemorySearchPage({
  items: [
    {
      chunkerVersion: 'memory-search-chunker-v1',
      contentHash: 'a'.repeat(64),
      guidance: ['Authorize before ranking.'],
      id: '0198f179-4837-7000-8000-000000000010',
      kind: 'constraint',
      matchedBecause: [{ excerpt: 'authorize before ranking', field: 'guidance', kind: 'lexical' }],
      projectId: null,
      provenance: [
        {
          observationId: '0198f179-4837-7000-8000-000000000011',
          observedAt: '2026-08-29T08:30:00.000Z',
          sensitivity: 'normal',
          sourceKind: 'commit',
          verification: 'accepted-proposal-evidence',
        },
      ],
      rank: { exact: 0, lexical: 2, total: 2, trigram: 0 },
      resourceKind: 'memory',
      revisionId: '0198f179-4837-7000-8000-000000000012',
      revisionNumber: 2,
      sensitivity: 'normal',
      status: 'active',
      summary: 'Authorization participates in candidate selection.',
      title: 'Authorized ranking',
      trust: 'explicit',
    },
  ],
  nextCursor: 'opaque-cursor',
  queryFingerprint: 'b'.repeat(64),
  rankingVersion: 'memory-search-lexical-v1',
  total: 1,
});

describe('Memory CLI rendering', () => {
  test('labels retrieved data and preserves trust, revision, matching, and provenance', () => {
    const output = renderMemorySearch(page, false);

    expect(output).toContain(MEMORY_RETRIEVED_DATA_NOTICE);
    expect(output).toContain('[constraint · active · explicit · normal] Authorized ranking');
    expect(output).toContain('matched guidance/lexical: authorize before ranking');
    expect(output).toContain('revision 2 · 0198f179-4837-7000-8000-000000000012');
    expect(output).toContain('provenance commit · accepted-proposal-evidence');
    expect(output).toContain('Next cursor: opaque-cursor');
  });

  test('keeps JSON output equal to the bounded service contract', () => {
    expect(JSON.parse(renderMemorySearch(page, true))).toEqual(page);
  });
});
