import { describe, expect, test } from 'bun:test';
import type { MemoryProposalReviewSnapshot } from '@ai-usage/web-contract/memory';
import { createHydratedWebQueryClient } from '../../query/client';
import { memoryProposalReviewsKey, memoryProposalReviewsQueryOptions } from '../../query/options/memory';
import { deferredMemoryPageData, loadMemoryPageData } from './memory-load';

const snapshot: MemoryProposalReviewSnapshot = {
  nextCursor: null,
  proposals: [],
  spaceId: '0198f179-4837-7000-8000-000000000001',
};

describe('Memory SSR load identity', () => {
  test('returns an empty hydration delta for SPA entry', () => {
    expect(deferredMemoryPageData()).toEqual({ queryState: { dehydratedState: { mutations: [], queries: [] } } });
  });

  test('awaits and hydrates exactly one bounded proposal-review identity', async () => {
    let calls = 0;
    const client = {
      applyProposalReviewAction: () => Promise.reject(new Error('unused')),
      proposalReviews: () => {
        calls += 1;
        return Promise.resolve(snapshot);
      },
      search: () => Promise.reject(new Error('unused')),
    };
    const data = await loadMemoryPageData(
      {
        fetch: () => Promise.reject(new Error('Injected Memory client owns this acquisition.')),
        url: new URL('http://memory.invalid/memory'),
      },
      { createClient: () => client },
    );

    expect(calls).toBe(1);
    expect(data.queryState.dehydratedState.queries).toHaveLength(1);
    expect(data.queryState.dehydratedState.queries[0]?.queryKey).toEqual(memoryProposalReviewsKey());
    const hydrated = createHydratedWebQueryClient(data.queryState);
    expect(hydrated.getQueryData<MemoryProposalReviewSnapshot>(memoryProposalReviewsKey())).toEqual(snapshot);
    expect(
      await hydrated.fetchQuery(memoryProposalReviewsQueryOptions(client, { browser: true, enabled: true })),
    ).toEqual(snapshot);
    expect(calls).toBe(1);
  });
});
