import {
  assertPortableUsageRowCount,
  assertPortableUsageTopLevelRowsPreflight,
  MAX_PORTABLE_USAGE_BYTES,
} from '@ai-usage/report-core/portable-usage';
import { parseUsageEngineMergePreviewOutput, type UsageEngineMergePreviewOutput } from '@ai-usage/usage-engine-control';
import { manualMergeUploadTransport } from '@ai-usage/web-contract/sync';
import type { ManualOperationError, ManualOperationResult } from '../../../manual-transfer-contract';
import { createSyncBrowserAdapter, type SyncFetch } from '../../rpc/sync-client';

const MAX_PUBLIC_ERROR_TEXT = 512;

export interface ManualTransferClient {
  confirm(
    file: File,
    preview: UsageEngineMergePreviewOutput,
    signal?: AbortSignal,
    onProgress?: ManualUploadProgressListener,
  ): Promise<ManualOperationResult<None>>;
  download(
    signal?: AbortSignal,
  ): Promise<{ readonly filename: string; readonly response: Response; readonly rows: number }>;
  preview(
    file: File,
    signal?: AbortSignal,
    onProgress?: ManualUploadProgressListener,
  ): Promise<ManualOperationResult<UsageEngineMergePreviewOutput>>;
}

export type ManualUploadProgress =
  | {
      readonly fileName: string;
      readonly fileSize: number;
      readonly loaded: number;
      readonly phase: 'uploading';
      readonly total: number;
    }
  | {
      readonly fileName: string;
      readonly fileSize: number;
      readonly phase: 'processing';
      readonly startedAt: number;
    };

export type ManualUploadProgressListener = (progress: ManualUploadProgress) => void;

export interface ManualUploadRequest {
  readonly action: 'confirm' | 'preview';
  readonly file: File;
  readonly headers: Readonly<Record<string, string>>;
  readonly onProgress?: ManualUploadProgressListener;
  readonly signal?: AbortSignal;
}

export type ManualUploadTransport = (request: ManualUploadRequest) => Promise<Response>;

interface None {
  readonly kind: 'none';
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const parseFailure = (value: unknown): ManualOperationError | undefined => {
  if (!(isRecord(value) && value.ok === false && isRecord(value.error))) {
    return;
  }
  const { error } = value;
  if (
    typeof error.message !== 'string' ||
    error.message.length === 0 ||
    error.message.length > MAX_PUBLIC_ERROR_TEXT ||
    typeof error.tag !== 'string' ||
    error.tag.length === 0 ||
    error.tag.length > MAX_PUBLIC_ERROR_TEXT ||
    (error.reason !== undefined &&
      (typeof error.reason !== 'string' || error.reason.length === 0 || error.reason.length > MAX_PUBLIC_ERROR_TEXT))
  ) {
    return;
  }
  return {
    message: error.message,
    ...(error.reason === undefined ? {} : { reason: error.reason }),
    tag: error.tag,
  };
};

const parseResponse = async <Value>(
  response: Response,
  parseValue: (value: unknown) => Value,
): Promise<ManualOperationResult<Value>> => {
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    return { error: { message: 'The server returned an unreadable response.', tag: 'InvalidResponse' }, ok: false };
  }
  const failure = parseFailure(value);
  if (failure) {
    return { error: failure, ok: false };
  }
  if (!(response.ok && isRecord(value) && value.ok === true && Object.hasOwn(value, 'data'))) {
    return { error: { message: 'The server returned an invalid response.', tag: 'InvalidResponse' }, ok: false };
  }
  try {
    return { data: parseValue(value.data), ok: true };
  } catch {
    return { error: { message: 'The server returned an invalid response.', tag: 'InvalidResponse' }, ok: false };
  }
};

const parseNone = (value: unknown): None => {
  if (!(isRecord(value) && Object.keys(value).length === 1 && value.kind === 'none')) {
    throw new Error('Expected an empty merge confirmation result.');
  }
  return { kind: 'none' };
};

const createAbortError = (signal: AbortSignal | undefined): unknown =>
  signal?.reason ?? new DOMException('The manual upload was aborted.', 'AbortError');

export const xhrManualUpload: ManualUploadTransport = async ({ action, file, headers, onProgress, signal }) =>
  await new Promise<Response>((resolve, reject) => {
    signal?.throwIfAborted();
    const request = new XMLHttpRequest();
    let settled = false;
    const cleanup = (): void => signal?.removeEventListener('abort', abort);
    const settle = (complete: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      complete();
    };
    const abort = (): void => {
      request.abort();
      settle(() => reject(createAbortError(signal)));
    };

    request.open(manualMergeUploadTransport.method, manualMergeUploadTransport.path);
    for (const [name, value] of Object.entries(headers)) {
      request.setRequestHeader(name, value);
    }
    request.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) {
        onProgress?.({
          fileName: file.name,
          fileSize: file.size,
          loaded: event.loaded,
          phase: 'uploading',
          total: event.total,
        });
      }
    });
    request.upload.addEventListener('load', () => {
      onProgress?.({ fileName: file.name, fileSize: file.size, phase: 'processing', startedAt: Date.now() });
    });
    request.addEventListener('load', () => {
      settle(() =>
        resolve(
          new Response(request.responseText, {
            headers: { 'content-type': request.getResponseHeader('content-type') ?? 'application/json' },
            status: request.status || 500,
            statusText: request.statusText,
          }),
        ),
      );
    });
    request.addEventListener('error', () => {
      settle(() => reject(new Error(`The manual ${action} upload failed at the network boundary.`)));
    });
    request.addEventListener('abort', () => settle(() => reject(createAbortError(signal))));
    signal?.addEventListener('abort', abort, { once: true });
    request.send(file);
  });

const exportedRowCount = async (response: Response): Promise<number> => {
  const text = await response.clone().text();
  assertPortableUsageTopLevelRowsPreflight(text, 'Manual export');
  const value: unknown = JSON.parse(text);
  if (!(isRecord(value) && Array.isArray(value.rows))) {
    throw new Error('The manual export row collection is invalid.');
  }
  assertPortableUsageRowCount(value.rows, 'Manual export');
  return value.rows.length;
};

const upload = async <Value>(
  file: File,
  action: 'confirm' | 'preview',
  parseValue: (value: unknown) => Value,
  uploadTransport: ManualUploadTransport,
  signal?: AbortSignal,
  preview?: UsageEngineMergePreviewOutput,
  onProgress?: ManualUploadProgressListener,
): Promise<ManualOperationResult<Value>> => {
  signal?.throwIfAborted();
  if (!(file.size > 0 && file.size <= MAX_PORTABLE_USAGE_BYTES)) {
    return {
      error: {
        message: `Manual import files must contain data and not exceed ${MAX_PORTABLE_USAGE_BYTES} bytes.`,
        tag: 'UploadTooLarge',
      },
      ok: false,
    };
  }
  const headers = {
    'content-type': 'application/json',
    'x-ai-usage-merge-action': action,
    ...(preview === undefined
      ? {}
      : {
          'x-ai-usage-merge-confirmation': preview.confirmationToken,
          'x-ai-usage-merge-digest': preview.documentDigest,
        }),
  };
  onProgress?.({ fileName: file.name, fileSize: file.size, loaded: 0, phase: 'uploading', total: file.size });
  const response = await uploadTransport({
    action,
    file,
    headers,
    ...(onProgress === undefined ? {} : { onProgress }),
    ...(signal === undefined ? {} : { signal }),
  });
  signal?.throwIfAborted();
  return await parseResponse(response, parseValue);
};

export const createManualTransferClient = (
  fetchTransport: SyncFetch = globalThis.fetch,
  uploadTransport: ManualUploadTransport = xhrManualUpload,
): ManualTransferClient => ({
  confirm: async (file, preview, signal, onProgress) =>
    await upload(file, 'confirm', parseNone, uploadTransport, signal, preview, onProgress),
  download: async (signal) => {
    const adapter = createSyncBrowserAdapter(
      { fleet: () => Promise.reject(new Error('Fleet RPC is outside manual download.')) },
      fetchTransport,
    );
    const result = await adapter.downloadManualMerge(signal);
    return { ...result, rows: await exportedRowCount(result.response) };
  },
  preview: async (file, signal, onProgress) =>
    await upload(file, 'preview', parseUsageEngineMergePreviewOutput, uploadTransport, signal, undefined, onProgress),
});
