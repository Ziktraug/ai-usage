import { MemoryServiceClientError } from '@ai-usage/memory-service/client';
import {
  type MemoryKnowledgeGetInput,
  type MemoryKnowledgeInput,
  type MemoryPromotionInput,
  type MemoryProposalReviewAction,
  type MemoryProposalReviewInput,
  type MemorySearchInput,
  memoryContract,
  memoryKnowledgeDetailSchema,
  memoryKnowledgePageSchema,
  memoryPromotionResultSchema,
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
  readonly getKnowledge: (input: MemoryKnowledgeGetInput, signal: AbortSignal | undefined) => Promise<unknown>;
  readonly isDemo: (signal: AbortSignal | undefined) => Promise<boolean>;
  readonly listKnowledge: (input: MemoryKnowledgeInput, signal: AbortSignal | undefined) => Promise<unknown>;
  readonly listProposalReviews: (
    signal: AbortSignal | undefined,
    position: MemoryProposalReviewInput,
  ) => Promise<unknown>;
  readonly promoteAnalysis: (input: MemoryPromotionInput, signal: AbortSignal | undefined) => Promise<unknown>;
  readonly searchMemory: (input: MemorySearchInput, signal: AbortSignal | undefined) => Promise<unknown>;
}

const isAbortError = (error: unknown, signal: AbortSignal | undefined): boolean =>
  signal?.aborted === true || (error instanceof DOMException && error.name === 'AbortError');

export const createMemoryRpcRouter = (dependencies: MemoryRpcDependencies) => {
  const memory = implement(memoryContract);
  return {
    getKnowledge: memory.getKnowledge.handler(async ({ errors, input, signal }) => {
      if (await dependencies.isDemo(signal)) {
        throw errors.ForbiddenDemo({
          data: { reason: 'demo-read-only' },
          message: 'Memory is unavailable in demo mode.',
        });
      }
      try {
        return parse(memoryKnowledgeDetailSchema, await dependencies.getKnowledge(input, signal));
      } catch (error) {
        signal?.throwIfAborted();
        if (isAbortError(error, signal)) {
          throw error;
        }
        throw errors.Unavailable({
          data: { reason: 'memory-revision-unavailable' },
          message: 'The selected accepted revision could not be read.',
        });
      }
    }),
    knowledge: memory.knowledge.handler(async ({ errors, input, signal }) => {
      if (await dependencies.isDemo(signal)) {
        throw errors.ForbiddenDemo({
          data: { reason: 'demo-read-only' },
          message: 'Memory is unavailable in demo mode.',
        });
      }
      try {
        return parse(memoryKnowledgePageSchema, await dependencies.listKnowledge(input, signal));
      } catch (error) {
        signal?.throwIfAborted();
        if (isAbortError(error, signal)) {
          throw error;
        }
        if (error instanceof MemoryServiceClientError && error.code === 'forbidden') {
          throw errors.Forbidden({
            data: { reason: 'memory-access-denied' },
            message: 'This Memory is not accessible.',
          });
        }
        throw errors.Unavailable({
          data: { reason: 'memory-service-unavailable' },
          message: 'Accepted Memory could not be read.',
        });
      }
    }),
    promote: memory.promote.handler(async ({ errors, input, signal }) => {
      if (await dependencies.isDemo(signal)) {
        throw errors.ForbiddenDemo({
          data: { reason: 'demo-read-only' },
          message: 'Proposals are unavailable in demo mode.',
        });
      }
      try {
        return parse(memoryPromotionResultSchema, await dependencies.promoteAnalysis(input, signal));
      } catch (error) {
        signal?.throwIfAborted();
        if (isAbortError(error, signal)) {
          throw error;
        }
        if (error instanceof MemoryServiceClientError && error.code === 'forbidden') {
          throw errors.Forbidden({
            data: { reason: 'memory-promotion-forbidden' },
            message: 'This analysis cannot be proposed as knowledge.',
          });
        }
        throw errors.Unavailable({
          data: { reason: 'memory-promotion-unavailable' },
          message: 'The proposal could not be saved. Its analysis remains unchanged.',
        });
      }
    }),
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
    proposalReviews: memory.proposalReviews.handler(async ({ errors, input, signal }) => {
      if (await dependencies.isDemo(signal)) {
        throw errors.ForbiddenDemo({
          data: { reason: 'demo-read-only' },
          message: 'Memory review is unavailable in demo mode.',
        });
      }
      try {
        return parse(memoryProposalReviewSnapshotSchema, await dependencies.listProposalReviews(signal, input));
      } catch (error) {
        signal?.throwIfAborted();
        if (isAbortError(error, signal)) {
          throw error;
        }
        if (error instanceof MemoryServiceClientError && error.code === 'not-found') {
          throw errors.Unavailable({
            data: { reason: 'not-found' },
            message: 'This Memory proposal is not pending review or is not accessible.',
          });
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
