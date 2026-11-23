import type { WorkThreadTaskCommand } from '@ai-usage/report-core/work-thread';
import {
  parseWorkThreadsCommandOutput,
  parseWorkThreadsDetailOutput,
  parseWorkThreadsListOutput,
  type WorkThreadsCommandInput,
  type WorkThreadsCommandOutput,
  type WorkThreadsContractClient,
  type WorkThreadsDetailInput,
  type WorkThreadsDetailOutput,
  type WorkThreadsListInput,
  type WorkThreadsListOutput,
} from '@ai-usage/web-contract/work-threads';
import { ORPCError } from '@orpc/client';

export interface WorkThreadsClientCallOptions {
  readonly signal?: AbortSignal;
}
export interface WorkThreadsClient {
  readonly command: (
    input: WorkThreadsCommandInput,
    options?: WorkThreadsClientCallOptions,
  ) => Promise<WorkThreadsCommandOutput>;
  readonly detail: (
    input: WorkThreadsDetailInput,
    options?: WorkThreadsClientCallOptions,
  ) => Promise<WorkThreadsDetailOutput>;
  readonly list: (
    input: WorkThreadsListInput,
    options?: WorkThreadsClientCallOptions,
  ) => Promise<WorkThreadsListOutput>;
}
export class WorkThreadsUnavailableError extends Error {
  readonly tag = 'Unavailable';
  constructor() {
    super('The task command could not be recorded. Retry this action to check its outcome.');
    this.name = 'WorkThreadsUnavailableError';
  }
}
type WithoutCommandId<T> = T extends { readonly commandId: string } ? Omit<T, 'commandId'> : never;
export type WorkThreadCommandActionInput = WithoutCommandId<WorkThreadsCommandInput>;
export type WorkThreadTaskCommandActionInput = WithoutCommandId<WorkThreadTaskCommand>;
/** Call once at the user gesture. Keep this object when retrying an uncertain response. */
export const createWorkThreadCommandAction = <Input extends WorkThreadCommandActionInput>(
  input: Input,
): Input & { readonly commandId: string } => ({
  ...input,
  commandId: crypto.randomUUID(),
});

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

// Each failure says what broke: the server is gone, it answered an error, or this page predates its answer.
const transportFailure = (error: unknown): WorkThreadsReadFailure => {
  if (error instanceof ORPCError) {
    return unavailable(
      error.defined
        ? error.message
        : `The web server answered with an error (HTTP ${error.status}). Its output names the cause.`,
    );
  }
  return unavailable('The web server could not be reached; it may have stopped. Restart it, then retry.');
};

const read = async <Output>(
  request: () => Promise<unknown>,
  parse: (value: unknown) => Output,
  signal: AbortSignal | undefined,
): Promise<Output | WorkThreadsReadFailure> => {
  let result: unknown;
  try {
    signal?.throwIfAborted();
    result = await request();
    signal?.throwIfAborted();
  } catch (error) {
    aborted(error, signal);
    return transportFailure(error);
  }
  try {
    return parse(result);
  } catch {
    return unavailable('The web server answered in a shape this page does not read; reload the page.');
  }
};

export const createWorkThreadsClient = (transport: WorkThreadsContractClient): WorkThreadsClient => ({
  list: (input, options = {}) => read(() => transport.list(input, options), parseWorkThreadsListOutput, options.signal),
  detail: (input, options = {}) =>
    read(() => transport.detail(input, options), parseWorkThreadsDetailOutput, options.signal),
  command: async (input, options = {}) => {
    try {
      options.signal?.throwIfAborted();
      const result = await transport.command(input, options);
      options.signal?.throwIfAborted();
      return parseWorkThreadsCommandOutput(result);
    } catch (error) {
      aborted(error, options.signal);
      throw new WorkThreadsUnavailableError();
    }
  },
});
