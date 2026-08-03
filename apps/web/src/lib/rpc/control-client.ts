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

const parseContentLength = (value: string | null, maximumBytes: number): void => {
  if (value === null) {
    return;
  }
  if (!CONTENT_LENGTH_PATTERN.test(value)) {
    throw new Error('The source control response length is invalid.');
  }
  const bytes = Number(value);
  if (!(Number.isSafeInteger(bytes) && bytes <= maximumBytes)) {
    throw new Error('The source control response exceeded its byte limit.');
  }
};

const cancelReader = async (reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> => {
  try {
    await reader.cancel();
  } catch {
    // The stream may already be errored by the same cancellation.
  }
};

const readBoundedJson = async (
  response: Response,
  maximumBytes: number,
  signal: AbortSignal | undefined,
): Promise<unknown> => {
  signal?.throwIfAborted();
  parseContentLength(response.headers.get('content-length'), maximumBytes);
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('The source control response body is unavailable.');
  }
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  let complete = false;
  try {
    try {
      while (true) {
        signal?.throwIfAborted();
        const chunk = await reader.read();
        signal?.throwIfAborted();
        if (chunk.done) {
          complete = true;
          break;
        }
        byteLength += chunk.value.byteLength;
        if (byteLength > maximumBytes) {
          throw new Error('The source control response exceeded its byte limit.');
        }
        chunks.push(chunk.value);
      }
    } finally {
      if (!complete) {
        await cancelReader(reader);
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
