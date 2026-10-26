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
/** Call once at the user gesture. Keep this object when retrying an uncertain response. */
export const createWorkThreadCommandAction = (input: WorkThreadCommandActionInput): WorkThreadsCommandInput => ({
  ...input,
  commandId: crypto.randomUUID(),
});

const aborted = (error: unknown, signal: AbortSignal | undefined) => {
  signal?.throwIfAborted();
  if (error instanceof DOMException && error.name === 'AbortError') {
    throw error;
  }
};
export const createWorkThreadsClient = (transport: WorkThreadsContractClient): WorkThreadsClient => ({
  list: async (input, options = {}) => {
    try {
      options.signal?.throwIfAborted();
      const result = await transport.list(input, options);
      options.signal?.throwIfAborted();
      return parseWorkThreadsListOutput(result);
    } catch (error) {
      aborted(error, options.signal);
      return { ok: false, error: { tag: 'Unavailable', message: 'Tasks are unavailable.' } };
    }
  },
  detail: async (input, options = {}) => {
    try {
      options.signal?.throwIfAborted();
      const result = await transport.detail(input, options);
      options.signal?.throwIfAborted();
      return parseWorkThreadsDetailOutput(result);
    } catch (error) {
      aborted(error, options.signal);
      return { ok: false, error: { tag: 'Unavailable', message: 'This task is unavailable.' } };
    }
  },
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
