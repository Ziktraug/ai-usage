import {
  parseWorkThreadCommand,
  type WorkThreadCommand,
  type WorkThreadCommandResult,
} from '@ai-usage/report-core/work-thread';
import type {
  WorkThreadDetailDataset,
  WorkThreadListDataset,
  WorkThreadListQuery,
} from '@ai-usage/report-core/work-thread-view';
import { queryWorkThreadDetail, queryWorkThreadList } from '@ai-usage/report-data/work-thread-read';
import { usageStoreErrorReasonFrom } from '@ai-usage/usage-store/reader';
import { Effect } from 'effect';
import type { RuntimeMode } from '../runtime-mode';
import { validateTrustedLocalRequest } from './local-request-trust.server';
import { getServerRuntimeMode } from './runtime-mode.server';
import { executeUsageEngineCommandToCompletion } from './usage-engine-command.server';
import { resolveUsageEngineControlClientForServer } from './usage-engine-control-resolver.server';
import { resolveUsageWebRuntimePaths } from './usage-runtime-paths.server';

/** The Web process reads projections and forwards commands; it never owns a live store writer. */
export interface WorkThreadServerPorts {
  readonly executeCommand: (command: WorkThreadCommand) => Promise<WorkThreadCommandResult>;
  readonly readDetail: (threadId: string) => Promise<WorkThreadDetailDataset | null>;
  readonly readList: (query: WorkThreadListQuery) => Promise<WorkThreadListDataset>;
}

export interface WorkThreadServerOptions {
  readonly mode?: RuntimeMode;
  readonly ports?: WorkThreadServerPorts;
  readonly signal?: AbortSignal;
}

export type WorkThreadReadResult<Data> =
  | { readonly data: Data; readonly ok: true }
  | { readonly error: { readonly message: string; readonly tag: 'Unavailable' | 'NotFound' }; readonly ok: false };

export class WorkThreadServiceUnavailableError extends Error {
  readonly tag = 'Unavailable';
}

const STORE_NOT_UPGRADED_MESSAGE =
  'The usage store has not been upgraded for this version yet; the engine upgrades it when it next starts.';

const readFromStore = async <Data>(operation: Effect.Effect<Data, unknown>): Promise<Data> => {
  const result = await Effect.runPromise(Effect.result(operation));
  if (result._tag === 'Success') {
    return result.success;
  }
  throw new WorkThreadServiceUnavailableError(
    usageStoreErrorReasonFrom(result.failure) === 'schema-too-old'
      ? STORE_NOT_UPGRADED_MESSAGE
      : 'Tasks could not be read from the usage store.',
  );
};

/**
 * Live mode reads threads through read-only connections and sends every change to the usage
 * engine, the store's only writer (ADR 0009). A refused change (stale revision, unknown thread)
 * is an answer of the engine, not an error; an engine that cannot be reached is.
 */
export const bindLiveWorkThreadPorts = (
  dbPath: string = resolveUsageWebRuntimePaths().databasePath,
  resolveControl: typeof resolveUsageEngineControlClientForServer = resolveUsageEngineControlClientForServer,
): WorkThreadServerPorts => ({
  executeCommand: async (command) => {
    const control = await resolveControl().catch(() => {
      throw new WorkThreadServiceUnavailableError('The usage engine is not running; the task was not changed.');
    });
    const completion = await executeUsageEngineCommandToCompletion(control, { command: 'work-thread', input: command });
    if (completion.state === 'succeeded' && completion.command === 'work-thread') {
      return completion.output.result;
    }
    throw new WorkThreadServiceUnavailableError(
      completion.state === 'failed' ? completion.error.message : 'The usage engine returned an unexpected answer.',
    );
  },
  readDetail: (threadId) => readFromStore(queryWorkThreadDetail({ dbPath, threadId })),
  readList: (query) => readFromStore(queryWorkThreadList({ dbPath, query })),
});

const portsFor = async (options: WorkThreadServerOptions): Promise<WorkThreadServerPorts> => {
  if (options.ports) {
    return options.ports;
  }
  const mode = options.mode ?? getServerRuntimeMode();
  if (mode === 'live') {
    return bindLiveWorkThreadPorts();
  }
  const fixture = await import('./work-threads-e2e-fixture.server');
  return fixture.getSyntheticWorkThreadPorts(mode);
};

const read = async <Data>(
  operation: (ports: WorkThreadServerPorts) => Promise<Data | null>,
  options: WorkThreadServerOptions,
): Promise<WorkThreadReadResult<Data>> => {
  options.signal?.throwIfAborted();
  try {
    const ports = await portsFor(options);
    options.signal?.throwIfAborted();
    const data = await operation(ports);
    options.signal?.throwIfAborted();
    return data === null
      ? { error: { message: 'This task could not be found.', tag: 'NotFound' }, ok: false }
      : { data, ok: true };
  } catch (error) {
    options.signal?.throwIfAborted();
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw error;
    }
    return {
      error: {
        message:
          error instanceof WorkThreadServiceUnavailableError ? error.message : 'Tasks could not be read. Try again.',
        tag: 'Unavailable',
      },
      ok: false,
    };
  }
};

export const readWorkThreadListForServer = (
  input: WorkThreadListQuery,
  options: WorkThreadServerOptions = {},
): Promise<WorkThreadReadResult<WorkThreadListDataset>> => read((ports) => ports.readList(input), options);

export const readWorkThreadDetailForServer = (
  input: { readonly threadId: string },
  options: WorkThreadServerOptions = {},
): Promise<WorkThreadReadResult<WorkThreadDetailDataset>> => read((ports) => ports.readDetail(input.threadId), options);

export const executeWorkThreadCommandForServer = async (
  input: WorkThreadCommand,
  options: WorkThreadServerOptions = {},
): Promise<WorkThreadCommandResult> => {
  options.signal?.throwIfAborted();
  const command = parseWorkThreadCommand(input);
  if (command === null) {
    throw new TypeError('The task command is invalid.');
  }
  const ports = await portsFor(options);
  options.signal?.throwIfAborted();
  const result = await ports.executeCommand(command);
  options.signal?.throwIfAborted();
  return result;
};

export const executeWorkThreadCommandFromRequestForServer = async (
  request: Request,
  input: WorkThreadCommand,
  options: WorkThreadServerOptions = {},
): Promise<WorkThreadCommandResult> => {
  const trustFailure = validateTrustedLocalRequest(request);
  if (trustFailure) {
    throw trustFailure;
  }
  return await executeWorkThreadCommandForServer(input, { ...options, signal: request.signal });
};
