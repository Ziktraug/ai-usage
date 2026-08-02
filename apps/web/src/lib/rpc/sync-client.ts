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

export const createSyncBrowserAdapter = (
  transport: SyncRpcTransport,
  fetchTransport: SyncFetch = globalThis.fetch,
): SyncBrowserAdapter => ({
  downloadManualMerge: async (signal) => {
    signal?.throwIfAborted();
    const response = await fetchTransport(manualMergeDownloadTransport.path, {
      method: manualMergeDownloadTransport.method,
      ...(signal === undefined ? {} : { signal }),
    });
    signal?.throwIfAborted();
    if (!response.ok) {
      throw new Error('The manual export could not be downloaded safely.');
    }
    if (response.headers.get('content-type') !== CANONICAL_CONTENT_TYPE) {
      throw new Error('The manual export content type is invalid.');
    }
    parseContentLength(response.headers.get('content-length'));
    const filename = parseFilename(response.headers.get('content-disposition'));
    if (!response.body) {
      throw new Error('The manual export body is unavailable.');
    }
    return { filename, response };
  },
  fleet: async (signal) => {
    signal?.throwIfAborted();
    const result = await transport.fleet({}, signal === undefined ? undefined : { signal });
    signal?.throwIfAborted();
    return parseSyncFleet(result);
  },
});
