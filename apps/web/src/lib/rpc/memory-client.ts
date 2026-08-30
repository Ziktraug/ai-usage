import {
  type MemoryContractClient,
  type MemoryProposalReviewAction,
  type MemoryProposalReviewActionResult,
  type MemoryProposalReviewSnapshot,
  type MemorySearchInput,
  type MemorySearchPage,
  parseMemoryProposalReviewActionResult,
  parseMemoryProposalReviewSnapshot,
  parseMemorySearchPage,
} from '@ai-usage/web-contract/memory';

export type MemoryRpcTransport = Pick<MemoryContractClient, 'applyProposalReviewAction' | 'proposalReviews' | 'search'>;

export interface MemoryBrowserAdapter {
  readonly applyProposalReviewAction: (
    action: MemoryProposalReviewAction,
    signal?: AbortSignal,
  ) => Promise<MemoryProposalReviewActionResult>;
  readonly proposalReviews: (signal?: AbortSignal) => Promise<MemoryProposalReviewSnapshot>;
  readonly search: (input: MemorySearchInput, signal?: AbortSignal) => Promise<MemorySearchPage>;
}

export const createMemoryBrowserAdapter = (transport: MemoryRpcTransport): MemoryBrowserAdapter => ({
  applyProposalReviewAction: async (action, signal) => {
    signal?.throwIfAborted();
    const result = await transport.applyProposalReviewAction(action, signal === undefined ? undefined : { signal });
    signal?.throwIfAborted();
    return parseMemoryProposalReviewActionResult(result);
  },
  proposalReviews: async (signal) => {
    signal?.throwIfAborted();
    const result = await transport.proposalReviews({}, signal === undefined ? undefined : { signal });
    signal?.throwIfAborted();
    return parseMemoryProposalReviewSnapshot(result);
  },
  search: async (input, signal) => {
    signal?.throwIfAborted();
    const result = await transport.search(input, signal === undefined ? undefined : { signal });
    signal?.throwIfAborted();
    return parseMemorySearchPage(result);
  },
});
