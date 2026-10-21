import { describe, expect, test } from 'bun:test';
import type { MemoryContractClient } from '@ai-usage/web-contract/memory';
import { QueryObserver } from '@tanstack/svelte-query';
import { createWebQueryClient } from '../client';
import { browserMemoryClient, memoryKnowledgeOptions } from './memory-workspace';

const input = { projectId: null, kind: null, cursor: null, pageSize: 20 } as const;
const unused = (): Promise<never> => Promise.reject(new Error('Unexpected Memory RPC call'));
describe('accepted Memory Query ownership', () => {
  test('keeps SSR and inactive knowledge reads disabled without another client surface', async () => {
    let calls = 0;
    const client: MemoryContractClient = {
      applyProposalReviewAction: unused,
      getKnowledge: unused,
      proposalReviews: unused,
      search: unused,
      knowledge: () => {
        calls += 1;
        return Promise.resolve({ items: [], nextCursor: null });
      },
    };
    const queryClient = createWebQueryClient();
    for (const options of [
      memoryKnowledgeOptions(undefined, input, true),
      memoryKnowledgeOptions(client, input, false),
    ]) {
      const observer = new QueryObserver(queryClient, options);
      const unsubscribe = observer.subscribe(() => undefined);
      await Promise.resolve();
      unsubscribe();
    }
    expect(calls).toBe(0);
    expect(() => browserMemoryClient(undefined)).toThrow('Memory reads run only in the browser.');
    expect(await queryClient.fetchQuery(memoryKnowledgeOptions(client, input, true))).toEqual({
      items: [],
      nextCursor: null,
    });
    expect(calls).toBe(1);
    queryClient.clear();
  });
  test('separates Project, type and page identities while keeping accepted knowledge under its named policy', () => {
    const base = memoryKnowledgeOptions(undefined, input, true);
    for (const change of [
      { projectId: '0198f179-4837-7000-8000-000000000011' },
      { kind: 'lesson' as const },
      { cursor: 'next' },
    ]) {
      expect(memoryKnowledgeOptions(undefined, { ...input, ...change }, true).queryKey).not.toEqual(base.queryKey);
    }
    expect(base.staleTime).toBe(30_000);
  });
});
