import {
  parseSourceControlCommand,
  parseSourceControlCommandResponse,
  sourceControlBounds,
} from '@ai-usage/report-core/source-control';
import {
  type SourceControlCommand,
  type SourceControlCommandResponse,
  sourceControlCommandTransport,
  sourceControlSseTransport,
} from '@ai-usage/web-contract/control';

const MAX_COMMAND_BYTES = 4 * 1024;
const CONTENT_LENGTH_PATTERN = /^[0-9]+$/u;
const MAX_COMMAND_RESPONSE_BYTES = sourceControlBounds.maxSnapshotBytes + sourceControlBounds.maxEventBytes;

export type ControlFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface ControlEventSource {
  close(): void;
}

export interface ControlBrowserDependencies {
  readonly createEventSource?: (path: string) => ControlEventSource;
  readonly fetch?: ControlFetch;
}

export interface ControlBrowserAdapter {
  readonly openEvents: () => ControlEventSource;
  readonly sendCommand: (command: SourceControlCommand, signal?: AbortSignal) => Promise<SourceControlCommandResponse>;
}

const defaultCreateEventSource = (path: string): ControlEventSource => new EventSource(path);

const parseContentLength = (value: string | null, maximumBytes: number): number | null => {
  if (value === null) {
    return null;
  }
  if (!CONTENT_LENGTH_PATTERN.test(value)) {
    throw new Error('The source control response length is invalid.');
  }
  const bytes = Number(value);
  if (!(Number.isSafeInteger(bytes) && bytes <= maximumBytes)) {
    throw new Error('The source control response exceeded its byte limit.');
  }
  return bytes;
};

const scheduleReaderCancellation = (reader: ReadableStreamDefaultReader<Uint8Array>): void => {
  try {
    reader.cancel().catch(() => undefined);
  } catch {
    // The stream may already be errored by the same cancellation.
  }
};

const readChunk = (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal | undefined,
): ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']> => {
  signal?.throwIfAborted();
  if (!signal) {
    return reader.read();
  }
  return new Promise((resolve, reject) => {
    const abort = (): void => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    reader
      .read()
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
};

const readBoundedJson = async (
  response: Response,
  maximumBytes: number,
  signal: AbortSignal | undefined,
): Promise<unknown> => {
  signal?.throwIfAborted();
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('The source control response body is unavailable.');
  }
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  let complete = false;
  try {
    try {
      const declaredBytes = parseContentLength(response.headers.get('content-length'), maximumBytes);
      while (true) {
        const chunk = await readChunk(reader, signal);
        signal?.throwIfAborted();
        if (chunk.done) {
          if (declaredBytes !== null && byteLength !== declaredBytes) {
            throw new Error('The source control response length did not match its body.');
          }
          complete = true;
          break;
        }
        byteLength += chunk.value.byteLength;
        if (byteLength > maximumBytes || (declaredBytes !== null && byteLength > declaredBytes)) {
          throw new Error('The source control response exceeded its byte limit.');
        }
        chunks.push(chunk.value);
      }
    } finally {
      if (!complete) {
        scheduleReaderCancellation(reader);
      }
      reader.releaseLock();
    }
  } catch (error) {
    signal?.throwIfAborted();
    throw error;
  }
  signal?.throwIfAborted();
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  return JSON.parse(text) as unknown;
};

export const createControlBrowserAdapter = (dependencies: ControlBrowserDependencies = {}): ControlBrowserAdapter => {
  const createEventSource = dependencies.createEventSource ?? defaultCreateEventSource;
  const fetchTransport = dependencies.fetch ?? globalThis.fetch;

  return {
    openEvents: () => createEventSource(sourceControlSseTransport.path),
    sendCommand: async (command, signal) => {
      signal?.throwIfAborted();
      const canonicalCommand = parseSourceControlCommand(command);
      const body = JSON.stringify(canonicalCommand);
      if (new TextEncoder().encode(body).byteLength > MAX_COMMAND_BYTES) {
        throw new Error('The source control command exceeded its byte limit.');
      }
      let response: Response;
      try {
        response = await fetchTransport(sourceControlCommandTransport.path, {
          body,
          headers: { 'content-type': 'application/json' },
          method: sourceControlCommandTransport.method,
          ...(signal === undefined ? {} : { signal }),
        });
      } catch (error) {
        signal?.throwIfAborted();
        throw error;
      }
      signal?.throwIfAborted();
      const result = parseSourceControlCommandResponse(
        await readBoundedJson(response, MAX_COMMAND_RESPONSE_BYTES, signal),
      );
      if (response.ok !== result.ok) {
        throw new Error('The source control command response status is inconsistent.');
      }
      return result;
    },
  };
};
