import {
  parseWorkRoutingContext,
  type WorkRoutingContext,
  type WorkRoutingContractClient,
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
