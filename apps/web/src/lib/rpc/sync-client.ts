import { MAX_PORTABLE_USAGE_BYTES } from '@ai-usage/report-core/portable-usage';
import {
  manualMergeDownloadTransport,
  parseSyncFleet,
  type SyncContractClient,
  type SyncFleet,
} from '@ai-usage/web-contract/sync';

const SAFE_ATTACHMENT_PATTERN = /^attachment; filename="([a-zA-Z0-9][a-zA-Z0-9._-]{0,254})"$/u;
const CANONICAL_CONTENT_TYPE = 'application/json; charset=utf-8';
const CONTENT_LENGTH_PATTERN = /^[1-9][0-9]*$/u;

export type SyncFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type SyncRpcTransport = Pick<SyncContractClient, 'fleet'>;

export interface ManualMergeDownload {
  readonly filename: string;
  readonly response: Response;
}

export interface SyncBrowserAdapter {
  readonly downloadManualMerge: (signal?: AbortSignal) => Promise<ManualMergeDownload>;
  readonly fleet: (signal?: AbortSignal) => Promise<SyncFleet>;
}

const parseContentLength = (value: string | null): number => {
  if (!(value && CONTENT_LENGTH_PATTERN.test(value))) {
    throw new Error('The manual export length is invalid.');
  }
  const bytes = Number(value);
  if (!(Number.isSafeInteger(bytes) && bytes <= MAX_PORTABLE_USAGE_BYTES)) {
    throw new Error('The manual export exceeded its byte limit.');
  }
  return bytes;
};

const parseFilename = (value: string | null): string => {
  const match = value?.match(SAFE_ATTACHMENT_PATTERN);
  const filename = match?.[1];
  if (!filename?.endsWith('.json')) {
    throw new Error('The manual export filename is invalid.');
  }
  return filename;
};

const cancelReader = async (reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> => {
  try {
    await reader.cancel();
  } catch {
    // The stream may already be errored by the same cancellation.
  }
};

const cancelResponseBody = async (response: Response): Promise<void> => {
  try {
    await response.body?.cancel();
  } catch {
    // Metadata rejection may race with transport cancellation.
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

const readManualMergeBytes = async (
  response: Response,
  declaredBytes: number,
  signal: AbortSignal | undefined,
): Promise<Uint8Array> => {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('The manual export body is unavailable.');
  }
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  let complete = false;
  try {
    while (true) {
      const chunk = await readChunk(reader, signal);
      signal?.throwIfAborted();
      if (chunk.done) {
        if (byteLength !== declaredBytes) {
          throw new Error('The manual export length did not match its body.');
        }
        complete = true;
        break;
      }
      byteLength += chunk.value.byteLength;
      if (byteLength > declaredBytes || byteLength > MAX_PORTABLE_USAGE_BYTES) {
        throw new Error('The manual export exceeded its byte limit.');
      }
      chunks.push(chunk.value);
    }
  } finally {
    if (!complete) {
      await cancelReader(reader);
    }
    reader.releaseLock();
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};

export const createSyncBrowserAdapter = (
  transport: SyncRpcTransport,
  fetchTransport: SyncFetch = globalThis.fetch,
): SyncBrowserAdapter => ({
  downloadManualMerge: async (signal) => {
    signal?.throwIfAborted();
    let response: Response;
    try {
      response = await fetchTransport(manualMergeDownloadTransport.path, {
        method: manualMergeDownloadTransport.method,
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      signal?.throwIfAborted();
      throw error;
    }
    signal?.throwIfAborted();
    try {
      if (!response.ok) {
        throw new Error('The manual export could not be downloaded safely.');
      }
      if (response.headers.get('content-type') !== CANONICAL_CONTENT_TYPE) {
        throw new Error('The manual export content type is invalid.');
      }
      const declaredBytes = parseContentLength(response.headers.get('content-length'));
      const filename = parseFilename(response.headers.get('content-disposition'));
      const bytes = await readManualMergeBytes(response, declaredBytes, signal);
      signal?.throwIfAborted();
      const replayBuffer = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(replayBuffer).set(bytes);
      return {
        filename,
        response: new Response(replayBuffer, {
          headers: response.headers,
          status: response.status,
          statusText: response.statusText,
        }),
      };
    } catch (error) {
      await cancelResponseBody(response);
      signal?.throwIfAborted();
      throw error;
    }
  },
  fleet: async (signal) => {
    signal?.throwIfAborted();
    const result = await transport.fleet({}, signal === undefined ? undefined : { signal });
    signal?.throwIfAborted();
    return parseSyncFleet(result);
  },
});
