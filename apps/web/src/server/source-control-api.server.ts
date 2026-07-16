import {
  chooseNewestSourceControlSnapshot,
  parseSourceControlCommand,
  type ReportPublishedEvent,
  type SourceControlCommand,
  type SourceControlView,
  sourceControlBounds,
} from '@ai-usage/report-core/source-control';
import { Cause, Option, Runtime } from 'effect';
import { validateTrustedLocalRequest } from './local-request-trust.server';
import { getWebSourceControlRuntime, type WebSourceControlRuntime } from './source-control.server';

// Bun's default HTTP idle timeout is ten seconds. Keep the stream active
// without requiring deployment-specific server tuning.
const SSE_HEARTBEAT_MS = 5000;
const SSE_RETRY_MS = 3000;
const MAX_COMMAND_BYTES = 4096;
const BYTE_COUNT_PATTERN = /^\d+$/;
const encoder = new TextEncoder();

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

export interface SourceControlStreamRuntime {
  readonly getSnapshot: () => Promise<SourceControlView>;
  readonly subscribe: (listener: (snapshot: SourceControlView) => void) => () => void;
}

export interface SourceControlEventStreamOptions {
  readonly heartbeatMs?: number;
  readonly maximumSnapshotBytes?: number;
  readonly onCleanup?: () => void;
  readonly retryMs?: number;
  readonly runtime?: SourceControlStreamRuntime;
  readonly scheduleHeartbeat?: (heartbeat: () => void, intervalMs: number) => () => void;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const unwrapEffectFailure = (error: unknown): unknown => {
  if (!Runtime.isFiberFailure(error)) {
    return error;
  }
  return Option.getOrUndefined(Cause.failureOption(error[Runtime.FiberFailureCauseId])) ?? error;
};

const commandFailure = (error: unknown): SourceControlCommandFailure => {
  const unwrapped = unwrapEffectFailure(error);
  const record = isRecord(unwrapped) ? unwrapped : {};
  const knownReason = typeof record.reason === 'string' ? record.reason : 'command-failed';
  const messageByReason: Readonly<Record<string, string>> = {
    disabled: 'The collection source is disabled.',
    'not-detected': 'The collection source is not detected.',
    'policy-write-failed': 'The source policy could not be saved.',
    'unknown-source': 'Unknown collection source.',
  };
  return {
    error: {
      message: messageByReason[knownReason] ?? 'The source control command could not be completed.',
      reason: knownReason,
      tag: 'SourceControlCommandError',
    },
    ok: false,
  };
};

export const applySourceControlCommandForServer = async (
  command: SourceControlCommand,
  runtime: WebSourceControlRuntime = getWebSourceControlRuntime(),
): Promise<SourceControlCommandResult> => {
  try {
    let accepted: boolean | number = true;
    if (command.command === 'set-enabled') {
      await runtime.setEnabled(command.sourceId, command.enabled);
    } else if (command.command === 'run-now') {
      accepted = await runtime.runNow(command.sourceId);
    } else if (command.command === 'run-all') {
      accepted = await runtime.runAllEnabled();
    } else {
      await runtime.detectAll();
    }
    return {
      accepted,
      ok: true,
      snapshot: await runtime.getSnapshot(),
    };
  } catch (error) {
    return commandFailure(error);
  }
};

export const getSourceControlSnapshotForServer = (
  runtime: WebSourceControlRuntime = getWebSourceControlRuntime(),
): Promise<SourceControlView> => runtime.getSnapshot();

const commandRequestFailure = (status: number, reason: string, message: string): Response =>
  Response.json(
    {
      error: {
        message,
        reason,
        tag: 'SourceControlCommandError',
      },
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
    const chunk = await reader.read();
    if (chunk.done) {
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
  runtime?: WebSourceControlRuntime,
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
  const result = await applySourceControlCommandForServer(command, runtime ?? getWebSourceControlRuntime());
  if (result.ok) {
    return Response.json(result);
  }
  const status = result.error.reason === 'policy-write-failed' ? 503 : 409;
  return Response.json(result, { status });
};

const snapshotEvent = (snapshot: SourceControlView, maximumBytes: number): Uint8Array => {
  const serialized = JSON.stringify(snapshot);
  if (encoder.encode(serialized).byteLength > maximumBytes) {
    throw new Error('Source control snapshot exceeded its transport limit.');
  }
  return encoder.encode(`event: snapshot\nid: ${snapshot.instanceId}:${snapshot.generation}\ndata: ${serialized}\n\n`);
};

const reportPublishedEvent = (event: ReportPublishedEvent): Uint8Array => {
  const serialized = JSON.stringify(event);
  if (encoder.encode(serialized).byteLength > sourceControlBounds.maxEventBytes) {
    throw new Error('Report publication event exceeded its transport limit.');
  }
  return encoder.encode(
    `event: report-published\nid: ${event.instanceId}:report:${event.sourceControlGeneration}\ndata: ${serialized}\n\n`,
  );
};

export const createSourceControlEventStream = (
  request: Request,
  options: SourceControlEventStreamOptions = {},
): Response => {
  const trustFailure = validateTrustedLocalRequest(request);
  if (trustFailure) {
    return trustFailure;
  }

  const runtime = options.runtime ?? getWebSourceControlRuntime();
  const heartbeatMs = options.heartbeatMs ?? SSE_HEARTBEAT_MS;
  const maximumSnapshotBytes = options.maximumSnapshotBytes ?? sourceControlBounds.maxSnapshotBytes;
  const retryMs = options.retryMs ?? SSE_RETRY_MS;
  const scheduleHeartbeat =
    options.scheduleHeartbeat ??
    ((sendHeartbeat: () => void, intervalMs: number) => {
      const handle = globalThis.setInterval(sendHeartbeat, intervalMs);
      return () => globalThis.clearInterval(handle);
    });
  let unsubscribe: (() => void) | undefined;
  let cancelHeartbeat: (() => void) | undefined;
  let closed = false;
  let initialized = false;
  let latest: SourceControlView | undefined;
  let latestPublication: ReportPublishedEvent | undefined;
  let observedPublicationRevision: string | undefined;
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;

  const cleanup = (): void => {
    if (closed) {
      return;
    }
    closed = true;
    cancelHeartbeat?.();
    unsubscribe?.();
    request.signal.removeEventListener('abort', abort);
    options.onCleanup?.();
  };

  const flushLatest = (): void => {
    if (closed || !initialized || !controller || (controller.desiredSize ?? 0) <= 0) {
      return;
    }
    if (latest) {
      const snapshot = latest;
      latest = undefined;
      controller.enqueue(snapshotEvent(snapshot, maximumSnapshotBytes));
      return;
    }
    if (latestPublication) {
      const publication = latestPublication;
      latestPublication = undefined;
      controller.enqueue(reportPublishedEvent(publication));
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
        unsubscribe = runtime.subscribe((snapshot) => {
          latest = chooseNewestSourceControlSnapshot(latest, snapshot);
          const revision = snapshot.publication.revision;
          const publishedAt = snapshot.publication.lastPublishedAt;
          if (revision && publishedAt && revision !== observedPublicationRevision) {
            observedPublicationRevision = revision;
            latestPublication = {
              instanceId: snapshot.instanceId,
              publishedAt,
              revision,
              sourceControlGeneration: snapshot.generation,
            };
          }
          flushLatest();
        });
        try {
          const initial = chooseNewestSourceControlSnapshot(latest, await runtime.getSnapshot());
          observedPublicationRevision ??= initial.publication.revision;
          latest = undefined;
          if (closed) {
            return;
          }
          streamController.enqueue(encoder.encode(`retry: ${retryMs}\n\n`));
          streamController.enqueue(snapshotEvent(initial, maximumSnapshotBytes));
          initialized = true;
          flushLatest();
          cancelHeartbeat = scheduleHeartbeat(() => {
            if (
              !closed &&
              latest === undefined &&
              latestPublication === undefined &&
              (streamController.desiredSize ?? 0) > 0
            ) {
              streamController.enqueue(encoder.encode(': heartbeat\n\n'));
            }
          }, heartbeatMs);
        } catch {
          cleanup();
          streamController.error(new Error('Source control stream could not start.'));
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
