import { randomUUID } from 'node:crypto';
import {
  parseUsageEngineCommandId,
  type UsageEngineCommand,
  type UsageEngineCommandCompletion,
  type UsageEngineErrorCode,
} from '@ai-usage/usage-engine-control';
import type { UsageEngineControlClient } from '@ai-usage/usage-engine-control/client';
import { USAGE_STORE_SCHEMA_VERSION } from '@ai-usage/usage-store/reader';

const DEFAULT_COMPLETION_TIMEOUT_MS = 5 * 60_000;
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
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

const completionFailure = (code: UsageEngineErrorCode, message: string): UsageEngineCommandCompletionError =>
  new UsageEngineCommandCompletionError(code, message);

export const executeUsageEngineCommandToCompletion = async (
  control: UsageEngineControlClient,
  command: UsageEngineCommand,
  options: ExecuteUsageEngineCommandOptions = {},
): Promise<UsageEngineCommandCompletion> => {
  const commandId = parseUsageEngineCommandId(options.commandId ?? randomUUID());
  const timeoutMs = options.timeoutMs ?? DEFAULT_COMPLETION_TIMEOUT_MS;
  if (!(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= DEFAULT_COMPLETION_TIMEOUT_MS)) {
    throw new Error('Usage engine command completion timeout is invalid.');
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

  try {
    const initialEvent = await iterator.next();
    if (initialEvent.done) {
      throw completionFailure('engine-unavailable', 'The usage engine event stream ended before its status.');
    }
    if (initialEvent.value.event !== 'status') {
      throw completionFailure('invalid-response', 'The usage engine event stream did not begin with status.');
    }
    const initialStatus = initialEvent.value.status;
    if (initialStatus.readiness !== 'ready' || initialStatus.storeSchemaVersion !== USAGE_STORE_SCHEMA_VERSION) {
      throw completionFailure(
        initialStatus.storeSchemaVersion !== null && initialStatus.storeSchemaVersion !== USAGE_STORE_SCHEMA_VERSION
          ? 'protocol-mismatch'
          : 'engine-unavailable',
        'The usage engine is not ready for mutations.',
      );
    }
    nextEvent = iterator.next();
    const admission = await control.execute(command, { commandId, signal: controller.signal });
    if (!admission.ok) {
      throw completionFailure(admission.error.code, admission.error.message);
    }
    if (admission.instanceId !== initialStatus.instanceId) {
      throw completionFailure('invalid-response', 'The usage engine instance changed during command admission.');
    }

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
      if (event.completion.command !== command.command) {
        throw completionFailure('invalid-response', 'Usage engine command completion kind is invalid.');
      }
      if (event.completion.state === 'failed') {
        throw completionFailure(event.completion.error.code, event.completion.error.message);
      }
      return event.completion;
    }
    throw completionFailure('invalid-response', 'Usage engine emitted too many unrelated events.');
  } catch (error) {
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
