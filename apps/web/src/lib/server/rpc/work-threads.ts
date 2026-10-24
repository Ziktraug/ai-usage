import {
  parseWorkThreadsCommandOutput,
  parseWorkThreadsDetailOutput,
  parseWorkThreadsListOutput,
  type WorkThreadsCommandInput,
  type WorkThreadsCommandOutput,
  type WorkThreadsDetailInput,
  type WorkThreadsDetailOutput,
  type WorkThreadsListInput,
  type WorkThreadsListOutput,
  workThreadsContract,
} from '@ai-usage/web-contract/work-threads';
import { implement, ORPCError } from '@orpc/server';

export interface WorkThreadsRpcDependencies {
  readonly command: (input: WorkThreadsCommandInput, signal: AbortSignal | undefined) => Promise<unknown>;
  readonly detail: (input: WorkThreadsDetailInput, signal: AbortSignal | undefined) => Promise<unknown>;
  readonly list: (input: WorkThreadsListInput, signal: AbortSignal | undefined) => Promise<unknown>;
}
const aborted = (error: unknown, signal: AbortSignal | undefined) => {
  signal?.throwIfAborted();
  if (error instanceof DOMException && error.name === 'AbortError') {
    throw error;
  }
};
export const createWorkThreadsRpcRouter = (dependencies: WorkThreadsRpcDependencies) => {
  const threads = implement(workThreadsContract);
  return {
    list: threads.list.handler(async ({ input, signal }): Promise<WorkThreadsListOutput> => {
      try {
        return parseWorkThreadsListOutput(await dependencies.list(input, signal));
      } catch (error) {
        aborted(error, signal);
        return { ok: false, error: { tag: 'Unavailable', message: 'Tasks are unavailable.' } };
      }
    }),
    detail: threads.detail.handler(async ({ input, signal }): Promise<WorkThreadsDetailOutput> => {
      try {
        return parseWorkThreadsDetailOutput(await dependencies.detail(input, signal));
      } catch (error) {
        aborted(error, signal);
        return { ok: false, error: { tag: 'Unavailable', message: 'This task is unavailable.' } };
      }
    }),
    command: threads.command.handler(async ({ input, signal }): Promise<WorkThreadsCommandOutput> => {
      try {
        return parseWorkThreadsCommandOutput(await dependencies.command(input, signal));
      } catch (error) {
        aborted(error, signal);
        throw new ORPCError('Unavailable', { status: 503, message: 'The task command could not be recorded.' });
      }
    }),
  };
};
