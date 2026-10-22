import {
  type WorkAttentionInput,
  type WorkAttentionOutput,
  workAttentionOutputSchema,
  workContract,
} from '@ai-usage/web-contract/work';
import { implement } from '@orpc/server';
import { parse } from 'valibot';

export interface WorkRpcDependencies {
  /** Resolves the runtime mode and reads the dataset; returns the contract envelope or throws. */
  readonly readAttention: (input: WorkAttentionInput, signal: AbortSignal | undefined) => Promise<unknown>;
}

const isAbortError = (error: unknown, signal: AbortSignal | undefined): boolean =>
  signal?.aborted === true || (error instanceof DOMException && error.name === 'AbortError');

const unavailable: WorkAttentionOutput = {
  error: { message: 'Work attention is unavailable.', tag: 'Unavailable' },
  ok: false,
};

/**
 * `work.attention`: the envelope is the contract, so a dependency failure or a dataset the schema
 * refuses both answer `ok: false` rather than a transport error. Aborts still propagate.
 */
export const createWorkRpcRouter = (dependencies: WorkRpcDependencies) => {
  const work = implement(workContract);
  return {
    attention: work.attention.handler(async ({ input, signal }): Promise<WorkAttentionOutput> => {
      try {
        return parse(workAttentionOutputSchema, await dependencies.readAttention(input, signal));
      } catch (error) {
        signal?.throwIfAborted();
        if (isAbortError(error, signal)) {
          throw error;
        }
        return unavailable;
      }
    }),
  };
};

export type WorkRpcRouter = ReturnType<typeof createWorkRpcRouter>;
