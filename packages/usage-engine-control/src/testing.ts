import {
  type UsageEngineControlClient,
  UsageEngineControlError,
  type UsageEngineExecuteOptions,
  type UsageEngineRequestOptions,
} from './client';
import {
  parseUsageEngineCommand,
  parseUsageEngineCommandId,
  parseUsageEngineCommandResult,
  parseUsageEngineEvent,
  parseUsageEngineStatus,
  USAGE_ENGINE_PROTOCOL_VERSION,
  type UsageEngineCommand,
  type UsageEngineCommandResult,
  UsageEngineContractError,
  type UsageEngineEvent,
  type UsageEngineStatus,
} from './contracts';
import { stabilizeUsageEngineCommandResult, stabilizeUsageEngineEvent, stableUsageEngineErrorMessages } from './errors';

interface EventSubscriber {
  cleanup: () => void;
  closed: boolean;
  pending:
    | {
        readonly reject: (error: unknown) => void;
        readonly resolve: (result: IteratorResult<UsageEngineEvent>) => void;
      }
    | undefined;
  readonly queue: UsageEngineEvent[];
  terminalError: UsageEngineControlError | undefined;
}

export interface InMemoryUsageEngineControlOptions {
  readonly execute?: (command: UsageEngineCommand, commandId: string) => UsageEngineCommandResult;
  readonly maxQueuedEvents?: number;
  readonly status: unknown;
}

export interface InMemoryUsageEngineControlAdapter {
  readonly client: UsageEngineControlClient;
  readonly commands: readonly UsageEngineCommand[];
  readonly dispose: () => void;
  readonly publish: (event: unknown) => void;
  readonly setStatus: (status: unknown) => void;
}

const cloneJson = (value: unknown): unknown => JSON.parse(JSON.stringify(value)) as unknown;

const abortedError = (operation: 'events' | 'status' = 'status'): UsageEngineControlError =>
  new UsageEngineControlError('aborted', operation, 'Usage engine in-memory request was aborted.');

const assertNotAborted = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted) {
    throw abortedError();
  }
};

const closeSubscriber = (subscriber: EventSubscriber, error?: UsageEngineControlError): void => {
  if (subscriber.closed) {
    return;
  }
  subscriber.closed = true;
  subscriber.queue.length = 0;
  if (error === undefined) {
    subscriber.pending?.resolve({ done: true, value: undefined });
  } else if (subscriber.pending === undefined) {
    subscriber.terminalError = error;
  } else {
    subscriber.pending?.reject(error);
  }
  subscriber.pending = undefined;
  subscriber.cleanup();
};

const nextSubscriberEvent = (subscriber: EventSubscriber): Promise<IteratorResult<UsageEngineEvent>> => {
  const queued = subscriber.queue.shift();
  if (queued !== undefined) {
    return Promise.resolve({ done: false, value: queued });
  }
  if (subscriber.closed) {
    if (subscriber.terminalError !== undefined) {
      const error = subscriber.terminalError;
      subscriber.terminalError = undefined;
      return Promise.reject(error);
    }
    return Promise.resolve({ done: true, value: undefined });
  }
  return new Promise((resolve, reject) => {
    subscriber.pending = { reject, resolve };
  });
};

export const createInMemoryUsageEngineControlClient = (
  options: InMemoryUsageEngineControlOptions,
): InMemoryUsageEngineControlAdapter => {
  const maxQueuedEvents = options.maxQueuedEvents ?? 64;
  if (!(Number.isSafeInteger(maxQueuedEvents) && maxQueuedEvents >= 2 && maxQueuedEvents <= 1024)) {
    throw new Error('In-memory usage engine event queue limit is invalid.');
  }
  let status = parseUsageEngineStatus(cloneJson(options.status));
  let disposed = false;
  const commands: UsageEngineCommand[] = [];
  const subscribers = new Set<EventSubscriber>();

  const getStatus = (requestOptions: UsageEngineRequestOptions = {}): Promise<UsageEngineStatus> =>
    Promise.resolve().then(() => {
      assertNotAborted(requestOptions.signal);
      if (disposed) {
        throw new UsageEngineControlError('engine-unavailable', 'status', 'In-memory usage engine is disposed.');
      }
      return parseUsageEngineStatus(cloneJson(status));
    });

  const execute = (
    commandValue: UsageEngineCommand,
    executeOptions: UsageEngineExecuteOptions = {},
  ): Promise<UsageEngineCommandResult> =>
    Promise.resolve().then(() => {
      assertNotAborted(executeOptions.signal);
      if (disposed) {
        throw new UsageEngineControlError('engine-unavailable', 'command', 'In-memory usage engine is disposed.');
      }
      const command = parseUsageEngineCommand(cloneJson(commandValue));
      const commandId = parseUsageEngineCommandId(executeOptions.commandId ?? crypto.randomUUID());
      commands.push(command);
      let result: UsageEngineCommandResult;
      try {
        result =
          options.execute?.(command, commandId) ??
          ({
            admission: 'accepted',
            commandId,
            instanceId: status.instanceId,
            ok: true,
            protocolVersion: USAGE_ENGINE_PROTOCOL_VERSION,
          } as const);
      } catch {
        throw new UsageEngineControlError(
          'transport-failed',
          'command',
          stableUsageEngineErrorMessages['transport-failed'],
        );
      }
      let parsedResult: UsageEngineCommandResult;
      try {
        parsedResult = stabilizeUsageEngineCommandResult(parseUsageEngineCommandResult(cloneJson(result)));
      } catch (error) {
        if (error instanceof UsageEngineContractError && error.reason === 'protocol-mismatch') {
          throw new UsageEngineControlError(
            'protocol-mismatch',
            'command',
            stableUsageEngineErrorMessages['protocol-mismatch'],
          );
        }
        throw new UsageEngineControlError(
          'invalid-response',
          'command',
          stableUsageEngineErrorMessages['invalid-response'],
        );
      }
      if (parsedResult.commandId !== commandId || parsedResult.instanceId !== status.instanceId) {
        throw new UsageEngineControlError(
          'invalid-response',
          'command',
          'In-memory usage engine command response identity is invalid.',
        );
      }
      return parsedResult;
    });

  const changes = (requestOptions: UsageEngineRequestOptions = {}): AsyncIterable<UsageEngineEvent> => ({
    [Symbol.asyncIterator]: () => {
      assertNotAborted(requestOptions.signal);
      const subscriber: EventSubscriber = {
        cleanup: () => undefined,
        closed: disposed,
        pending: undefined,
        queue: [],
        terminalError: undefined,
      };
      if (!disposed) {
        subscriber.queue.push(
          parseUsageEngineEvent({
            event: 'status',
            eventId: `status:${status.generation}`,
            instanceId: status.instanceId,
            sequence: 0,
            status,
          }),
        );
        subscribers.add(subscriber);
      }
      const onAbort = (): void => closeSubscriber(subscriber, abortedError('events'));
      subscriber.cleanup = () => {
        requestOptions.signal?.removeEventListener('abort', onAbort);
        subscribers.delete(subscriber);
      };
      requestOptions.signal?.addEventListener('abort', onAbort, { once: true });
      return {
        next: () => nextSubscriberEvent(subscriber),
        return: () => {
          closeSubscriber(subscriber);
          return Promise.resolve({ done: true as const, value: undefined });
        },
      };
    },
  });

  const publish = (eventValue: unknown): void => {
    if (disposed) {
      throw new UsageEngineControlError('engine-unavailable', 'events', 'In-memory usage engine is disposed.');
    }
    const event = stabilizeUsageEngineEvent(parseUsageEngineEvent(cloneJson(eventValue)));
    if (event.instanceId !== status.instanceId) {
      throw new UsageEngineControlError(
        'invalid-response',
        'events',
        'In-memory usage engine event has an unexpected instance identity.',
      );
    }
    for (const subscriber of subscribers) {
      if (subscriber.closed) {
        continue;
      }
      if (subscriber.pending) {
        const { resolve } = subscriber.pending;
        subscriber.pending = undefined;
        resolve({ done: false, value: parseUsageEngineEvent(cloneJson(event)) });
      } else {
        if (subscriber.queue.length >= maxQueuedEvents) {
          const firstIncrementalIndex = subscriber.queue[0]?.event === 'status' ? 1 : 0;
          subscriber.queue.splice(firstIncrementalIndex, 1);
        }
        subscriber.queue.push(parseUsageEngineEvent(cloneJson(event)));
      }
    }
  };

  const setStatus = (nextStatus: unknown): void => {
    const parsedStatus = parseUsageEngineStatus(cloneJson(nextStatus));
    if (parsedStatus.instanceId !== status.instanceId) {
      throw new UsageEngineControlError(
        'invalid-response',
        'status',
        'In-memory usage engine status cannot rotate instance identity.',
      );
    }
    status = parsedStatus;
  };

  const dispose = (): void => {
    if (disposed) {
      return;
    }
    disposed = true;
    for (const subscriber of subscribers) {
      closeSubscriber(subscriber);
    }
    subscribers.clear();
  };

  return {
    client: { changes, execute, getStatus },
    commands,
    dispose,
    publish,
    setStatus,
  };
};
