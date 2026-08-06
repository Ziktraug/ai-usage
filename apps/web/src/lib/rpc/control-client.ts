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
import { readBoundedResponseBytes } from './bounded-response-reader';

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

const readBoundedJson = async (
  response: Response,
  maximumBytes: number,
  signal: AbortSignal | undefined,
): Promise<unknown> => {
  const bytes = await readBoundedResponseBytes(response, {
    bodyUnavailableMessage: 'The source control response body is unavailable.',
    byteLimitMessage: 'The source control response exceeded its byte limit.',
    declaredBytes: parseContentLength(response.headers.get('content-length'), maximumBytes),
    lengthMismatchMessage: 'The source control response length did not match its body.',
    maximumBytes,
    ...(signal === undefined ? {} : { signal }),
  });
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
