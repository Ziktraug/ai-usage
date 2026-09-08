import type { MemoryProposalReviewSnapshot, MemorySearchInput } from '@ai-usage/web-contract/memory';
import type { QueryClient } from '@tanstack/svelte-query';
import { queryOptions } from '@tanstack/svelte-query';
import type { MemoryBrowserAdapter } from '../../rpc/memory-client';
import { type ControlPlaneQueryKey, controlPlaneKey } from '../keys';
import { webQueryPolicies } from '../policies';

export type MemoryProposalReviewClient = Pick<MemoryBrowserAdapter, 'proposalReviews'>;

export interface MemoryProposalReviewQueryContext {
  readonly browser: boolean;
  readonly enabled: boolean;
}

export type MemorySearchClient = Pick<MemoryBrowserAdapter, 'search'>;

export interface MemorySearchQueryContext {
  readonly browser: boolean;
  readonly enabled: boolean;
}

export const memoryProposalReviewsKey = (): ControlPlaneQueryKey => controlPlaneKey('memory', 'proposal-reviews', 'v1');

export const memoryProposalReviewsQueryOptions = (
  client: MemoryProposalReviewClient,
  context: MemoryProposalReviewQueryContext,
) =>
  queryOptions({
    ...webQueryPolicies.boundedControlPlane,
    enabled: context.browser && context.enabled,
    queryFn: ({ signal }) => client.proposalReviews(signal),
    queryKey: memoryProposalReviewsKey(),
  });

export const memorySearchKey = (input: MemorySearchInput): ControlPlaneQueryKey =>
  controlPlaneKey(
    'memory',
    'search',
    'v1',
    input.query,
    input.projectId ?? '',
    input.includeSpaceWide,
    input.matchingMode,
    input.limit,
    input.cursor ?? '',
  );

export const memorySearchQueryOptions = (
  client: MemorySearchClient,
  input: MemorySearchInput,
  context: MemorySearchQueryContext,
) =>
  queryOptions({
    ...webQueryPolicies.boundedControlPlane,
    enabled: context.browser && context.enabled,
    queryFn: ({ signal }) => client.search(input, signal),
    queryKey: memorySearchKey(input),
  });

export const acknowledgeMemoryProposalReview = async (client: QueryClient, proposalId: string): Promise<void> => {
  client.setQueryData<MemoryProposalReviewSnapshot>(memoryProposalReviewsKey(), (snapshot) =>
    snapshot === undefined
      ? undefined
      : {
          ...snapshot,
          proposals: snapshot.proposals.filter((proposal) => proposal.proposalId !== proposalId),
        },
  );
  await client.invalidateQueries({
    exact: true,
    queryKey: memoryProposalReviewsKey(),
    refetchType: 'none',
  });
};
