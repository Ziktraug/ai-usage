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
type WorkThreadsReadFailure = Extract<WorkThreadsListOutput | WorkThreadsDetailOutput, { readonly ok: false }>;
const unavailable = (message: string): WorkThreadsReadFailure => ({
  ok: false,
  error: { tag: 'Unavailable', message },
});

// The reader answers its own typed failures; reaching a catch here means the reader itself broke,
// or its answer does not fit the contract, and the message says which.
const read = async <Output>(
  request: () => Promise<unknown>,
  parse: (value: unknown) => Output,
  signal: AbortSignal | undefined,
): Promise<Output | WorkThreadsReadFailure> => {
  let result: unknown;
  try {
    result = await request();
  } catch (error) {
    aborted(error, signal);
    return unavailable('The web server failed while reading tasks; retry, or restart it if this persists.');
  }
  try {
    return parse(result);
  } catch {
    return unavailable('The task data does not fit what this version can display.');
  }
};

export const createWorkThreadsRpcRouter = (dependencies: WorkThreadsRpcDependencies) => {
  const threads = implement(workThreadsContract);
  return {
    list: threads.list.handler(
      ({ input, signal }): Promise<WorkThreadsListOutput> =>
        read(() => dependencies.list(input, signal), parseWorkThreadsListOutput, signal),
    ),
    detail: threads.detail.handler(
      ({ input, signal }): Promise<WorkThreadsDetailOutput> =>
        read(() => dependencies.detail(input, signal), parseWorkThreadsDetailOutput, signal),
    ),
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
