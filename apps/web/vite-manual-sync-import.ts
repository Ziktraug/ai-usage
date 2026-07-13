import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import type { ManualOperationResult } from './src/manual-transfer-contract';
import { handleManualMergeUpload } from './src/server/manual-merge-upload.server';

type ImportBundle = (text: string) => Promise<ManualOperationResult<unknown>>;

interface ManualSyncImportDevOptions {
  importBundle: ImportBundle;
  maxBytes?: number;
}

const manualMergeServerModuleUrl = new URL('./src/server/manual-merge.server.ts', import.meta.url).href;

const nodeRequestHeaders = (request: IncomingMessage): Headers => {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(name, item);
      }
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }
  return headers;
};

const nodeRequestBody = (request: IncomingMessage): ReadableStream<Uint8Array> => {
  let cancelled = false;
  let cleanup = () => undefined;

  const readChunk = (): Uint8Array | null => {
    const chunk = request.read() as Buffer | string | null;
    if (chunk === null) {
      return null;
    }
    return typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
  };

  return new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
      cleanup();
      request.resume();
    },
    pull(controller) {
      const availableChunk = readChunk();
      if (availableChunk !== null) {
        controller.enqueue(availableChunk);
        return;
      }
      if (request.readableEnded) {
        controller.close();
        return;
      }

      return new Promise<void>((resolve) => {
        const settle = () => {
          cleanup();
          resolve();
        };
        const onReadable = () => {
          if (cancelled) {
            settle();
            return;
          }
          const chunk = readChunk();
          if (chunk !== null) {
            controller.enqueue(chunk);
          } else if (request.readableEnded) {
            controller.close();
          }
          settle();
        };
        const onEnd = () => {
          if (!cancelled) {
            controller.close();
          }
          settle();
        };
        const onError = (error: Error) => {
          if (!cancelled) {
            controller.error(error);
          }
          settle();
        };
        cleanup();
        cleanup = () => {
          request.off('readable', onReadable);
          request.off('end', onEnd);
          request.off('error', onError);
        };
        request.once('readable', onReadable);
        request.once('end', onEnd);
        request.once('error', onError);
      });
    },
  });
};

const nodeRequestToFetchRequest = (request: IncomingMessage): Request => {
  const method = request.method ?? 'GET';
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  const headers = nodeRequestHeaders(request);
  if (method === 'GET' || method === 'HEAD') {
    return new Request(url, { headers, method });
  }
  const requestInit: RequestInit & { duplex: 'half' } = {
    body: nodeRequestBody(request),
    duplex: 'half',
    headers,
    method,
  };
  return new Request(url, requestInit);
};

const sendFetchResponse = async (fetchResponse: Response, response: ServerResponse): Promise<void> => {
  response.statusCode = fetchResponse.status;
  response.statusMessage = fetchResponse.statusText;
  fetchResponse.headers.forEach((value, name) => {
    response.setHeader(name, value);
  });
  response.end(new Uint8Array(await fetchResponse.arrayBuffer()));
};

export const handleManualSyncImportDevRequest = async (
  request: IncomingMessage,
  response: ServerResponse,
  options: ManualSyncImportDevOptions,
): Promise<void> => {
  const fetchRequest = nodeRequestToFetchRequest(request);
  const fetchResponse = await handleManualMergeUpload(fetchRequest, options);
  if (!(request.readableEnded || request.destroyed)) {
    request.resume();
  }
  await sendFetchResponse(fetchResponse, response);
};

export const manualSyncImportDevPlugin = (): Plugin => ({
  name: 'ai-usage-manual-sync-import-dev',
  enforce: 'pre',
  apply: 'serve',
  configureServer(server) {
    server.middlewares.use(async (request, response, next) => {
      if (request.method !== 'POST' || (request.url?.split('?', 1)[0] ?? '') !== '/sync') {
        next();
        return;
      }

      try {
        const { importManualMergeBundleForServer } = (await import(
          manualMergeServerModuleUrl
        )) as typeof import('./src/server/manual-merge.server');
        await handleManualSyncImportDevRequest(request, response, {
          importBundle: (text) => importManualMergeBundleForServer({ text }),
        });
      } catch {
        response.statusCode = 500;
        response.setHeader('content-type', 'application/json');
        response.end(
          JSON.stringify({
            ok: false,
            error: { tag: 'ImportFailed', message: 'The server could not process the manual import file.' },
          }),
        );
      }
    });
  },
});
