import { workRoutingContextSchema, workRoutingContract } from '@ai-usage/web-contract/work-routing';
import { implement } from '@orpc/server';
import { parse } from 'valibot';

export interface WorkRoutingRpcDependencies {
  readonly isDemo: (signal: AbortSignal | undefined) => Promise<boolean>;
  readonly readContext: (signal: AbortSignal | undefined) => Promise<unknown>;
}

const isAbortError = (error: unknown, signal: AbortSignal | undefined): boolean =>
  signal?.aborted === true || (error instanceof DOMException && error.name === 'AbortError');

export const createWorkRoutingRpcRouter = (dependencies: WorkRoutingRpcDependencies) => {
  const workRouting = implement(workRoutingContract);
  return {
    context: workRouting.context.handler(async ({ errors, signal }) => {
      if (await dependencies.isDemo(signal)) {
        throw errors.ForbiddenDemo({
          data: { reason: 'demo-read-only' },
          message: 'Review routing declarations are unavailable in demo mode.',
        });
      }
      try {
        return parse(workRoutingContextSchema, await dependencies.readContext(signal));
      } catch (error) {
        signal?.throwIfAborted();
        if (isAbortError(error, signal)) {
          throw error;
        }
        // Config and store problems stay server-side; paths and values never reach the browser.
        throw errors.Unavailable({
          data: { reason: 'work-routing-context-unavailable' },
          message: 'Review routing context could not be read safely.',
        });
      }
    }),
  };
};

export type WorkRoutingRpcRouter = ReturnType<typeof createWorkRoutingRpcRouter>;
