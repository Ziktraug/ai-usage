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
import type { RuntimeMode } from '../runtime-mode';
import { validateTrustedLocalRequest } from './local-request-trust.server';
import { getServerRuntimeMode } from './runtime-mode.server';

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

/**
 * INTEGRATION BINDING: the supervisor binds readList/readDetail to report-data's read-only
 * queryWorkThreadList/queryWorkThreadDetail and executeCommand to the engine control command
 * { command: 'work-thread', input }. Those parallel implementations are deliberately not
 * imported here yet. An unbound live service is visibly unavailable, never synthetic or empty.
 */
export const bindLiveWorkThreadPorts = (): WorkThreadServerPorts => {
  const unavailable = (): Promise<never> =>
    Promise.reject(new WorkThreadServiceUnavailableError('Task storage is not connected in this build.'));
  return { executeCommand: unavailable, readDetail: unavailable, readList: unavailable };
};

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
