import {
  type WorkRoutingQualifyInput,
  type WorkRoutingQualifyOutput,
  workRoutingContextSchema,
  workRoutingContract,
  workRoutingQualifyOutputSchema,
} from '@ai-usage/web-contract/work-routing';
import { implement } from '@orpc/server';
import { parse } from 'valibot';

export interface WorkRoutingRpcDependencies {
  readonly isDemo: (signal: AbortSignal | undefined) => Promise<boolean>;
  /** Forwards one `qualify-review-routing` engine command (ADR 0057); returns the envelope or throws. */
  readonly qualify: (input: WorkRoutingQualifyInput, signal: AbortSignal | undefined) => Promise<unknown>;
  readonly readContext: (signal: AbortSignal | undefined) => Promise<unknown>;
}

const isAbortError = (error: unknown, signal: AbortSignal | undefined): boolean =>
  signal?.aborted === true || (error instanceof DOMException && error.name === 'AbortError');

const qualifyUnavailable: WorkRoutingQualifyOutput = {
  error: { message: 'The routing could not be qualified.', tag: 'Unavailable' },
  ok: false,
};

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
    // The envelope is the contract: an engine failure or an answer the schema refuses both become
    // `ok: false` rather than a transport error. Aborts still propagate.
    qualify: workRouting.qualify.handler(async ({ input, signal }): Promise<WorkRoutingQualifyOutput> => {
      try {
        return parse(workRoutingQualifyOutputSchema, await dependencies.qualify(input, signal));
      } catch (error) {
        signal?.throwIfAborted();
        if (isAbortError(error, signal)) {
          throw error;
        }
        return qualifyUnavailable;
      }
    }),
  };
};

export type WorkRoutingRpcRouter = ReturnType<typeof createWorkRoutingRpcRouter>;
