import { describe, expect, test } from 'bun:test';
import type { MemoryProposalReviewSnapshot, MemorySearchInput, MemorySearchPage } from '@ai-usage/web-contract/memory';
import { createWebQueryClient } from '../client';
import {
  acknowledgeMemoryProposalReview,
  memoryProposalReviewsKey,
  memoryProposalReviewsQueryOptions,
  memorySearchKey,
  memorySearchQueryOptions,
} from './memory';

const snapshot: MemoryProposalReviewSnapshot = {
  nextCursor: null,
  proposals: [
    {
      guidance: [],
      observationSources: [],
      projectId: null,
      proposalId: '0198f179-4837-7000-8000-000000000002',
      proposedByKind: 'service',
      proposedKind: 'decision',
      sensitivity: 'normal',
      structuredContent: {},
      summary: '',
      title: 'First proposal',
      trustCandidate: 'harvest-accepted',
    },
    {
      guidance: [],
      observationSources: [],
      projectId: null,
      proposalId: '0198f179-4837-7000-8000-000000000003',
      proposedByKind: 'person',
      proposedKind: 'lesson',
      sensitivity: 'normal',
      structuredContent: {},
      summary: '',
      title: 'Second proposal',
      trustCandidate: 'explicit',
    },
  ],
  spaceId: '0198f179-4837-7000-8000-000000000001',
};

describe('Memory proposal Query options', () => {
  test('uses one bounded control-plane identity and forwards cancellation', async () => {
    const observedSignals: AbortSignal[] = [];
    const client = createWebQueryClient();
    const options = memoryProposalReviewsQueryOptions(
      {
        proposalReviews: (signal) => {
          if (signal) {
            observedSignals.push(signal);
          }
          return Promise.resolve(snapshot);
        },
      },
      { browser: true, enabled: true },
    );

    await expect(client.fetchQuery(options)).resolves.toEqual(snapshot);
    expect(options).toMatchObject({
      queryKey: ['web', 'control-plane', 'memory', 'proposal-reviews', 'v1'],
      refetchOnMount: true,
      retry: false,
    });
    expect(observedSignals).toHaveLength(1);
  });

  test('acknowledges only the successful proposal and leaves the snapshot stale', async () => {
    const client = createWebQueryClient();
    client.setQueryData(memoryProposalReviewsKey(), snapshot);

    await acknowledgeMemoryProposalReview(client, '0198f179-4837-7000-8000-000000000002');

    const remaining = client.getQueryData<MemoryProposalReviewSnapshot>(memoryProposalReviewsKey());
    expect(remaining?.proposals.map((proposal) => proposal.proposalId)).toEqual([
      '0198f179-4837-7000-8000-000000000003',
    ]);
    expect(client.getQueryState(memoryProposalReviewsKey())?.isInvalidated).toBe(true);
  });
});

const searchInput: MemorySearchInput = {
  cursor: null,
  includeSpaceWide: false,
  limit: 10,
  matchingMode: 'literal',
  projectId: null,
  query: 'SQLITE_BUSY',
};

const searchPage: MemorySearchPage = {
  items: [],
  nextCursor: null,
  queryFingerprint: 'a'.repeat(64),
  rankingVersion: 'memory-search-lexical-v1',
  total: 0,
};

describe('Memory search Query options', () => {
  test('binds every result-shaping field to one bounded identity and forwards cancellation', async () => {
    const observedSignals: AbortSignal[] = [];
    const client = createWebQueryClient();
    const options = memorySearchQueryOptions(
      {
        search: (_input, signal) => {
          if (signal) {
            observedSignals.push(signal);
          }
          return Promise.resolve(searchPage);
        },
      },
      searchInput,
      { browser: true, enabled: true },
    );

    await expect(client.fetchQuery(options)).resolves.toEqual(searchPage);
    expect(options).toMatchObject({
      queryKey: ['web', 'control-plane', 'memory', 'search', 'v1', 'SQLITE_BUSY', '', false, 'literal', 10, ''],
      retry: false,
    });
    expect(observedSignals).toHaveLength(1);
    expect(memorySearchKey({ ...searchInput, matchingMode: 'hybrid' })).not.toEqual(memorySearchKey(searchInput));
  });
});
