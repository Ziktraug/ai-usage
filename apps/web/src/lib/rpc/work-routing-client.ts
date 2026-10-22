import {
  parseWorkRoutingContext,
  parseWorkRoutingQualifyOutput,
  type WorkRoutingContext,
  type WorkRoutingContractClient,
  type WorkRoutingQualifyInput,
  type WorkRoutingQualifyOutput,
} from '@ai-usage/web-contract/work-routing';
import { ORPCError } from '@orpc/client';

export type WorkRoutingRpcTransport = Pick<WorkRoutingContractClient, 'context'>;

export interface WorkRoutingClientCallOptions {
  readonly signal?: AbortSignal;
}

/**
 * The browser-side result: a failure is data the Work view renders ("routing context unavailable"
 * with its tag), not an exception that would hide the quota-only candidates behind an error state.
 */
export type WorkRoutingClientResult =
  | { readonly data: WorkRoutingContext; readonly ok: true }
  | { readonly error: { readonly message: string; readonly tag: string }; readonly ok: false };

export interface WorkRoutingClient {
  readonly getContext: (options?: WorkRoutingClientCallOptions) => Promise<WorkRoutingClientResult>;
}

const fallbackError = { message: 'Review routing context is unavailable.', tag: 'Unavailable' } as const;

export const createWorkRoutingClient = (transport: WorkRoutingRpcTransport): WorkRoutingClient => ({
  getContext: async (options = {}) => {
    try {
      options.signal?.throwIfAborted();
      const result = await transport.context({}, options.signal === undefined ? undefined : { signal: options.signal });
      options.signal?.throwIfAborted();
      return { data: parseWorkRoutingContext(result), ok: true };
    } catch (error) {
      options.signal?.throwIfAborted();
      if (error instanceof ORPCError && error.defined) {
        return { error: { message: error.message, tag: error.code }, ok: false };
      }
      return { error: fallbackError, ok: false };
    }
  },
});

export type WorkRoutingQualifyTransport = Pick<WorkRoutingContractClient, 'qualify'>;

export interface WorkRoutingQualifyClient {
  readonly qualify: (
    input: WorkRoutingQualifyInput,
    options?: WorkRoutingClientCallOptions,
  ) => Promise<WorkRoutingQualifyOutput>;
}

const qualifyFallback: WorkRoutingQualifyOutput = {
  error: { message: 'The routing could not be qualified.', tag: 'Unavailable' },
  ok: false,
};

/**
 * `workRouting.qualify` from the browser (ADR 0057): the answer is an envelope the Work view
 * renders; a defined demo error keeps its tag, anything else is `Unavailable`, cancellation is
 * re-thrown. Nothing is cached here: each call is one fresh engine qualification.
 */
export const createWorkRoutingQualifyClient = (transport: WorkRoutingQualifyTransport): WorkRoutingQualifyClient => ({
  qualify: async (input, options = {}) => {
    try {
      options.signal?.throwIfAborted();
      const result = await transport.qualify(
        input,
        options.signal === undefined ? undefined : { signal: options.signal },
      );
      options.signal?.throwIfAborted();
      return parseWorkRoutingQualifyOutput(result);
    } catch (error) {
      options.signal?.throwIfAborted();
      if (error instanceof ORPCError && error.defined && error.code === 'ForbiddenDemo') {
        return { error: { message: error.message, tag: 'ForbiddenDemo' }, ok: false };
      }
      return qualifyFallback;
    }
  },
});
