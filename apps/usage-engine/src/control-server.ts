import { timingSafeEqual } from 'node:crypto';
import {
  parseUsageEngineCommandCancellationResult,
  parseUsageEngineCommandId,
  parseUsageEngineCommandRequest,
  parseUsageEngineCommandResult,
  parseUsageEngineEvent,
  parseUsageEngineStatus,
  USAGE_ENGINE_PROTOCOL_VERSION,
  type UsageEngineErrorCode,
  type UsageEngineEvent,
  type UsageEngineStatus,
  usageEngineControlBounds,
} from '@ai-usage/usage-engine-control';
import { revealUsageEngineBearerToken, type UsageEngineBearerToken } from '@ai-usage/usage-engine-control/node';
import type { UsageEngineRuntimeHost } from '@ai-usage/usage-engine-runtime';

const JSON_MEDIA_TYPE = 'application/json';
const EVENT_STREAM_MEDIA_TYPE = 'text/event-stream';
const PROTOCOL_HEADER = 'x-ai-usage-protocol-version';
const SSE_HEARTBEAT_MS = 5000;
const REPLAY_EVENT_ID_PATTERN = /^(?:engine|snapshot):(\d+)$/;
const COMMAND_CANCELLATION_PATH_PATTERN = /^\/v1\/commands\/([^/]+)$/;
const encoder = new TextEncoder();

export const usageEngineControlServerBounds = {
  maxReplayEvents: 128,
  requestTimeoutMs: 5000,
  maxSubscriberFrames: 129,
  maxSubscribers: 64,
} as const;

interface EventSubscriber {
  readonly close: () => void;
  readonly emit: (event: UsageEngineEvent) => void;
}

export type UsageEngineInternalFailureBoundary =
  | 'command-cancellation'
  | 'command-execution'
  | 'event-stream'
  | 'event-stream-cleanup'
  | 'event-stream-status'
  | 'status';

export interface UsageEngineControlHandler {
  readonly dispose: () => Promise<void>;
  readonly handle: (request: Request, peerAddress: string | null) => Promise<Response>;
}

export interface CreateUsageEngineControlHandlerOptions {
  readonly clearHeartbeat?: (heartbeat: ReturnType<typeof setInterval>) => void;
  readonly reportInternalFailure?: (boundary: UsageEngineInternalFailureBoundary) => void;
  readonly requestTimeoutMs?: number;
  readonly runtime: UsageEngineRuntimeHost;
  readonly scheduleHeartbeat?: (callback: () => void, milliseconds: number) => ReturnType<typeof setInterval>;
  readonly token: UsageEngineBearerToken;
}

export interface StartUsageEngineControlServerOptions extends CreateUsageEngineControlHandlerOptions {
  readonly hostname?: string;
  readonly port?: number;
}

export interface UsageEngineControlServer {
  readonly dispose: () => Promise<void>;
  readonly hostname: '127.0.0.1';
  readonly port: number;
}

const jsonResponse = (value: unknown, status = 200): Response => {
  const body = JSON.stringify(value);
  return new Response(body, {
    headers: {
      'cache-control': 'no-store',
      'content-length': String(encoder.encode(body).byteLength),
      'content-type': JSON_MEDIA_TYPE,
    },
    status,
  });
};

const errorResponse = (code: UsageEngineErrorCode, message: string, status: number, instanceId?: string): Response =>
  jsonResponse(
    {
      error: { code, message },
      ...(instanceId === undefined ? {} : { instanceId }),
      ok: false,
      protocolVersion: USAGE_ENGINE_PROTOCOL_VERSION,
    },
    status,
  );

const unauthorized = (): Response => errorResponse('authentication-failed', 'Usage engine authentication failed.', 401);

const forbidden = (): Response =>
  errorResponse('authentication-failed', 'Usage engine request origin is not permitted.', 403);

const tokenMatches = (authorization: string | null, expected: string): boolean => {
  if (!authorization?.startsWith('Bearer ')) {
    return false;
  }
  const supplied = authorization.slice('Bearer '.length);
  const suppliedBytes = encoder.encode(supplied);
  const expectedBytes = encoder.encode(expected);
  return suppliedBytes.byteLength === expectedBytes.byteLength && timingSafeEqual(suppliedBytes, expectedBytes);
};

const responseMediaType = (value: string | null): string => (value ?? '').split(';', 1)[0]?.trim().toLowerCase() ?? '';

type RequestBoundaryErrorCode = Extract<UsageEngineErrorCode, 'aborted' | 'timeout'>;

class RequestBoundaryError extends Error {
  readonly code: RequestBoundaryErrorCode;

  constructor(code: RequestBoundaryErrorCode) {
    super(code === 'aborted' ? 'request-aborted' : 'request-timeout');
    this.code = code;
  }
}

interface RequestDeadline {
  readonly run: <Value>(operation: () => Promise<Value>) => Promise<Value>;
}

const createRequestDeadline = (request: Request, timeoutMs: number): RequestDeadline => {
  const deadlineAt = Date.now() + timeoutMs;
  return {
    run: async <Value>(operation: () => Promise<Value>): Promise<Value> => {
      if (request.signal.aborted) {
        throw new RequestBoundaryError('aborted');
      }
      const remainingMs = deadlineAt - Date.now();
      if (remainingMs <= 0) {
        throw new RequestBoundaryError('timeout');
      }
      return await new Promise<Value>((resolve, reject) => {
        let settled = false;
        const finish = (complete: () => void): void => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timeout);
          request.signal.removeEventListener('abort', onAbort);
          complete();
        };
        const onAbort = (): void => finish(() => reject(new RequestBoundaryError('aborted')));
        const timeout = setTimeout(() => finish(() => reject(new RequestBoundaryError('timeout'))), remainingMs);
        request.signal.addEventListener('abort', onAbort, { once: true });
        if (request.signal.aborted) {
          onAbort();
          return;
        }
        try {
          operation().then(
            (value) => finish(() => resolve(value)),
            (error: unknown) => finish(() => reject(error)),
          );
        } catch (error) {
          finish(() => reject(error));
        }
      });
    },
  };
};

const requestBoundaryResponse = (error: unknown): Response | undefined => {
  if (!(error instanceof RequestBoundaryError)) {
    return;
  }
  return error.code === 'aborted'
    ? errorResponse('aborted', 'Usage engine request was aborted.', 408)
    : errorResponse('timeout', 'Usage engine request timed out.', 408);
};

const readBoundedBody = async (request: Request, deadline: RequestDeadline): Promise<Uint8Array> => {
  const contentLengthValue = request.headers.get('content-length');
  if (contentLengthValue !== null) {
    const contentLength = Number(contentLengthValue);
    if (!(Number.isSafeInteger(contentLength) && contentLength >= 0)) {
      throw new Error('invalid-content-length');
    }
    if (contentLength > usageEngineControlBounds.maxCommandBytes) {
      throw new Error('request-too-large');
    }
  }
  if (request.body === null) {
    return new Uint8Array();
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let completed = false;
  try {
    while (true) {
      const { done, value } = await deadline.run(async () => await reader.read());
      if (done) {
        completed = true;
        break;
      }
      total += value.byteLength;
      if (total > usageEngineControlBounds.maxCommandBytes) {
        throw new Error('request-too-large');
      }
      chunks.push(value);
    }
  } finally {
    if (!completed) {
      reader.cancel().catch(() => {
        // Cancellation is best-effort after the request boundary has already failed.
      });
    }
    try {
      reader.releaseLock();
    } catch {
      // A non-cooperative body may retain its pending read after cancellation.
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};

const parseBodyJson = (bytes: Uint8Array): unknown => {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  return JSON.parse(text) as unknown;
};

const sseFrame = (event: UsageEngineEvent): Uint8Array =>
  encoder.encode(`id: ${event.eventId}\nevent: usage-engine\ndata: ${JSON.stringify(event)}\n\n`);

const lastSeenSequence = (
  lastEventId: string | null,
  snapshotBoundarySequence: number,
  eventBuffer: readonly UsageEngineEvent[],
): number => {
  if (lastEventId === null) {
    return 0;
  }
  const exact = eventBuffer.find((event) => event.eventId === lastEventId);
  if (exact) {
    return Math.min(exact.sequence, snapshotBoundarySequence);
  }
  const match = REPLAY_EVENT_ID_PATTERN.exec(lastEventId);
  const parsed = Number(match?.[1]);
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= snapshotBoundarySequence
    ? parsed
    : snapshotBoundarySequence;
};

export const createUsageEngineControlHandler = ({
  clearHeartbeat = clearInterval,
  requestTimeoutMs = usageEngineControlServerBounds.requestTimeoutMs,
  reportInternalFailure: reportInternalFailureOption,
  runtime,
  scheduleHeartbeat = setInterval,
  token,
}: CreateUsageEngineControlHandlerOptions): UsageEngineControlHandler => {
  if (!(Number.isSafeInteger(requestTimeoutMs) && requestTimeoutMs > 0)) {
    throw new Error('Usage engine control request timeout is invalid.');
  }
  const expectedToken = revealUsageEngineBearerToken(token);
  const eventBuffer: UsageEngineEvent[] = [];
  const subscribers = new Set<EventSubscriber>();
  const runtimeIterator = runtime.changes()[Symbol.asyncIterator]();
  let disposed = false;
  let disposalPromise: Promise<void> | undefined;
  let eventPumpState: 'disposed' | 'failed' | 'running' = 'running';

  const reportInternalFailure = (boundary: UsageEngineInternalFailureBoundary): void => {
    try {
      reportInternalFailureOption?.(boundary);
    } catch {
      // Diagnostics must not change the control-plane response or lifecycle.
    }
  };

  const publish = (eventValue: UsageEngineEvent): void => {
    const event = parseUsageEngineEvent(eventValue);
    eventBuffer.push(event);
    if (eventBuffer.length > usageEngineControlServerBounds.maxReplayEvents) {
      eventBuffer.shift();
    }
    for (const subscriber of subscribers) {
      subscriber.emit(event);
    }
  };

  const failEventPump = (): void => {
    if (eventPumpState !== 'running') {
      return;
    }
    eventPumpState = 'failed';
    eventBuffer.length = 0;
    for (const subscriber of [...subscribers]) {
      subscriber.close();
    }
    reportInternalFailure('event-stream');
  };

  const eventPump = (async () => {
    try {
      while (!disposed) {
        const next = await runtimeIterator.next();
        if (next.done) {
          if (!disposed) {
            failEventPump();
          }
          return;
        }
        publish(next.value);
      }
    } catch {
      if (!disposed) {
        failEventPump();
      }
    }
  })();

  const authorize = (request: Request, peerAddress: string | null): Response | undefined => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return forbidden();
    }
    if (peerAddress !== '127.0.0.1' || url.protocol !== 'http:' || url.hostname !== '127.0.0.1') {
      return forbidden();
    }
    if (request.headers.get(PROTOCOL_HEADER) !== String(USAGE_ENGINE_PROTOCOL_VERSION)) {
      return errorResponse('protocol-mismatch', 'Usage engine protocol version mismatch.', 426);
    }
    if (!tokenMatches(request.headers.get('authorization'), expectedToken)) {
      return unauthorized();
    }
  };

  const createEventStream = async (request: Request, deadline: RequestDeadline): Promise<Response> => {
    if (subscribers.size >= usageEngineControlServerBounds.maxSubscribers) {
      return errorResponse('engine-busy', 'Usage engine event subscriber capacity is full.', 503);
    }
    const replayEvents = eventBuffer.slice();
    const snapshotBoundarySequence = replayEvents.at(-1)?.sequence ?? 0;
    const pending: UsageEngineEvent[] = [];
    let pendingOverflow = false;
    let deliver = (event: UsageEngineEvent): void => {
      if (pending.length >= usageEngineControlServerBounds.maxSubscriberFrames) {
        pendingOverflow = true;
        return;
      }
      pending.push(event);
    };
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    let closed = false;
    const subscriber: EventSubscriber = {
      close: () => {
        if (closed) {
          return;
        }
        closed = true;
        if (heartbeat !== undefined) {
          clearHeartbeat(heartbeat);
        }
        subscribers.delete(subscriber);
        try {
          controller?.close();
        } catch {
          // The transport may have already cancelled the stream.
        }
      },
      emit: (event) => deliver(event),
    };
    subscribers.add(subscriber);
    let status: UsageEngineStatus;
    try {
      status = parseUsageEngineStatus(await deadline.run(runtime.status));
    } catch (cause) {
      subscribers.delete(subscriber);
      closed = true;
      throw cause;
    }
    const statusEvent = parseUsageEngineEvent({
      event: 'status',
      eventId: `snapshot:${snapshotBoundarySequence}`,
      instanceId: status.instanceId,
      sequence: 0,
      status,
    });
    const stream = new ReadableStream<Uint8Array>(
      {
        cancel: () => subscriber.close(),
        start: (streamController) => {
          controller = streamController;
          let latestSequence = -1;
          const enqueueFrame = (frame: Uint8Array): boolean => {
            if (closed || (streamController.desiredSize ?? 0) <= 0) {
              subscriber.close();
              return false;
            }
            try {
              streamController.enqueue(frame);
              return true;
            } catch {
              subscriber.close();
              return false;
            }
          };
          const enqueueEvent = (event: UsageEngineEvent): void => {
            if (event.sequence <= latestSequence) {
              return;
            }
            if (enqueueFrame(sseFrame(event))) {
              latestSequence = event.sequence;
            }
          };
          if (!enqueueFrame(sseFrame(statusEvent))) {
            return;
          }
          const seenSequence = lastSeenSequence(
            request.headers.get('last-event-id'),
            snapshotBoundarySequence,
            replayEvents,
          );
          for (const event of replayEvents) {
            if (
              event.event === 'command-completed' &&
              event.sequence > seenSequence &&
              event.sequence <= snapshotBoundarySequence
            ) {
              enqueueEvent(event);
            }
          }
          deliver = enqueueEvent;
          for (const event of pending) {
            if (event.sequence > snapshotBoundarySequence) {
              enqueueEvent(event);
            }
          }
          pending.length = 0;
          if (pendingOverflow) {
            subscriber.close();
            return;
          }
          if (!closed) {
            heartbeat = scheduleHeartbeat(() => {
              enqueueFrame(encoder.encode(': heartbeat\n\n'));
            }, SSE_HEARTBEAT_MS);
          }
        },
      },
      {
        highWaterMark: usageEngineControlServerBounds.maxSubscriberFrames,
        size: () => 1,
      },
    );
    return new Response(stream, {
      headers: {
        'cache-control': 'no-cache, no-store',
        connection: 'keep-alive',
        'content-type': EVENT_STREAM_MEDIA_TYPE,
        'x-accel-buffering': 'no',
      },
    });
  };

  const handle = async (request: Request, peerAddress: string | null): Promise<Response> => {
    const rejected = authorize(request, peerAddress);
    if (rejected) {
      return rejected;
    }
    if (disposed || eventPumpState === 'disposed') {
      return errorResponse('engine-unavailable', 'Usage engine is stopping.', 503);
    }
    if (eventPumpState === 'failed') {
      return errorResponse('engine-unavailable', 'Usage engine is unavailable.', 503);
    }
    const { pathname } = new URL(request.url);
    const deadline = createRequestDeadline(request, requestTimeoutMs);
    if (pathname === '/v1/status') {
      if (request.method !== 'GET') {
        return new Response(null, { status: 405 });
      }
      try {
        return jsonResponse(parseUsageEngineStatus(await deadline.run(runtime.status)));
      } catch (error) {
        const response = requestBoundaryResponse(error);
        if (response) {
          return response;
        }
        reportInternalFailure('status');
        return errorResponse('engine-unavailable', 'Usage engine is unavailable.', 503);
      }
    }
    if (pathname === '/v1/events') {
      if (request.method !== 'GET' || responseMediaType(request.headers.get('accept')) !== EVENT_STREAM_MEDIA_TYPE) {
        return new Response(null, { status: 406 });
      }
      try {
        return await createEventStream(request, deadline);
      } catch (error) {
        const response = requestBoundaryResponse(error);
        if (response) {
          return response;
        }
        reportInternalFailure('event-stream-status');
        return errorResponse('engine-unavailable', 'Usage engine is unavailable.', 503);
      }
    }
    const cancellationMatch = COMMAND_CANCELLATION_PATH_PATTERN.exec(pathname);
    if (cancellationMatch) {
      if (request.method !== 'DELETE') {
        return new Response(null, { status: 405 });
      }
      if (request.body !== null) {
        return errorResponse('command-rejected', 'Usage engine cancellation must not include a body.', 400);
      }
      let commandId: ReturnType<typeof parseUsageEngineCommandId>;
      try {
        commandId = parseUsageEngineCommandId(cancellationMatch[1]);
      } catch {
        return errorResponse('command-rejected', 'Usage engine cancellation is invalid.', 400);
      }
      try {
        const result = parseUsageEngineCommandCancellationResult(
          await deadline.run(async () => await runtime.cancelCommand(commandId)),
        );
        if (result.commandId !== commandId) {
          return errorResponse('invalid-response', 'Usage engine cancellation identity is invalid.', 500);
        }
        return jsonResponse(result);
      } catch (error) {
        const boundaryResponse = requestBoundaryResponse(error);
        if (boundaryResponse) {
          return boundaryResponse;
        }
        reportInternalFailure('command-cancellation');
        return errorResponse('engine-unavailable', 'Usage engine is unavailable.', 503);
      }
    }
    if (pathname === '/v1/commands') {
      if (request.method !== 'POST') {
        return new Response(null, { status: 405 });
      }
      if (responseMediaType(request.headers.get('content-type')) !== JSON_MEDIA_TYPE) {
        return errorResponse('command-rejected', 'Usage engine commands require JSON.', 415);
      }
      let bytes: Uint8Array;
      try {
        bytes = await readBoundedBody(request, deadline);
      } catch (error) {
        const boundaryResponse = requestBoundaryResponse(error);
        if (boundaryResponse) {
          return boundaryResponse;
        }
        if (error instanceof Error && error.message === 'request-too-large') {
          return errorResponse('request-too-large', 'Usage engine command exceeds its byte limit.', 413);
        }
        return errorResponse('command-rejected', 'Usage engine command body is invalid.', 400);
      }
      let commandRequest: ReturnType<typeof parseUsageEngineCommandRequest>;
      try {
        commandRequest = parseUsageEngineCommandRequest(parseBodyJson(bytes));
      } catch {
        return errorResponse('command-rejected', 'Usage engine command is invalid.', 400);
      }
      try {
        const result = parseUsageEngineCommandResult(
          await deadline.run(
            async () => await runtime.executeCommand(commandRequest.command, commandRequest.commandId),
          ),
        );
        return jsonResponse(result);
      } catch (error) {
        const boundaryResponse = requestBoundaryResponse(error);
        if (boundaryResponse) {
          return boundaryResponse;
        }
        reportInternalFailure('command-execution');
        return errorResponse('engine-unavailable', 'Usage engine is unavailable.', 503);
      }
    }
    return new Response(null, { status: 404 });
  };

  const dispose = (): Promise<void> => {
    disposalPromise ??= (async () => {
      disposed = true;
      eventPumpState = eventPumpState === 'failed' ? 'failed' : 'disposed';
      try {
        await runtimeIterator.return?.();
      } catch (error) {
        reportInternalFailure('event-stream-cleanup');
        if (eventPumpState !== 'failed') {
          for (const subscriber of [...subscribers]) {
            subscriber.close();
          }
          throw error;
        }
      }
      await eventPump;
      for (const subscriber of [...subscribers]) {
        subscriber.close();
      }
    })();
    return disposalPromise;
  };

  return { dispose, handle };
};

export const startUsageEngineControlServer = async ({
  hostname = '127.0.0.1',
  port = 0,
  reportInternalFailure,
  requestTimeoutMs,
  runtime,
  token,
}: StartUsageEngineControlServerOptions): Promise<UsageEngineControlServer> => {
  if (hostname !== '127.0.0.1') {
    throw new Error('Usage engine control must bind numeric 127.0.0.1.');
  }
  if (!(Number.isSafeInteger(port) && port >= 0 && port <= 65_535)) {
    throw new Error('Usage engine control port is invalid.');
  }
  const handler = createUsageEngineControlHandler({
    ...(reportInternalFailure === undefined ? {} : { reportInternalFailure }),
    ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }),
    runtime,
    token,
  });
  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      fetch: async (request, bunServer) => await handler.handle(request, bunServer.requestIP(request)?.address ?? null),
      hostname,
      port,
    });
  } catch (error) {
    await handler.dispose();
    throw error;
  }
  const boundPort = server.port;
  if (!(typeof boundPort === 'number' && Number.isSafeInteger(boundPort) && boundPort >= 1 && boundPort <= 65_535)) {
    await server.stop(true);
    await handler.dispose();
    throw new Error('Usage engine control server did not bind a valid numeric port.');
  }
  let disposal: Promise<void> | undefined;
  return {
    dispose: () => {
      disposal ??= (async () => {
        await server.stop(true);
        await handler.dispose();
      })();
      return disposal;
    },
    hostname,
    port: boundPort,
  };
};
