import {
  chooseNewestSourceControlSnapshot,
  parseSourceControlCommand,
  type ReportPublishedEvent,
  type SourceControlCommand,
  type SourceControlView,
  sourceControlBounds,
} from '@ai-usage/report-core/source-control';
import type {
  UsageEngineCommand,
  UsageEngineErrorCode,
  UsageEngineEvent,
  UsageEngineStatus,
} from '@ai-usage/usage-engine-control';
import {
  type UsageEngineControlClient,
  UsageEngineControlError,
  type UsageEngineRequestOptions,
} from '@ai-usage/usage-engine-control/client';
import { USAGE_STORE_SCHEMA_VERSION } from '@ai-usage/usage-store/reader';
import { readAbortableRequestBodyChunk } from './abortable-request-body.server';
import { validateTrustedLocalRequest } from './local-request-trust.server';
import { resolveUsageEngineControlClientForServer } from './usage-engine-control-resolver.server';

const SSE_HEARTBEAT_MS = 5000;
const SSE_HEALTH_CHECK_MS = 5000;
const SSE_RETRY_MS = 3000;
const MAX_COMMAND_BYTES = 4096;
const BYTE_COUNT_PATTERN = /^\d+$/;
const encoder = new TextEncoder();

export type SourceControlControlState = 'disconnected' | 'live' | 'protocol-mismatch';

export interface SourceControlCommandSuccess {
  readonly accepted: boolean | number;
  readonly ok: true;
  readonly snapshot: SourceControlView;
}

export interface SourceControlCommandFailure {
  readonly error: {
    readonly message: string;
    readonly reason: string;
    readonly tag: 'SourceControlCommandError';
  };
  readonly ok: false;
}

export type SourceControlCommandResult = SourceControlCommandFailure | SourceControlCommandSuccess;

type ScheduleRepeatingOperation = (operation: () => void, intervalMs: number) => () => void;

export interface SourceControlEventStreamOptions {
  readonly control?: UsageEngineControlClient;
  readonly healthCheckMs?: number;
  readonly heartbeatMs?: number;
  readonly maximumSnapshotBytes?: number;
  readonly onCleanup?: () => void;
  readonly resolveControl?: () => Promise<UsageEngineControlClient>;
  readonly retryMs?: number;
  readonly scheduleHealthCheck?: ScheduleRepeatingOperation;
  readonly scheduleHeartbeat?: ScheduleRepeatingOperation;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const disableRequestIdleTimeout = (request: Request): void => {
  const runtime = 'runtime' in request && isRecord(request.runtime) ? request.runtime : undefined;
  if (!runtime) {
    return;
  }
  const bunRuntime = runtime.bun;
  if (isRecord(bunRuntime) && isRecord(bunRuntime.server) && typeof bunRuntime.server.timeout === 'function') {
    bunRuntime.server.timeout(request, 0);
  }
  const nodeRuntime = runtime.node;
  if (!isRecord(nodeRuntime)) {
    return;
  }
  if (isRecord(nodeRuntime.req) && typeof nodeRuntime.req.setTimeout === 'function') {
    nodeRuntime.req.setTimeout(0);
  }
  if (isRecord(nodeRuntime.res) && typeof nodeRuntime.res.setTimeout === 'function') {
    nodeRuntime.res.setTimeout(0);
  }
};

const stableMessageByReason: Readonly<Record<string, string>> = {
  aborted: 'The source control command was cancelled.',
  'authentication-failed': 'The usage engine rejected local authentication.',
  'command-rejected': 'The source control command was rejected.',
  'engine-busy': 'The usage engine is busy.',
  'engine-unavailable': 'The usage engine is unavailable.',
  'invalid-response': 'The usage engine returned an invalid response.',
  'protocol-mismatch': 'The usage engine is incompatible with this web application.',
  'request-too-large': 'The source control command exceeded its size limit.',
  'response-too-large': 'The usage engine response exceeded its size limit.',
  timeout: 'The usage engine did not respond in time.',
  'transport-failed': 'The usage engine is unavailable.',
};

const commandFailureForReason = (reason: string): SourceControlCommandFailure => ({
  error: {
    message: stableMessageByReason[reason] ?? 'The source control command could not be completed.',
    reason,
    tag: 'SourceControlCommandError',
  },
  ok: false,
});

const commandFailure = (error: unknown): SourceControlCommandFailure =>
  commandFailureForReason(error instanceof UsageEngineControlError ? error.code : 'command-failed');

const toUsageEngineCommand = (command: SourceControlCommand): UsageEngineCommand => {
  switch (command.command) {
    case 'detect-all':
      return { command: 'detect-all' };
    case 'run-all':
      return { command: 'run-all-enabled' };
    case 'run-now':
      return { command: 'run-source', sourceId: command.sourceId };
    case 'set-enabled':
      return { command: 'set-source-enabled', enabled: command.enabled, sourceId: command.sourceId };
    default: {
      const unsupported: never = command;
      throw new Error(`Unsupported source control command: ${JSON.stringify(unsupported)}`);
    }
  }
};

const controlStateForStatus = (status: UsageEngineStatus): SourceControlControlState => {
  if (status.storeSchemaVersion !== null && status.storeSchemaVersion !== USAGE_STORE_SCHEMA_VERSION) {
    return 'protocol-mismatch';
  }
  return status.readiness === 'ready' ? 'live' : 'disconnected';
};

const resolveControl = async (control?: UsageEngineControlClient): Promise<UsageEngineControlClient> =>
  control ?? (await resolveUsageEngineControlClientForServer());

export const applySourceControlCommandForServer = async (
  commandValue: SourceControlCommand,
  controlValue?: UsageEngineControlClient,
  requestOptions: UsageEngineRequestOptions = {},
): Promise<SourceControlCommandResult> => {
  try {
    const command = parseSourceControlCommand(commandValue);
    const control = await resolveControl(controlValue);
    const initialStatus = await control.getStatus(requestOptions);
    const initialControlState = controlStateForStatus(initialStatus);
    if (initialControlState !== 'live') {
      return commandFailureForReason(
        initialControlState === 'protocol-mismatch' ? initialControlState : 'engine-unavailable',
      );
    }
    const result = await control.execute(toUsageEngineCommand(command), requestOptions);
    if (!result.ok) {
      return commandFailureForReason(result.error.code);
    }
    if (result.instanceId !== initialStatus.instanceId) {
      return commandFailureForReason('invalid-response');
    }
    const status = await control.getStatus(requestOptions);
    const controlState = controlStateForStatus(status);
    if (controlState !== 'live') {
      return commandFailureForReason(controlState === 'protocol-mismatch' ? controlState : 'engine-unavailable');
    }
    if (status.instanceId !== result.instanceId) {
      return commandFailureForReason('invalid-response');
    }
    return { accepted: true, ok: true, snapshot: status.sourceControl };
  } catch (error) {
    return commandFailure(error);
  }
};

const commandRequestFailure = (status: number, reason: string, message: string): Response =>
  Response.json(
    {
      error: { message, reason, tag: 'SourceControlCommandError' },
      ok: false,
    } satisfies SourceControlCommandFailure,
    { status },
  );

const readCommandBody = async (request: Request): Promise<string | Response> => {
  const contentType = request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') {
    return commandRequestFailure(415, 'unsupported-media-type', 'Source control commands require JSON.');
  }
  const contentLength = request.headers.get('content-length');
  if (
    contentLength !== null &&
    (!BYTE_COUNT_PATTERN.test(contentLength) || Number(contentLength) > MAX_COMMAND_BYTES)
  ) {
    return commandRequestFailure(413, 'command-too-large', 'Source control command exceeded its size limit.');
  }
  if (!request.body) {
    return commandRequestFailure(400, 'invalid-command', 'Source control command body is required.');
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  while (true) {
    const chunk = await readAbortableRequestBodyChunk(reader, request.signal);
    if ('aborted' in chunk) {
      return commandRequestFailure(499, 'aborted', 'The source control command was cancelled.');
    }
    if (chunk.done) {
      if (request.signal.aborted) {
        return commandRequestFailure(499, 'aborted', 'The source control command was cancelled.');
      }
      break;
    }
    byteLength += chunk.value.byteLength;
    if (byteLength > MAX_COMMAND_BYTES) {
      await reader.cancel();
      return commandRequestFailure(413, 'command-too-large', 'Source control command exceeded its size limit.');
    }
    chunks.push(chunk.value);
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return commandRequestFailure(400, 'invalid-command', 'Source control command must be valid UTF-8 JSON.');
  }
};

export const handleSourceControlCommandRequest = async (
  request: Request,
  control?: UsageEngineControlClient,
): Promise<Response> => {
  const trustFailure = validateTrustedLocalRequest(request);
  if (trustFailure) {
    return trustFailure;
  }
  const body = await readCommandBody(request);
  if (body instanceof Response) {
    return body;
  }
  let command: SourceControlCommand;
  try {
    command = parseSourceControlCommand(JSON.parse(body) as unknown);
  } catch {
    return commandRequestFailure(400, 'invalid-command', 'Source control command is invalid.');
  }
  const result = await applySourceControlCommandForServer(command, control, { signal: request.signal });
  if (result.ok) {
    return Response.json(result);
  }
  const unavailableReasons = new Set<UsageEngineErrorCode | string>([
    'engine-unavailable',
    'timeout',
    'transport-failed',
  ]);
  const status = unavailableReasons.has(result.error.reason) ? 503 : 409;
  return Response.json(result, { status });
};

const serializedEvent = (event: string, id: string, value: unknown, maximumBytes: number): Uint8Array => {
  const serialized = JSON.stringify(value);
  if (encoder.encode(serialized).byteLength > maximumBytes) {
    throw new Error(`Source control ${event} event exceeded its transport limit.`);
  }
  return encoder.encode(`event: ${event}\nid: ${id}\ndata: ${serialized}\n\n`);
};

const snapshotEvent = (snapshot: SourceControlView, maximumBytes: number): Uint8Array =>
  serializedEvent('snapshot', `${snapshot.instanceId}:${snapshot.generation}`, snapshot, maximumBytes);

const reportPublishedEvent = (event: ReportPublishedEvent): Uint8Array =>
  serializedEvent(
    'report-published',
    `${event.instanceId}:report:${event.sourceControlGeneration}`,
    event,
    sourceControlBounds.maxEventBytes,
  );

const controlStateEvent = (state: SourceControlControlState, id: string): Uint8Array =>
  serializedEvent('control-state', id, { state }, sourceControlBounds.maxEventBytes);

const defaultSchedule = (operation: () => void, intervalMs: number): (() => void) => {
  const handle = globalThis.setInterval(operation, intervalMs);
  return () => globalThis.clearInterval(handle);
};

export const createSourceControlEventStream = (
  request: Request,
  options: SourceControlEventStreamOptions = {},
): Response => {
  const trustFailure = validateTrustedLocalRequest(request);
  if (trustFailure) {
    return trustFailure;
  }
  disableRequestIdleTimeout(request);

  const heartbeatMs = options.heartbeatMs ?? SSE_HEARTBEAT_MS;
  const healthCheckMs = options.healthCheckMs ?? SSE_HEALTH_CHECK_MS;
  const maximumSnapshotBytes = options.maximumSnapshotBytes ?? sourceControlBounds.maxSnapshotBytes;
  const retryMs = options.retryMs ?? SSE_RETRY_MS;
  const scheduleHeartbeat = options.scheduleHeartbeat ?? defaultSchedule;
  const scheduleHealthCheck = options.scheduleHealthCheck ?? defaultSchedule;
  const lifecycleAbort = new AbortController();
  let cancelHeartbeat: (() => void) | undefined;
  let cancelHealthCheck: (() => void) | undefined;
  let closed = false;
  let initialized = false;
  let latestSnapshot: SourceControlView | undefined;
  let latestPublication: ReportPublishedEvent | undefined;
  let observedPublicationRevision: string | undefined;
  let lastControlState: SourceControlControlState | undefined;
  let lastSnapshotIdentity: string | undefined;
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let control: UsageEngineControlClient | undefined;

  const cleanup = (): void => {
    if (closed) {
      return;
    }
    closed = true;
    lifecycleAbort.abort();
    cancelHeartbeat?.();
    cancelHealthCheck?.();
    request.signal.removeEventListener('abort', abort);
    options.onCleanup?.();
  };

  const flushLatest = (): void => {
    if (closed || !initialized || !controller || (controller.desiredSize ?? 0) <= 0) {
      return;
    }
    if (latestSnapshot) {
      const snapshot = latestSnapshot;
      latestSnapshot = undefined;
      controller.enqueue(snapshotEvent(snapshot, maximumSnapshotBytes));
      return;
    }
    if (latestPublication) {
      const publication = latestPublication;
      latestPublication = undefined;
      controller.enqueue(reportPublishedEvent(publication));
    }
  };

  const queueSnapshot = (snapshot: SourceControlView): void => {
    const identity = `${snapshot.instanceId}:${snapshot.generation}`;
    if (identity === lastSnapshotIdentity) {
      return;
    }
    lastSnapshotIdentity = identity;
    latestSnapshot = chooseNewestSourceControlSnapshot(latestSnapshot, snapshot);
    flushLatest();
  };

  const queuePublication = (publication: ReportPublishedEvent): void => {
    if (publication.revision === observedPublicationRevision) {
      return;
    }
    observedPublicationRevision = publication.revision;
    latestPublication = publication;
    flushLatest();
  };

  const closeWithState = (state: Exclude<SourceControlControlState, 'live'>, id: string): void => {
    if (closed || !controller) {
      return;
    }
    controller.enqueue(controlStateEvent(state, id));
    cleanup();
    controller.close();
  };

  const acceptStatus = (status: UsageEngineStatus): boolean => {
    queueSnapshot(status.sourceControl);
    const state = controlStateForStatus(status);
    if (state !== 'live') {
      closeWithState(state, `${status.instanceId}:control:${status.generation}`);
      return false;
    }
    if (lastControlState !== state) {
      lastControlState = state;
      controller?.enqueue(controlStateEvent('live', `${status.instanceId}:control:${status.generation}`));
    }
    return true;
  };

  const acceptEngineEvent = (event: UsageEngineEvent): void => {
    if (event.event === 'status') {
      acceptStatus(event.status);
      return;
    }
    if (event.event === 'source-control') {
      queueSnapshot(event.snapshot);
      return;
    }
    if (event.event === 'report-published') {
      queuePublication(event.publication);
    }
  };

  const abort = (): void => {
    if (closed) {
      return;
    }
    cleanup();
    controller?.close();
  };

  const body = new ReadableStream<Uint8Array>(
    {
      cancel: cleanup,
      pull: flushLatest,
      start: async (streamController) => {
        controller = streamController;
        request.signal.addEventListener('abort', abort, { once: true });
        if (request.signal.aborted) {
          abort();
          return;
        }
        streamController.enqueue(encoder.encode(`retry: ${retryMs}\n\n`));
        initialized = true;
        try {
          control = options.control ?? (await (options.resolveControl ?? resolveUsageEngineControlClientForServer)());
          if (closed) {
            return;
          }
          const initialStatus = await control.getStatus({ signal: lifecycleAbort.signal });
          if (closed) {
            return;
          }
          observedPublicationRevision = initialStatus.sourceControl.publication.revision;
          lastSnapshotIdentity = `${initialStatus.sourceControl.instanceId}:${initialStatus.sourceControl.generation}`;
          streamController.enqueue(snapshotEvent(initialStatus.sourceControl, maximumSnapshotBytes));
          const initialControlState = controlStateForStatus(initialStatus);
          lastControlState = initialControlState;
          if (initialControlState !== 'live') {
            closeWithState(initialControlState, `${initialStatus.instanceId}:control:${initialStatus.generation}`);
            return;
          }
          streamController.enqueue(
            controlStateEvent('live', `${initialStatus.instanceId}:control:${initialStatus.generation}`),
          );
          if (closed) {
            return;
          }
          cancelHeartbeat = scheduleHeartbeat(() => {
            if (
              !closed &&
              latestSnapshot === undefined &&
              latestPublication === undefined &&
              (streamController.desiredSize ?? 0) > 0
            ) {
              streamController.enqueue(encoder.encode(': heartbeat\n\n'));
            }
          }, heartbeatMs);
          let healthCheckRunning = false;
          cancelHealthCheck = scheduleHealthCheck(() => {
            if (closed || healthCheckRunning || !control) {
              return;
            }
            healthCheckRunning = true;
            control
              .getStatus({ signal: lifecycleAbort.signal })
              .then((status) => {
                if (!closed) {
                  acceptStatus(status);
                }
              })
              .catch((error: unknown) => {
                if (!closed) {
                  closeWithState(
                    error instanceof UsageEngineControlError && error.code === 'protocol-mismatch'
                      ? 'protocol-mismatch'
                      : 'disconnected',
                    'usage-engine:control-error',
                  );
                }
              })
              .finally(() => {
                healthCheckRunning = false;
              });
          }, healthCheckMs);
          try {
            for await (const event of control.changes({ signal: lifecycleAbort.signal })) {
              if (closed) {
                break;
              }
              acceptEngineEvent(event);
            }
            if (!closed) {
              closeWithState('disconnected', 'usage-engine:events-ended');
            }
          } catch (error) {
            if (!closed) {
              closeWithState(
                error instanceof UsageEngineControlError && error.code === 'protocol-mismatch'
                  ? 'protocol-mismatch'
                  : 'disconnected',
                'usage-engine:events-failed',
              );
            }
          }
        } catch (error) {
          closeWithState(
            error instanceof UsageEngineControlError && error.code === 'protocol-mismatch'
              ? 'protocol-mismatch'
              : 'disconnected',
            'usage-engine:initial-status-failed',
          );
        }
      },
    },
    { highWaterMark: 1 },
  );

  return new Response(body, {
    headers: {
      'cache-control': 'no-cache, no-store, must-revalidate',
      connection: 'keep-alive',
      'content-type': 'text/event-stream; charset=utf-8',
      'x-accel-buffering': 'no',
    },
  });
};
