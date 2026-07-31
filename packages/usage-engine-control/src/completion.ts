import { randomUUID } from 'node:crypto';
import type { UsageEngineControlClient } from './client';
import {
  parseUsageEngineCommandId,
  type UsageEngineCommand,
  type UsageEngineCommandCompletion,
  type UsageEngineErrorCode,
  type UsageEngineStatus,
} from './contracts';

const DEFAULT_COMPLETION_TIMEOUT_MS = 5 * 60_000;
const BEST_EFFORT_CANCELLATION_TIMEOUT_MS = 1000;
const MAX_IGNORED_EVENTS = 512;

export class UsageEngineCommandCompletionError extends Error {
  readonly code: UsageEngineErrorCode;
  override readonly name = 'UsageEngineCommandCompletionError';

  constructor(code: UsageEngineErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface ExecuteUsageEngineCommandOptions {
  readonly commandId?: string;
  readonly expectedStoreSchemaVersion: number;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

const completionFailure = (code: UsageEngineErrorCode, message: string): UsageEngineCommandCompletionError =>
  new UsageEngineCommandCompletionError(code, message);

const assertReadyStatus = (status: UsageEngineStatus, expectedStoreSchemaVersion: number): void => {
  if (status.storeSchemaVersion !== null && status.storeSchemaVersion !== expectedStoreSchemaVersion) {
    throw completionFailure('protocol-mismatch', 'The usage engine store schema is incompatible.');
  }
  if (status.readiness !== 'ready') {
    throw completionFailure('engine-unavailable', 'The usage engine is not ready for mutations.');
  }
};

export const executeUsageEngineCommandToCompletion = async (
  control: UsageEngineControlClient,
  command: UsageEngineCommand,
  options: ExecuteUsageEngineCommandOptions,
): Promise<UsageEngineCommandCompletion> => {
  const commandId = parseUsageEngineCommandId(options.commandId ?? randomUUID());
  const timeoutMs = options.timeoutMs ?? DEFAULT_COMPLETION_TIMEOUT_MS;
  if (
    !(
      Number.isSafeInteger(options.expectedStoreSchemaVersion) &&
      options.expectedStoreSchemaVersion > 0 &&
      Number.isSafeInteger(timeoutMs) &&
      timeoutMs > 0 &&
      timeoutMs <= DEFAULT_COMPLETION_TIMEOUT_MS
    )
  ) {
    throw new Error('Usage engine command completion options are invalid.');
  }
  if (options.signal?.aborted) {
    throw completionFailure('aborted', 'Usage engine command was cancelled.');
  }

  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = (): void => controller.abort(new DOMException('Command cancelled', 'AbortError'));
  options.signal?.addEventListener('abort', abortFromCaller, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException('Command completion timed out', 'TimeoutError'));
  }, timeoutMs);
  const iterator = control.changes({ signal: controller.signal })[Symbol.asyncIterator]();
  let nextEvent: ReturnType<typeof iterator.next> | undefined;
  let admissionAttempted = false;
  let terminalObserved = false;

  try {
    const initialEvent = await iterator.next();
    if (initialEvent.done) {
      throw completionFailure('engine-unavailable', 'The usage engine event stream ended before its status.');
    }
    if (initialEvent.value.event !== 'status') {
      throw completionFailure('invalid-response', 'The usage engine event stream did not begin with status.');
    }
    const initialStatus = initialEvent.value.status;
    assertReadyStatus(initialStatus, options.expectedStoreSchemaVersion);
    nextEvent = iterator.next();
    admissionAttempted = true;
    const admission = await control.execute(command, { commandId, signal: controller.signal });
    if (!admission.ok) {
      terminalObserved = true;
      throw completionFailure(admission.error.code, admission.error.message);
    }
    if (admission.instanceId !== initialStatus.instanceId) {
      throw completionFailure('invalid-response', 'The usage engine instance changed during command admission.');
    }

    let completion: UsageEngineCommandCompletion | undefined;
    for (let ignoredEvents = 0; ignoredEvents <= MAX_IGNORED_EVENTS; ignoredEvents++) {
      const eventResult = await nextEvent;
      if (eventResult.done) {
        throw completionFailure('engine-unavailable', 'The usage engine event stream ended before completion.');
      }
      nextEvent = iterator.next();
      const event = eventResult.value;
      if (event.instanceId !== admission.instanceId) {
        throw completionFailure('invalid-response', 'The usage engine instance changed before command completion.');
      }
      if (event.event !== 'command-completed' || event.completion.commandId !== commandId) {
        continue;
      }
      terminalObserved = true;
      if (event.completion.command !== command.command) {
        throw completionFailure('invalid-response', 'Usage engine command completion kind is invalid.');
      }
      if (event.completion.state === 'failed') {
        throw completionFailure(event.completion.error.code, event.completion.error.message);
      }
      completion = event.completion;
      break;
    }
    if (!completion) {
      throw completionFailure('invalid-response', 'Usage engine emitted too many unrelated events.');
    }
    return completion;
  } catch (error) {
    if (admissionAttempted && !terminalObserved) {
      const cancellationController = new AbortController();
      let cancellationTimeout: ReturnType<typeof setTimeout> | undefined;
      const cancellation = Promise.resolve()
        .then(async () => {
          await control.cancelCommand(commandId, { signal: cancellationController.signal });
        })
        .catch(() => undefined);
      try {
        await Promise.race([
          cancellation,
          new Promise<void>((resolve) => {
            cancellationTimeout = setTimeout(() => {
              cancellationController.abort(new DOMException('Cancellation timed out', 'TimeoutError'));
              resolve();
            }, BEST_EFFORT_CANCELLATION_TIMEOUT_MS);
          }),
        ]);
      } finally {
        cancellationController.abort(new DOMException('Cancellation settled', 'AbortError'));
        if (cancellationTimeout !== undefined) {
          clearTimeout(cancellationTimeout);
        }
      }
    }
    if (error instanceof UsageEngineCommandCompletionError) {
      throw error;
    }
    if (timedOut) {
      throw completionFailure('timeout', 'Usage engine command completion timed out.');
    }
    if (options.signal?.aborted || controller.signal.aborted) {
      throw completionFailure('aborted', 'Usage engine command was cancelled.');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', abortFromCaller);
    controller.abort();
    try {
      await iterator.return?.();
    } catch {
      // The linked abort already owns event-stream cleanup.
    }
    nextEvent?.catch(() => undefined);
  }
};
