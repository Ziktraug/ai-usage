import { timingSafeEqual } from 'node:crypto';
import {
  parseUsageEngineCommandCancellationResult,
  parseUsageEngineCommandId,
  parseUsageEngineCommandRequest,
  parseUsageEngineCommandResult,
  parseUsageEngineStatus,
  USAGE_ENGINE_PROTOCOL_VERSION,
  type UsageEngineErrorCode,
  usageEngineControlBounds,
} from '@ai-usage/usage-engine-control';
import { revealUsageEngineBearerToken, type UsageEngineBearerToken } from '@ai-usage/usage-engine-control/node';
import type { UsageEngineRuntimeHost } from '@ai-usage/usage-engine-runtime';
import { createUsageEngineControlEventHub } from './control-event-stream';

const JSON_MEDIA_TYPE = 'application/json';
const EVENT_STREAM_MEDIA_TYPE = 'text/event-stream';
const PROTOCOL_HEADER = 'x-ai-usage-protocol-version';
const COMMAND_CANCELLATION_PATH_PATTERN = /^\/v1\/commands\/([^/]+)$/;
const encoder = new TextEncoder();

export const usageEngineControlServerBounds = {
  maxReplayEvents: 128,
  requestTimeoutMs: 5000,
  maxSubscriberFrames: 129,
  maxSubscribers: 64,
} as const;

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
  let disposed = false;

  const reportInternalFailure = (boundary: UsageEngineInternalFailureBoundary): void => {
    try {
      reportInternalFailureOption?.(boundary);
    } catch {
      // Diagnostics must not change the control-plane response or lifecycle.
    }
  };

  const eventHub = createUsageEngineControlEventHub({
    capacityResponse: () => errorResponse('engine-busy', 'Usage engine event subscriber capacity is full.', 503),
    clearHeartbeat,
    maxReplayEvents: usageEngineControlServerBounds.maxReplayEvents,
    maxSubscriberFrames: usageEngineControlServerBounds.maxSubscriberFrames,
    maxSubscribers: usageEngineControlServerBounds.maxSubscribers,
    reportFailure: reportInternalFailure,
    runtime,
    scheduleHeartbeat,
  });

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

  const createEventStream = async (request: Request, deadline: RequestDeadline): Promise<Response> =>
    await eventHub.createResponse(request, async () => await deadline.run(runtime.status));

  const handle = async (request: Request, peerAddress: string | null): Promise<Response> => {
    const rejected = authorize(request, peerAddress);
    if (rejected) {
      return rejected;
    }
    if (disposed || eventHub.state() === 'disposed') {
      return errorResponse('engine-unavailable', 'Usage engine is stopping.', 503);
    }
    if (eventHub.state() === 'failed') {
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

  const dispose = async (): Promise<void> => {
    disposed = true;
    await eventHub.dispose();
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
