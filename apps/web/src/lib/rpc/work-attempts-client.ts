import {
  parseWorkAttemptsListOutput,
  parseWorkAttemptsStartOutput,
  type WorkAttemptsContractClient,
  type WorkAttemptsListInput,
  type WorkAttemptsListOutput,
  type WorkAttemptsStartInput,
  type WorkAttemptsStartOutput,
} from '@ai-usage/web-contract/work-attempts';
import { ORPCError } from '@orpc/client';

export type WorkAttemptsRpcTransport = Pick<WorkAttemptsContractClient, 'list' | 'start'>;

export interface WorkAttemptsClientCallOptions {
  readonly signal?: AbortSignal;
}

export interface WorkAttemptsClient {
  readonly list: (
    input: WorkAttemptsListInput,
    options?: WorkAttemptsClientCallOptions,
  ) => Promise<WorkAttemptsListOutput>;
  readonly start: (
    input: WorkAttemptsStartInput,
    options?: WorkAttemptsClientCallOptions,
  ) => Promise<WorkAttemptsStartOutput>;
}

const listFallback: WorkAttemptsListOutput = {
  error: { message: 'Review attempts are unavailable.', tag: 'Unavailable' },
  ok: false,
};
const startFallback: WorkAttemptsStartOutput = {
  error: { message: 'The review could not be started.', reason: null, tag: 'Unavailable' },
  ok: false,
};

const callOptions = (options: WorkAttemptsClientCallOptions) =>
  options.signal === undefined ? undefined : { signal: options.signal };

/**
 * The browser-side client: both answers are envelopes the Work view renders. A defined oRPC error
 * (demo boundary) keeps its tag; anything else is `Unavailable`; cancellation is re-thrown.
 */
export const createWorkAttemptsClient = (transport: WorkAttemptsRpcTransport): WorkAttemptsClient => ({
  list: async (input, options = {}) => {
    try {
      options.signal?.throwIfAborted();
      const result = await transport.list(input, callOptions(options));
      options.signal?.throwIfAborted();
      return parseWorkAttemptsListOutput(result);
    } catch (error) {
      options.signal?.throwIfAborted();
      if (error instanceof ORPCError && error.defined && error.code === 'ForbiddenDemo') {
        return { error: { message: error.message, tag: 'ForbiddenDemo' }, ok: false };
      }
      return listFallback;
    }
  },
  start: async (input, options = {}) => {
    try {
      options.signal?.throwIfAborted();
      const result = await transport.start(input, callOptions(options));
      options.signal?.throwIfAborted();
      return parseWorkAttemptsStartOutput(result);
    } catch (error) {
      options.signal?.throwIfAborted();
      if (error instanceof ORPCError && error.defined && error.code === 'ForbiddenDemo') {
        return { error: { message: error.message, reason: null, tag: 'ForbiddenDemo' }, ok: false };
      }
      return startFallback;
    }
  },
});
