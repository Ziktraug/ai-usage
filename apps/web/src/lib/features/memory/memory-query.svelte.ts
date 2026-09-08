import type {
  MemoryProposalReviewAction,
  MemoryProposalReviewActionResult,
  MemoryProposalReviewSnapshot,
  MemorySearchInput,
  MemorySearchPage,
} from '@ai-usage/web-contract/memory';
import { type CreateQueryResult, createQuery } from '@tanstack/svelte-query';
import {
  type MemoryProposalReviewClient,
  type MemorySearchClient,
  memoryProposalReviewsQueryOptions,
  memorySearchQueryOptions,
} from '../../query/options/memory';
import { useWebQueryRpcContext } from '../../query/rpc-context.svelte';
import { createMemoryBrowserAdapter } from '../../rpc/memory-client';

const unavailableReviews = (): Promise<never> =>
  Promise.reject(new Error('Memory proposal RPC is unavailable during SSR.'));

const createLazyClient = (): MemoryProposalReviewClient => {
  let client: MemoryProposalReviewClient | undefined;
  return {
    proposalReviews: async (...parameters) => {
      client ??= createMemoryBrowserAdapter(useWebQueryRpcContext().rpc.memory);
      return await client.proposalReviews(...parameters);
    },
  };
};

export const createHydratedMemoryProposalQuery = (
  browser: boolean,
): CreateQueryResult<MemoryProposalReviewSnapshot, Error> =>
  createQuery(() =>
    memoryProposalReviewsQueryOptions(browser ? createLazyClient() : { proposalReviews: unavailableReviews }, {
      browser,
      enabled: true,
    }),
  );

export const createMemoryProposalActor = (
  browser: boolean,
): ((action: MemoryProposalReviewAction) => Promise<MemoryProposalReviewActionResult>) | undefined => {
  if (!browser) {
    return;
  }
  const client = createMemoryBrowserAdapter(useWebQueryRpcContext().rpc.memory);
  return async (action) => await client.applyProposalReviewAction(action);
};

const createLazySearchClient = (): MemorySearchClient => {
  let client: MemorySearchClient | undefined;
  return {
    search: async (...parameters) => {
      client ??= createMemoryBrowserAdapter(useWebQueryRpcContext().rpc.memory);
      return await client.search(...parameters);
    },
  };
};

export const createMemorySearchQuery = (
  browser: boolean,
  input: () => MemorySearchInput,
  enabled: () => boolean,
): CreateQueryResult<MemorySearchPage, Error> => {
  const client: MemorySearchClient = browser
    ? createLazySearchClient()
    : { search: () => Promise.reject(new Error('Memory search RPC is unavailable during SSR.')) };
  return createQuery(() => memorySearchQueryOptions(client, input(), { browser, enabled: enabled() }));
};
