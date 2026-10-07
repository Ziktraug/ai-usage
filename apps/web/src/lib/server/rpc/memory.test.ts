import { describe, expect, test } from 'bun:test';
import { MemoryServiceClientError } from '@ai-usage/memory-service/client';
import type { MemoryProposalReviewSnapshot } from '@ai-usage/web-contract/memory';
import { call } from '@orpc/server';
import { createMemoryRpcRouter, type MemoryRpcDependencies } from './memory';

const proposalId = '0198f179-4837-7000-8000-000000000002';
const snapshot: MemoryProposalReviewSnapshot = {
  nextCursor: null,
  proposals: [],
  spaceId: '0198f179-4837-7000-8000-000000000001',
};
const unused = () => Promise.reject(new Error('unused'));
const router = (listProposalReviews: MemoryRpcDependencies['listProposalReviews']) =>
  createMemoryRpcRouter({
    applyProposalReviewAction: unused,
    getKnowledge: unused,
    isDemo: async () => false,
    listKnowledge: unused,
    listProposalReviews,
    promoteAnalysis: unused,
    searchMemory: unused,
  });

describe('Memory proposal review RPC', () => {
  test('forwards an addressed proposal and refuses one the service cannot start a page at', async () => {
    const positions: unknown[] = [];
    const reviews = router((_signal, position) => {
      positions.push(position);
      return Promise.resolve(snapshot);
    });
    await expect(call(reviews.proposalReviews, { proposalId })).resolves.toEqual(snapshot);
    expect(positions).toEqual([{ proposalId }]);

    await expect(
      call(
        router(() => Promise.reject(new MemoryServiceClientError('not-found', 'private diagnostic'))).proposalReviews,
        { proposalId },
      ),
    ).rejects.toMatchObject({ code: 'Unavailable', data: { reason: 'not-found' } });
    await expect(
      call(
        router(() => Promise.reject(new MemoryServiceClientError('service-unavailable', 'private diagnostic')))
          .proposalReviews,
        { proposalId },
      ),
    ).rejects.toMatchObject({ code: 'Unavailable', data: { reason: 'memory-review-unavailable' } });
  });

  test('rejects a malformed or ambiguous address before reading Memory', async () => {
    let reads = 0;
    const reviews = router(() => {
      reads += 1;
      return Promise.resolve(snapshot);
    });
    for (const input of [{ proposalId: 'not-a-proposal' }, { cursor: 'opaque', proposalId }]) {
      await expect(call(reviews.proposalReviews, input as never)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    }
    expect(reads).toBe(0);
  });
});
