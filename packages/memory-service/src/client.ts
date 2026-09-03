import type { CheckoutResolutionAction, CheckoutResolutionActionResult } from '@ai-usage/project-registry/review';
import type { MemoryProjectContext } from './application';
import {
  MEMORY_SERVICE_PROTOCOL_VERSION,
  type MemoryProposalReviewAction,
  type MemoryProposalReviewActionResult,
  type MemoryProposalReviewSnapshot,
  type MemoryResolutionReviewSnapshot,
  type MemoryServiceErrorCode,
  memoryServiceBounds,
  parseCheckoutResolutionActionResult,
  parseMemoryProposalReviewActionResult,
  parseMemoryProposalReviewSnapshot,
  parseMemoryResolutionReviewSnapshot,
  parseMemoryServiceResponse,
} from './contracts';
import type { MemoryItemResult } from './domain';
import { type MemoryServiceRendezvous, revealMemoryServiceToken } from './node';
import {
  type MemoryItemReadRequest,
  type MemoryProjectContextReadRequest,
  type MemorySearchReadRequest,
  parseMemoryItemReadResult,
  parseMemoryProjectContext,
  parseMemorySearchPage,
} from './read-contract';
import type { MemorySearchPage } from './search';

export interface MemoryServiceClient {
  readonly applyProposalReviewAction: (
    action: MemoryProposalReviewAction,
    options?: MemoryServiceRequestOptions,
  ) => Promise<MemoryProposalReviewActionResult>;
  readonly applyResolutionAction: (
    action: CheckoutResolutionAction,
    options?: MemoryServiceRequestOptions,
  ) => Promise<CheckoutResolutionActionResult>;
  readonly getMemoryItem: (
    input: MemoryItemReadRequest,
    options?: MemoryServiceRequestOptions,
  ) => Promise<MemoryItemResult>;
  readonly getProjectContext: (
    input: MemoryProjectContextReadRequest,
    options?: MemoryServiceRequestOptions,
  ) => Promise<MemoryProjectContext>;
  readonly listProposalReviews: (
    cursor?: string | null,
    options?: MemoryServiceRequestOptions,
  ) => Promise<MemoryProposalReviewSnapshot>;
  readonly listResolutionReviews: (options?: MemoryServiceRequestOptions) => Promise<MemoryResolutionReviewSnapshot>;
  readonly searchMemory: (
    input: MemorySearchReadRequest,
    options?: MemoryServiceRequestOptions,
  ) => Promise<MemorySearchPage>;
}

export interface MemoryServiceRequestOptions {
  readonly signal?: AbortSignal;
}

export interface CreateMemoryServiceClientOptions {
  readonly fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  readonly requestTimeoutMs?: number;
  readonly resolveRendezvous: (signal?: AbortSignal) => Promise<MemoryServiceRendezvous>;
}

export class MemoryServiceClientError extends Error {
  override readonly name = 'MemoryServiceClientError';
  readonly code: MemoryServiceErrorCode;

  constructor(code: MemoryServiceErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

const jsonMediaType = 'application/json';
const protocolHeader = 'x-ai-usage-memory-protocol-version';

const readBoundedResponse = async (response: Response, signal: AbortSignal): Promise<unknown> => {
  const declared = response.headers.get('content-length');
  if (declared !== null) {
    const bytes = Number(declared);
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > memoryServiceBounds.maxResponseBytes) {
      throw new MemoryServiceClientError('invalid-response', 'Memory service response length is invalid.');
    }
  }
  if (response.body === null) {
    throw new MemoryServiceClientError('invalid-response', 'Memory service response body is unavailable.');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > memoryServiceBounds.maxResponseBytes) {
        throw new MemoryServiceClientError('invalid-response', 'Memory service response exceeded its byte limit.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new MemoryServiceClientError('invalid-response', 'Memory service response is invalid.');
  }
};

const linkedSignal = (caller: AbortSignal | undefined, timeoutMs: number) => {
  const controller = new AbortController();
  const onAbort = (): void => controller.abort(caller?.reason);
  caller?.addEventListener('abort', onAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(new DOMException('Request timed out', 'TimeoutError')), timeoutMs);
  return {
    cleanup: () => {
      clearTimeout(timeout);
      caller?.removeEventListener('abort', onAbort);
    },
    signal: controller.signal,
  };
};

export const createMemoryServiceClient = ({
  fetch: fetchTransport = globalThis.fetch,
  requestTimeoutMs = memoryServiceBounds.requestTimeoutMs,
  resolveRendezvous,
}: CreateMemoryServiceClientOptions): MemoryServiceClient => {
  if (!(Number.isSafeInteger(requestTimeoutMs) && requestTimeoutMs > 0 && requestTimeoutMs <= 120_000)) {
    throw new Error('Memory service client timeout is invalid.');
  }
  const request = async <Value>(
    pathname: string,
    method: 'GET' | 'POST',
    body: unknown,
    parseData: (value: unknown) => Value,
    options?: MemoryServiceRequestOptions,
  ): Promise<Value> => {
    const linked = linkedSignal(options?.signal, requestTimeoutMs);
    try {
      const rendezvous = await resolveRendezvous(linked.signal);
      const response = await fetchTransport(`http://127.0.0.1:${rendezvous.port}${pathname}`, {
        headers: {
          accept: jsonMediaType,
          authorization: `Bearer ${revealMemoryServiceToken(rendezvous.token)}`,
          ...(method === 'POST' ? { 'content-type': jsonMediaType } : {}),
          [protocolHeader]: String(MEMORY_SERVICE_PROTOCOL_VERSION),
        },
        method,
        ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
        signal: linked.signal,
      });
      if ((response.headers.get('content-type') ?? '').split(';', 1)[0]?.trim() !== jsonMediaType) {
        throw new MemoryServiceClientError('invalid-response', 'Memory service response content type is invalid.');
      }
      const parsed = parseMemoryServiceResponse(await readBoundedResponse(response, linked.signal), parseData);
      if (!parsed.ok) {
        throw new MemoryServiceClientError(parsed.error.code, parsed.error.message);
      }
      return parsed.data;
    } catch (error) {
      options?.signal?.throwIfAborted();
      if (error instanceof MemoryServiceClientError) {
        throw error;
      }
      throw new MemoryServiceClientError('service-unavailable', 'Memory service is unavailable.');
    } finally {
      linked.cleanup();
    }
  };
  const client: MemoryServiceClient = {
    applyResolutionAction: async (action, options) =>
      await request('/v1/repository-resolutions/actions', 'POST', action, parseCheckoutResolutionActionResult, options),
    listResolutionReviews: async (options) =>
      await request('/v1/repository-resolutions', 'GET', undefined, parseMemoryResolutionReviewSnapshot, options),
    applyProposalReviewAction: async (action, options) =>
      await request('/v1/memory-proposals/actions', 'POST', action, parseMemoryProposalReviewActionResult, options),
    listProposalReviews: async (cursor, options) =>
      await request(
        `/v1/memory-proposals${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
        'GET',
        undefined,
        parseMemoryProposalReviewSnapshot,
        options,
      ),
    getMemoryItem: async (input, options) => {
      const result = await request('/v1/memory-items/get', 'POST', input, parseMemoryItemReadResult, options);
      const expectedRevisionId = input.revisionId ?? result.item.currentRevisionId;
      if (result.item.id !== input.itemId || result.revision.id !== expectedRevisionId) {
        throw new MemoryServiceClientError('invalid-response', 'Memory service returned a different item revision.');
      }
      return result;
    },
    getProjectContext: async (input, options) =>
      await request('/v1/memory-project-context', 'POST', input, parseMemoryProjectContext, options),
    searchMemory: async (input, options) =>
      await request('/v1/memory-search', 'POST', input, parseMemorySearchPage, options),
  };
  return Object.freeze(client);
};
