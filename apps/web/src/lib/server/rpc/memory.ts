import { MemoryServiceClientError } from '@ai-usage/memory-service/client';
import {
  type MemoryProposalReviewAction,
  type MemorySearchInput,
  memoryContract,
  memoryProposalReviewActionResultSchema,
  memoryProposalReviewSnapshotSchema,
  memorySearchPageSchema,
} from '@ai-usage/web-contract/memory';
import { implement } from '@orpc/server';
import { parse } from 'valibot';

export interface MemoryRpcDependencies {
  readonly applyProposalReviewAction: (
    input: MemoryProposalReviewAction,
    signal: AbortSignal | undefined,
  ) => Promise<unknown>;
  readonly isDemo: (signal: AbortSignal | undefined) => Promise<boolean>;
  readonly listProposalReviews: (signal: AbortSignal | undefined) => Promise<unknown>;
  readonly searchMemory: (input: MemorySearchInput, signal: AbortSignal | undefined) => Promise<unknown>;
}

const isAbortError = (error: unknown, signal: AbortSignal | undefined): boolean =>
  signal?.aborted === true || (error instanceof DOMException && error.name === 'AbortError');

export const createMemoryRpcRouter = (dependencies: MemoryRpcDependencies) => {
  const memory = implement(memoryContract);
  return {
    applyProposalReviewAction: memory.applyProposalReviewAction.handler(async ({ errors, input, signal }) => {
      if (await dependencies.isDemo(signal)) {
        throw errors.ForbiddenDemo({
          data: { reason: 'demo-read-only' },
          message: 'Memory review is read-only in demo mode.',
        });
      }
      try {
        return parse(
          memoryProposalReviewActionResultSchema,
          await dependencies.applyProposalReviewAction(input, signal),
        );
      } catch (error) {
        signal?.throwIfAborted();
        if (isAbortError(error, signal)) {
          throw error;
        }
        if (error instanceof MemoryServiceClientError && error.code === 'forbidden') {
          throw errors.Forbidden({
            data: { reason: 'memory-review-forbidden' },
            message: 'This Memory proposal action is not permitted.',
          });
        }
        if (
          error instanceof MemoryServiceClientError &&
          (error.code === 'invalid-request' || error.code === 'request-too-large')
        ) {
          throw errors.InvalidInput({
            data: { reason: 'memory-review-invalid' },
            message: 'The Memory proposal action is invalid.',
          });
        }
        throw errors.Unavailable({
          data: { reason: 'memory-review-unavailable' },
          message: 'The Memory proposal action could not be applied.',
        });
      }
    }),
    proposalReviews: memory.proposalReviews.handler(async ({ errors, signal }) => {
      if (await dependencies.isDemo(signal)) {
        throw errors.ForbiddenDemo({
          data: { reason: 'demo-read-only' },
          message: 'Memory review is unavailable in demo mode.',
        });
      }
      try {
        return parse(memoryProposalReviewSnapshotSchema, await dependencies.listProposalReviews(signal));
      } catch (error) {
        signal?.throwIfAborted();
        if (isAbortError(error, signal)) {
          throw error;
        }
        throw errors.Unavailable({
          data: { reason: 'memory-review-unavailable' },
          message: 'Memory proposals could not be read safely.',
        });
      }
    }),
    search: memory.search.handler(async ({ errors, input, signal }) => {
      if (await dependencies.isDemo(signal)) {
        throw errors.ForbiddenDemo({
          data: { reason: 'demo-read-only' },
          message: 'Memory search is unavailable in demo mode.',
        });
      }
      try {
        return parse(memorySearchPageSchema, await dependencies.searchMemory(input, signal));
      } catch (error) {
        signal?.throwIfAborted();
        if (isAbortError(error, signal)) {
          throw error;
        }
        if (error instanceof MemoryServiceClientError && error.code === 'forbidden') {
          throw errors.Forbidden({
            data: { reason: 'memory-search-forbidden' },
            message: 'This Memory search is not permitted.',
          });
        }
        if (
          error instanceof MemoryServiceClientError &&
          (error.code === 'invalid-request' || error.code === 'request-too-large')
        ) {
          throw errors.InvalidInput({
            data: { reason: 'memory-search-invalid' },
            message: 'The Memory search is invalid.',
          });
        }
        throw errors.Unavailable({
          data: { reason: 'memory-search-unavailable' },
          message: 'Memory search is temporarily unavailable.',
        });
      }
    }),
  };
};

export type MemoryRpcRouter = ReturnType<typeof createMemoryRpcRouter>;
