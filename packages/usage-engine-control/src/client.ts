import {
  classifyUsageEngineRetry,
  parseUsageEngineCommand,
  parseUsageEngineCommandId,
  parseUsageEngineCommandRequest,
  parseUsageEngineCommandResult,
  parseUsageEngineErrorResponse,
  parseUsageEngineEvent,
  parseUsageEngineStatus,
  USAGE_ENGINE_PROTOCOL_VERSION,
  type UsageEngineCommand,
  type UsageEngineCommandId,
  type UsageEngineCommandResult,
  UsageEngineContractError,
  type UsageEngineErrorCode,
  type UsageEngineEvent,
  type UsageEngineRetryDisposition,
  type UsageEngineRetryOperation,
  type UsageEngineStatus,
  usageEngineControlBounds,
} from './contracts';
import { stabilizeUsageEngineCommandResult, stabilizeUsageEngineEvent, stableUsageEngineErrorMessages } from './errors';
import { type UsageEngineRendezvous, UsageEngineRendezvousError, usageEngineLoopbackOrigin } from './rendezvous';
import { revealUsageEngineBearerToken } from './secret';

export interface UsageEngineRequestOptions {
  readonly signal?: AbortSignal;
}

export interface UsageEngineExecuteOptions extends UsageEngineRequestOptions {
  readonly commandId?: UsageEngineCommandId;
}

export interface UsageEngineControlClient {
  readonly changes: (options?: UsageEngineRequestOptions) => AsyncIterable<UsageEngineEvent>;
  readonly execute: (
    command: UsageEngineCommand,
    options?: UsageEngineExecuteOptions,
  ) => Promise<UsageEngineCommandResult>;
  readonly getStatus: (options?: UsageEngineRequestOptions) => Promise<UsageEngineStatus>;
}

export type UsageEngineFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface UsageEngineControlClientOptions {
  readonly commandId?: () => string;
  readonly eventIdleTimeoutMs?: number;
  readonly fetch?: UsageEngineFetch;
  readonly reconnectDelayMs?: number;
  readonly requestTimeoutMs?: number;
  readonly resolveRendezvous: (signal?: AbortSignal) => Promise<UsageEngineRendezvous>;
  readonly wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

export class UsageEngineControlError extends Error {
  override readonly name = 'UsageEngineControlError';
  readonly code: UsageEngineErrorCode;
  readonly retry: UsageEngineRetryDisposition;

  constructor(code: UsageEngineErrorCode, operation: UsageEngineRetryOperation, message: string) {
    super(message);
    this.code = code;
    this.retry = classifyUsageEngineRetry(code, operation);
  }
}

const defaultRequestTimeoutMs = 15_000;
const defaultEventIdleTimeoutMs = 15_000;
const defaultReconnectDelayMs = 250;
const maximumReconnectDelayMs = 60_000;
const maximumRequestTimeoutMs = 5 * 60_000;
const jsonMediaType = 'application/json';
const eventStreamMediaType = 'text/event-stream';
const protocolHeader = 'x-ai-usage-protocol-version';
const encoder = new TextEncoder();

const isAbortError = (error: unknown): boolean =>
  error instanceof DOMException ? error.name === 'AbortError' : error instanceof Error && error.name === 'AbortError';

const controlError = (
  code: UsageEngineErrorCode,
  operation: UsageEngineRetryOperation,
  message: string,
): UsageEngineControlError => new UsageEngineControlError(code, operation, message);

const mapContractResponseFailure = (
  error: unknown,
  operation: UsageEngineRetryOperation,
  invalidMessage: string,
): never => {
  if (error instanceof UsageEngineContractError && error.reason === 'protocol-mismatch') {
    throw controlError('protocol-mismatch', operation, stableUsageEngineErrorMessages['protocol-mismatch']);
  }
  throw controlError('invalid-response', operation, invalidMessage);
};

interface LinkedSignal {
  readonly cleanup: () => void;
  readonly clearTimeout: () => void;
  readonly signal: AbortSignal;
  readonly timedOut: () => boolean;
}

const createLinkedSignal = (
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
  operation: UsageEngineRetryOperation,
): LinkedSignal => {
  if (callerSignal?.aborted) {
    throw controlError('aborted', operation, 'Usage engine request was aborted.');
  }
  if (!(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= maximumRequestTimeoutMs)) {
    throw controlError('invalid-response', operation, 'Usage engine request timeout is invalid.');
  }
  const controller = new AbortController();
  let timeoutTriggered = false;
  const onCallerAbort = (): void => controller.abort(new DOMException('Request aborted', 'AbortError'));
  callerSignal?.addEventListener('abort', onCallerAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
    timeoutTriggered = true;
    controller.abort(new DOMException('Request timed out', 'TimeoutError'));
  }, timeoutMs);
  const clearRequestTimeout = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
  return {
    cleanup: () => {
      clearRequestTimeout();
      callerSignal?.removeEventListener('abort', onCallerAbort);
    },
    clearTimeout: clearRequestTimeout,
    signal: controller.signal,
    timedOut: () => timeoutTriggered,
  };
};

const responseMediaType = (response: Response): string =>
  (response.headers.get('content-type') ?? '').split(';', 1)[0]?.trim().toLowerCase() ?? '';

const cancelReaderWithoutWaiting = (reader: ReadableStreamDefaultReader<Uint8Array>): void => {
  try {
    reader.cancel().catch(() => undefined);
  } catch {
    // A hostile or already-released reader cannot make request cleanup fail.
  }
};

const releaseReaderLock = (reader: ReadableStreamDefaultReader<Uint8Array>): void => {
  try {
    reader.releaseLock();
  } catch {
    // A pending non-cooperative read keeps the lock until it settles.
  }
};

const readBoundedResponseBytes = async (
  response: Response,
  maximumBytes: number,
  operation: UsageEngineRetryOperation,
  signal: AbortSignal,
): Promise<Uint8Array> => {
  const contentLengthText = response.headers.get('content-length');
  if (contentLengthText !== null) {
    const contentLength = Number(contentLengthText);
    if (!(Number.isSafeInteger(contentLength) && contentLength >= 0)) {
      throw controlError('invalid-response', operation, 'Usage engine response Content-Length is invalid.');
    }
    if (contentLength > maximumBytes) {
      throw controlError('response-too-large', operation, 'Usage engine response exceeds its byte limit.');
    }
  }
  if (response.body === null) {
    return new Uint8Array();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let completed = false;
  try {
    while (true) {
      const { done, value } = await awaitWithAbort(reader.read(), signal);
      if (done) {
        completed = true;
        break;
      }
      total += value.byteLength;
      if (total > maximumBytes) {
        throw controlError('response-too-large', operation, 'Usage engine response exceeds its byte limit.');
      }
      chunks.push(value);
    }
  } finally {
    if (!completed) {
      cancelReaderWithoutWaiting(reader);
    }
    releaseReaderLock(reader);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};

const decodeJson = (bytes: Uint8Array, operation: UsageEngineRetryOperation): unknown => {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw controlError('invalid-response', operation, 'Usage engine response is not valid UTF-8.');
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw controlError('invalid-response', operation, 'Usage engine response is not valid JSON.');
  }
};

const headersFor = (rendezvous: UsageEngineRendezvous, token: string): Headers =>
  new Headers({
    accept: jsonMediaType,
    authorization: `Bearer ${token}`,
    [protocolHeader]: String(rendezvous.protocolVersion),
  });

const mapHttpFailure = async (
  response: Response,
  operation: UsageEngineRetryOperation,
  signal: AbortSignal,
): Promise<never> => {
  if (response.status === 401 || response.status === 403) {
    throw controlError('authentication-failed', operation, stableUsageEngineErrorMessages['authentication-failed']);
  }
  if (response.status === 409 || response.status === 429 || response.status === 503) {
    throw controlError('engine-busy', operation, stableUsageEngineErrorMessages['engine-busy']);
  }
  if (response.status === 413) {
    throw controlError('request-too-large', operation, stableUsageEngineErrorMessages['request-too-large']);
  }
  if (response.status === 426) {
    throw controlError('protocol-mismatch', operation, stableUsageEngineErrorMessages['protocol-mismatch']);
  }
  if (responseMediaType(response) === jsonMediaType) {
    try {
      const errorValue = decodeJson(
        await readBoundedResponseBytes(response, usageEngineControlBounds.maxErrorResponseBytes, operation, signal),
        operation,
      );
      const parsed = parseUsageEngineErrorResponse(errorValue);
      throw controlError(parsed.error.code, operation, stableUsageEngineErrorMessages[parsed.error.code]);
    } catch (error) {
      if (error instanceof UsageEngineControlError) {
        throw error;
      }
      return mapContractResponseFailure(error, operation, 'Usage engine error response is invalid.');
    }
  }
  throw controlError('engine-unavailable', operation, 'Usage engine request failed.');
};

interface RequestContext {
  readonly operation: UsageEngineRetryOperation;
  readonly rendezvous: UsageEngineRendezvous;
  readonly secret: string;
  readonly signal: LinkedSignal;
}

const awaitWithAbort = async <Value>(promise: Promise<Value>, signal: AbortSignal): Promise<Value> => {
  if (signal.aborted) {
    throw signal.reason;
  }
  return await new Promise<Value>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
};

const requestContext = async (
  options: UsageEngineControlClientOptions,
  operation: UsageEngineRetryOperation,
  callerSignal: AbortSignal | undefined,
): Promise<RequestContext> => {
  if (callerSignal?.aborted) {
    throw controlError('aborted', operation, 'Usage engine request was aborted.');
  }
  const signal = createLinkedSignal(callerSignal, options.requestTimeoutMs ?? defaultRequestTimeoutMs, operation);
  try {
    const rendezvous = await awaitWithAbort(options.resolveRendezvous(signal.signal), signal.signal);
    return {
      operation,
      rendezvous,
      secret: revealUsageEngineBearerToken(rendezvous.token),
      signal,
    };
  } catch (error) {
    signal.cleanup();
    if (signal.timedOut()) {
      throw controlError('timeout', operation, 'Usage engine rendezvous resolution timed out.');
    }
    if (signal.signal.aborted || isAbortError(error)) {
      throw controlError('aborted', operation, 'Usage engine rendezvous resolution was aborted.');
    }
    if (error instanceof UsageEngineRendezvousError && error.reason === 'protocol-mismatch') {
      throw controlError('protocol-mismatch', operation, stableUsageEngineErrorMessages['protocol-mismatch']);
    }
    throw controlError('engine-unavailable', operation, stableUsageEngineErrorMessages['engine-unavailable']);
  }
};

const mapTransportFailure = (error: unknown, context: RequestContext): never => {
  if (error instanceof UsageEngineControlError) {
    throw error;
  }
  if (context.signal.timedOut()) {
    throw controlError('timeout', context.operation, 'Usage engine request timed out.');
  }
  if (context.signal.signal.aborted || isAbortError(error)) {
    throw controlError('aborted', context.operation, 'Usage engine request was aborted.');
  }
  throw controlError('transport-failed', context.operation, stableUsageEngineErrorMessages['transport-failed']);
};

const requestJson = async (
  options: UsageEngineControlClientOptions,
  path: '/v1/commands' | '/v1/status',
  operation: 'command' | 'status',
  init: { readonly body?: string; readonly method: 'GET' | 'POST'; readonly signal?: AbortSignal },
  maximumResponseBytes: number,
): Promise<{ readonly rendezvous: UsageEngineRendezvous; readonly value: unknown }> => {
  const context = await requestContext(options, operation, init.signal);
  const fetchImplementation: UsageEngineFetch = options.fetch ?? globalThis.fetch;
  try {
    const headers = headersFor(context.rendezvous, context.secret);
    if (init.body !== undefined) {
      headers.set('content-type', jsonMediaType);
    }
    const response = await awaitWithAbort(
      fetchImplementation(`${usageEngineLoopbackOrigin(context.rendezvous)}${path}`, {
        ...(init.body === undefined ? {} : { body: init.body }),
        headers,
        method: init.method,
        redirect: 'error',
        signal: context.signal.signal,
      }),
      context.signal.signal,
    );
    if (response.redirected) {
      throw controlError('invalid-response', operation, 'Usage engine responses must not redirect.');
    }
    if (!response.ok) {
      return await mapHttpFailure(response, operation, context.signal.signal);
    }
    if (responseMediaType(response) !== jsonMediaType) {
      throw controlError('invalid-response', operation, 'Usage engine response has the wrong media type.');
    }
    return {
      rendezvous: context.rendezvous,
      value: decodeJson(
        await readBoundedResponseBytes(response, maximumResponseBytes, operation, context.signal.signal),
        operation,
      ),
    };
  } catch (error) {
    return mapTransportFailure(error, context);
  } finally {
    context.signal.cleanup();
  }
};

interface SseFrame {
  readonly data: string;
  readonly event: string;
  readonly id: string;
}

const readStreamChunk = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
  idleTimeoutMs: number,
) => {
  if (signal.aborted) {
    throw signal.reason;
  }
  const idleController = new AbortController();
  let idleTimeoutTriggered = false;
  const onAbort = (): void => idleController.abort(signal.reason);
  signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => {
    idleTimeoutTriggered = true;
    idleController.abort(new DOMException('Event stream idle timeout', 'TimeoutError'));
  }, idleTimeoutMs);
  try {
    return await awaitWithAbort(reader.read(), idleController.signal);
  } catch (error) {
    if (idleTimeoutTriggered) {
      throw controlError('timeout', 'events', 'Usage engine event stream became idle.');
    }
    if (signal.aborted) {
      throw signal.reason;
    }
    throw error;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
};

const parseSseFrames = async function* (
  response: Response,
  signal: AbortSignal,
  idleTimeoutMs: number,
): AsyncGenerator<SseFrame> {
  if (response.body === null) {
    throw controlError('invalid-response', 'events', 'Usage engine event stream has no body.');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  let dataLines: string[] = [];
  let eventName = '';
  let eventId = '';
  let completed = false;

  const consumeLine = (line: string): SseFrame | undefined => {
    if (line.length === 0) {
      if (dataLines.length === 0) {
        eventName = '';
        eventId = '';
        return;
      }
      const frame = { data: dataLines.join('\n'), event: eventName, id: eventId };
      dataLines = [];
      eventName = '';
      eventId = '';
      return frame;
    }
    if (line.startsWith(':')) {
      return;
    }
    const separator = line.indexOf(':');
    const field = separator === -1 ? line : line.slice(0, separator);
    const rawValue = separator === -1 ? '' : line.slice(separator + 1);
    const fieldValue = rawValue.startsWith(' ') ? rawValue.slice(1) : rawValue;
    if (field === 'data') {
      dataLines.push(fieldValue);
    } else if (field === 'event') {
      eventName = fieldValue;
    } else if (field === 'id') {
      eventId = fieldValue;
    } else {
      throw controlError('invalid-response', 'events', 'Usage engine event stream contains an unknown field.');
    }
    const frameBytes = encoder.encode(`${eventName}\n${eventId}\n${dataLines.join('\n')}`).byteLength;
    if (frameBytes > usageEngineControlBounds.maxStatusEventBytes) {
      throw controlError('response-too-large', 'events', 'Usage engine event frame exceeds its byte limit.');
    }
  };

  try {
    while (true) {
      if (signal.aborted) {
        throw controlError('aborted', 'events', 'Usage engine event stream was aborted.');
      }
      const { done, value } = await readStreamChunk(reader, signal, idleTimeoutMs);
      if (done) {
        completed = true;
        break;
      }
      try {
        buffer += decoder.decode(value, { stream: true });
      } catch {
        throw controlError('invalid-response', 'events', 'Usage engine event stream is not valid UTF-8.');
      }
      if (encoder.encode(buffer).byteLength > usageEngineControlBounds.maxStatusEventBytes * 2) {
        throw controlError('response-too-large', 'events', 'Usage engine event stream line exceeds its byte limit.');
      }
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const rawLine = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const frame = consumeLine(rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine);
        if (frame) {
          yield frame;
        }
        newline = buffer.indexOf('\n');
      }
    }
    try {
      buffer += decoder.decode();
    } catch {
      throw controlError('invalid-response', 'events', 'Usage engine event stream is not valid UTF-8.');
    }
  } finally {
    if (!completed) {
      cancelReaderWithoutWaiting(reader);
    }
    releaseReaderLock(reader);
  }
};

const defaultWait = async (milliseconds: number, signal: AbortSignal): Promise<void> => {
  if (signal.aborted) {
    throw controlError('aborted', 'events', 'Usage engine event reconnect was aborted.');
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(controlError('aborted', 'events', 'Usage engine event reconnect was aborted.'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
};

const waitForReconnect = async (
  wait: (milliseconds: number, signal: AbortSignal) => Promise<void>,
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> => {
  try {
    await awaitWithAbort(wait(milliseconds, signal), signal);
  } catch (error) {
    if (error instanceof UsageEngineControlError) {
      throw error;
    }
    if (signal.aborted || isAbortError(error)) {
      throw controlError('aborted', 'events', 'Usage engine event reconnect was aborted.');
    }
    throw controlError('transport-failed', 'events', stableUsageEngineErrorMessages['transport-failed']);
  }
};

const openEventStream = async function* (
  options: UsageEngineControlClientOptions,
  callerSignal: AbortSignal | undefined,
  expectedInstanceId: string,
  minimumStatusGeneration: number,
  lastEventId: string | undefined,
  eventIdleTimeoutMs: number,
): AsyncGenerator<UsageEngineEvent> {
  const context = await requestContext(options, 'events', callerSignal);
  const fetchImplementation: UsageEngineFetch = options.fetch ?? globalThis.fetch;
  try {
    const headers = headersFor(context.rendezvous, context.secret);
    headers.set('accept', eventStreamMediaType);
    if (lastEventId !== undefined) {
      headers.set('last-event-id', lastEventId);
    }
    if (context.rendezvous.instanceId !== expectedInstanceId) {
      throw controlError('engine-unavailable', 'events', 'Usage engine instance changed before event connection.');
    }
    const response = await awaitWithAbort(
      fetchImplementation(`${usageEngineLoopbackOrigin(context.rendezvous)}/v1/events`, {
        headers,
        method: 'GET',
        redirect: 'error',
        signal: context.signal.signal,
      }),
      context.signal.signal,
    );
    if (response.redirected) {
      throw controlError('invalid-response', 'events', 'Usage engine event responses must not redirect.');
    }
    if (!response.ok) {
      return await mapHttpFailure(response, 'events', context.signal.signal);
    }
    if (responseMediaType(response) !== eventStreamMediaType) {
      throw controlError('invalid-response', 'events', 'Usage engine event stream has the wrong media type.');
    }
    let receivedAuthoritativeStatus = false;
    for await (const frame of parseSseFrames(response, context.signal.signal, eventIdleTimeoutMs)) {
      if (frame.event !== 'usage-engine' || frame.id.length === 0) {
        throw controlError('invalid-response', 'events', 'Usage engine event frame metadata is invalid.');
      }
      let rawEvent: unknown;
      try {
        rawEvent = JSON.parse(frame.data) as unknown;
      } catch {
        throw controlError('invalid-response', 'events', 'Usage engine event data is not valid JSON.');
      }
      let event: UsageEngineEvent;
      try {
        event = stabilizeUsageEngineEvent(parseUsageEngineEvent(rawEvent));
      } catch (error) {
        return mapContractResponseFailure(error, 'events', 'Usage engine event payload is invalid.');
      }
      if (event.eventId !== frame.id) {
        throw controlError('invalid-response', 'events', 'Usage engine SSE and payload event IDs differ.');
      }
      if (!receivedAuthoritativeStatus) {
        if (event.event !== 'status') {
          throw controlError(
            'invalid-response',
            'events',
            'Usage engine event stream must begin with an authoritative status.',
          );
        }
        receivedAuthoritativeStatus = true;
        if (event.status.generation < minimumStatusGeneration) {
          throw controlError('invalid-response', 'events', 'Usage engine event stream began with a stale status.');
        }
        context.signal.clearTimeout();
      }
      yield event;
    }
    if (!receivedAuthoritativeStatus) {
      throw controlError('invalid-response', 'events', 'Usage engine event stream ended before its status snapshot.');
    }
  } catch (error) {
    return mapTransportFailure(error, context);
  } finally {
    context.signal.cleanup();
  }
};

export const createUsageEngineControlClient = (options: UsageEngineControlClientOptions): UsageEngineControlClient => {
  const reconnectDelayMs = options.reconnectDelayMs ?? defaultReconnectDelayMs;
  const eventIdleTimeoutMs = options.eventIdleTimeoutMs ?? defaultEventIdleTimeoutMs;
  if (
    !(Number.isSafeInteger(reconnectDelayMs) && reconnectDelayMs >= 0 && reconnectDelayMs <= maximumReconnectDelayMs)
  ) {
    throw controlError('invalid-response', 'events', 'Usage engine reconnect delay is invalid.');
  }
  if (
    !(
      Number.isSafeInteger(eventIdleTimeoutMs) &&
      eventIdleTimeoutMs > 0 &&
      eventIdleTimeoutMs <= maximumRequestTimeoutMs
    )
  ) {
    throw controlError('invalid-response', 'events', 'Usage engine event idle timeout is invalid.');
  }

  const getStatus = async (requestOptions: UsageEngineRequestOptions = {}): Promise<UsageEngineStatus> => {
    const response = await requestJson(
      options,
      '/v1/status',
      'status',
      { method: 'GET', ...(requestOptions.signal === undefined ? {} : { signal: requestOptions.signal }) },
      usageEngineControlBounds.maxStatusBytes,
    );
    let status: UsageEngineStatus;
    try {
      status = parseUsageEngineStatus(response.value);
    } catch (error) {
      return mapContractResponseFailure(error, 'status', 'Usage engine status response is invalid.');
    }
    if (status.instanceId !== response.rendezvous.instanceId) {
      throw controlError('invalid-response', 'status', 'Usage engine status and rendezvous identities differ.');
    }
    return status;
  };

  const execute = async (
    commandValue: UsageEngineCommand,
    executeOptions: UsageEngineExecuteOptions = {},
  ): Promise<UsageEngineCommandResult> => {
    const command = parseUsageEngineCommand(commandValue);
    const commandId = parseUsageEngineCommandId(
      executeOptions.commandId ?? options.commandId?.() ?? crypto.randomUUID(),
    );
    const request = parseUsageEngineCommandRequest({
      command,
      commandId,
      protocolVersion: USAGE_ENGINE_PROTOCOL_VERSION,
    });
    const body = JSON.stringify(request);
    if (encoder.encode(body).byteLength > usageEngineControlBounds.maxCommandBytes) {
      throw controlError('request-too-large', 'command', 'Usage engine command request exceeds its byte limit.');
    }
    const response = await requestJson(
      options,
      '/v1/commands',
      'command',
      { body, method: 'POST', ...(executeOptions.signal === undefined ? {} : { signal: executeOptions.signal }) },
      usageEngineControlBounds.maxCommandResultBytes,
    );
    let result: UsageEngineCommandResult;
    try {
      result = parseUsageEngineCommandResult(response.value);
    } catch (error) {
      return mapContractResponseFailure(error, 'command', 'Usage engine command response is invalid.');
    }
    if (result.instanceId !== response.rendezvous.instanceId || result.commandId !== commandId) {
      throw controlError('invalid-response', 'command', 'Usage engine command response identity is invalid.');
    }
    return stabilizeUsageEngineCommandResult(result);
  };

  const changes = async function* (requestOptions: UsageEngineRequestOptions = {}): AsyncGenerator<UsageEngineEvent> {
    let instanceId: string | undefined;
    let lastSequence = -1;
    let lastEventId: string | undefined;
    const wait = options.wait ?? defaultWait;
    while (true) {
      if (requestOptions.signal?.aborted) {
        throw controlError('aborted', 'events', 'Usage engine event stream was aborted.');
      }
      let status: UsageEngineStatus;
      try {
        status = await getStatus(requestOptions);
      } catch (error) {
        if (!(error instanceof UsageEngineControlError && error.retry === 'safe-request')) {
          throw error;
        }
        const reconnectSignal = requestOptions.signal ?? new AbortController().signal;
        await waitForReconnect(wait, reconnectDelayMs, reconnectSignal);
        continue;
      }
      if (instanceId !== status.instanceId) {
        instanceId = status.instanceId;
        lastSequence = -1;
        lastEventId = undefined;
      }

      try {
        for await (const event of openEventStream(
          options,
          requestOptions.signal,
          instanceId,
          status.generation,
          lastEventId,
          eventIdleTimeoutMs,
        )) {
          if (event.instanceId !== instanceId) {
            throw controlError('invalid-response', 'events', 'Usage engine event has an unexpected instance identity.');
          }
          if (event.event === 'status') {
            yield event;
            continue;
          }
          if (event.sequence <= lastSequence) {
            continue;
          }
          lastSequence = event.sequence;
          lastEventId = event.eventId;
          yield event;
        }
      } catch (error) {
        if (!(error instanceof UsageEngineControlError && error.retry === 'reconnect')) {
          throw error;
        }
      }

      const reconnectSignal = requestOptions.signal ?? new AbortController().signal;
      await waitForReconnect(wait, reconnectDelayMs, reconnectSignal);
    }
  };

  return { changes, execute, getStatus };
};
