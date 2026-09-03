import { describe, expect, test } from 'bun:test';
import { safeParse } from 'valibot';
import {
  type MemoryProposalReviewSnapshot,
  type MemorySearchPage,
  memoryProposalReviewActionSchema,
  memoryProposalReviewSnapshotSchema,
  memorySearchInputSchema,
  memorySearchPageSchema,
  parseMemoryProposalReviewActionResult,
  parseMemoryProposalReviewSnapshot,
  parseMemorySearchPage,
} from './memory';

const spaceId = '0198f179-4837-7000-8000-000000000001';
const proposalId = '0198f179-4837-7000-8000-000000000002';

const snapshot: MemoryProposalReviewSnapshot = {
  nextCursor: null,
  proposals: [
    {
      guidance: ['Keep the two data authorities separate.'],
      observationSources: [
        {
          id: '0198f179-4837-7000-8000-000000000003',
          observedAt: '2026-08-29T08:30:00.000Z',
          sensitivity: 'normal',
          sourceKind: 'commit',
          sourceLocator: 'commit:0123456789ab',
        },
      ],
      projectId: null,
      proposalId,
      proposedByKind: 'service',
      proposedKind: 'decision',
      sensitivity: 'normal',
      structuredContent: { authority: 'sqlite' },
      summary: 'The local Memory authority remains SQLite.',
      title: 'Keep local Memory offline-first',
      trustCandidate: 'harvest-accepted',
    },
  ],
  spaceId,
};

describe('Memory proposal review contract', () => {
  test('accepts only bounded provenance without principal or audit content', () => {
    expect(parseMemoryProposalReviewSnapshot(snapshot)).toEqual(snapshot);
    expect(
      safeParse(memoryProposalReviewSnapshotSchema, {
        ...snapshot,
        proposals: [{ ...snapshot.proposals[0], proposedByPrincipal: { token: 'private' } }],
      }).success,
    ).toBe(false);
  });

  test('closes accept, edit-then-accept, and reject actions', () => {
    const actions = [
      { kind: 'accept', proposalId, scope: 'space', spaceId },
      {
        edits: {
          guidance: ['Keep the bounded application seam.'],
          sensitivity: 'sensitive',
          structuredContent: { reviewed: true },
          summary: 'Reviewed summary',
          title: 'Reviewed title',
        },
        kind: 'accept',
        proposalId,
        scope: 'project',
        spaceId,
      },
      { kind: 'reject', proposalId, reason: 'Not durable knowledge', spaceId },
    ] as const;
    for (const action of actions) {
      expect(safeParse(memoryProposalReviewActionSchema, action).success).toBe(true);
    }
    expect(
      safeParse(memoryProposalReviewActionSchema, {
        kind: 'reject',
        proposalId,
        reason: 'No',
        sourcePath: '/private/operator/memory.jsonl',
        spaceId,
      }).success,
    ).toBe(false);
    expect(
      parseMemoryProposalReviewActionResult({
        itemId: '0198f179-4837-7000-8000-000000000004',
        kind: 'accepted',
        revisionId: '0198f179-4837-7000-8000-000000000005',
      }),
    ).toMatchObject({ kind: 'accepted' });
  });
});

const searchPage: MemorySearchPage = {
  items: [
    {
      chunkerVersion: 'memory-search-chunker-v1',
      contentHash: 'a'.repeat(64),
      guidance: ['Use the complete authorized relation before ranking.'],
      id: '0198f179-4837-7000-8000-000000000010',
      kind: 'constraint',
      matchedBecause: [{ excerpt: 'authorize before ranking', field: 'guidance', kind: 'lexical' }],
      projectId: '0198f179-4837-7000-8000-000000000020',
      provenance: [
        {
          observationId: '0198f179-4837-7000-8000-000000000030',
          observedAt: '2026-08-29T08:30:00.000Z',
          sensitivity: 'normal',
          sourceKind: 'commit',
          verification: 'accepted-proposal-evidence',
        },
      ],
      rank: { exact: 0, lexical: 2.5, total: 2.5, trigram: 0 },
      resourceKind: 'memory',
      revisionId: '0198f179-4837-7000-8000-000000000011',
      revisionNumber: 3,
      sensitivity: 'normal',
      status: 'active',
      summary: 'Authorization is part of the search query.',
      title: 'Authorize before ranking',
      trust: 'explicit',
    },
  ],
  nextCursor: null,
  queryFingerprint: 'b'.repeat(64),
  rankingVersion: 'memory-search-lexical-v1',
  total: 1,
};

describe('Memory search contract', () => {
  test('accepts bounded active-search input and revision-pinned result cards', () => {
    expect(
      safeParse(memorySearchInputSchema, {
        cursor: null,
        includeSpaceWide: true,
        limit: 10,
        matchingMode: 'hybrid',
        projectId: '0198f179-4837-7000-8000-000000000020',
        query: 'authorized ranking',
      }).success,
    ).toBe(true);
    expect(parseMemorySearchPage(searchPage)).toEqual(searchPage);
  });

  test('rejects unbounded inputs, private additions, and incomplete provenance', () => {
    expect(
      safeParse(memorySearchInputSchema, {
        cursor: null,
        includeSpaceWide: false,
        limit: 26,
        matchingMode: 'hybrid',
        projectId: null,
        query: 'x'.repeat(513),
      }).success,
    ).toBe(false);
    expect(
      safeParse(memorySearchPageSchema, {
        ...searchPage,
        items: [{ ...searchPage.items[0], sourceLocator: '/private/operator/memory.sqlite' }],
      }).success,
    ).toBe(false);
    expect(
      safeParse(memorySearchPageSchema, {
        ...searchPage,
        items: [{ ...searchPage.items[0], provenance: [{ sourceKind: 'commit' }] }],
      }).success,
    ).toBe(false);
  });
});
