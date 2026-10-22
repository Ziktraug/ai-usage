import {
  type WorkAttemptsListInput,
  type WorkAttemptsListOutput,
  type WorkAttemptsReleaseInput,
  type WorkAttemptsReleaseOutput,
  type WorkAttemptsStartInput,
  type WorkAttemptsStartOutput,
  type WorkAttemptsStopInput,
  type WorkAttemptsStopOutput,
  workAttemptsContract,
  workAttemptsListOutputSchema,
  workAttemptsReleaseOutputSchema,
  workAttemptsStartOutputSchema,
  workAttemptsStopOutputSchema,
} from '@ai-usage/web-contract/work-attempts';
import { implement } from '@orpc/server';
import { parse } from 'valibot';

export interface WorkAttemptsRpcDependencies {
  /** Resolves the runtime mode and reads the attempts; returns the contract envelope or throws. */
  readonly list: (input: WorkAttemptsListInput, signal: AbortSignal | undefined) => Promise<unknown>;
  /** Forwards the operator's release of a held reservation; returns the contract envelope or throws. */
  readonly release: (input: WorkAttemptsReleaseInput, signal: AbortSignal | undefined) => Promise<unknown>;
  /** Forwards the engine command; returns the contract envelope or throws. */
  readonly start: (input: WorkAttemptsStartInput, signal: AbortSignal | undefined) => Promise<unknown>;
  readonly stop: (input: WorkAttemptsStopInput, signal: AbortSignal | undefined) => Promise<unknown>;
}

const isAbortError = (error: unknown, signal: AbortSignal | undefined): boolean =>
  signal?.aborted === true || (error instanceof DOMException && error.name === 'AbortError');

const listUnavailable: WorkAttemptsListOutput = {
  error: { message: 'Review attempts are unavailable.', tag: 'Unavailable' },
  ok: false,
};
const releaseUnavailable: WorkAttemptsReleaseOutput = {
  error: { message: 'The release could not be recorded.', tag: 'Unavailable' },
  ok: false,
};
const stopUnavailable: WorkAttemptsStopOutput = {
  error: { message: 'The stop request did not complete.', tag: 'Unavailable' },
  ok: false,
};
const startUnavailable: WorkAttemptsStartOutput = {
  error: { message: 'The review could not be started.', reason: null, tag: 'Unavailable' },
  ok: false,
};

/**
 * `workAttempts.list` and `workAttempts.start`: the envelope is the contract, so a dependency
 * failure or an answer the schema refuses both become `ok: false` rather than a transport error.
 * Aborts still propagate. Nothing here decides anything; the engine does.
 */
export const createWorkAttemptsRpcRouter = (dependencies: WorkAttemptsRpcDependencies) => {
  const workAttempts = implement(workAttemptsContract);
  return {
    stop: workAttempts.stop.handler(async ({ input, signal }): Promise<WorkAttemptsStopOutput> => {
      try {
        return parse(workAttemptsStopOutputSchema, await dependencies.stop(input, signal));
      } catch (error) {
        signal?.throwIfAborted();
        if (isAbortError(error, signal)) {
          throw error;
        }
        return stopUnavailable;
      }
    }),
    list: workAttempts.list.handler(async ({ input, signal }): Promise<WorkAttemptsListOutput> => {
      try {
        return parse(workAttemptsListOutputSchema, await dependencies.list(input, signal));
      } catch (error) {
        signal?.throwIfAborted();
        if (isAbortError(error, signal)) {
          throw error;
        }
        return listUnavailable;
      }
    }),
    release: workAttempts.release.handler(async ({ input, signal }): Promise<WorkAttemptsReleaseOutput> => {
      try {
        return parse(workAttemptsReleaseOutputSchema, await dependencies.release(input, signal));
      } catch (error) {
        signal?.throwIfAborted();
        if (isAbortError(error, signal)) {
          throw error;
        }
        return releaseUnavailable;
      }
    }),
    start: workAttempts.start.handler(async ({ input, signal }): Promise<WorkAttemptsStartOutput> => {
      try {
        return parse(workAttemptsStartOutputSchema, await dependencies.start(input, signal));
      } catch (error) {
        signal?.throwIfAborted();
        if (isAbortError(error, signal)) {
          throw error;
        }
        return startUnavailable;
      }
    }),
  };
};

export type WorkAttemptsRpcRouter = ReturnType<typeof createWorkAttemptsRpcRouter>;
