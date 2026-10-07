import type { MemoryProposalReviewSnapshot, MemorySearchInput } from '@ai-usage/web-contract/memory';
import type { QueryClient } from '@tanstack/svelte-query';
import { queryOptions } from '@tanstack/svelte-query';
import type { MemoryBrowserAdapter } from '../../rpc/memory-client';
import { type ControlPlaneQueryKey, controlPlaneKey, finiteSwrKey } from '../keys';
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

export const memoryProposalReviewsKey = (cursor?: string | null): ControlPlaneQueryKey =>
  cursor
    ? controlPlaneKey('memory', 'proposal-reviews', 'v1', cursor)
    : controlPlaneKey('memory', 'proposal-reviews', 'v1');

export const memoryProposalReviewsQueryOptions = (
  client: MemoryProposalReviewClient,
  context: MemoryProposalReviewQueryContext,
  cursor?: string | null,
) =>
  queryOptions({
    ...webQueryPolicies.boundedControlPlane,
    enabled: context.browser && context.enabled,
    queryFn: ({ signal }) => client.proposalReviews(signal, cursor),
    queryKey: memoryProposalReviewsKey(cursor),
  });

export const memorySearchKey = (input: MemorySearchInput): ControlPlaneQueryKey =>
  controlPlaneKey(
    'memory',
    'search',
    'v1',
    input.query,
    input.projectId ?? '',
    JSON.stringify(input.kinds ?? []),
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
  await Promise.all([
    client.invalidateQueries({ queryKey: finiteSwrKey('memory', 'knowledge') }),
    client.invalidateQueries({ queryKey: controlPlaneKey('memory', 'search') }),
  ]);
};
